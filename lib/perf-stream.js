'use strict';

const {Transform} = require('stream');
const {performance} = require('perf_hooks');

class PerfStream extends Transform {
  constructor(options) {
    super(options);
    this._last = 0;
  }

  _transform(chunk, encoding, cb) {
    this._last = performance.now();
    cb(null, chunk);
  }

  get last() {
    return this._last;
  }
}

module.exports = PerfStream;
