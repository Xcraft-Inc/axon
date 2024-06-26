/**
 * Module dependencies.
 */

const zlib = require('zlib');
var Emitter = require('events').EventEmitter;
var Configurable = require('configurable');
var debug = require('debug')('axon:sock');
var Message = require('xcraft-amp-message');
var Parser = require('xcraft-amp').Stream;
var url = require('url');
var net = require('net');
var tls = require('tls');
var {Perf} = require('../symbols.js');
var PerfStream = require('../perf-stream.js');

/**
 * Errors to ignore.
 */

var ignore = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'ENOENT',
  'Z_BUF_ERROR',
  'Z_DATA_ERROR'
];

/**
 * Expose `Socket`.
 */

module.exports = Socket;

/**
 * Initialize a new `Socket`.
 *
 * A "Socket" encapsulates the ability of being
 * the "client" or the "server" depending on
 * whether `connect()` or `bind()` was called.
 *
 * @api private
 */

function Socket() {
  this.server = null;
  this.socks = [];
  this.settings = {};
  this.set('hwm', Infinity);
  this.set('identity', String(process.pid));
  this.set('retry timeout', 100);
  this.set('retry max timeout', 5000);
  this.set('socket timeout', 0);
  this.set('disable zlib', false);
}

/**
 * Inherit from `Emitter.prototype`.
 */

Socket.prototype.__proto__ = Emitter.prototype;

/**
 * Make it configurable `.set()` etc.
 */

Configurable(Socket.prototype);

/**
 * Use the given `plugin`.
 *
 * @param {Function} plugin
 * @api private
 */

Socket.prototype.use = function(plugin){
  plugin(this);
  return this;
};

/**
 * Creates a new `Message` and write the `args`.
 *
 * @param {Array} args
 * @return {Buffer}
 * @api private
 */

Socket.prototype.pack = function(args){
  var msg = new Message(args);
  var buffer = msg.toBuffer();
  return this.get('disable zlib') ? buffer : zlib.gzipSync(buffer);
};

/**
 * Close all open underlying sockets.
 *
 * @api private
 */

Socket.prototype.closeSockets = function(){
  debug('%s closing %d connections', this.type, this.socks.length);
  this.socks.forEach(function(sock){
    sock.destroy();
  });
};

/**
 * Close the socket.
 *
 * Delegates to the server or clients
 * based on the socket `type`.
 *
 * @param {Function} [fn]
 * @api public
 */

Socket.prototype.close = function(fn){
  debug('%s closing', this.type);
  this.closing = true;
  this.closeSockets();
  if (this.server) this.closeServer(fn);
};

/**
 * Close the server.
 *
 * @param {Function} [fn]
 * @api public
 */

Socket.prototype.closeServer = function(fn){
  debug('%s closing server', this.type);
  this.server.on('close', this.emit.bind(this, 'close'));
  this.server.close();
  fn && fn();
};

/**
 * Return the server address.
 *
 * @return {Object}
 * @api public
 */

Socket.prototype.address = function(){
  if (!this.server) return;
  var addr = this.server.address();
  addr.string = (this.get('tls') ? 'tls://' : 'tcp://') + addr.address + ':' + addr.port;
  return addr;
};

/**
 * Remove `sock`.
 *
 * @param {Socket} sock
 * @api private
 */

Socket.prototype.removeSocket = function(sock){
  var i = this.socks.indexOf(sock);
  if (!~i) return;
  debug('%s remove socket %d', this.type, i);
  this.socks.splice(i, 1);
};

Socket.prototype.handleError = function(sock, err){
  sock.destroy();
  debug('%s error %s', this.type, err.code || err.message);
  this.emit('socket error', err, sock);
  if (!~ignore.indexOf(err.code)) return this.emit('error', err, sock);
  debug('%s ignored %s', this.type, err.code);
  this.emit('ignored error', err);
}

/**
 * Add `sock`.
 *
 * @param {Socket} sock
 * @api private
 */

