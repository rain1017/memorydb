'use strict';

/* jshint ignore:start */

/*!
 * Module dependencies.
 */

var MongooseCollection = require('mongoose/lib/collection')
	, Collection = require('mongodb').Collection
	, STATES = require('mongoose/lib/connectionstate')
	, utils = require('mongoose/lib/utils')
	, util = require('util')
	, uuid = require('node-uuid')
	, mdb = require('../index')
	, logger = require('pomelo-logger').getLogger('memorydb', __filename)
	, Q = require('q');

/**
 * A [node-mongodb-native](https://github.com/mongodb/node-mongodb-native) collection implementation.
 *
 * All methods methods from the [node-mongodb-native](https://github.com/mongodb/node-mongodb-native) driver are copied and wrapped in queue management.
 *
 * @inherits Collection
 * @api private
 */

function NativeCollection () {
	this.collection = null;
	MongooseCollection.apply(this, arguments);
	this.id = uuid.v4();
}

/*!
 * Inherit from abstract Collection.
 */

NativeCollection.prototype.__proto__ = MongooseCollection.prototype;

/**
 * Called when the connection opens.
 *
 * @api private
 */

NativeCollection.prototype.onOpen = function () {
	var self = this;

	// always get a new collection in case the user changed host:port
	// of parent db instance when re-opening the connection.

	if (!self.opts.capped.size) {
		// non-capped
		return self.conn.db.collection(self.name, callback);
	}

	// capped
	return self.conn.db.collection(self.name, function (err, c) {
		if (err) return callback(err);

		// discover if this collection exists and if it is capped
		self.conn.db.collection( 'system.namespaces', function(err, namespaces) {
			var namespaceName = self.conn.db.databaseName + '.' + self.name;
			namespaces.findOne({ name : namespaceName }, function(err, doc) {
				if (err) {
					return callback(err);
				}
				var exists = !!doc;

				if (exists) {
					if (doc.options && doc.options.capped) {
						callback(null, c);
					} else {
						var msg = 'A non-capped collection exists with the name: '+ self.name +'\n\n'
										+ ' To use this collection as a capped collection, please '
										+ 'first convert it.\n'
										+ ' http://www.mongodb.org/display/DOCS/Capped+Collections#CappedCollections-Convertingacollectiontocapped'
						err = new Error(msg);
						callback(err);
					}
				} else {
					// create
					var opts = utils.clone(self.opts.capped);
					opts.capped = true;
					self.conn.db.createCollection(self.name, opts, callback);
				}
			});
		});
	});

	function callback (err, collection) {
		if (err) {
			// likely a strict mode error
			self.conn.emit('error', err);
		} else {
			self.collection = collection;
			MongooseCollection.prototype.onOpen.call(self);
		}
	};
};

/**
 * Called when the connection closes
 *
 * @api private
 */

NativeCollection.prototype.onClose = function () {
	MongooseCollection.prototype.onClose.call(this);
};

NativeCollection.prototype.findOneInMdb = function(id, cb) {
	logger.debug('findOneInMdb %s: %j', this.name, arguments);
	var conn = mdb.autoConnect();
	var coll = conn.collection(this.name);
	Q.fcall(function(){
		return coll.find(id);
	}).nodeify(cb);
};

NativeCollection.prototype.findByIndexInMdb = function(field, value, cb){
	logger.debug('findByIndexInMdb %s: %j', this.name, arguments);
	var conn = mdb.autoConnect();
	var coll = conn.collection(this.name);
	Q.fcall(function(){
		return coll.findByIndex(field, value);
	}).nodeify(cb);
};

NativeCollection.prototype.insert = function(docs, opts, cb) {
	logger.debug('insert %s: %j', this.name, arguments);

	var conn = mdb.autoConnect();
	var coll = conn.collection(this.name);
	if(typeof docs !== 'array') {
		docs = [docs];
	}
	Q.all(docs.map(function(doc){
		return Q.fcall(function(){
			return coll.insert(doc._id, doc);
		});
	})).nodeify(cb);
};


NativeCollection.prototype.checkSelector = function(selector, cb) {
	if(!selector || Object.keys(selector).length !== 1 || !selector._id) {
		cb(new Error(util.format('unsupported selector: %j', selector)));
		return false;
	}
	return true;
};


NativeCollection.prototype.checkUpdate = function(updateDoc, cb) {
	if(!updateDoc || Object.keys(updateDoc).length !== 1 || !updateDoc['$set']) {
		cb(new Error(util.format('unsupported update doc: %j', updateDoc)));
		return false;
	}
	return true;
};


