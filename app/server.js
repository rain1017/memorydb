'use strict';
var P = require('bluebird');
var minimist = require('minimist');
var path = require('path');
var fs = require('fs');
var forever = require('forever');
var child_process = require('child_process');

var pomeloLogger = require('pomelo-logger');
var logger = pomeloLogger.getLogger('memdb', __filename);

var startShard = function(opts){
	var Database = require('./database');
	var server = require('socket.io')();

	var db = new Database(opts);
	db.start().then(function(){
		logger.warn('server started');
	});

	server.on('connection', function(socket){
		var connId = db.connect();
		var remoteAddr = socket.conn.remoteAddress;

		socket.on('req', function(msg){
			logger.info('[%s] %s => %j', connId, remoteAddr, msg);
			var resp = {seq : msg.seq};

			P.try(function(){
				var method = msg.method;
				var args = [connId].concat(msg.args);
				return db[method].apply(db, args);
			})
			.then(function(ret){
				resp.err = null;
				resp.data = ret;
			}, function(err){
				resp.err = err.stack;
				resp.data = null;
			})
			.then(function(){
				socket.emit('resp', resp);
				var level = resp.err ? 'warn' : 'info';
				logger[level]('[%s] %s <= %j', connId, remoteAddr, resp);
			})
			.catch(function(e){
				logger.error(e.stack);
			});
		});

		socket.on('disconnect', function(){
			db.disconnect(connId);
			logger.info('%s disconnected', remoteAddr);
		});

		logger.info('%s connected', remoteAddr);
	});

	server.listen(opts.port);

	var _isShutingDown = false;
	var shutdown = function(){
		if(_isShutingDown){
			return;
		}
		_isShutingDown = true;

		return P.try(function(){
			server.close();

			return db.stop();
		})
		.catch(function(e){
			logger.error(e.stack);
		})
		.finally(function(){
			logger.warn('server closed');
			setTimeout(function(){
				process.exit(0);
			}, 200);
		});
	};

	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
};


if (require.main === module) {
	process.on('uncaughtException', function(err) {
		logger.error('Uncaught exception: %s', err.stack);
	});

	var argv = minimist(process.argv.slice(2));
	if(argv.help || argv.h){
		var usage = 'Usage: server.js [options]\n\n' +
					'Options:\n' +
					'  -c, --conf path 	Specify config file path (must with .json extension)\n' +
					'  -s, --shard shardId	Start specific shard\n' +
					'  -d, --daemon		Start as daemon\n' +
					'  -h, --help 		Display this help';
		console.log(usage);
		process.exit(0);
	}

	var searchPaths = [];
	var confPath = argv.conf || argv.c || null;
	if(confPath){
		searchPaths.push(confPath);
	}
	searchPaths = searchPaths.concat(['./memdb.json', '~/.memdb.json', '/etc/memdb.json']);
	var conf = null;
	for(var i=0; i<searchPaths.length; i++){
		if(fs.existsSync(searchPaths[i])){
			conf = require(path.resolve(searchPaths[i]));
			break;
		}
	}
	if(!conf){
		console.error('Error: config file not found! %j', searchPaths);
		process.exit(1);
	}

	var shardId = argv.s || argv.shard || null;

	if(conf.promise && conf.promise.longStackTraces){
		P.longStackTraces();
	}

	// Configure logger
	var loggerConf = conf.logger || {};

	var base = loggerConf.path || '/var/log/memdb';
	pomeloLogger.configure(path.join(__dirname, 'log4js.json'), {shardId : shardId, base : base});

	var level = loggerConf.level || 'INFO';
	pomeloLogger.setGlobalLogLevel(pomeloLogger.levels[level]);

	var shards = conf.shards || {};

	var isDaemon = argv.d || argv.daemon;

	if(!shardId){
		console.error('Please specify shardId with --shard');
		process.exit(1);

		// Main script, will start all shards via ssh
		// Object.keys(shards).forEach(function(shardId){
		// 	var host = shards[shardId].host;
		// 	console.info('start %s via ssh... (TBD)', shardId);
		// 	// TODO: start shard
		// });
	}
	else{
		// Start specific shard
		var shardConfig = shards[shardId];
		if(!shardConfig){
			console.error('Shard %s not exist in config', shardId);
			process.exit(1);
		}

		if(isDaemon){
			console.warn('Daemon mode is not supported now');
			isDaemon = false;
		}

		if(isDaemon && !argv.child){
			var args = process.argv.slice(2);
			args.push('--child');

			forever.startDaemon(__filename, {
				max : 1,
				slient : true,
				killTree : false,
				args : args,
			});
		}
		else{
			var opts = {
				shard : shardId,
				host : shardConfig.host,
				port : shardConfig.port,
				redis : conf.redis,
				backend : conf.backend,
				slave : shardConfig.slave,
				collections : conf.collections,
			};
			startShard(opts);
		}
	}
}
