/* jshint esversion:6 */
let fs = require('fs');
let WebSocket = require('ws');
let crypto = require('crypto');

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

function getValue (value, ...params) { // returns the value, if it's a function it will be ran with the params
	if (typeof(value) === 'function') {
		return value(...params);
	}
	return value;
}

let Server = {
	configFilename: "JSON/config.json",

	/** Sends data to all clients
	channel: if not null, restricts broadcast to clients in the channel
	*/
	broadcast: function (data, channel) {
		for (let client of Server.websocket.clients) {
			if (channel ? client.channel === channel : client.channel) {
				send(data, client);
			}
		}
	},

	hash: function (password) {
		let sha = crypto.createHash(Server.Config.hash.algorithm);
		sha.update(password + Server.Config.salt);
		return sha.digest(Server.Config.hash.encoding).substr(Server.Config.hash.position.begin, Server.Config.hash.position.end);
	},

	send: function (data, client) {
		// Add timestamp to command
		data.time = Date.now();
		try {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify(data));
			}
		} catch (e) {
			console.error(e);
		}
	},

	getAddress: function (client) {
		if (Server.Config.x_forwarded_for) {
			// The remoteAddress is 127.0.0.1 since if all connections
			// originate from a proxy (e.g. nginx).
			// You must write the x-forwarded-for header to determine the
			// client's real IP address.
			return client.upgradeReq.headers['x-forwarded-for'];
		} else {
			return client.upgradeReq.connection.remoteAddress;
		}
	},

	nicknameValid: function (nick) {
		// Allow letters, numbers, and underscores
		return /^[a-zA-Z0-9_]{1,24}$/.test(nick);
	},

	isAdminPair: function (nick, trip) {
		let admins = Server.Config.admins;
		for (let i = 0; i < admins.length; i++) {
			if (nick.toLowerCase() === admins[i][0].toLowerCase()) {
				if (trip === admins[i][1]) {
					return true;
				}
				return false;
			}
		}
		return false;
	},

	isAdmin: function (client) {
		return this.isAdminPair(client.nick, client.trip);
	},

	isMod: function (client) {
		if (Server.isAdmin(client)) return true;
		if (Server.Config.mods) {
			if (client.trip && Server.Config.mods.includes(client.trip)) {
				return true;
			}
		}
		return false;
	}
};
// Declaring global variables for simplicity
let send = Server.send;

// Config
Server.Config = loadJSON(Server.configFilename);
fs.watchFile(Server.configFilename, { persistent: false }, _ => Server.Config = loadJSON(Server.configFilename));

// WebSocket Server
Server.websocket = new WebSocket.Server({ host: Server.Config.host, port: Server.Config.port });
console.log("Started server on " + Server.Config.host + ":" + Server.Config.port);

Server.websocket.on('connection', socket => {
	// Socket receiver has crashed, flush and kill socket
	socket._receiver.onerror = error => {
		socket._receiver.flush();
		socket._receiver.messageBuffer = [];
		socket._receiver.cleanup();
		socket.close();
	};

	socket.on('message', data => {
		try {
			// Don't penalize yet, but check whether IP is rate-limited
			if (POLICE.frisk(socket, 0)) {
				send({ cmd: 'warn', text: "Your IP is being rate-limited or blocked." }, socket);
				return;
			}

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
		} catch (error) {
			// Socket sent malformed JSON or buffer contains invalid JSON
			// For security reasons, we should kill it
			socket._receiver.flush();
			socket._receiver.messageBuffer = [];
			socket._receiver.cleanup();
			socket.close();
			console.warn(error.stack);
		}
	});

	socket.on('close', _ => {
		try {
			if (socket.channel) {
				Server.broadcast({ cmd: 'onlineRemove', nick: socket.nick }, socket.channel);
			}
		} catch (error) {
			console.warn(error.stack);
		}
	});
});

class Command {
	constructor (verify, func) {
		this.func = func;
		this.verify = verify || (_ => true);

		this.settings = {
			penalize: Server.Config.commands.default.penalize,
			onPenalized: Server.Config.commands.default.onPenalized
		};
	}

	run (socket, args) {
		if (POLICE.frisk(socket, this.getPenalize(socket, args))) {
			return this.getOnPenalized(socket, args);
		}
		if (this.verify(socket, args)) {
			return this.func(socket, args);
		}
		return false;
	}

	getPenalize (socket, args) {
		return getValue(this.settings.penalize, socket, args);
	}

