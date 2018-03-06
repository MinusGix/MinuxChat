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
		sha.update(password + Server.Config.hash.salt);
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
		if (Server.Config.server.x_forwarded_for) {
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
		if (nick) {
			let admins = Server.Config.admins;
			for (let i = 0; i < admins.length; i++) {
				if (nick.toLowerCase() === admins[i][0].toLowerCase()) {
					if (trip === admins[i][1]) {
						return true;
					}
					return false;
				}
			}
		}
		return false;
	},

	isAdmin: function (client) {
		return Server.isAdminPair(client.nick, client.trip);
	},

	isMod: function (client) {
		if (Server.isAdmin(client)) return true;
		if (Server.Config.mods) {
			if (client.trip && Server.Config.mods.includes(client.trip)) {
				return true;
			}
		}
		return false;
	},

	socketPair (socket) {
		let pair = [socket.nick];	
		if (socket.trip) {
			pair.push(socket.trip);
		}
		return pair;
	}
};
// Declaring global variables for simplicity
let send = Server.send;

// Config
Server.Config = loadJSON(Server.configFilename);
fs.watchFile(Server.configFilename, { persistent: false }, _ => Server.Config = loadJSON(Server.configFilename));

// WebSocket Server
Server.websocket = new WebSocket.Server({ host: Server.Config.server.host, port: Server.Config.server.port });
console.log("Started server on " + Server.Config.server.host + ":" + Server.Config.server.port);

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
				send(Server.Config.server.ratelimitedOrBlocked, socket);
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
				Server.broadcast({ cmd: 'onlineRemove', nick: Server.socketPair(socket) }, socket.channel);
			}
		} catch (error) {
			console.warn(error.stack);
		}
	});
});

class Command {
	constructor (verify, func) {
		this.func = func || (_=>_);
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

	setVerify (func) {
		this.verify = func;
		return this;
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
	ping: new Command().setPenalize(_ => Server.Config.commands.ping.penalize), // Don't do anything

	join: new Command()
	.setVerify((socket, args) => args.channel && args.nick && !socket.nick)
	.setCommandFunction((socket, args) => {
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
			send(Server.Config.commands.join.nicknameNotValid, socket);
			return;
		}

		if (password) {
			socket.trip = Server.hash(password);
		}

		let admins = Server.Config.admins;
		for (let i = 0; i < admins.length; i++) {
			if (nick.toLowerCase() === admins[i][0].toLowerCase()) {
				if (socket.trip !== admins[i][1]) {
					send(Server.Config.commands.join.impersonatingAdmin, socket);
					return;
				}
			}
		}

		let address = Server.getAddress(socket);
		for (let client of Server.websocket.clients) {
			if (client.channel === channel) {
				if (client.nick.toLowerCase() === nick.toLowerCase()) {
					send(Server.Config.commands.join.nicknameTaken, socket);
					return;
				}
			}
		}

		socket.nick = nick;

		// Announce the new user
		Server.broadcast({ cmd: 'onlineAdd', nick: Server.socketPair(socket) }, channel);

		// Formally join channel
		socket.channel = channel;

		// Set the online users for new user
		let nicks = Server.websocket.clients
			.filter(client => client.channel === channel)
			.map(client => Server.socketPair(client));
		
		send({ cmd: 'onlineSet', nicks }, socket);
	})
	.setPenalize(_ => Server.Config.commands.join.penalize)
	.setOnPenalized(_ => Server.Config.commands.join.onPenalized),

	chat: new Command()
	.setVerify((socket, args) => socket.channel && socket.nick && args.text)
	.setCommandFunction((socket, args) => {
		let data = { 
			cmd: 'chat', 
			nick: socket.nick, 
			text: args.modifiedText // modified in the setPenalize.
		};
		if (Server.isAdmin(socket)) {
			data.admin = true;
		} else if (Server.isMod(socket)) {
			data.mod = true;
		}
		
		if (socket.trip && !data.admin) {
			data.trip = socket.trip;
		}

		Server.broadcast(data, socket.channel);
	})
	.setPenalize((socket, args) => {
		args.modifiedText = String(args.text)
			.replace(/^\s*\n|^\s+$|\n\s*$/g, '') // strip newlines from beginning and end
			.replace(/\n{3,}/g, "\n\n"); // replace 3+ newlines with just 2 newlines
		return (args.modifiedText.length / 83 / 4) + 1;
	}).setOnPenalized(_ => Server.Config.commands.chat.onPenalized),

	invite: new Command()
	.setVerify((socket, args) => socket.channel && socket.nick && args.nick)
	.setCommandFunction((socket, args) => {
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
			send(Server.Config.commands.invite.couldNotFindUser, socket);
			return;
		}

		if (friend === socket) {
			// Ignore silently
			return;
		}
		// perhaps make it one command and for the inviter have a boolean argument telling them it's themselves?
		send({ cmd: 'invite', themself: true, nick: Server.socketPair(friend), channel }, socket);
		send({ cmd: 'invite', nick: Server.socketPair(socket), channel }, friend);
	})
	.setPenalize(_ => Server.Config.commands.invite.penalize)
	.setOnPenalized(_ => Server.Config.commands.invite.onPenalized),

	stats: new Command()
	.setCommandFunction((socket, args) => {
		let ips = {};
		let channels = {};

		for (let client of Server.websocket.clients) {
			if (client.channel) {
				channels[client.channel] = true;
				ips[Server.getAddress(client)] = true;
			}
		}

		send({
			cmd: 'stats',
			ipCount: Object.keys(ips).length,
			channelCount: Object.keys(channels).length
		}, socket);
	}),

