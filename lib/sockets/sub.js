/**
 * Module dependencies.
 */

var debug = require('debug')('axon:sub');
var escape = require('escape-regexp');
var Message = require('amp-message');
var Socket = require('./sock');

const {Cache} = require('xcraft-core-transport');

/**
 * Expose `SubSocket`.
 */

module.exports = SubSocket;

/**
 * Initialize a new `SubSocket`.
 *
 * @api private
 */

function SubSocket() {
  Socket.call(this);
  this.subscriptions = {};
  this._subscriptionsSize = 0;
  this._cache = new Cache();
}

/**
 * Inherits from `Socket.prototype`.
 */

SubSocket.prototype.__proto__ = Socket.prototype;

/**
 * Check if this socket has subscriptions.
 *
 * @return {Boolean}
 * @api public
 */

SubSocket.prototype.hasSubscriptions = function() {
  return this._subscriptionsSize > 0;
};

/**
 * Check if any subscriptions match `topic`.
 *
 * @param {String} topic
 * @return {Boolean}
 * @api public
 */

SubSocket.prototype.matches = function(topic, ids) {
  return this._cache.matches(topic, ids);
};

/**
 * Message handler.
 *
 * @param {net.Socket} sock
 * @return {Function} closure(msg, mulitpart)
 * @api private
 */

SubSocket.prototype.onmessage = function(sock) {
  var subs = this.hasSubscriptions();
  var self = this;

  return function(buf) {
    var msg = new Message(buf);

    if (subs) {
      var topic = msg.args[0];
      if (!self.matches(topic)) {
        return debug('not subscribed to "%s"', topic);
      }
    }

    self.emit.apply(self, ['message'].concat(msg.args));
  };
};

SubSocket.prototype._unsub = function(id, reS) {
  this._cache.del(id, reS);
  delete this.subscriptions[reS];
  --this._subscriptionsSize;
};

/**
 * Subscribe with the given `re`.
 *
 * @param {RegExp|String} re
 * @return {RegExp}
 * @api public
 */

SubSocket.prototype.subscribe = function(re, ids = ['_']) {
  debug('subscribe to "%s"', re);
  const id = ids.length > 1 ? ids[1] : ids[0];

  re = toRegExp(re);
  const reS = re.toString();
  if (!this.subscriptions[reS]) {
    this._cache.set(id, reS, re);
    this.subscriptions[reS] = {
      regex: re,
      unsub: reS => this._unsub(id, reS),
    };
    ++this._subscriptionsSize;
  }
  return this.subscriptions[reS].regex;
};

/**
 * Unsubscribe with the given `re`.
 *
 * @param {RegExp|String} re
 * @api public
 */

SubSocket.prototype.unsubscribe = function(re) {
  debug('unsubscribe from "%s"', re);
  re = toRegExp(re);
  var s = re.toString();
  if (this.subscriptions[s]) {
    this.subscriptions[s].unsub(s);
  }
};

/**
 * Clear current subscriptions.
 *
 * @api public
 */

SubSocket.prototype.clearSubscriptions = function() {
  for (const sub in this.subscriptions) {
    this.subscriptions[sub].unsub(sub);
  }
  this.subscriptions = {};
  this._subscriptionsSize = 0;
  this._cache.clear();
};

/**
 * Subscribers should not send messages.
 */

SubSocket.prototype.send = function() {
  throw new Error('subscribers cannot send messages');
};

/**
 * Convert `str` to a `RegExp`.
 *
 * @param {String} str
 * @return {RegExp}
 * @api private
 */

function toRegExp(str) {
  if (str instanceof RegExp) return str;
  str = escape(str);
  str = str.replace(/\\\*/g, '(.+)');
  return new RegExp('^' + str + '$');
}
