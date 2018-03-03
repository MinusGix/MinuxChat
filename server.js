/* jshint esversion:6 */
let fs = require('fs');
let WebSocket = require('ws');
let crypto = require('crypto');


let config = {};
function loadJSON(filename) {
	try {
		let data = fs.readFileSync(filename, 'utf8');
		console.log("Loaded JSON '" + filename + "'");
		return JSON.parse(data);
	} catch (e) {
		console.warn(e);
		return null;
	}
}

let configFilename = 'JSON/config.json';
config = loadJSON(configFilename);
fs.watchFile(configFilename, { persistent: false }, _ => config = loadJSON(configFilename));


let server = new WebSocket.Server({ host: config.host, port: config.port });
console.log("Started server on " + config.host + ":" + config.port);

server.on('connection', function(socket) {
	// Socket receiver has crashed, flush and kill socket
	socket._receiver.onerror = function(e){
		socket._receiver.flush();
		socket._receiver.messageBuffer = [];
		socket._receiver.cleanup();
		socket.close();
	};

	socket.on('message', data => {
		try {
			// Don't penalize yet, but check whether IP is rate-limited
			if (POLICE.frisk(getAddress(socket), 0)) {
				send({ cmd: 'warn', text: "Your IP is being rate-limited or blocked." }, socket);
				return;
			}
			// Penalize here, but don't do anything about it
			POLICE.frisk(getAddress(socket), 1);

			// ignore ridiculously large packets
			if (data.length > 65536) {
				return;
			}
			let args = JSON.parse(data);
			let cmd = args.cmd;

			if (COMMANDS.hasOwnProperty(cmd)) {
				let command = COMMANDS[cmd];
				if (command instanceof Command && args) {
					command.run(socket, args);
				}
			}
		} catch (e) {
			// Socket sent malformed JSON or buffer contains invalid JSON
			// For security reasons, we should kill it
			socket._receiver.flush();
			socket._receiver.messageBuffer = [];
			socket._receiver.cleanup();
			socket.close();
			console.warn(e.stack);
		}
	});

	socket.on('close', _ => {
		try {
			if (socket.channel) {
				broadcast({ cmd: 'onlineRemove', nick: socket.nick }, socket.channel);
			}
		} catch (e) {
			console.warn(e.stack);
		}
	});
});

function send(data, client) {
	// Add timestamp to command
	data.time = Date.now();
	try {
		if (client.readyState === WebSocket.OPEN) {
			client.send(JSON.stringify(data));
		}
	} catch (e) {
		console.error(e);
	}
}

/** Sends data to all clients
channel: if not null, restricts broadcast to clients in the channel
*/
function broadcast(data, channel) {
	for (let client of server.clients) {
		if (channel ? client.channel === channel : client.channel) {
			send(data, client);
		}
	}
}

function nicknameValid(nick) {
	// Allow letters, numbers, and underscores
	return /^[a-zA-Z0-9_]{1,24}$/.test(nick);
}

function getAddress(client) {
	if (config.x_forwarded_for) {
		// The remoteAddress is 127.0.0.1 since if all connections
		// originate from a proxy (e.g. nginx).
		// You must write the x-forwarded-for header to determine the
		// client's real IP address.
		return client.upgradeReq.headers['x-forwarded-for'];
	}
	else {
		return client.upgradeReq.connection.remoteAddress;
	}
}

function hash(password) {
	let sha = crypto.createHash('sha256');
	sha.update(password + config.salt);
	return sha.digest('base64').substr(0, 6);
}

function isAdmin(client) {
	return client.nick === config.admin;
}

function isMod(client) {
	if (isAdmin(client)) return true;
	if (config.mods) {
		if (client.trip && config.mods.includes(client.trip)) {
			return true;
		}
	}
	return false;
}

class Command {
	constructor (verify, func) {
		this.func = func;
		this.verify = verify || (_ => true);
	}

	run (socket, args) {
		if (this.verify(socket, args)) {
			return this.func(socket, args);
		}
		return false;
	}
}


