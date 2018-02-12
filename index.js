// Adblock Radio module to buffer radio stream data and deliver it to end user
// according to its listening preferences.

"use strict";

var log = require("./log.js")("master");
var cp = require("child_process");
var findDataFiles = require("./findDataFiles.js");
var DlFactory = require("./DlFactory.js");
var abrsdk = require("adblockradio-sdk")();

const FETCH_METADATA = true;
const SAVE_AUDIO = false;
const SEG_DURATION = 10; // in seconds
const LISTEN_BUFFER = 30; // in seconds
var USE_ABRSDK = true;

var { config, getRadios, getUserConfig, insertRadio, removeRadio, toggleContent, getAvailableInactive } = require("./config.js");

var dl = [];
var updateDlList = function() {
	var playlistChange = false;

	// add missing sockets
	for (var i=0; i<config.radios.length; i++) {
		var alreadyThere = false;
		for (var j=0; j<dl.length; j++) {
			if (dl[j].country == config.radios[i].country && dl[j].name == config.radios[i].name) {
				alreadyThere = true;
				break;
			}
		}
		if (!alreadyThere && config.radios[i].enable) {
			config.radios[i].liveStatus = {};
			log.info("updateDlList: start " + config.radios[i].country + "_" + config.radios[i].name);
			dl.push(DlFactory(config.radios[i], {
				fetchMetadata: FETCH_METADATA,
				segDuration: SEG_DURATION,
				saveAudio: SAVE_AUDIO,
				cacheLen: config.user.cacheLen + config.user.streamInitialBuffer
			}));
			playlistChange = true;
		}
	}

	// remove obsolete ones.
	for (var j=dl.length-1; j>=0; j--) {
		var shouldBeThere = false;
		for (var i=0; i<config.radios.length; i++) {
			if (dl[j].country == config.radios[i].country && dl[j].name == config.radios[i].name) {
				shouldBeThere = true;
				break;
			}
		}
		if (!shouldBeThere) {
			log.info("updateDlList: stop " + dl[j].country + "_" + dl[j].name);
			dl[j].stopDl();
			dl.splice(j, 1);
			playlistChange = true;
		}
	}

	if (USE_ABRSDK && playlistChange) {
		var playlistArray = [];
		for (var i=0; i<config.radios.length; i++) {
			playlistArray.push(config.radios[i].country + "_" + config.radios[i].name);
		}
		abrsdk.sendPlaylist(playlistArray, config.user.token, function(err, validatedPlaylist) {
			if (err) {
				log.warn("abrsdk: sendPlaylist error = " + err);
			} else {
				if (playlistArray.length != validatedPlaylist.length) {
					log.warn("abrsdk: playlist not accepted. requested=" + JSON.stringify(playlistArray) + " validated=" + JSON.stringify(validatedPlaylist));
				} else {
					log.debug("abrsdk: playlist successfully updated");
				}
				abrsdk.setPredictionCallback(function(predictions) {
					var status, volume;
					for (var i=0; i<predictions.radios.length; i++) {
						switch (predictions.status[i]) {
							case abrsdk.statusList.STATUS_AD: status = "AD"; break;
							case abrsdk.statusList.STATUS_SPEECH: status = "SPEECH"; break;
							case abrsdk.statusList.STATUS_MUSIC: status = "MUSIC"; break;
							default: status = "not available";
						}
						// normalized volume to apply to the audio tag to have similar loudness between channels
						volume = Math.pow(10, (Math.min(abrsdk.GAIN_REF-predictions.gain[i],0))/20);
						// you can now plug the data to your radio player.
						//log.debug("abrsdk: " + predictions.radios[i] + " has status " + status + " and volume " + Math.round(volume*100)/100);
						var radio = getRadio(predictions.radios[i]);
						if (!radio || !radio.liveStatus || !radio.liveStatus.onClassPrediction) {
							log.error("abrsdk: cannot call prediction callback");
						} else {
							radio.liveStatus.onClassPrediction(status, volume);
						}
					}
				});
			}
		});
	}
}

