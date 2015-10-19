kstats
======

slim, durable stats logger and uploader

Records stats to a journal file, uploads in batches.  Stackdriver upload
support built in.


        var QFputs = require('qfputs')
        var KStats = require('kstats')
        var statsLogfile = "/tmp/kstats.log"
        var statLogger = new KStats({ journal: new QFputs(statsLogfile), prefix: 'test-' })

        statLogger.logStat('heap_used', process.memoryUsage().heapUsed)

        statLogger.uploadStatsFromJournal(
            statsLogfile,
            function(journalContents, cb) {
                statLogger.uploadToStackdriver(
                    journalContents,
                    { apiKey: 'my*Stackdriver*Api*Key' },
                    function(err) {
                        cb(err)
                    }
                )
            },
            function(err) {
                if (err) console.log("error uploading journal contents: " + err)
            }
        )


API
---

### new KStats( options )

Create a stats logger.

Stats are written to the configured `journal` or standard output by default.
Methods are available to atomically paginate the journal and upload the stats to
stackdriver.

Options:

* `hostname`: name of system sending the metrics (default `/bin/hostname -s`)
* `journal`: journal object with `write` method (default `process.stdout`)
* `prefix`: string to prepend to every metric name logged (default none)
* `instance`: AWS instance id to which to attribute the uploaded stats (default none)

### logStat( name, value [,timestamp] )

Record a metric to the stats journal.  The journal file is plaintext newline
terminated records, one sample per line, in `timestamp, name, value` order.
The provided timestamp is used, else a human readable datetime string is
generated.  The sample names are prepended with the configured prefix, if any.
The name, value and timestamp must not contain whitespace characters.

### uploadToStackdriver( journalContents, stackdriverConfig, callback )

Parse the journal file contents and upload the data to Stackdriver.com.
The stackdriverConfig must contain a field `apiKey` that identifies the
account to upload to.

StackdriverConfig:

* `apiKey`: stackdriver custom metrics api key, required (no default)
* `host`: name of host to send to (default "custom-gateway.stackdriver.com")
* `port`: host port to connect to (default 443)
* `path`: http path to POST to (default "/v1/custom")

### uploadStatsFromJournal( filename, uploadFunction, callback )

rename `filename` to `filename.up`, wait 50ms for open file handles to age out
and be closed, assert a LOCK_EX to ensure that the last write finished, and hand
the file contents to the provided upload function.  If no errors, remove the
processed `filename.up` journal file.  After a successful upload both `filename`
and `filename.up` will have been removed.

If `filename.up` already exists, the existing file will be uploaded instead (and
removed), and `filename` will be left as is.

### rejectedLines( [arrayToHoldLines] )

Return or specify the array holding the lines that were not uploaded successfully
to stackdriver.  Lines are rejected for being unparseable or being too old (stats
must be no more than 2 hours old at the time of upload).  The default is `null`
to not save the rejected lines.

If called with no arguments, the function returns the currently configured
rejected-lines array.  If called with an array, it will install the array to
receive any future rejected lines, and returns the previously configured
rejected-lines array.

### unixTimestamp( [timeSpecifier] )

Convert the specified time to a unix timestamp, seconds since "the epoch"
(1970-01-01 00:00:00 GMT).  Treats numbers as javascript millisecond-precision
timestamps, numeric strings as either javascript or unix timestamps depending
on whether 10 digits (unix) else javascript (13), converts strings and objects
with `new Date(timeSpecifier)`, and if no time is specified, the current time
is used.

### lookUpInstanceId( )

Convenience function to return the AWS instance-id of this server.  Uses the
`ec2metadata` command.


Related Work
------------

* `qfputs` - fast, robust, atomic logging and journaling
* `stats-logger` - stats aggregator and uploader
