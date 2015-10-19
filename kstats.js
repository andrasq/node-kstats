/*
 * Copyright (c) 2015, Kinvey, Inc. All rights reserved.
 *
 * This software is licensed to you under the Kinvey terms of service located at
 * http://www.kinvey.com/terms-of-use. By downloading, accessing and/or using this
 * software, you hereby accept such terms of service  (and any agreement referenced
 * therein) and agree that you have read, understand and agree to be bound by such
 * terms of service and are of legal age to agree to such terms with Kinvey.
 *
 * This software contains valuable confidential and proprietary information of
 * KINVEY, INC and is subject to applicable licensing agreements.
 * Unauthorized reproduction, transmission or distribution of this file and its
 * contents is a violation of applicable laws.
 *
 * 2015-09-10 AR.
 */

/*
 * kstats -- simple stats logger and statsd uploader
 * gathers and uploads application stats to StackDriver
 *
 * This logger knows only about sample values, not averages or counters or gauges.
 * It accepts and saves samples to persistent store, and uploads them.
 * Aggregation and interpretation of the samples is up to the target backend.
 *
 * Features:
 *   - stats are written to external (durable) journal
 *   - journal contents are uploaded in batches
 *   - stackdriver backend upload supported
 *
 * Todo:
 *   - statsd backend tbd
 */

'use strict'

var os = require('os')
var fs = require('fs')
var https = require('https')
var http = require('http')
var child_process = require('child_process')
var QFputs = require('qfputs')


function KStats( config ) {
  config = config || {}

  var hostname = os.hostname()
  if (hostname.indexOf('.') > 0) hostname = hostname.slice(0, hostname.indexOf('.'))

  this.pid = process.pid
  this.hostname = config.hostname || config.host || hostname
  this.prefix = config.prefix || this.hostname + '.'
  this.journal = config.journal || process.stdout
  // instance-id, if metrics are tied to an instance
  // retrieve on AWS with "curl http://169.254.169.254/latest/meta-data/instance-id"
  this.instance = config.instance || undefined
  this.rejectedJournalLines = null
}

