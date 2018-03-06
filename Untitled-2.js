/* jshint esversion:6 */
const WebSocket = require('ws');

let Server = {
	control: new WebSocket.Server({
		port: 6061
	}),
	outside: new WebSocket.Server({
		port: 6060
	}),

	currentEventID: 0,
	eventsInput: [],
	eventsOutput: [],
	clients: [],
	free: [],
	buffered: [],
	controlConnection: null
};

function processEvents () {
	if (!Server.controlConnection) return;

	let out = [];
	[out, Server.eventsInput] = [Server.eventsInput, out]; // swap the values
	
	Server.controlConnection.send(out);
	Server.buffered.push(out);
}

function addEvent (event) {
	event.id = ++Server.currentEventID;
	Server.eventsInput.push(event);
	processEvents();
}

function revert () {
	Server.buffered.push(Server.eventsInput);
	Server.eventsInput = [].concat(Server.buffered);
}

function acknowledge (eventID) {
	for (let i = 0; i < Server.buffered.length; i++) {
		if (Server.buffered[i].id === Server.currentEventID) {
			if (i !== 0) console.log('[WARNING] Acknowledge is out of order');

			Server.buffered.slice(i, 1);
			return;
		}
	}
}