let COMMANDS = {
	ping: new Command(null, _ => _), // Don't do anything
	join: new Command((socket, args) => args.channel && args.nick && !socket.nick, (socket, args) => {
		let channel = String(args.channel);
		let nick = String(args.nick);

		if (POLICE.frisk(getAddress(socket), 3)) {
			send({ cmd: 'warn', text: "You are joining channels too fast. Wait a moment and try again." }, socket);
			return;
		}

		// Process channel name
		channel = channel.trim();
		if (!channel) {
			// Must join a non-blank channel
			return;
		}

		// Process nickname
		let nickArr = nick.split('#', 2);
		nick = nickArr[0].trim();

		if (!nicknameValid(nick)) {
			send({ cmd: 'warn', text: "Nickname must consist of up to 24 letters, numbers, and underscores" }, socket);
			return;
		}

		let password = nickArr[1];
		if (nick.toLowerCase() == config.admin.toLowerCase()) {
			if (password !== config.password) {
				send({ cmd: 'warn', text: "Cannot impersonate the admin" }, socket);
				return;
			}
		} else if (password) {
			socket.trip = hash(password);
		}

		let address = getAddress(socket);
		for (let client of server.clients) {
			if (client.channel === channel) {
				if (client.nick.toLowerCase() === nick.toLowerCase()) {
					send({ cmd: 'warn', text: "Nickname taken" }, socket);
					return;
				}
			}
		}

		// Announce the new user
		broadcast({ cmd: 'onlineAdd', nick }, channel);

		// Formally join channel
		socket.channel = channel;
		socket.nick = nick;

		// Set the online users for new user
		let nicks = [];
		for (let client of server.clients) {
			if (client.channel === channel) {
				nicks.push(client.nick);
			}
		}
		send({ cmd: 'onlineSet', nicks }, socket);
	}),

	chat: new Command((socket, args) => socket.channel && socket.nick && args.text, (socket, args) => {
		let text = String(args.text);

		// strip newlines from beginning and end
		text = text.replace(/^\s*\n|^\s+$|\n\s*$/g, '');
		// replace 3+ newlines with just 2 newlines
		text = text.replace(/\n{3,}/g, "\n\n");
		if (!text) {
			return;
		}

		let score = text.length / 83 / 4;
		if (POLICE.frisk(getAddress(socket), score)) {
			send({ cmd: 'warn', text: "You are sending too much text. Wait a moment and try again.\nPress the up arrow key to restore your last message." }, socket);
			return;
		}

		let data = { cmd: 'chat', nick: socket.nick, text };
		if (isAdmin(socket)) {
			data.admin = true;
		} else if (isMod(socket)) {
			data.mod = true;
		}
		
		if (socket.trip) {
			data.trip = socket.trip;
		}

		broadcast(data, socket.channel);
	}),

	invite: new Command((socket, args) => socket.channel && socket.nick && args.nick, (socket, args) => {
		let nick = String(args.nick);

		if (POLICE.frisk(getAddress(socket), 2)) {
			send({ cmd: 'warn', text: "You are sending invites too fast. Wait a moment before trying again." }, socket);
			return;
		}

		let friend;
		for (let client of server.clients) {
			// Find friend's client
			if (client.channel == socket.channel && client.nick == nick) {
				friend = client;
				break;
			}
		}
		if (!friend) {
			send({ cmd: 'warn', text: "Could not find user in channel" }, socket);
			return;
		}

		if (friend === socket) {
			// Ignore silently
			return;
		}

		let channel = Math.random().toString(36).substr(2, 8);
		send({ cmd: 'info', text: "You invited " + friend.nick + " to ?" + channel }, socket);
		send({ cmd: 'info', text: socket.nick + " invited you to ?" + channel }, friend);
	}),

	stats: new Command(null, (socket, args) => {
		let ips = {};
		let channels = {};

		for (let client of server.clients) {
			if (client.channel) {
				channels[client.channel] = true;
				ips[getAddress(client)] = true;
			}
		}

		send({ cmd: 'info', text: Object.keys(ips).length + " unique IPs in " + Object.keys(channels).length + " channels" }, socket);
	}),

	// Moderator-only commands below this point

	ban: new Command((socket, args) => isMod(socket) && socket.channel && socket.nick && args.nick, (socket, args) => {
		let nick = String(args.nick);

		let badClient = server.clients
			.filter(client =>  client.channel === socket.channel && client.nick === nick, socket)[0];

		if (!badClient) {
			send({ cmd: 'warn', text: "Could not find " + nick }, socket);
			return;
		}

		if (isMod(badClient)) {
			send({ cmd: 'warn', text: "Cannot ban moderator" }, socket);
			return;
		}

		POLICE.arrest(getAddress(badClient));
		console.log(socket.nick + " [" + socket.trip + "] banned " + nick + " in " + socket.channel);
		broadcast({ cmd: 'info', text: "Banned " + nick }, socket.channel);
	}),

	unban: new Command((socket, args) => isMod(socket) && socket.channel && socket.nick && args.ip, (socket, args) => {
		let ip = String(args.ip);

		POLICE.pardon(ip);
		console.log(socket.nick + " [" + socket.trip + "] unbanned " + ip + " in " + socket.channel);
		send({ cmd: 'info', text: "Unbanned " + ip }, socket);
	}),

	// Admin-only commands below this point

	listUsers: new Command(isAdmin, socket => {
		let channels = {};
		for (let client of server.clients) {
			if (client.channel) {
				if (!channels[client.channel]) {
					channels[client.channel] = [];
				}
				channels[client.channel].push(client.nick);
			}
		}

		let lines = Object.entries(channels).map(channel => "?" + channel[0] + " " + channel[1].join(', '));
		let text = server.clients.length + " users online:\n\n";
		text += lines.join("\n");
		send({ cmd: 'info', text }, socket);
	}),

	broadcast: new Command((socket, args) => args.text && isAdmin(socket), (socket, args) => {
		let text = String(args.text);
		broadcast({ cmd: 'info', text: "Server broadcast: " + text });
	})
};


// rate limiter
let POLICE = {
	records: {},
	halflife: 30000, // ms
	threshold: 15,

	loadJail: function(filename) {
		let ids;
		try {
			let text = fs.readFileSync(filename, 'utf8');
			ids = text.split(/\r?\n/);
		} catch (e) {
			return; // don't need console.error, because the file is only created if you want tob an users even after restart
		}

		for (let id of ids) {
			if (id && id[0] != '#') {
				this.arrest(id);
			}
		}
		console.log("Loaded jail '" + filename + "'");
	},

	search: function(id) {
		let record = this.records[id];
		if (!record) {
			record = this.records[id] = {
				time: Date.now(),
				score: 0,
			};
		}
		return record;
	},

	frisk: function(id, deltaScore) {
		let record = this.search(id);
		if (record.arrested) {
			return true;
		}

		record.score *= Math.pow(2, -(Date.now() - record.time)/POLICE.halflife);
		record.score += deltaScore;
		record.time = Date.now();
		if (record.score >= this.threshold) {
			return true;
		}
		return false;
	},

	arrest: function(id) {
		let record = this.search(id);
		if (record) {
			record.arrested = true;
		}
	},

	pardon: function(id) {
		let record = this.search(id);
		if (record) {
			record.arrested = false;
		}
	},
};

POLICE.loadJail('jail.txt');