if (USE_ABRSDK && config.user.email) {
	log.info("abrsdk: token detected for email " + config.user.email);
	abrsdk.connectServer(function(err) {
		if (err) {
			log.error("abrsdk: connection error: " + err + ". switch off sdk");
			USE_ABRSDK = false;
		}
		updateDlList();
	});
} else {
	updateDlList();
}

var http = require('http');
var express = require('express');
var app = express();
var server = http.createServer(app);
server.listen(9820, "localhost");

app.get('/config', function(request, response) {
	response.set({ 'Access-Control-Allow-Origin': '*' });
	response.json({ radios: getRadios(), user: getUserConfig() });
});

app.get('/config/radios/insert/:country/:name', function(request, response) {
	response.set({ 'Access-Control-Allow-Origin': '*' });
	var country = decodeURIComponent(request.params.country);
	var name = decodeURIComponent(request.params.name);
	insertRadio(country, name, function(err) {
		if (err) {
			log.error("/config/insert/" + country + "/" + name + ": err=" + err);
			response.writeHead(400);
			response.end("err=" + err);
		} else {
			response.writeHead(200);
			response.end("OK");
			updateDlList();
		}
	});
});

app.get('/config/radios/remove/:country/:name', function(request, response) {
	response.set({ 'Access-Control-Allow-Origin': '*' });
	var country = decodeURIComponent(request.params.country);
	var name = decodeURIComponent(request.params.name);
	removeRadio(country, name, function(err) {
		if (err) {
			log.error("/config/remove/" + country + "/" + name + ": err=" + err);
			response.writeHead(400);
			response.end("err=" + err);
		} else {
			response.writeHead(200);
			response.end("OK");
			updateDlList();
		}
	});
});

app.get('/config/radios/available', function(request, response) {
	response.set({ 'Access-Control-Allow-Origin': '*' });
	response.json(getAvailableInactive());
});

app.get('/config/radios/content/:country/:name/:type/:enable', function(request, response) {
	response.set({ 'Access-Control-Allow-Origin': '*' });
	var country = decodeURIComponent(request.params.country);
	var name = decodeURIComponent(request.params.name);
	var type = decodeURIComponent(request.params.type);
	var enable = decodeURIComponent(request.params.enable);
	toggleContent(country, name, type, enable, function(err) {
		if (err) {
			log.error("/config/radios/content/" + country + "/" + name + "/" + type + "/" + enable + ": err=" + err);
			response.writeHead(400);
			response.end("err=" + err);
		} else {
			response.writeHead(200);
			response.end("OK");
		}
	});
});

var getRadio = function(country, name) {
	if (name) { // both parameters used
		for (var j=0; j<config.radios.length; j++) {
			if (config.radios[j].country == country && config.radios[j].name == name) {
				return config.radios[j];
			}
		}
	} else { // only first parameter used
		for (var j=0; j<config.radios.length; j++) {
			if (config.radios[j].country + "_" + config.radios[j].name == country) {
				return config.radios[j];
			}
		}
	}
	return null;
}

var listenRequestDate = null;