	// Moderator-only commands below this point

	kick: new Command()
	.setVerify((socket, args) => Server.isMod(socket) && (args.nick || args.nicks))
	.setCommandFunction((socket, args) => {
		let nicks = String(args.nick || '') || args.nicks;
		let anon = Boolean(args.anon);
		let channel = String(args.channel || Math.random().toString(36).substr(2, 8));

		if (!Array.isArray(nicks)) {
			nicks = [nicks];
		}

		let clientsInChannel = Server.websocket.clients
			.filter(client => client.channel === socket.channel);
		let kicked = [];

		for (let i = 0; i < nicks.length; i++) {
			let nick = nicks[i];

			let badClient = clientsInChannel
				.filter(client => client.nick === nick)[0];

			if (!badClient) {
				send({ cmd: 'warn', text: 'Could not find ' + nick }, socket);
				continue;
			}

			if (Server.isMod(badClient)) {
				send({ cmd: 'warn', text: 'Cannot kick moderator' });
				continue;
			}
			
			kicked.push(Server.socketPair(badClient));
			badClient.channel = channel;
			
			console.log(socket.nick + " [" + socket.trip + "] kicked " + nick + " [" + badClient.trip + "] in " + socket.channel + " to " + channel);
		}

		if (kicked.length !== 0) {
			for (let i = 0; i < kicked.length; i++) {
				// this needs to be in a separate loop, otherwise the other kicked users will see other users leaving
				// which might tip off a person spamming with multiple users.
				Server.broadcast({ cmd: 'onlineRemove', nick: kicked[i] }, socket.channel);
			}
		
			let kicker;
			if (!anon) {
				kicker = Server.socketPair(socket);
			}
		
			Server.broadcast({ 
				cmd: 'kick', 
				kicker,
				nicks: kicked 
			}, socket.channel);
		}
	})
	.setPenalize(0.1),

	usersWithSameIP: new Command()
	.setVerify(Server.isMod)
	.setCommandFunction((socket, args) => { // does not inform mod of users ip, just that they have the same one
		let users = {};

		Server.websocket.clients.forEach(client => {
			let address = Server.getAddress(client);
			if (!users[address]) {
				users[address] = [];
			}
			users[address].push(Server.socketPair(client));
		});

		let same = [];
		for (let address in users) {
			if (users[address].length > 1) {
				same.push(users[address]);
			}
		}

		send({ cmd: 'usersWithSameIP', same }, socket);
	}),

	ban: new Command()
	.setVerify((socket, args) => Server.isMod(socket) && socket.channel && socket.nick && (args.nick || args.nicks))
	.setCommandFunction((socket, args) => {
		let nicks = String(args.nick || '') || args.nicks;
		let anon = Boolean(args.anon);

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
				continue;
			}

			if (Server.isMod(badClient)) {
				send(Server.Config.commands.ban.canNotBanModerator, socket);
				continue;
			}

			banned.push(Server.socketPair(badClient));
			POLICE.arrest(badClient);
			console.log(socket.nick + " [" + socket.trip + "] banned " + nick + " [" + badClient.trip + "] in " + socket.channel);
		}
		
		if (banned.length !== 0) {
			let /*bruce*/ banner;
			if (!anon) {
				banner = Server.socketPair(socket);
			}
		
			Server.broadcast({ 
				cmd: 'ban', 
				nicks: banned,
				banner
			}, socket.channel);
		}
	})
	.setPenalize(Server.Config.commands.ban.penalize), // very minute amount on the ban

	unban: new Command()
	.setVerify((socket, args) => Server.isMod(socket) && socket.channel && socket.nick && args.ip)
	.setCommandFunction((socket, args) => {
		let ips = String(args.ip || '') || args.ips;

		if (!Array.isArray(ips)) {
			ips = [ips];
		}

		for (let i = 0; i < ips.length; i++) {
			POLICE.pardon(ips[i]);
			console.log(socket.nick + " [" + socket.trip + "] unbanned " + ips[i] + " in " + socket.channel);
		}
		send({ cmd: 'unban', ips }, socket);
	}),

	listUsersInChannel: new Command()
	.setVerify((socket, args) => Server.isMod(socket) && args.channel)
	.setCommandFunction((socket, args) => {
		let channel = String(args.channel);

		let users = Server.websocket.clients
			.filter(client => client.channel === channel)
			.map(client => Server.socketPair(client));
		
		send({ cmd: 'listUsersInChannel', channel, users }, socket);
	}),

	// Admin-only commands below this point

	listUsers: new Command()
	.setVerify(Server.isAdmin)
	.setCommandFunction(socket => {
		let channels = {};
		for (let client of Server.websocket.clients) {
			if (client.channel) {
				if (!channels[client.channel]) {
					channels[client.channel] = [];
				}
				channels[client.channel].push(Server.socketPair(client));
			}
		}

		send({ cmd: 'listUsers', channels, clientAmount: Server.websocket.clients.length }, socket);
	}),

	broadcast: new Command()
	.setVerify((socket, args) => args.text && Server.isAdmin(socket))
	.setCommandFunction((socket, args) => {
		let text = String(args.text);
		let anon = Boolean(args.anon);

		let nick;

		if (!anon) {
			nick = Server.socketPair(socket);
		}
		Server.broadcast({ cmd: 'broadcast', text, nick });
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