KStats.prototype = {

  // set the AWS instance-id retrieved with this.lookUpInstanceId()
  setInstanceId: function setInstanceId( instanceId ) {
    this.instance = instanceId
    return this
  },

  // set and/or get the array holding the rejected journal lines
  rejectedLines: function rejectedLines( saveToArray ) {
    var ret = this.rejectedJournalLines
    if (Array.isArray(saveToArray)) this.rejectedJournalLines = saveToArray
    return ret
  },

  // convert the timestamp into seconds since the epoch
  // time can be anything understood by new Date(), including a datetime string
  unixTimestamp: function unixTimestamp( timestamp ) {
    if (typeof timestamp == 'number') {         // javascript ms timestamp
      return (timestamp / 1000) >>> 0
    }
    else if (timestamp && timestamp.match(/^[0-9]+$/)) {
      if (timestamp.length == 10) return timestamp >>> 0        // 10-digit unix sec since epoch
      else return (timestamp / 1000) >>> 0                      // 13-digit js ms since epoch
    }
    else if (timestamp != undefined) {
      return (new Date(timestamp) / 1000) >>> 0 // string or Date timestamp
    }
    else return (Date.now() / 1000) >>> 0
  },

  // generate a human-readable timestamp for journaling stats
  makeTimestamp: function makeTimestamp( ) {
    return new Date().toISOString()
  },

  // record a stat in the journal for batched upload later
  // stats are written to a journal to not be lost in case of a crash
  logStat: function logStat( name, value, timestampString ) {
    if (timestampString === undefined) timestampString = this.makeTimestamp()
    var line = timestampString + " " + this.prefix + name + " " + value + "\n"
    this.journal.write(line)
  },

  // convert the journal file contents into stackdriver compatible data
  _parseJournalStackdriverContents: function _parseJournalStackdriverContents( journalContents ) {
    var twoHoursAgo = this.unixTimestamp(Date.now() - 7202000)
    var lines = journalContents.split("\n")
    var line, fields, collectedAtTimestamp
    var data = []
    for (var i=0; i<lines.length; i++) {
      line = lines[i]
      if (!line) continue
      fields = line.split(' ')
      collectedAtTimestamp = this.unixTimestamp(fields[0])
      if (collectedAtTimestamp > twoHoursAgo) {
        data.push({
          name: fields[1],
          // stackdriver accepts only numeric values
          value: parseFloat(fields[2]) || 0,
          // must have been collected_at <= 2 hours ago
          collected_at: collectedAtTimestamp,
          instance: this.instance,
        })
      }
      else {
        if (this.rejectedJournalLines) this.rejectedJournalLines.push(line)
      }
    }
    return data
  },

  // courtesy function to retrieve the AWS host instance-id
  lookUpInstanceId:
  function lookUpInstanceId( cb ) {
    // AWS instance-id "curl http://169.254.169.254/latest/meta-data/instance-id"
    // or the ec2metadata command-line utility
    child_process.exec('ec2metadata | grep instance-id', function(err, stdout, stderr) {
      if (err || stderr) cb(new Error("error running ec2metadata: " + err.message + "\n" + stderr), undefined)
      else {
        // note: stdout is a string, but nodejs.org claims is a Buffer.  Handle both
        var words = stdout.toString().trim().split(' ')
        cb(null, words.pop())
      }
    })
  },

  // send the data to stackdriver
  // stackdriver averages sample values from within the same minute
  uploadToStackdriver:
  function uploadToStackdriver( journalContents, backendConfig, cb ) {
    // http://support.stackdriver.com/customer/portal/articles/1491766-sending-custom-application-metrics-to-the-stackdriver-system
    if (!backendConfig.apiKey) return cb(new Error("missing apiKey"))
    var statsData = this._parseJournalStackdriverContents(journalContents)
    if (statsData.length <= 0) return cb(null, {})
    var body = JSON.stringify({
      timestamp: this.unixTimestamp(),
      proto_version: 1,
      data: statsData,
    })
    var uri = {
      host: backendConfig.host || "custom-gateway.stackdriver.com",
      port: backendConfig.port || 443,
      path: backendConfig.path || "/v1/custom",
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stackdriver-Apikey': backendConfig.apiKey,
        'Content-Length': body.length,
      }
    }
    var erroredOut = false
    var httpRequest = uri.port == 443 && https.request || http.request
    var req = httpRequest(uri, function(res) {
      if (erroredOut) return
      res.body = ''
      res.on('data', function(chunk) {
        res.body += chunk
      })
      res.on('end', function() {
        if (res.statusCode >= 300) return cb(new Error("error HTTP " + res.statusCode), res.body)
        cb(null, res.body)
      })
      res.on('error', function(err) { cb(err) })
    })
    req.on('error', function(err) { erroredOut = true ; cb(err) })
    req.write(body)
    req.end()
  },

  // upload the stats journal using the uploadCallback function
  // on success, clear out the journal, else try again next time
  // uploadCallback takes the journal file contents and a cb
  uploadStatsFromJournal:
  function uploadStatsFromJournal( journalFileName, uploadCallback, doneCallback ) {
    var capturedFileName = journalFileName + ".up"
    var kstats = this

    // TODO: log errors to a passed-in log, not console
    QFputs.FileWriter.renameFile(journalFileName, capturedFileName, function(err) {
      if (err && err.message.indexOf('EEXIST') < 0) {
        if (err.message.indexOf('ENOENT') < 0) {
          console.log("error reading journal file %s:", journalFileName, err.message)
        }
        return doneCallback(err)
      }
      else {
        fs.readFile(capturedFileName, function(err, contents) {
          if (err) console.log("error reading stats logfile %s", capturedFileName, err)
          contents = contents.toString()
          if (!contents) {
            fs.unlink(capturedFileName, function(err) {
              if (err) console.log("unable to remove", capturedFileName, err)
            })
            return doneCallback(err)
          }
          else {
            uploadCallback(contents, function(err) {
              if (err) {
                console.log("error uploading stats:", err)
                return doneCallback(err)
              }
              if (kstats.rejectedJournalLines && stats.rejectedLines().length > 0) {
                console.log("unable to upload lines:")
                console.log(kstats.rejectedLines().join('\n'))
                // TODO: handle rejects better than just writing them to process.log
                kstats.rejectedLines([])
              }
              // remove the file only if successful to updload, else try again next time
              fs.unlink(capturedFileName, function(err) {
                if (err) console.log("unable to remove", capturedFileName, err)
                return doneCallback()
              })
            })
          }
        })
      }
    })
  },

  // log the memory usage statistics reported by process.memoryUsage()
  logMemoryUsage: function logMemoryUsage( usage ) {
    usage = usage || process.memoryUsage()
    var timeString = this.makeTimestamp()
    if (usage.rss) this.logStat('mem_rss', usage.rss, timeString)
    if (usage.heapTotal) this.logStat('mem_heap_total', usage.heapTotal, timeString)
    if (usage.heapUsed) this.logStat('mem_heap_used', usage.heapUsed, timeString)
  },
}

KStats.lookUpInstanceId = KStats.prototype.lookUpInstanceId

module.exports = KStats