app.get('/:action/:radio/:delay', function(request, response) {
	var action = request.params.action;
	var radio = decodeURIComponent(request.params.radio);
	var delay = request.params.delay;
	//log.debug("get: action=" + action + " radio=" + radio + " delay=" + delay);

	if (!getRadio(radio) || !getRadio(radio).enable) {
		response.writeHead(400);
		return response.end("radio not found");
	}

	switch(action) {
		case "listen":

			if (delay == "available") {
				response.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, must-revalidate' });
				response.json({ radio: radio, available: Math.floor(getRadio(radio).liveStatus.audioCache.getAvailableCache()-config.user.streamInitialBuffer)});
				return;
			}

			var state = { requestDate: new Date() }; //newRequest: true,
			listenRequestDate = state.requestDate;

			var radioObj = getRadio(radio);
			var initialBuffer = radioObj.liveStatus.audioCache.readLast(+delay+config.user.streamInitialBuffer,config.user.streamInitialBuffer);
			//log.debug("listen: readCursor set to " + radioObj.liveStatus.audioCache.readCursor);

			if (!initialBuffer) {
				log.error("/listen/" + radio + "/" + delay + ": initialBuffer not available");
				response.writeHead(400);
				return response.end("buffer not available");
			}

			log.info("listen: send initial buffer of " + initialBuffer.length + " bytes (" + getDeviceInfoExpress(request) + ")");

			switch(radioObj.codec) {
				case "AAC": response.set('Content-Type', 'audio/aacp'); break;
				case "MP3": response.set('Content-Type', 'audio/mpeg'); break;
				default: log.warn("unsupported codec: " + radioObj.codec);
			}

			response.write(initialBuffer);

			var finish = function() {
				clearInterval(listenTimer);
				response.end();
			}

			var listenTimer = setInterval(function() {
				var willWaitDrain = !response.write("");
				if (!willWaitDrain) { // detect congestion of stream
					sendMore();
				} else {
					log.debug("listenHandler: will wait for drain event");

					var drainCallback = function() {
						clearTimeout(timeoutMonitor);
						sendMore();
					}
					response.once("drain", drainCallback);
					var timeoutMonitor = setTimeout(function() {
						response.removeListener("drain", drainCallback);
						log.error("listenHandler: drain event not emitted, connection timeout");
						return finish();
					}, config.user.streamGranularity*1500);
				}
			}, 1000*config.user.streamGranularity);

			var sendMore = function() {
				/*if (state.newRequest) {
					listenRequestDate = state.requestDate;
					state.newRequest = false;
				} else*/
				if (listenRequestDate !== state.requestDate) {
					log.warn("request canceled because another one has been initiated");
					return finish();
				}
				var radioObj = getRadio(radio);
				if (!radioObj) {
					log.error("/listen/" + radio + "/" + delay + ": radio not available");
					return finish();
				}
				var audioCache = radioObj.liveStatus.audioCache;
				if (!audioCache) {
					log.error("/listen/" + radio + "/" + delay + ": audioCache not available");
					return finish();
				}
				var prevReadCursor = audioCache.readCursor;
				response.write(audioCache.readAmountAfterCursor(config.user.streamGranularity));
				//log.debug("listen: readCursor date=" + state.requestDate + " : " + prevReadCursor + " => " + audioCache.readCursor);
			}
			break;

		case "metadata":
			response.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, must-revalidate' });
			var radio = getRadio(radio);
			if (!radio) {
				log.error("/metadata/" + radio + "/" + delay + ": radio not available");
				response.writeHead(400);
				return response.end("radio not found");
			} else if (!radio.liveStatus) {
				log.error("/metadata/" + radio + "/" + delay + ": radio.liveStatus not available");
				response.writeHead(400);
				return response.end("radio not ready");
			} else if (!radio.liveStatus.metaCache) {
				log.error("/metadata/" + radio + "/" + delay + ": metadata not available");
				response.writeHead(400);
				return response.end("metadata not available");
			}
			response.json(radio.liveStatus.metaCache.read());
			break;

		default:
			response.writeHead(400);
			response.end("unknown route");
	}
});


var getIPExpress = function(request) {
	var ip = request.headers['x-forwarded-for']; // standard proxy header
	if (!ip) ip = request.headers['x-real-ip']; // nginx proxy header
	if (!ip) ip = request.connection.remoteAddress;
	return ip;
}

var getDeviceInfoExpress = function(request) {
    var agent = request.headers['user-agent'];
    return "login from IP " + getIPExpress(request) + " and UA " + agent;
}
