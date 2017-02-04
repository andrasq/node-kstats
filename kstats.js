/*
 * Copyright (c) 2015, 2017, Kinvey, Inc. All rights reserved.
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

var os = require('os');
var fs = require('fs');
var https = require('https');
var http = require('http');
var child_process = require('child_process');
var QFputs = require('qfputs');

function KStats( config ) {
    config = config || {};

    this.pid = process.pid;
    this.hostname = config.hostname || config.host || hostname_s();
    this.prefix = config.prefix || this.hostname + '.';
    this.journal = config.journal || process.stdout;
    // instance-id, if metrics are tied to an instance
    // retrieve on AWS with "curl http://169.254.169.254/latest/meta-data/instance-id"
    // or 'ec2metadata | grep instanceId'
    this.instance = config.instance || undefined;
    this.backendConfig = config.backendConfig;
    this.rejectedJournalLines = null;
}

function hostname_s( ) {
    var hostname = os.hostname();
    if (hostname.indexOf('.') > 0) hostname = hostname.slice(0, hostname.indexOf('.'));
    return hostname;
}

function _tryExecSync( cmdline ) {
    try {
        return child_process.execSync(cmdline);
    }
    catch (err) {
        console.log("error running command:", err.message);
        return "";
    }
}

KStats.prototype = {

    // set the AWS instance-id retrieved with this.lookUpInstanceId()
    setInstanceId: function setInstanceId( instanceId ) {
        this.instance = instanceId;
        return this;
    },

    // return the lines not uploaded thus far, and clear (or set) the line store
    // Pass false as the newSaveToArray to not clear but reuse the existing store.
    rejectedLines: function rejectedLines( newSaveToArray ) {
        if (newSaveToArray === undefined) newSaveToArray = [];
        var currentArray = this.rejectedJournalLines;
        if (Array.isArray(newSaveToArray)) this.rejectedJournalLines = newSaveToArray;
        return currentArray;
    },

    // convert the timestamp into seconds since the epoch
    // time can be anything understood by new Date(), including a datetime string
    unixTimestamp: function unixTimestamp( timestamp ) {
        if (typeof timestamp == 'number') {                     // javascript ms timestamp
            return (timestamp / 1000) >>> 0;
        }
        else if (timestamp && timestamp.match(/^[0-9]+$/)) {
            if (timestamp.length == 10) return timestamp >>> 0; // 10-digit unix sec since epoch
            else return (timestamp / 1000) >>> 0;               // 13-digit js ms since epoch
        }
        else if (timestamp != undefined) {
            return (new Date(timestamp) / 1000) >>> 0;          // string or Date timestamp
        }
        else return (Date.now() / 1000) >>> 0;
    },

    // generate a human-readable timestamp for journaling stats
    makeTimestamp: function makeTimestamp( ) {
        return new Date().toISOString();
    },

    // append to the stats journal
    write: function write( line ) {
        this.journal.write(line);
    },

    // record a stat in the journal for batched upload later
    // stats are written to a journal to not be lost in case of a crash
    logStat: function logStat( name, value, timestampString ) {
        if (timestampString === undefined) timestampString = this.makeTimestamp();
        var line = timestampString + " " + this.prefix + name + " " + value + "\n";
        this.journal.write(line);
    },

    // forever loop to periodically upload the journaled stats to the named backend
    // To cancel, clear the returned interval timeout.
    uploadLoop: function uploadLoop( statsLogfileName, backendName, backendConfig, uploadInterval, onError ) {
        if (!backendConfig) throw new Error(backendName + ": stats upload backend not configured");
        if (!uploadInterval) uploadInterval = 120000;
        if (!onError) onError = function(){};
        var statsLogger = this;

        var uploadStatsFunc;
        switch (backendName) {
        case 'stackdriver':
            uploadStatsFunc = function uploadToStackdriver( contents, callback ) {
                statsLogger.uploadToStackdriver(contents, backendConfig, function(err, response) {
                    if (err) onError(err, "error uploading stats to stackdriver: " + err.message + ": " + response);
                    var rejectLines = statsLogger.rejectedLines([]);
                    if (rejectLines.length > 0) {
                        onError({}, "did not upload some stats lines:\n" + rejectLines.join('\n'));
                    }
                    callback();
                });
            }
            break;
        default:
            throw new Error(backendName + ": stats upload not supported");
        }

        var uploader = setInterval(function() {
            statsLogger.uploadStatsFromJournal(statsLogfileName, uploadStatsFunc, function(err, ret) {
                if (err) onError(err, "stats upload error: " + err.message + ": " + err.debug);
            });
        }, uploadInterval);
        return uploader;
    },

    // convert the journal file contents into stackdriver compatible data
    _parseJournalStackdriverContents: function _parseJournalStackdriverContents( journalContents ) {
        var twoHoursAgo = this.unixTimestamp(Date.now() - 7202000);
        var line, fields, collectedAtTimestamp, value;
        var data = [];

        var lines = journalContents.split("\n");
        for (var i=0; i<lines.length; i++) {
            line = lines[i];
            if (!line) continue;

            fields = line.split(' ');

            // stackdriver accepts only numeric values
            // must have been collected_at <= 2 hours ago
            collectedAtTimestamp = this.unixTimestamp(fields[0]);
            value = parseFloat(fields[2]);

            if (fields.length === 3 &&
                collectedAtTimestamp > twoHoursAgo &&
                value > -Infinity && value < Infinity)
            {
                data.push({
                    name: fields[1],
                    value: parseFloat(fields[2]) || 0,
                    collected_at: collectedAtTimestamp,
                    instance: this.instance,
                });
            }
            else {
                if (this.rejectedJournalLines) this.rejectedJournalLines.push(line);
            }
        }
        return data;
    },

    // courtesy function to retrieve the AWS host instance-id
    lookUpInstanceId: function lookUpInstanceId( cb ) {
        // AWS instance-id "curl http://169.254.169.254/latest/meta-data/instance-id"
        // or the ec2metadata command-line utility
        var cmdline = 'ec2metadata | grep instance-id';

        if (!cb) return _tryExecSync(cmdline).toString().split(' ').pop().trim();

        child_process.exec(cmdline, function(err, stdout, stderr) {
            if (err || stderr) {
                cb(new Error("error running ec2metadata: " + err.message + "\n" + stderr), undefined);
            }
            else {
                var words = stdout.toString().trim().split(' ');
                cb(null, words.pop());
            }
        });
    },

    // send the data to stackdriver
    // stackdriver averages sample values from within the same minute
    // http://support.stackdriver.com/customer/portal/articles/1491766-sending-custom-application-metrics-to-the-stackdriver-system
    uploadToStackdriver: function uploadToStackdriver( journalContents, backendConfig, cb ) {
        if (!backendConfig.apiKey) return cb(new Error("missing apiKey"));

        var statsData = this._parseJournalStackdriverContents(journalContents);
        if (statsData.length <= 0) return cb(null, {});

        var body = JSON.stringify({
            timestamp: this.unixTimestamp(),
            proto_version: 1,
            data: statsData,
        });

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
        var erroredOut = false;

        // TODO: use k-http
        var httpRequest = uri.port == 443 && https.request || http.request;
        var req = httpRequest(uri, function(res) {
            if (erroredOut) return;
            res.body = '';
            res.on('data', function(chunk) {
                res.body += chunk;
            });
            res.on('end', function() {
                if (res.statusCode >= 300) return cb(new Error("http error " + res.statusCode), res.body);
                cb(null, res.body);
            });
            res.on('error', function(err) { cb(err) });
        });
        req.on('error', function(err) { erroredOut = true ; cb(err) });
        req.write(body);
        req.end();
    },

    // upload the stats journal using the uploadCallback function
    // on success, clear out the journal, else try again next time
    // uploadCallback takes the journal file contents and a cb
    uploadStatsFromJournal: function uploadStatsFromJournal( journalFileName, uploadCallback, doneCallback ) {
        var capturedFileName = journalFileName + ".up";
        var self = this;

        // if already uploading, nothing to do
        if (self._uploading) return doneCallback();

        // wrapper the callback to be sure to turn off _uploading
        function returnToCaller( err, debugMessage ) {
            self._uploading = false;
            if (err && debugMessage) err.debug = debugMessage;
            doneCallback(err);
        }

        self._uploading = true;
        var debug;
        QFputs.FileWriter.renameFile(journalFileName, capturedFileName, function(err) {
            // not an error for there to already be a captured filename, process it
            if (err && err.message.indexOf('EEXIST') >= 0) err = null;

            if (err) {
                debug = "error reading stats logfile " + journalFileName;
                return returnToCaller(err, debug);
            }
            else {
                fs.readFile(capturedFileName, function(err, contents) {
                    if (err) {
                        debug = "error reading stats logfile " + capturedFileName;
                        return returnToCaller(err, debug);
                    }
                    contents = contents.toString();
                    if (!contents) {
                        fs.unlink(capturedFileName, function(err) {
                            debug = "unable to remove empty stats file " + capturedFileName;
                            return returnToCaller(err, debug);
                        });
                    }
                    else {
                        uploadCallback(contents, function(err, response) {
                            if (err) {
                                debug = "error uploading stats to stackdriver: " + response;
                                return returnToCaller(err, debug);
                            }
                            // remove the file only if successful to updload, else try again next time
                            fs.unlink(capturedFileName, function(err) {
                                debug = "unable to remove uploaded stats file " + capturedFileName;
                                return returnToCaller(err, debug);
                            });
                        });
                    }
                });
            }
        });
    },

    // log the memory usage statistics reported by process.memoryUsage()
    logMemoryUsage: function logMemoryUsage( usage ) {
        usage = usage || process.memoryUsage();
        var timeString = this.makeTimestamp();
        if (usage.rss) this.logStat('mem_rss', usage.rss, timeString);
        if (usage.heapTotal) this.logStat('mem_heap_total', usage.heapTotal, timeString);
        if (usage.heapUsed) this.logStat('mem_heap_used', usage.heapUsed, timeString);
    },
}

// expose some functions as class methods
KStats.lookUpInstanceId = KStats.prototype.lookUpInstanceId;
KStats._tryExecSync = _tryExecSync;

module.exports = KStats;