NativeCollection.prototype.remove = function(selector, opts, cb) {
	logger.debug('remove %s: %j', this.name, arguments);
	if(!this.checkSelector(selector, cb)) return;

	var conn = mdb.autoConnect();
	var coll = conn.collection(this.name);
	Q.fcall(function(){
		return coll.remove(selector._id);
	}).nodeify(cb);
};


NativeCollection.prototype.update = function(selector, doc, opts, cb) {
	logger.debug('update %s: %j', this.name, arguments);

	if(!this.checkSelector(selector, cb)) return;
	if(!this.checkUpdate(doc, cb)) return;

	var conn = mdb.autoConnect();
	var coll = conn.collection(this.name);
	Q.fcall(function(){
		return coll.update(selector._id, doc['$set']);
	}).nodeify(cb);
};


NativeCollection.prototype.save = function(doc, opts, cb) {
	logger.debug('save %s: %j', this.name, arguments);
	throw new Error('Collection#save unimplemented by driver');
};


NativeCollection.prototype.findAndModify = function() {
	throw new Error('Collection#findAndModify unimplemented by driver');
};


NativeCollection.prototype.findAndRemove = function() {
	throw new Error('Collection#findAndRemove unimplemented by driver');
};


/*!
 * Copy the collection methods and make them subject to queues
 */

for (var i in Collection.prototype) {

	var unimplemented = ['findAndModify', 'findAndRemove'];
	if (unimplemented.indexOf(i) != -1) {
		continue;
	}

	(function(i){

		var needReplace = ['insert', 'remove', 'save', 'update'];
		var funcName = i;
		if (needReplace.indexOf(i) != -1) {
			funcName = 'actual' + i.substring(0,1).toUpperCase() + i.substring(1);
		}

		NativeCollection.prototype[funcName] = function () {
			if (this.buffer) {
				this.addQueue(i, arguments);
				return;
			}

			var collection = this.collection
				, args = arguments
				, self = this
				, debug = self.conn.base.options.debug;
			logger.debug('nativecollection[%s][%s] %s: %j', this.id, this.name, funcName, arguments);
			if (debug) {
				if ('function' === typeof debug) {
					debug.apply(debug
						, [self.name, i].concat(utils.args(args, 0, args.length-1)));
				} else {
					console.error('\x1B[0;36mMongoose:\x1B[0m %s.%s(%s) %s %s %s'
						, self.name
						, i
						, print(args[0])
						, print(args[1])
						, print(args[2])
						, print(args[3]))
				}
			}

			return collection[i].apply(collection, args);
		};
	})(i);
}


/*!
 * Debug print helper
 */

function print (arg) {
	var type = typeof arg;
	if ('function' === type || 'undefined' === type) return '';
	return format(arg);
}

/*!
 * Debug print helper
 */

function format (obj, sub) {
	var x = utils.clone(obj);
	if (x) {
		if ('Binary' === x.constructor.name) {
			x = '[object Buffer]';
		} else if ('ObjectID' === x.constructor.name) {
			var representation = 'ObjectId("' + x.toHexString() + '")';
			x = { inspect: function() { return representation; } };
		} else if ('Date' === x.constructor.name) {
			var representation = 'new Date("' + x.toUTCString() + '")';
			x = { inspect: function() { return representation; } };
		} else if ('Object' === x.constructor.name) {
			var keys = Object.keys(x)
				, i = keys.length
				, key
			while (i--) {
				key = keys[i];
				if (x[key]) {
					if ('Binary' === x[key].constructor.name) {
						x[key] = '[object Buffer]';
					} else if ('Object' === x[key].constructor.name) {
						x[key] = format(x[key], true);
					} else if ('ObjectID' === x[key].constructor.name) {
						;(function(x){
							var representation = 'ObjectId("' + x[key].toHexString() + '")';
							x[key] = { inspect: function() { return representation; } };
						})(x)
					} else if ('Date' === x[key].constructor.name) {
						;(function(x){
							var representation = 'new Date("' + x[key].toUTCString() + '")';
							x[key] = { inspect: function() { return representation; } };
						})(x)
					} else if (Array.isArray(x[key])) {
						x[key] = x[key].map(function (o) {
							return format(o, true)
						});
					}
				}
			}
		}
		if (sub) return x;
	}

	return require('util')
		.inspect(x, false, 10, true)
		.replace(/\n/g, '')
		.replace(/\s{2,}/g, ' ')
}

/**
 * Retreives information about this collections indexes.
 *
 * @param {Function} callback
 * @method getIndexes
 * @api public
 */

NativeCollection.prototype.getIndexes = NativeCollection.prototype.indexInformation;

/*!
 * Module exports.
 */

module.exports = NativeCollection;