Socket.prototype.addSocket = function(sock){
  const perf = new PerfStream;
  perf.on('error', (err) => this.handleError(sock, err));

  let gunzip;
  if (this.get('disable zlib') === false) {
    gunzip = zlib.createGunzip({level: 1});
    gunzip.on('error', (err) => this.handleError(sock, err));
  }

  var parser = new Parser;
  parser.on('error', (err) => this.handleError(sock, err));

  var i = this.socks.push(sock) - 1;
  debug('%s add socket %d', this.type, i);
  sock[Perf] = () => perf.last;

  if (this.get('disable zlib')) {
    sock.pipe(perf).pipe(parser);
  } else {
    sock.pipe(perf).pipe(gunzip).pipe(parser);
  }
  parser.on('data', this.onmessage(sock));
};

/**
 * Handle `sock` errors.
 *
 * Emits:
 *
 *  - `error` (err) when the error is not ignored
 *  - `ignored error` (err) when the error is ignored
 *  - `socket error` (err) regardless of ignoring
 *
 * @param {Socket} sock
 * @api private
 */

Socket.prototype.handleErrors = function(sock){
  var self = this;
  sock.on('error', function(err){
    debug('%s error %s', self.type, err.code || err.message);
    self.emit('socket error', err, sock);
    self.removeSocket(sock);
    if (!~ignore.indexOf(err.code)) return self.emit('error', err, sock);
    debug('%s ignored %s', self.type, err.code);
    self.emit('ignored error', err);
  });
};

/**
 * Handles framed messages emitted from the parser, by
 * default it will go ahead and emit the "message" events on
 * the socket. However, if the "higher level" socket needs
 * to hook into the messages before they are emitted, it
 * should override this method and take care of everything
 * it self, including emitted the "message" event.
 *
 * @param {net.Socket} sock
 * @return {Function} closure(msg, mulitpart)
 * @api private
 */

Socket.prototype.onmessage = function(sock){
  var self = this;
  return function(buf){
    var msg = new Message(buf);
    self.emit.apply(self, ['message'].concat(msg.args).concat(sock));
  };
};

/**
 * Connect to `port` at `host` and invoke `fn()`.
 *
 * Defaults `host` to localhost.
 *
 * TODO: needs big cleanup
 *
 * @param {Number|String} port
 * @param {String} host
 * @param {Function} fn
 * @return {Socket}
 * @api public
 */

Socket.prototype.connect = function(port, host, fn){
  var self = this;
  if ('server' == this.type) throw new Error('cannot connect() after bind()');
  if ('function' == typeof host) {
    fn = host;
    host = undefined;
  }

  if ('string' == typeof port) {
    port = url.parse(port);

    if (port.protocol == "unix:") {
      host = fn;
      fn = undefined;
      port = port.pathname;
      self.isUnixSocket = true;
    } else {
      host = port.hostname || '0.0.0.0';
      port = parseInt(port.port, 10);
    }
  } else {
    host = host || '0.0.0.0';
  }

  var max = self.get('retry max timeout');
  var timeout = self.get('socket timeout');
  var sock;
  var connectEvent;
  var tlsOpts = this.get('tls');
  var keepAlive = this.get('tcp connect keep-alive');

  debug('%s connect attempt %s:%s', self.type, host, port);
  if (tlsOpts) {
    tlsOpts.host = host;
    tlsOpts.port = port;
    sock = tls.connect(tlsOpts);
    connectEvent = 'secureConnect';
  } else {
    sock = new net.Socket;
    sock.connect(port, host);
    connectEvent = 'connect';
  }

  sock.setNoDelay();
  if (Number.isInteger(keepAlive))
    sock.setKeepAlive(true, keepAlive);
  else if (keepAlive === false)
    sock.setKeepAlive(false);
  if (timeout){
    sock.setTimeout(timeout, () => sock.destroy());
  }
  this.type = 'client';

  this.handleErrors(sock);

  sock.on('close', function(){
    self.emit('socket close', sock);
    self.connected = false;
    self.removeSocket(sock);
    if (self.closing) return self.emit('close', sock);
    var retry = self.retry || self.get('retry timeout');
    setTimeout(function(){
      debug('%s attempting reconnect', self.type);
      self.emit('reconnect attempt');
      sock.destroy();
      if (self.isUnixSocket) {
        port = `unix://${port}`;
      }
      self.connect(port, host);
      self.retry = Math.round(Math.min(max, retry * 1.5));
    }, retry);
  });

  sock.on(connectEvent, function(){
    debug('%s connect', self.type);
    self.connected = true;
    self.addSocket(sock);
    self.retry = self.get('retry timeout');
    self.emit('connect', sock);
    fn && fn();
  });

  return this;
};

