/**
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

'use strict'

var assert = require('assert');
var http = require('http');
var os = require('os');
var fs = require('fs');

var KStats = require('./');

describe ('KStats', function() {
    var lines = [];
    var cut = null;     // class under test

    beforeEach (function(done) {
        lines = [];
        cut = new KStats({
            journal: { write: function(line) { lines.push(line) } },
            prefix: "unit.test.",
            instance: undefined,
        });
        done();
    })

    it ('should parse package.json', function(done) {
        require('./package.json');
        done();
    })

    describe ('class', function() {
        it ('should set pid and hostname', function(done) {
            assert.equal(cut.pid, process.pid);
            assert.equal(os.hostname().indexOf(cut.hostname), 0);
            done();
        })

        it ('should look up instanceId', function(done) {
            cut.lookUpInstanceId(function(err, id) {
                //console.log("lookUpInstanceId:", err, id);
                done();
            })
        })

        it ('should set instanceId', function(done) {
            var stats = new KStats({ instance: 'testinstance' });
            assert.equal(stats.instance, 'testinstance');
            stats.setInstanceId('testid1234');
            assert.equal(stats.instance, 'testid1234');
            done();
        })

        it ('unixTimestamp should return a large integer', function(done) {
            var now = Date.now();
            assert.equal(cut.unixTimestamp(1500000000000), 1500000000);
            assert.equal(cut.unixTimestamp("1500000000000"), 1500000000);
            assert.equal(cut.unixTimestamp("2017-07-13 22:40:00.000 EDT"), 1500000000);
            assert(cut.unixTimestamp() >= now / 1000 >>> 0);
            done();
        })

        it ('makeTimestamp should return a time string', function(done) {
            var now = Date.now();
            var timestamp = cut.makeTimestamp(now);
            assert.equal(typeof timestamp, 'string');
            assert.equal(typeof new Date(timestamp), 'object');
            assert(timestamp.indexOf(new Date(now).getFullYear()) >= 0);
            assert(timestamp.indexOf("" + (new Date(now).getMonth()+1)) >= 0);
            assert(new Date(timestamp) <= Date.now());
            done();
        })

        it ('logStat should write to journal', function(done) {
            cut.logStat('stat-name', 111, '2015-01-01T12:34:56.789Z');
            cut.logStat('stat2-name', 222, '2015-01-01T12:34:57.789Z');
            assert.equal(lines.length, 2);
            assert.equal(lines[0], "2015-01-01T12:34:56.789Z unit.test.stat-name 111\n");
            assert.equal(lines[1], "2015-01-01T12:34:57.789Z unit.test.stat2-name 222\n");
            done();
        })

        it ('rejectedLines(false) should return the currently configured failed lines store', function(done) {
            cut.rejectedLines([]);
            var lines1 = cut.rejectedLines(false);
            var lines2 = cut.rejectedLines(false);
            assert.equal(lines1, lines2);
            assert.ok(lines1);
            done();
        })

        it ('rejectedLines should by default reset the failed lines store', function(done) {
            var lines1 = cut.rejectedLines();
            var lines2 = cut.rejectedLines();
            var lines3 = cut.rejectedLines();
            assert.ok(lines1 != lines2);
            assert.ok(lines2 != lines3);
            done();
        })

        it ('rejectedLines should set the failed lines store', function(done) {
            var lines = [];
            cut.rejectedLines(lines);
            assert.equal(cut.rejectedLines(false), lines);
            done();
        })

        it ('rejectedLines should swap the failed lines store', function(done) {
            var lines = [];
            var lines1 = cut.rejectedLines(false);
            var lines2 = cut.rejectedLines(lines);
            assert.equal(lines1, lines2);
            assert.equal(cut.rejectedLines(false), lines);
            done();
        })
    })

    describe ('stats loggers', function() {
        it ('logMemoryUsage should record 3 stat points', function(done) {
            cut.logMemoryUsage(process.memoryUsage());
            assert.equal(lines.length, 3);
            done();
        })
    })

    describe ('uploadStatsFromJournal', function() {
        var tempfile = "/tmp/unit-kstats.tmp";
        var grabfile = "/tmp/unit-kstats.tmp" + ".up";

        beforeEach (function(done) {
            cut.logMemoryUsage({rss: 333, heapTotal: 222, heapUsed: 111});
            fs.writeFileSync(tempfile, lines.join(''));
            try { fs.unlinkSync(grabfile) } catch (err) { }
            done();
        })

        afterEach (function(done) {
            try { fs.unlinkSync(tempfile) } catch (err) { }
            try { fs.unlinkSync(grabfile) } catch (err) { }
            done();
        })

        it ('should return error if journal does not exist', function(done) {
            var kstats = new KStats();
            kstats.uploadStatsFromJournal("/nonesuch", function(){}, function(err) {
                assert(err);
                assert.ok(err.message.indexOf('ENOENT') >= 0);
                done();
            })
        })

        it ('should return error on file access error', function(done) {
            var kstats = new KStats();
            kstats.uploadStatsFromJournal("/root/", function(){}, function(err) {
                assert(err);
                done();
            })
        })

        it ('should return error and keep renamed journal on upload error', function(done) {
            var kstats = new KStats();
            kstats.uploadStatsFromJournal(tempfile,
                function(contents, cb) {
                    cb(new Error("deliberate"))
                },
                function(err) {
                    assert(err);
                    var contents = fs.readFileSync(grabfile).toString();
                    assert.ok(contents.length > 0);
                    done();
                }
            )
        })

        it ('should upload journal contents and remove journal on success', function(done) {
            var kstats = new KStats({});
            kstats.uploadStatsFromJournal(tempfile,
                function(contents, cb) {
                    cb();
                },
                function(err) {
                    assert(!err);
                    fs.open(grabfile, "r", function(err, fd) {
                        assert.ok(err);
                        assert.ok(err.message.indexOf('ENOENT') >= 0);
                        fs.open(tempfile, "r", function(err, fs) {
                            assert.ok(err);
                            assert.ok(err.message.indexOf('ENOENT') >= 0);
                            done();
                        })
                    })
                }
            )
        })

        it ('should upload already existing grab-to file first', function(done) {
            fs.writeFileSync(grabfile, "exists");
            cut.uploadStatsFromJournal(
                tempfile,
                function(contents, cb) {
                    assert.equal(contents, "exists");
                    cb();
                },
                function(err) {
                    assert(!err);
                    done();
                }
            )
        })
    })

    describe ('backends', function() {
        var serverData = null;
        var server = null;

        beforeEach(function(done) {
            serverData = "";
            // small loopback server to register the backend call
            server = http.createServer(function(req, res) {
                req.setEncoding('utf8');
                req.on('data', function(chunk) { serverData += chunk });
                req.on('end', function() { res.writeHead(200) ; res.end() });
                req.on('error', function(err) { /* suppress */ });
                // if forcing an error response, still go through the on 'end' 200 response codepath
                if (req.url == '/error') { res.writeHead(400) ; res.end("deliberate error") }
            })
            server.listen(1337);
            done();
        })

        afterEach(function(done) {
            server.close();
            done();
        })

        it ('stackdriver _parseJournalStackdriverContents should build stats data array', function(done) {
            var timestamp = cut.makeTimestamp();
            cut.logStat('stat1-name', 111, timestamp);
            cut.logStat('stat2-name', 222, timestamp);
            cut.logStat('stat3-name', 333, timestamp);
            var data = cut._parseJournalStackdriverContents(lines.join(""));
            assert.equal(data.length, 3);
            assert.equal(data[0].value, 111);
            assert.equal(data[1].collected_at, new Date(timestamp)/1000 >>> 0);
            done();
        })

        it ('_parseJournalStackdriverContents should reject old samples', function(done) {
            var rejects = [];
            cut.rejectedLines(rejects);
            var data = cut._parseJournalStackdriverContents("1 sample 1.0\n" + (Date.now()/1000 >>> 0) + " sample 2.0\n" + "3 sample 3.0");
            assert.equal(rejects.length, 2);
            assert.equal(data.length, 1);
            assert.equal(rejects[0], '1 sample 1.0');
            assert.equal(rejects[1], '3 sample 3.0');
            cut.rejectedLines([]);
            done();
        })

        it ('stackdriver should send http POST request', function(done) {
            var stackdriverConfig = {
                host: 'localhost',
                port: 1337,
                apiKey: 'x',
            };
            cut.logMemoryUsage({rss: 250, heapTotal: 230, heapUsed: 120});
            var journalContents = lines.join('');
            cut.uploadToStackdriver(journalContents, stackdriverConfig, function(err) {
                assert.equal(serverData.slice(0, 13), '{"timestamp":');
                var json = JSON.parse(serverData);

                // unset the annotations to match the expected input
                for (var i in json.data) delete json.data[i].collected_at;

                assert.deepEqual(json.data[0], {name: "unit.test.mem_rss", value: 250});
                assert.deepEqual(json.data[1], {name: "unit.test.mem_heap_total", value: 230});
                assert.deepEqual(json.data[2], {name: "unit.test.mem_heap_used", value: 120});
                done();
            })
        })

        it ('stackdriver should return error on http error', function(done) {
            var stackdriverConfig = {
                host: 'localhost',
                port: 1337,
                path: '/error',
                apiKey: 'x',
            };
            cut.logMemoryUsage({rss: 250, heapTotal: 230, heapUsed: 120});
            var journalContents = lines.join('');
            cut.uploadToStackdriver(journalContents, stackdriverConfig, function(err, responseBody) {
                assert.ok(err instanceof Error);
                assert.equal(responseBody, "deliberate error");
                done();
            })
        })

        it ('stackdriver should actually upload', function(done) {
            var stackdriverConfig = {
                apiKey: 'HM0R2KGICRBMGMRJUUXLUUXWDHV8KCST',     // AR unit test account
                host: "custom-gateway.stackdriver.com",
                port: 443,
                path: "/v1/custom",
            };
            cut.logMemoryUsage(process.memoryUsage());
            var journalContents = lines.join('');
            cut.uploadToStackdriver(journalContents, stackdriverConfig, function(err, responseBody) {
                assert(!err);
                assert.equal(responseBody, "Published");
                done();
            })
        })
    })
})