	getOnPenalized (socket, args) {
		return getValue(this.settings.onPenalized, socket, args);
	}

	setCommandFunction (func) { // for if they want to set the command later
		this.func = func;
		return this;
	}

	setPenalize (n=1) {
		this.settings.penalize = n;
		return this;
	}

	setOnPenalized (message="You are doing stuff too much! Wait a bit!") {
		if (typeof(message) === 'string') {
			this.settings.onPenalized = (socket, args) => send({ cmd: 'warn', text: message }, socket);
		} else if (typeof(message) === 'function') {
			this.settings.onPenalized = message;
		}
		return this;
	}
}


let COMMANDS = Server.COMMANDS = {
	ping: new Command(null, _ => _).setPenalize(_ => Server.Config.commands.ping.penalize), // Don't do anything

	join: new Command((socket, args) => args.channel && args.nick && !socket.nick, (socket, args) => {
		let channel = String(args.channel);
		let nick = String(args.nick).trim();
		let password = String(args.pass || '');

		// Process channel name
		channel = channel.trim();
		if (!channel) {
			// Must join a non-blank channel
			return;
		}

		if (!Server.nicknameValid(nick)) {
			send({ cmd: 'warn', text: "Nickname must consist of up to 24 letters, numbers, and underscores" }, socket);
			return;
		}

		if (password) {
			socket.trip = Server.hash(password);
		}

		let admins = Server.Config.admins;
		for (let i = 0; i < admins.length; i++) {
			if (nick.toLowerCase() === admins[i][0].toLowerCase()) {
				if (socket.trip !== admins[i][1]) {
					send({ cmd: 'warn', text: "Cannot impersonate an admin" }, socket);
					return;
				}
			}
		}

		let address = Server.getAddress(socket);
		for (let client of Server.websocket.clients) {
			if (client.channel === channel) {
				if (client.nick.toLowerCase() === nick.toLowerCase()) {
					send({ cmd: 'warn', text: "Nickname taken" }, socket);
					return;
				}
			}
		}

		// Announce the new user
		Server.broadcast({ cmd: 'onlineAdd', nick }, channel);

		// Formally join channel
		socket.channel = channel;
		socket.nick = nick;

		// Set the online users for new user
		let nicks = Server.websocket.clients
			.filter(client => client.channel === channel)
			.map(client => client.nick);
		
		send({ cmd: 'onlineSet', nicks }, socket);
	}).setPenalize(_ => Server.Config.commands.join.penalize)
	.setOnPenalized(_ => Server.Config.commands.join.onPenalized),

	chat: new Command((socket, args) => socket.channel && socket.nick && args.text, (socket, args) => {
		let text = args.modifiedText; // modified in the setPenalize.

		let data = { cmd: 'chat', nick: socket.nick, text };
		if (Server.isAdmin(socket)) {
			data.admin = true;
		} else if (Server.isMod(socket)) {
			data.mod = true;
		}
		
		if (socket.trip && !data.admin) {
			data.trip = socket.trip;
		}

		Server.broadcast(data, socket.channel);
	}).setPenalize((socket, args) => {
		args.modifiedText = String(args.text)
			.replace(/^\s*\n|^\s+$|\n\s*$/g, '') // strip newlines from beginning and end
			.replace(/\n{3,}/g, "\n\n"); // replace 3+ newlines with just 2 newlines
		return (args.modifiedText.length / 83 / 4) + 1;
	}).setOnPenalized(_ => Server.Config.commands.chat.onPenalized),

	invite: new Command((socket, args) => socket.channel && socket.nick && args.nick, (socket, args) => {
		let nick = String(args.nick);
		let channel = String(args.channel || '') || Math.random().toString(36).substr(2, 8);

		let friend;
		for (let client of Server.websocket.clients) {
			// Find friend's client
			if (client.channel === socket.channel && client.nick === nick) {
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

		send({ cmd: 'info', text: "You invited " + friend.nick + " to ?" + channel }, socket);
		send({ cmd: 'info', text: socket.nick + " invited you to ?" + channel }, friend);
	}).setPenalize(_ => Server.Config.commands.invite.penalize)
	.setOnPenalized(_ => Server.Config.commands.invite.onPenalized),

	stats: new Command(null, (socket, args) => {
		let ips = {};
		let channels = {};

		for (let client of Server.websocket.clients) {
			if (client.channel) {
				channels[client.channel] = true;
				ips[Server.getAddress(client)] = true;
			}
		}

		send({ cmd: 'info', text: Object.keys(ips).length + " unique IPs in " + Object.keys(channels).length + " channels" }, socket);
	}),

	// Moderator-only commands below this point

	ban: new Command((socket, args) => Server.isMod(socket) && socket.channel && socket.nick && (args.nick || args.nicks), (socket, args) => {
		let nicks = String(args.nick || '') || args.nicks;

		if (!Array.isArray(nicks)) {
			nicks = [nicks];
		}

		let clientsInChannel = Server.websocket.clients
			.filter(client => client.channel === socket.channel);
		let banned = [];

		for (let i = 0; i < nicks.length; i++) {
			let nick = nicks[i];

			let badClient = clientsInChannel
				.filter(client => client.nick === nick)[0];

			if (!badClient) {
				send({ cmd: 'warn', text: "Could not find " + nick }, socket);
				return;
			}

			if (Server.isMod(badClient)) {
				send({ cmd: 'warn', text: "Cannot ban moderator" }, socket);
				return;
			}

			banned.push(nick);
			POLICE.arrest(badClient);
			console.log(socket.nick + " [" + socket.trip + "] banned " + nick + " [" + badClient.trip + "] in " + socket.channel);
		}
		Server.broadcast({ cmd: 'info', text: "Banned " + banned.join(', ') }, socket.channel);
	}).setPenalize(Server.Config.commands.ban.penalize), // very minute amount on the ban

	unban: new Command((socket, args) => Server.isMod(socket) && socket.channel && socket.nick && args.ip, (socket, args) => {
		let ips = String(args.ip || '') || args.ips;

		if (!Array.isArray(ips)) {
			ips = [ips];
		}

		for (let i = 0; i < ips.length; i++) {
			POLICE.pardon(ips[i]);
			console.log(socket.nick + " [" + socket.trip + "] unbanned " + ips[i] + " in " + socket.channel);
		}
		send({ cmd: 'info', text: "Unbanned " + ips.join(', ') }, socket);
	}),

	// Admin-only commands below this point

	listUsers: new Command(Server.isAdmin, socket => {
		let channels = {};
		for (let client of Server.websocket.clients) {
			if (client.channel) {
				if (!channels[client.channel]) {
					channels[client.channel] = [];
				}
				channels[client.channel].push(client.nick);
			}
		}

		let lines = Object.entries(channels).map(channel => "?" + channel[0] + " " + channel[1].join(', '));
		let text = Server.websocket.clients.length + " users online:\n\n";
		text += lines.join("\n");
		send({ cmd: 'info', text }, socket);
	}),

	broadcast: new Command((socket, args) => args.text && Server.isAdmin(socket), (socket, args) => {
		let text = String(args.text);
		Server.broadcast({ cmd: 'info', text: "Server broadcast: " + text });
	})
};


// rate limiter
let POLICE = Server.POLICE = {
	records: {},
	halflife: Server.Config.police.halflife, // ms
	threshold: Server.Config.police.threshold,

	loadJail: filename => {
		let ids;
		try {
			let text = fs.readFileSync(filename, 'utf8');
			ids = text.split(/\r?\n/);
		} catch (e) {
			return; // don't need console.error, because the file is only created if you want tob an users even after restart
		}

		for (let id of ids) {
			if (id && id[0] != '#') {
				POLICE.arrest(id);
			}
		}
		console.log("Loaded jail '" + filename + "'");
	},

	search: id => {
		id = POLICE.convertID(id);
		let record = POLICE.records[id];
		if (!record) {
			record = POLICE.records[id] = {
				time: Date.now(),
				score: 0,
			};
		}
		return record;
	},

	frisk: (id, deltaScore) => {
		id = POLICE.convertID(id);
		let record = POLICE.search(id);
		if (record.arrested) {
			return true;
		}

		record.score *= Math.pow(2, -(Date.now() - record.time) / POLICE.halflife);
		record.score += deltaScore;
		record.time = Date.now();
		if (record.score >= POLICE.threshold) {
			return true;
		}
		return false;
	},

	arrest: id => {
		id = POLICE.convertID(id);
		let record = POLICE.search(id);
		if (record) {
			record.arrested = true;
		}
	},

	pardon: id => {
		id = POLICE.convertID(id);
		let record = POLICE.search(id);
		if (record) {
			record.arrested = false;
		}
	},

	convertID: id => {
		if (id instanceof WebSocket) {
			return Server.getAddress(id);
		}
		return id;
	}
};

POLICE.loadJail(Server.Config.police.jailFile);