/**
 * Handle connection.
 *
 * @param {Socket} sock
 * @api private
 */

Socket.prototype.onconnect = function(sock){
  var self = this;
  var addr = sock.remoteAddress + ':' + sock.remotePort;
  var tlsOpts = self.get('tls');
  if (tlsOpts & !sock.authorized) {
    debug('%s denied %s for authorizationError %s', self.type, addr, sock.authorizationError);
  }
  debug('%s accept %s', self.type, addr);
  var keepAlive = this.get('tcp onconnect keep-alive');
  if (Number.isInteger(keepAlive))
    sock.setKeepAlive(true, keepAlive);
  else if (keepAlive === false)
    sock.setKeepAlive(false);
  var timeout = self.get('socket timeout');
  if (timeout){
    sock.setTimeout(timeout, () => sock.destroy());
  }
  this.addSocket(sock);
  this.handleErrors(sock);
  if (tlsOpts && !sock.authorized && tlsOpts.requestCert){
    this.emit('reject', sock);
  } else {
    this.emit('connect', sock);
  }
  sock.on('close', function(hadError) {
    debug('%s disconnect %s', self.type, addr);
    self.emit('disconnect', sock, hadError);
    self.removeSocket(sock);
  });
};

/**
 * Bind to `port` at `host` and invoke `fn()`.
 *
 * Defaults `host` to INADDR_ANY.
 *
 * Emits:
 *
 *  - `connection` when a client connects
 *  - `disconnect` when a client disconnects
 *  - `bind` when bound and listening
 *
 * @param {Number|String} port
 * @param {Function} fn
 * @return {Socket}
 * @api public
 */

Socket.prototype.bind = function(port, host, fn){
  var self = this;
  if ('client' == this.type) throw new Error('cannot bind() after connect()');
  if ('function' == typeof host) {
    fn = host;
    host = undefined;
  }

  var unixSocket = false;

  if ('string' == typeof port) {
    port = url.parse(port);

    if ('tls:' == port.protocol && !self.get('tls')) throw new Error('missing tls options');
    if ('unix:' == port.protocol) {
      host = fn;
      fn = undefined;
      port = port.pathname;
      unixSocket = true;
    } else {
      host = port.hostname || '0.0.0.0';
      port = parseInt(port.port, 10);
    }
  } else {
    host = host || '0.0.0.0';
  }

  this.type = 'server';

  var tlsOpts = self.get('tls');
  if (tlsOpts) {
    tlsOpts.requestCert = tlsOpts.requestCert !== false;
    tlsOpts.rejectUnauthorized = tlsOpts.rejectUnauthorized !== false;
    this.server = tls.createServer(tlsOpts, this.onconnect.bind(this));
  } else {
    this.server = net.createServer(this.onconnect.bind(this));
  }

  debug('%s bind %s:%s', this.type, host, port);
  this.server.on('listening', this.emit.bind(this, 'bind'));
  if (unixSocket) {
    const fse = require('fs-extra');
    fse.removeSync(port);
    this.server.listen(port, host);
  } else {
    this.server.listen(port, host, fn);
  }
  return this;
};
