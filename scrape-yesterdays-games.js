"use strict"

//
// USAGE
// To scrape yesterday's games: node scrape-game.js
//

var request = require("request");
var pg = require("pg");
var async = require("async");
var _ = require("lodash");
var url = require("url");

// Contexts and stats to record
var recordedScoreSits = ["-3", "-2", "-1", "0", "1", "2", "3"];
var recordedStrengthSits = ["ev5", "pp", "sh", "penShot", "noOwnG", "noOppG", "other"];
var recordedStats = ["toi", "ig", "is", "ibs", "ims", "ia1", "ia2", "blocked", "gf", "ga", "sf", "sa", "bsf", "bsa", "msf", "msa", "foWon", "foLost", "ofo", "dfo", "nfo", "penTaken", "penDrawn", "cfOff", "caOff"];

// Instantiate database client
var params = url.parse(process.env.HEROKU_POSTGRESQL_COPPER_URL);
var authParams = params.auth.split(":");
var client = new pg.Client({
	user: authParams[0],
	password: authParams[1],
	host: params.hostname,
	port: params.port,
	database: params.pathname.split("/")[1],
	ssl: true
});
client.connect();

//
// To scrape yesterday's games, get yesterday's date in UTC (EST is UTC-5, EDT is UTC-4)
//

var today = new Date();
var yesterday = new Date(new Date().setDate(today.getDate() - 1));
var yyyy = yesterday.getFullYear();
var mm = yesterday.getMonth() + 1;
var dd = yesterday.getDate();

//
// Get the season corresponding to yesterday's games
// This is the year in which the season starts (2016 for the 2016-2017 season)
//

var season = yyyy;
if (mm >= 1 && mm <= 8) {
	season--;
}

//
// Call api to get a list of game objects
//

var reqDateStr = yyyy + "-" + mm + "-" + dd;
var reqUrl = "https://statsapi.web.nhl.com/api/v1/schedule?startDate=" + reqDateStr + "&endDate=" + reqDateStr;
var gameObjects = [];
request(reqUrl, function (error, response, body) {
	if (!error && response.statusCode == 200) {
		gameObjects = JSON.parse(body);
		gameObjects = gameObjects.dates[0].games;
		getGameIds();
	} else {
		console.log("Unable to get game list json: " + error);
	}
});

//
// From the list of game objects, get the game id of each game
// In the game objects, the game id format is "2016020001" - we want "20001"
//

var gameIds = [];
function getGameIds() {
	gameObjects.forEach(function(g) {
		var gId = +g["gamePk"].toString().substring(5);
		gameIds.push(gId);
	});
	console.log("Starting to scrape yesterday's games (" + reqDateStr + "): " + gameIds.toString());
	startScrape();
}

//
// Loop through each gameId one at a time aysnchronously
//

var unfinishedGameIds = [];	// Log games that were not scraped because they weren't final
var noInputGameIds = [];	// Log games that we were unable to get input jsons for

function startScrape() {
	async.eachSeries(gameIds, function(gId, callback) {
		// Wait a bit between games to avoid overloading api and database
		setTimeout(function() {
			getData(gId);
			callback(); // Callback to start next iteration
		}, 3000);
	}, function(err) {
		// Callback when all iterations finish
		if (err) {
			return next(err);
		}
		// Wait a bit for the last iteration to finish before closing connection
		setTimeout(function() {
			// Remove duplicates from noInputGameIds before logging results
			noInputGameIds = _.uniq(noInputGameIds);
			console.log("Finished scraping yesterday's games (" + reqDateStr + "): " + gameIds.toString()
				+ " -- State not final: " + unfinishedGameIds.toString()
				+ " -- Data unavailable: " + noInputGameIds.toString());
			// Clear cached api responses on server
			var reqUrl = "http://datarink.herokuapp.com/api/cache/clear";
			request(reqUrl, function (error, response, body) {
				if (!error && response.statusCode === 200) {
					console.log("apicache cleared: " + body);
					cacheApis();
				} else {
					console.log("Failed to clear apicache: " + error);
				}
			});
			// Close connection
			client.end();
		}, 9000);
	});
}

//
// Request apis that we want cached
//

function cacheApis() {
	setTimeout(function() {
		console.log("Requesting apis to cache them...");
		var apiRoot = "http://datarink.herokuapp.com/api/";
		var endpoints = ["highlights", "teams", "players", "players/breakpoints"];
		var tricodes = ["car", "cbj", "njd", "nyi", "nyr", "phi",
			"pit", "wsh", "bos", "buf", "det", "fla",
			"mtl", "ott", "tbl", "tor", "chi", "col",
			"dal", "min", "nsh", "stl", "wpg", "ana",
			"ari", "cgy", "edm", "lak", "sjs", "van"];
		tricodes.forEach(function(t) {
			endpoints.push("lines/" + t);
		});
		endpoints.forEach(function(endpoint, i) {
			setTimeout(function() {
				var route = apiRoot + endpoint;
				request(
					{	uri: route,
						method: "GET"
					},
					function (error, response, body) {
						if (!error && response.statusCode === 200) {
							console.log("Loaded " + route);
						} else {
							console.log("Failed to load " + route);
						}
					}
				);
			}, i * 6000);
		});
	}, 90000);
}

