
/**
 * Module dependencies.
 */

var Socket = require('./sock');
var net = require('net');

/**
 * Expose `PubSocket`.
 */

module.exports = PubSocket;

/**
 * Initialize a new `PubSocket`.
 *
 * @api private
 */

function PubSocket() {
  Socket.call(this);
}

/**
 * Inherits from `Socket.prototype`.
 */

PubSocket.prototype.__proto__ = Socket.prototype;

/**
 * Send `msg` to all established peers.
 *
 * @param {Mixed} msg
 * @api public
 */

PubSocket.prototype.send = function(...args){
  var socks = this.socks;
  var socket;
  if (args[args.length - 1] instanceof net.Socket) socket = args[args.length - 1];
  var len = socket ? 1 : socks.length;
  var sock = socket;

  var buf = this.pack(args);

  for (var i = 0; i < len; i++) {
    if (!socket) sock = socks[i];
    if (sock.writable) sock.write(buf);
  }

  return this;
};