//
// Get raw data for gId, then call function to process the data
//

function getData(gId, callback) {
	var urlId = season * 1000000 + gId;
	var pbpJson;
	var shiftJson;

	// Download pbp and shift jsons
	var pbpJsonUrl = "https://statsapi.web.nhl.com/api/v1/game/" + urlId  + "/feed/live";
	var shiftJsonUrl = "http://www.nhl.com/stats/rest/shiftcharts?cayenneExp=gameId=" + urlId;

	// Download pbp json
	request(pbpJsonUrl, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			pbpJson = JSON.parse(body);
			processData(gId, pbpJson, shiftJson);
		} else {
			console.log("Game " + gId + ": Unable to get pbp json: " + error);
			noInputGameIds.push(gId);
		}
	});

	// Download shift json
	request(shiftJsonUrl, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			shiftJson = JSON.parse(body);
			processData(gId, pbpJson, shiftJson);
		} else {
			console.log("Game " + gId + ": Unable to get shift json: " + error);
			noInputGameIds.push(gId);
		}
	});
}

//
// Process pbp and shift data for a specified game
//

function processData(gId, pbpJson, shiftJson) {

	// Only start processing when both pbp and shift jsons are loaded
	if (!pbpJson || !shiftJson) {
		console.log("Game " + gId + ": Waiting for both pbp and shift jsons to be loaded");
		return;
	}
	console.log("Game " + gId + ": Processing pbp and shift jsons");

	// Only process game results that are final
	if (pbpJson.gameData.status.abstractGameState.toLowerCase() !== "final") {
		console.log("Game " + gId + ": Results are not final");
		unfinishedGameIds.push(gId);
		return;
	}

	// Variables for output
	var gameDate = pbpJson.gameData.datetime.dateTime;	// A string in UTC time: "2016-02-20T00:00:00Z"
	var maxPeriod = 0;		// Period in which the game ended (not 0-based)
	var maxTime = 0;		// Time at which the game ended in the last period (maxPeriod)
	var eventData = [];		// An array of event objects
	var playerData = {};	// An associative array of objects, using playerId (as strings) as keys
	var teamData = {		// An associative array of objects, using "away" and "home" as keys
		away: {},
		home: {}
	};
	var teamStrSitTimes;	// An associative array of objects to store when each team played at a ev5, pp, or sh. Search for 'teamStrSitTimes = {};' to see how it's intialized

	//
	// Prepare team output
	//

	var teamsObject = pbpJson.gameData.teams;
	["away", "home"].forEach(function(v) {

		teamData[v]["tricode"] = teamsObject[v]["triCode"].toLowerCase();

		// Initialize contexts and stats
		recordedStrengthSits.forEach(function(str) {
			teamData[v][str] = {};
			recordedScoreSits.forEach(function(sc) {
				teamData[v][str][sc] = {};
				recordedStats.forEach(function(stat) {
					teamData[v][str][sc][stat] = 0;
				});
			});
		});
	});

	//
	// Prepare player output
	// Loop through the properties in pbpJson.gameData.players
	//

	var gameDataPlayersObject = pbpJson.gameData.players;
	var boxScoreTeamsObject = pbpJson.liveData.boxscore.teams;
	for (var prop in gameDataPlayersObject) {

		// "prop" is formatted as "ID" + playerId
		// Check if the property is an actual property of the players object, and doesn't come from the prototype
		if (!gameDataPlayersObject.hasOwnProperty(prop)) {
			continue;
		}

		var pId = gameDataPlayersObject[prop]["id"].toString();
		playerData[pId] = {};
		playerData[pId]["first"] = gameDataPlayersObject[prop]["firstName"];
		playerData[pId]["last"] = gameDataPlayersObject[prop]["lastName"];
		playerData[pId]["shifts"] = [];

		// Record the player's team, venue, position, and jersey number
		// Some players are listed with position "n/a" - convert this to "na"
		["away", "home"].forEach(function(v) {
			if (boxScoreTeamsObject[v]["players"].hasOwnProperty(prop)) {
				playerData[pId]["position"] = boxScoreTeamsObject[v]["players"][prop]["position"]["code"].toLowerCase().replace("/", "");
				playerData[pId]["jersey"] = +boxScoreTeamsObject[v]["players"][prop]["jerseyNumber"];
				playerData[pId]["venue"] = v;
				playerData[pId]["team"] = teamData[v]["tricode"];
			}
		});

		// Initialize contexts and stats
		recordedStrengthSits.forEach(function(str) {
			playerData[pId][str] = {};
			recordedScoreSits.forEach(function(sc) {
				playerData[pId][str][sc] = {};
				recordedStats.forEach(function(stat) {
					playerData[pId][str][sc][stat] = 0;
				});
			});
		});
	}

	//
	// Prepare events output
	// eventsObject is an array of event objects
	//

	var isPlayoffs = gId >= 30000;
	var recordedEvents = ["goal", "shot", "missed_shot", "blocked_shot", "faceoff", "penalty"];
	var eventsObject = pbpJson.liveData.plays.allPlays;

	eventsObject.forEach(function(ev) {

		var period = ev["about"]["period"];
		var type = ev["result"]["eventTypeId"].toLowerCase();

		// Store period and time at which game ended
		// For SO, the json's game_end will have period=5, time=0
		if (type === "game_end") {
			maxPeriod = period;
			maxTime = toSecs(ev["about"]["periodTime"]);
		}

		// Skip irrelevant events and skip shootout events
		if (recordedEvents.indexOf(type) < 0) {
			return;
		} else if (!isPlayoffs && period > 4) {
			return;
		}

		// Create object to store event information
		var newEv = {};
		newEv["id"] = ev["about"]["eventIdx"];
		newEv["period"] = period;
		newEv["time"] = toSecs(ev["about"]["periodTime"]);
		newEv["description"] = ev["result"]["description"];
		newEv["type"] = type;
		newEv["subtype"] = "";
		if (ev["result"].hasOwnProperty("secondaryType")) {
			newEv["subtype"] = ev["result"]["secondaryType"].toLowerCase();
		}

		// Record penalty-specific information
		if (type === "penalty") {
			newEv["penSeverity"] = ev["result"]["penaltySeverity"].toLowerCase();
			newEv["penMins"] = ev["result"]["penaltyMinutes"];
		}

		// Record location information
		if (ev.hasOwnProperty("coordinates")) {
			if (ev["coordinates"].hasOwnProperty("x") && ev["coordinates"].hasOwnProperty("y")) {

				newEv["locX"] = ev["coordinates"]["x"];
				newEv["locY"] = ev["coordinates"]["y"];

				// Convert coordinates into a zone (from the home team's perspective)
				// Determine whether the home team's defensive zone has x < 0 or x > 0
				// Starting in 2014-2015, teams switch ends prior to the start of OT in the regular season

				// For even-numbered periods (2, 4, etc.), the home team's defensive zone has x > 0
				var hDefZoneIsNegX = period % 2 == 0 ? false : true;

				// Redlines are located at x = -25 and +25
				if (newEv["locX"] >= -25 && newEv["locX"] <= 25) {
					newEv["hZone"] = "n";
				} else if (hDefZoneIsNegX) {
					if (newEv["locX"] < -25) {
						newEv["hZone"] = "d";
					} else if (newEv["locX"] > 25) {
						newEv["hZone"] = "o";
					}
				} else if (!hDefZoneIsNegX) {
					if (newEv["locX"] < -25) {
						newEv["hZone"] = "o";
					} else if (newEv["locX"] > 25) {
						newEv["hZone"] = "d";
					}
				}
			}
		}

		// Record players and their roles, excluding goalies
		// For goals, the json simply lists "assist" for both assisters - enhance this to "assist1" and "assist2"
		if (ev.hasOwnProperty("players")) {
			newEv["roles"] = [];
			ev["players"].forEach(function(p) {
				var pId = p["player"]["id"];
				var role = p["playerType"].toLowerCase();
				if (type === "goal") {
					// Assume the scorer is always listed first, the primary assister listed second, and secondary assister listed third
					if (role === "assist" && pId === ev["players"][1]["player"]["id"]) {
						role = "assist1";
					} else if (role === "assist" && pId === ev["players"][2]["player"]["id"]) {
						role = "assist2";
					}
				}
				if (role !== "goalie") {
					newEv["roles"].push({
						player: pId,
						role: role
					});
				}
			});
		}

		// Record team and venue information
		if (ev.hasOwnProperty("team")) {
			newEv["team"] = ev["team"]["triCode"].toLowerCase();
			newEv["venue"] = newEv["team"] === teamData["away"]["tricode"] ? "away" : "home";

			// For blocked shots, the json lists the blocking team as the team - we want the shooting team instead
			if (type === "blocked_shot") {
				newEv["team"] = newEv["team"] === teamData["away"]["tricode"] ? teamData["home"]["tricode"] : teamData["away"]["tricode"];
				newEv["venue"] = newEv["team"] === teamData["away"]["tricode"] ? "away" : "home";
			}
		}

		// Record the home and away scores when the event occurred
		// For goals, the json includes the goal itself in the score situation, but it's more accurate to say that the first goal was scored when it was 0-0
		newEv["score"] = [ev["about"]["goals"]["away"], ev["about"]["goals"]["home"]];
		if (type === "goal") {
			if (newEv["venue"] === "away") {
				newEv["score"][0]--;
			} else if (newEv["venue"] === "home") {
				newEv["score"][1]--;
			}
		}

		// Store event
		eventData.push(newEv);

	}); // Done looping through eventsObject

	// Flag penalty shots by appending {penalty_shot} to the description
	// To find penalty shots, find penalties with severity "penalty shot", then get the next event
	// Since eventData only contains faceoffs, penalties, and shots, treat the first shot after the penalty as the penalty shot
	eventData.forEach(function(ev, i) {
		if (ev["type"] === "penalty") {
			if (ev["penSeverity"] === "penalty shot") {
				var j = 1;
				var isPenShotFound = false;
				while (i + j < eventData.length && !isPenShotFound) {
					if (["goal", "shot", "missed_shot", "blocked_shot"].indexOf(eventData[i + j]["type"]) >= 0) {
						eventData[i + 1]["description"] += " {penalty_shot}"
						isPenShotFound = true;
					} else {
						j++;
					}
				}
			}
		}
	});

	//
	//
	// Process shift data
	//
	//

	// Append shifts to the player objects in playerData - skip shootout shifts
	// Also skip shifts that list a player who isn't already in playerData
	// In 2016020107, Schneider has shifts in the shift json, but isn't listed anywhere in the pbp or box score page
	shiftJson = shiftJson["data"];
	shiftJson.forEach(function(sh) {
		if ((sh["period"] <= 4 && !isPlayoffs) || isPlayoffs) {
			if (playerData.hasOwnProperty(sh["playerId"].toString())) {
				playerData[sh["playerId"].toString()]["shifts"].push({
					period: sh["period"],
					start: toSecs(sh["startTime"]),
					end: toSecs(sh["endTime"])
				});
			}
		}
	});

	// Initalize object to store when each team played at ev5, pp, or sh
	teamStrSitTimes = {};
	for (var prd = 1; prd <= maxPeriod; prd++) {
		teamStrSitTimes[prd.toString()] = {
			away: {
				ev5: [],
				pp: [],
				sh: []
			},
			home: {
				ev5: [],
				pp: [],
				sh: []
			}
		}
	}

	// Process shifts, one period at a time
	for (var prd = 1; prd <= maxPeriod; prd++) {

		// Set the period duration
		// For the final period, use the maxPeriod and maxTime we got from the game_end event
		var prdDur = 20 * 60;
		if (prd === maxPeriod) {
			prdDur = maxTime;
		} else if (prd === 4 && !isPlayoffs) {
			prdDur = 5 * 60;
		}

		// Initialize array to store information about each 1-second interval
		// A 4-second period will have 4 intervals: 0:00-0:01, 0:01-0:02, 0:02-0:03, 0:03-0:04
		var intervals = [];
		for (var t = 0; t < prdDur; t++) {
			// Use idx0 for away; idx1 for away
			var interval = {
				start: t,
				end: t + 1,
				goalies: [[], []],
				skaters: [[], []],
				strengthSits: ["", ""],
				score: [0, 0],
				scoreSits: ["", ""]
			};
			intervals.push(interval);
		}

		// Record on-ice players during each interval
		// If a shift has start=0 and end=2, then add the player to 0:00-0:01, 0:01-0:02, but not 0:02-0:03
		for (var key in playerData) {

			// Check if the property is an actual property of the players object, and doesn't come from the prototype
			if (!playerData.hasOwnProperty(key)) {
				continue;
			}

			// Get player's venue, position, and shifts in the period
			var venueIdx = playerData[key]["venue"] === "away" ? 0 : 1;
			var positionToUpdate = playerData[key]["position"] === "g" ? "goalies" : "skaters";
			var shiftsInPrd = playerData[key]["shifts"].filter(function(d) { return d["period"] === prd; });

			// Loop through each of the player's shifts and add them to the corresponding intervals
			shiftsInPrd.forEach(function(sh) {
				var intervalsToUpdate = intervals.filter(function(d) { return d["start"] >= sh["start"] && d["end"] <= sh["end"]; });
				intervalsToUpdate.forEach(function(interval) {
					interval[positionToUpdate][venueIdx].push(key);
				});
			});
		}

		// Record strength situation during each interval
		intervals.forEach(function(interval) {
			interval["strengthSits"] = getStrengthSits({
				goalieCounts: [interval["goalies"][0].length, interval["goalies"][1].length],
				skaterCounts: [interval["skaters"][0].length, interval["skaters"][1].length]
			});
			// Record start time in teamStrSitTimes if the teams were playing at ev5, pp, or sh
			if (interval["strengthSits"][0] === "ev5" || interval["strengthSits"][0] === "pp" || interval["strengthSits"][0] === "sh") {
				teamStrSitTimes[prd]["away"][interval["strengthSits"][0]].push(interval["start"]);
				teamStrSitTimes[prd]["home"][interval["strengthSits"][1]].push(interval["start"]);
			}
		});

		// For goals scored in previous period, add the goal to every interval of the current period
		// For goals in the current period:
		// 		If goal time = 0: increment 0:00-0:01 and onwards
		// 		If goal time = 1: increment 0:01-0:02 and onwards
		// 		If goal time = 2: increment 0:02-0:03 and onwards
		// 		If goal time = 3 and the period is 3s long: there are no intervals to increment
		var goals = eventData.filter(function(d) { return d["type"] === "goal" && d["period"] <= prd; });
		goals.forEach(function(g) {

			var venueIdx = g["venue"] === "away" ? 0 : 1;

			if (g["period"] < prd) {
				intervals.forEach(function(interval) {
					interval["score"][venueIdx]++;
				});
			} else {
				var intervalsToIncrement = intervals.filter(function(interval) { return interval["start"] >= g["time"]; });
				intervalsToIncrement.forEach(function(interval) {
					interval["score"][venueIdx]++;
				});
			}
		});

		// Record each team's score situation for each interval
		intervals.forEach(function(interval) {
			interval["scoreSits"] = getScoreSits(interval["score"][0], interval["score"][1]);
		});

		//
		// Increment toi for each score and strength situation for players and teams
		//

		intervals.forEach(function(interval) {
			["away", "home"].forEach(function(venue, venueIdx) {
				incrementOnIceStats(playerData, interval["skaters"][venueIdx], interval["goalies"][venueIdx], interval["strengthSits"][venueIdx], interval["scoreSits"][venueIdx], "toi", 1);
				teamData[venue][interval["strengthSits"][venueIdx]][interval["scoreSits"][venueIdx]]["toi"]++;
			});
		});

		//
		// Append on-ice players for each event
		//

		var evsInPrd = eventData.filter(function(d) { return d["period"] === prd; });
		evsInPrd.forEach(function(ev) {

			// If a faceoff occurred at 0:05, then attribute it to all players on ice during interval 0:05-0:06
			// If a shot or penalty occurred at 0:05, then attribute it to all players on ice during interval 0:04-0:05
			// Special case: If a shot occurred at 0:00, then attribute it to all players on ice during interval 0:00-0:01
			// 		This occurred in period1, time0 of 2016020078 (eventIdx 3)
			// Special case: If a faceoff occurred at 20:00 (at the end of of the period), then attribute it to all players on ice during interval 19:59-20:00
			var interval;
			if (ev["type"] === "faceoff" && ev["time"] === prdDur) {
				interval = intervals.find(function(d) { return d["end"] === ev["time"]; });
			} else if (ev["type"] === "faceoff"
				|| (["blocked_shot", "missed_shot", "shot"].indexOf(ev["type"]) >= 0 && ev["time"] === 0)) {
				interval = intervals.find(function(d) { return d["start"] === ev["time"]; });
			} else {
				interval = intervals.find(function(d) { return d["end"] === ev["time"]; });
			}

			// Record on-ice skaters and goalies for event
			ev["skaters"] = [[], []];
			ev["goalies"] = [[], []];
			["away", "home"].forEach(function(venue, venueIdx) {
				interval["skaters"][venueIdx].forEach(function(pId) {
					ev["skaters"][venueIdx].push(pId);
				});
				interval["goalies"][venueIdx].forEach(function(pId) {
					ev["goalies"][venueIdx].push(pId);
				});
			});
		});
	} // Done looping through a game's periods

	//
	// For each event, increment player and team stats
	//

	eventData.forEach(function(ev) {

		// Get score and strength situations
		var scoreSits = getScoreSits(ev["score"][0], ev["score"][1]);
		var strengthSits = getStrengthSits({
			goalieCounts: [ev["goalies"][0].length, ev["goalies"][1].length],
			skaterCounts: [ev["skaters"][0].length, ev["skaters"][1].length]
		});

		// Update strengthSits for penalty shots
		if (ev["description"].indexOf("{penalty_shot}") > 0) {
			strengthSits = ["penShot", "penShot"];
		}

		// Increment individual stats
		ev["roles"].forEach(function(r) {
			var iStat = [];
			if (r["role"] === "winner") {
				iStat = ["foWon"];
			} else if (r["role"] === "loser") {
				iStat = ["foLost"];
			} else if (r["role"] === "blocker") {
				iStat = ["blocked"];
			} else if (r["role"] === "scorer") {
				iStat = ["ig", "is"];
			} else if (r["role"] === "assist1") {
				iStat = ["ia1"];
			} else if (r["role"] === "assist2") {
				iStat = ["ia2"];
			} else if (r["role"] === "penaltyon") {
				iStat = ["penTaken"];
			} else if (r["role"] === "drewby") {
				iStat = ["penDrawn"];
			} else if (r["role"] === "shooter") {
				if (ev["type"] === "shot") {
					iStat = ["is"];
				} else if (ev["type"] === "blocked_shot") {
					iStat = ["ibs"];
				} else if (ev["type"] === "missed_shot") {
					iStat = ["ims"];
				}
			}
			var playerVenueIdx = 0;
			if (playerData[r["player"].toString()]["venue"] === "home") {
				playerVenueIdx = 1;
			}
			iStat.forEach(function(is) {
				playerData[r["player"].toString()][strengthSits[playerVenueIdx]][scoreSits[playerVenueIdx]][is]++;
			});
		});

		// Increment team and on-ice stats
		["away", "home"].forEach(function(v, vIdx) {

			var suffix = ev["venue"] === v ? "f" : "a";
			var penSuffix = ev["venue"] === v ? "Taken" : "Drawn";
			var foSuffix = ev["venue"] === v ? "Won" : "Lost";

			if (ev["type"] === "goal") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["g" + suffix]++;
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["s" + suffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "g" + suffix, 1);
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "s" + suffix, 1);
			} else if (ev["type"] === "shot") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["s" + suffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "s" + suffix, 1);
			} else if (ev["type"] === "blocked_shot") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["bs" + suffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "bs" + suffix, 1);
			} else if (ev["type"] === "missed_shot") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["ms" + suffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "ms" + suffix, 1);
			} else if (ev["type"] === "faceoff") {
				// Increment zone faceoffs
				var zone = ev["hZone"];
				if (v === "away") {
					if (zone === "d") {
						zone = "o";
					} else if (zone === "o") {
						zone = "d";
					}
				}
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]][zone + "fo"]++;
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["fo" + foSuffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], zone + "fo", 1);
			} else if (ev["type"] === "penalty") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["pen" + penSuffix]++;
			}
		});
	});

	//
	// Increment off-ice stats
	//

	for (var key in playerData) {
		if (!playerData.hasOwnProperty(key)) {
			continue;
		}
		recordedStrengthSits.forEach(function(strSit) {
			recordedScoreSits.forEach(function(scSit) {
				var playerVenue = playerData[key]["venue"];
				["f", "a"].forEach(function(suffix) {
					var playerCorsi = playerData[key][strSit][scSit]["s" + suffix] + playerData[key][strSit][scSit]["ms" + suffix] + playerData[key][strSit][scSit]["bs" + suffix];
					var teamCorsi = teamData[playerVenue][strSit][scSit]["s" + suffix] + teamData[playerVenue][strSit][scSit]["ms" + suffix] + teamData[playerVenue][strSit][scSit]["bs" + suffix]
					playerData[key][strSit][scSit]["c" + suffix + "Off"] = teamCorsi - playerCorsi;
				});
			});
		});
	}

	//
	// Convert the teamStrSitTimes array of timepoints into ranges: [1,2,3,7,8,9] becomes [[1,3], [7,9]]
	//

	for (var prd = 1; prd <= maxPeriod; prd++) {
		["away", "home"].forEach(function(v) {
			["ev5", "pp", "sh"].forEach(function(sit) {

				// Sort the timepoints and refer to it as "times" for convenience
				teamStrSitTimes[prd.toString()][v][sit].sort(function(a, b) { return a - b; });
				var times = teamStrSitTimes[prd.toString()][v][sit];

				// Iterate through the timepoints and record [start, end] pairs
				var ranges = [];
				var start;
				var end;
				for (var i = 0; i < times.length; i++) {
					if (i === 0) {
						start = times[i];
					} else if (times[i] - times[i - 1] > 1) {
						// If the difference between the current timepoint and the previous timepoint is more than 1s, then end the interval and start a new one
						// Add 1s to the end time to match how shifts are stored: playerA's shift spans :00-:10, playerB takes his place at :10-:15. Goalies play 0-1200s.
						end = times[i - 1] + 1;
						ranges.push([start, end]);
						start = times[i];
					} else if (i === times.length - 1) {
						// If we're at the last timepoint, then end the interval
						end = times[i] + 1;
						ranges.push([start, end]);
					}
				}

				// Replace original array of timepoints with new array of ranges
				teamStrSitTimes[prd.toString()][v][sit] = ranges;
			});
		});
	}

	//
	//
	// Write output to database
	//
	//

	console.log("Game " + gId + ": Writing results to database");

	// Delete existing records with the same season and gameId
	["game_stats", "game_shifts", "game_events", "game_rosters", "game_results", "game_strength_situations"].forEach(function(table) {
		var queryString = "DELETE FROM " + table
			+ " WHERE season=" + season + " AND game_id=" + gId;
		client.query(queryString, function(err) {
			if (err) {
				console.log("Error deleting records from: " + table);
				throw err;
			}
		});
	});

	// Write team and player stats
	var queryString = "INSERT INTO game_stats VALUES ";
	for (var key in teamData) {
		if (!teamData.hasOwnProperty(key)) {
			continue;
		}
		recordedStrengthSits.forEach(function(strSit) {
			recordedScoreSits.forEach(function(scSit) {
				// If all stats=0 for the given strSit and scSit, don't output this line
				if (!isRowEmpty(teamData[key][strSit][scSit])) {
					// Set playerId=0 for away team, playerId=1 for home team
					var venueIdx = key === "away" ? 0 : 1;
					var line = season
						+ "," + gId
						+ ",'" + teamData[key]["tricode"] + "'"
						+ "," + venueIdx
						+ ",'" + strSit + "'"
						+ "," + scSit;
					recordedStats.forEach(function(st) {
						line += "," + teamData[key][strSit][scSit][st]
					});
					queryString += "(" + line + "),";
				}
			});
		});
	}
	for (var key in playerData) {
		if (!playerData.hasOwnProperty(key)) {
			continue;
		}
		recordedStrengthSits.forEach(function(strSit) {
			recordedScoreSits.forEach(function(scSit) {
				if (!isRowEmpty(playerData[key][strSit][scSit])) {
					var line = season
						+ "," + gId
						+ ",'" + playerData[key]["team"] + "'"
						+ "," + key
						+ ",'" + strSit + "'"
						+ "," + scSit;
					recordedStats.forEach(function(st) {
						line += "," + playerData[key][strSit][scSit][st]
					});
					queryString += "(" + line + "),";
				}
			});
		});
	}
	queryString = queryString.slice(0, -1);
	client.query(queryString, function(err) {
		if (err) {
			console.log("Error inserting records into: game_stats");
			throw err;
		}
	});

	// Write player shifts
	var queryString = "INSERT INTO game_shifts VALUES ";
	for (var key in playerData) {
		if (!playerData.hasOwnProperty(key)) {
			continue;
		}

		// Output shifts as a string: start-end&start-end&...
		var shiftsGroupedByPeriod = _.groupBy(playerData[key]["shifts"], "period");
		for (var period in shiftsGroupedByPeriod) {

			if (!shiftsGroupedByPeriod.hasOwnProperty(period)) {
				continue;
			}

			var shiftOutput = "";
			shiftsGroupedByPeriod[period].forEach(function(sh) {
				shiftOutput += sh["start"] + "-" + sh["end"] + ";";
			});
			shiftOutput = shiftOutput.slice(0, -1);

			// Create row
			var line = season
				+ "," + gId
				+ ",'" + playerData[key]["team"] + "'"
				+ "," + key
				+ "," + parseInt(period)
				+ ",'" + shiftOutput + "'";
			queryString += "(" + line + "),";
		}
	}
	queryString = queryString.slice(0, -1);
	client.query(queryString, function(err) {
		if (err) {
			console.log("Error inserting records into: game_shifts");
			throw err;
		}
	});

	// Write records to game_strength_situations
	var queryString = "INSERT INTO game_strength_situations VALUES ";
	for (var prd = 1; prd <= maxPeriod; prd++) {
		["away", "home"].forEach(function(v) {
			["ev5", "pp", "sh"].forEach(function(sit) {
				// Convert the array of ranges into a string: start-end;start-end;...
				var rangeStr = "";
				teamStrSitTimes[prd.toString()][v][sit].forEach(function(range) {
					if (range[0] === range[1]) {
						rangeStr += range[0].toString();
					} else {
						rangeStr += (range[0] + "-" + range[1])
					}
					rangeStr += ";";
				});
				rangeStr = rangeStr.slice(0, -1);

				// Append to query if rangeStr isn't empty
				if (rangeStr.length > 0) {
					var line = season
						+ "," + gId
						+ ",'" + teamData[v]["tricode"] + "'"
						+ "," + prd
						+ ",'" + sit + "'"
						+ ",'" + rangeStr + "'";
					queryString += "(" + line + "),";
				}
			});
		});
	}
	queryString = queryString.slice(0, -1);
	client.query(queryString, function(err) {
		if (err) {
			console.log("Error inserting records into: game_strength_situations");
			throw err;
		}
	});

	// Write game_rosters
	// For player names, escape any apostrophes
	var queryString = "INSERT INTO game_rosters VALUES ";
	for (var key in playerData) {
		if (!playerData.hasOwnProperty(key)) {
			continue;
		}
		var jersey = playerData[key]["jersey"] ? playerData[key]["jersey"] : "NULL"; // Some scratched players don't have a jersey number listed
		var line = season
			+ "," + gId
			+ ",'" + playerData[key]["team"] + "'"
			+ "," + key
			+ ",'" + playerData[key]["first"].replace(/'/g, "''") + "'"
			+ ",'" + playerData[key]["last"].replace(/'/g, "''") + "'"
			+ "," + jersey
			+ ",'" + playerData[key]["position"] + "'";
		queryString += "(" + line + "),";
	}
	queryString = queryString.slice(0, -1);
	client.query(queryString, function(err) {
		if (err) {
			console.log("Error inserting records into: game_rosters");
			throw err;
		}
	});

	// Write events
	var queryString = "INSERT INTO game_events VALUES ";
	eventData.forEach(function(ev) {

		// Clean up values for database
		["locX", "locY"].forEach(function(col) {
			if (!ev[col]) {
				ev[col] = "NULL";
			}
		});
		if (!ev["hZone"]) {
			ev["hZone"] = "NULL";
		} else {
			ev["hZone"] = "'" + ev["hZone"] + "'";
		}

		// Start writing line to be inserted
		var line = season + "," + gId + "," + ev["id"] + "," + ev["period"] + "," + ev["time"] + ",";
		line += ev["score"][0] + "," + ev["score"][1] + "," + ev["skaters"][0].length + "," + ev["skaters"][1].length + "," + ev["hZone"] + "," + ev["locX"] + "," + ev["locY"] + ",";
		line += "'" + ev["description"].replace(/,/g, ";").replace(/'/g, "''") + "',"; // Replace commas in description to preserve csv format. Also escape apostrophes in player's names
		line += "'" + ev["type"] + "','" + ev["subtype"] + "','" + ev["team"] + "','" + ev["venue"] + "',"

		// Write players and roles - ["a", "", "c"].toString() gives "a,,c"
		var players = ["NULL", "NULL", "NULL"];
		var roles = ["NULL", "NULL", "NULL"];
		ev["roles"].forEach(function(r, i) {
			players[i] = r["player"];
			roles[i] = r["role"];
		});
		line += players.toString() + ",";

		// Wrap each role in quotes
		roles = roles.map(function(d) {
			if (d) {
				return "'" + d + "'";
			} else {
				return "NULL";
			}
		});
		line += roles.toString() + ",";

		// Write on-ice players
		["away", "home"].forEach(function(venue, vIdx) {

			var players = ["NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL"];

			// Skaters recorded in idx0 to idx5
			// Ignore the 7th and beyond skaters
			ev["skaters"][vIdx].forEach(function(pId, i) {
				if (i <= 5) {
					players[i] = pId;
				}
			});

			// Goalie recorded in idx6 - if there's multiple goalies, just take the first
			if (ev["goalies"][vIdx].length > 0) {
				players[6] = ev["goalies"][vIdx][0];
			}

			// Add players to csv line
			line += players.toString();
			if (venue === "away") {
				line += ",";
			}
		});
		queryString += "(" + line + "),";
	});
	queryString = queryString.slice(0, -1);
	client.query(queryString, function(err) {
		if (err) {
			console.log("Error inserting records into: game_events");
			throw err;
		}
	});

	// Write game result - include shootout results in the final result
	var finalScore = [pbpJson.liveData.linescore.teams.away.goals, pbpJson.liveData.linescore.teams.home.goals];
	var queryString = "INSERT INTO game_results"
		+ " VALUES ("
			+ season
			+ ",'" + gameDate + "'"
			+ "," + gId
			+ ",'" + teamData.away.tricode + "'"
			+ ",'" + teamData.home.tricode + "'"
			+ "," + finalScore[0]
			+ "," + finalScore[1]
			+ "," + maxPeriod + ")";
	client.query(queryString, function(err) {
		if (err) {
			console.log("Error inserting records into: game_results");
			throw err;
		}
	});
}

// Check if all the stats in a row equal 0
// row is teamData[key][strSit][scSit] for teamData
// row is playerData[key][strSit][scSit] for playerData
function isRowEmpty(row) {
	var isEmpty = true;
	recordedStats.forEach(function(st) {
		if (row[st] !== 0) {
			isEmpty = false;
		}
	});
	return isEmpty;
}

// Convert mm:ss to seconds
function toSecs(timeString) {
	var mm = +timeString.substring(0, timeString.indexOf(":"));
	var ss = +timeString.substring(timeString.indexOf(":") + 1);
	return 60 * mm + ss;
}

// Converts away and home scores into [awayScoreSit, homeScoreSit]
function getScoreSits(aScore, hScore) {
	var scoreSits = [];
	scoreSits.push(Math.max(-3, Math.min(3, aScore - hScore))).toString();
	scoreSits.push(Math.max(-3, Math.min(3, hScore - aScore))).toString();
	return scoreSits;
}

// Converts away and home goalie/skater counts into [awayStrengthSit, homeStrengthSit]
// countObject: { goalieCounts: [1, 1], skaterCounts: [5, 5] }
function getStrengthSits(countObject) {
	if (countObject["goalieCounts"][0] < 1 && countObject["goalieCounts"][1] > 0) {
		return ["noOwnG", "noOppG"];
	} else if (countObject["goalieCounts"][0] > 0 && countObject["goalieCounts"][1] < 1) {
		return ["noOppG", "noOwnG"];
	} else if (countObject["skaterCounts"][0] === 5 && countObject["skaterCounts"][1] === 5) {
		return ["ev5", "ev5"];
	} else if (countObject["skaterCounts"][0] > countObject["skaterCounts"][1]
		&& countObject["skaterCounts"][0] <= 6
		&& countObject["skaterCounts"][1] >= 3) {
		return ["pp", "sh"];
	} else if (countObject["skaterCounts"][1] > countObject["skaterCounts"][0]
		&& countObject["skaterCounts"][1] <= 6
		&& countObject["skaterCounts"][0] >= 3) {
		return ["sh", "pp"];
	} else {
		return ["other", "other"];
	}
}

// Given a list of skater and goalie playerIds, increment the specified stat by the specified amount
function incrementOnIceStats(playerData, skaters, goalies, strengthSit, scoreSit, stat, amount) {
	var playersToUpdate = skaters.concat(goalies);
	playersToUpdate.forEach(function(pId) {
		playerData[pId.toString()][strengthSit][scoreSit][stat] += amount;
	});
}
