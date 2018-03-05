/* jshint esversion:6 */
let frontpage = [
	"                            _           _         _       _   ",
	"                           | |_ ___ ___| |_   ___| |_ ___| |_ ",
	"                           |   |_ ||  _| '_| |  _|   |_ ||  _|",
	"                           |_|_|__/|___|_,_|.|___|_|_|__/|_|  ",
	"",
	"",
	"Welcome to hack.chat, a minimal, distraction-free chat application.",
	"Channels are created and joined by going to https://hack.chat/?your-channel. There are no channel lists, so a secret channel name can be used for private discussions.",
	"",
	"Here are some pre-made channels you can join:",
	"?lounge ?meta",
	"?math ?physics ?chemistry",
	"?technology ?programming",
	"?games ?banana",
	"And here's a random one generated just for you: ?" + Math.random().toString(36).substr(2, 8),
	"",
	"",
	"Formatting:",
	"Whitespace is preserved, so source code can be pasted verbatim.",
	"",
	"GitHub: https://github.com/AndrewBelt/hack.chat",
	"Android apps: https://goo.gl/UkbKYy https://goo.gl/qasdSu https://goo.gl/fGQFQN",
	"",
	"Server and web client released under the MIT open source license.",
	"No message history is retained on the hack.chat server.",
].join("\n");

function $(query) {
	return document.querySelector(query);
}

function localStorageGet(key) {
	try {
		return window.localStorage[key];
	} catch(e) {}
}

function localStorageSet(key, val) {
	try {
		window.localStorage[key] = val;
	} catch(e) {}
}


let ws;
let myNick = localStorageGet('my-nick');
let myChannel = window.location.search.replace(/^\?/, '');
let lastSent = [""];
let lastSentPos = 0;


// Ping server every 50 seconds to retain WebSocket connection
window.setInterval(_ => send({ cmd: 'ping' }), 50000);


function join(channel) {
	if (document.domain == 'hack.chat') {
		// For https://hack.chat/
		ws = new WebSocket('wss://hack.chat/chat-ws');
	} else {
		// for local installs
		ws = new WebSocket('ws://' + document.domain + ':6060');
	}

	let wasConnected = false;

	ws.onopen = _ => {
		if (!wasConnected) {
			if (location.hash) {
				myNick = location.hash.substr(1);
			} else {
				myNick = prompt('Nickname:', myNick);
			}
		}
		if (myNick) {
			localStorageSet('my-nick', myNick);
			send({ cmd: 'join', channel: channel, nick: myNick.split('#')[0], pass: myNick.split('#')[1] });
		}
		wasConnected = true;
	};

	ws.onclose = _ => {
		if (wasConnected) {
			pushMessage({ nick: '!', text: "Server disconnected. Attempting to reconnect..." });
		}
		window.setTimeout(_ => join(channel), 2000);
	};

	ws.onmessage = message => {
		let args = JSON.parse(message.data);
		let cmd = args.cmd;
		let command = COMMANDS[cmd];
		command(args);
	};
}


let COMMANDS = {
	chat: args => {
		if (ignoredUsers.indexOf(args.nick) >= 0) {
			return;
		}
		pushMessage(args);
	},
	ban: args => {
		let msg = {
			nick: '*',
			cmd: 'info',
			text: (args.banner || '') + ' Banned ' + args.nicks.join(', ')
		};
		pushMessage(msg);
	},
	usersWithSameIP: args => {
		let msg = {
			nick: '*',
			cmd: 'info',
			text: "Users with same IPs:\n" + args.same.map(users => '* Same: ' + users.join(', ')).join('\n')
		};
		pushMessage(msg);
	},
	invited: args => {
		let msg = {
			nick: '*',
			cmd: 'info',
			text: "You invited " + args.nick + " to ?" + args.channel
		};
		pushMessage(msg);
	},
	invite: args => {
		let msg = {
			nick: '*',
			cmd: 'info',
			text: args.nick + " invited you to ?" + args.channel
		};
		pushMessage(msg);
	},
	stats: args => {
		let msg = {
			nick: '*',
			cmd: 'info',
			text: args.ipCount + " unique IPs in " + args.channelCount + " channels"
		};
		pushMessage(msg);
	},
	kick: args => {
		let msg = {
			nick: '*',
			cmd: 'info',
			text: (args.kicker || '') + ' Kicked ' + args.nicks.join(', ')
		};
		pushMessage(msg);
	},
	info: args => {
		args.nick = '*';
		pushMessage(args);
	},
	warn: args => {
		args.nick = '!';
		pushMessage(args);
	},
	onlineSet: args => {
		let nicks = args.nicks;
		usersClear();
		nicks.forEach(nick => userAdd(nick));
		pushMessage({ nick: '*', text: "Users online: " + nicks.join(", ") });
	},
	onlineAdd: args => {
		let nick = args.nick;
		userAdd(nick);
		if ($('#joined-left').checked) {
			pushMessage({ nick: '*', text: nick + " joined" });
		}
	},
	onlineRemove: args => {
		let nick = args.nick;
		userRemove(nick);
		if ($('#joined-left').checked) {
			pushMessage({ nick: '*', text: nick + " left" });
		}
	}
};


function pushMessage(args) {
	// Message container
	let messageEl = document.createElement('div');
	messageEl.classList.add('message');

	if (args.nick === myNick) {
		messageEl.classList.add('me');
	}

	if (args.nick == '!') {
		messageEl.classList.add('warn');
	} else if (args.nick == '*') {
		messageEl.classList.add('info');
	} else if (args.admin) {
		messageEl.classList.add('admin');
	} else if (args.mod) {
		messageEl.classList.add('mod');
	}

	// Nickname
	let nickSpanEl = document.createElement('span');
	nickSpanEl.classList.add('nick');
	messageEl.appendChild(nickSpanEl);

	if (args.trip) {
		let tripEl = document.createElement('span');
		tripEl.textContent = args.trip + " ";
		tripEl.classList.add('trip');
		nickSpanEl.appendChild(tripEl);
	}

	if (args.nick) {
		let nickLinkEl = document.createElement('a');
		nickLinkEl.textContent = args.nick;
		nickLinkEl.onclick = _ => {
			insertAtCursor("@" + args.nick + " ");
			$('#chatinput').focus();
		};
		let date = new Date(args.time || Date.now());
		nickLinkEl.title = date.toLocaleString();
		nickSpanEl.appendChild(nickLinkEl);
	}

	// Text
	let textEl = document.createElement('pre');
	textEl.classList.add('text');

	textEl.textContent = args.text || '';
	textEl.innerHTML = textEl.innerHTML.replace(/(\?|https?:\/\/)\S+?(?=[,.!?:)]?\s|$)/g, parseLinks);

	messageEl.appendChild(textEl);

	// Scroll to bottom
	let atBottom = isAtBottom();

	$('#messages').appendChild(messageEl);

	if (atBottom) {
		window.scrollTo(0, document.body.scrollHeight);
	}

	unread += 1;
	updateTitle();
}


function insertAtCursor(text) {
	let input = $('#chatinput');
	let start = input.selectionStart || 0;
	let before = input.value.substr(0, start);
	let after = input.value.substr(start);
	before += text;
	input.value = before + after;
	input.selectionStart = input.selectionEnd = before.length;
	updateInputSize();
}


function send(data) {
	if (ws && ws.readyState == ws.OPEN) {
		ws.send(JSON.stringify(data));
	}
}


function parseLinks(g0) {
	let a = document.createElement('a');
	a.innerHTML = g0;
	let url = a.textContent;
	a.href = url;
	a.target = '_blank';
	return a.outerHTML;
}


let windowActive = true;
let unread = 0;

window.onfocus = _ => {
	windowActive = true;
	updateTitle();
};

window.onblur = _ => windowActive = false;

window.onscroll = _ => {
	if (isAtBottom()) {
		updateTitle();
	}
};

function isAtBottom() {
	return (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 1);
}

function updateTitle() {
	if (windowActive && isAtBottom()) {
		unread = 0;
	}

	let title;
	if (myChannel) {
		title = "?" + myChannel;
	} else {
		title = "hack.chat";
	}
	
	if (unread > 0) {
		title = '(' + unread + ') ' + title;
	}

	document.title = title;
}

/* footer */

$('#footer').onclick = _ => $('#chatinput').focus();

$('#chatinput').onkeydown = e => {
	if (e.keyCode == 13 /* ENTER */ && !e.shiftKey) {
		e.preventDefault();
		// Submit message
		if (e.target.value !== '') {
			let text = e.target.value;
			e.target.value = '';
			send({ cmd: 'chat', text });
			lastSent[0] = text;
			lastSent.unshift("");
			lastSentPos = 0;
			updateInputSize();
		}
	} else if (e.keyCode == 38 /* UP */) {
		// Restore previous sent messages
		if (e.target.selectionStart === 0 && lastSentPos < lastSent.length - 1) {
			e.preventDefault();
			if (lastSentPos === 0) {
				lastSent[0] = e.target.value;
			}
			lastSentPos += 1;
			e.target.value = lastSent[lastSentPos];
			e.target.selectionStart = e.target.selectionEnd = e.target.value.length;
			updateInputSize();
		}
	} else if (e.keyCode == 40 /* DOWN */) {
		if (e.target.selectionStart === e.target.value.length && lastSentPos > 0) {
			e.preventDefault();
			lastSentPos -= 1;
			e.target.value = lastSent[lastSentPos];
			e.target.selectionStart = e.target.selectionEnd = 0;
			updateInputSize();
		}
	} else if (e.keyCode == 27 /* ESC */) {
		e.preventDefault();
		// Clear input field
		e.target.value = "";
		lastSentPos = 0;
		lastSent[lastSentPos] = "";
		updateInputSize();
	} else if (e.keyCode == 9 /* TAB */) {
		// Tab complete nicknames starting with @
		e.preventDefault();
		let pos = e.target.selectionStart || 0;
		let text = e.target.value;
		let index = text.lastIndexOf('@', pos);
		if (index >= 0) {
			let stub = text.substring(index + 1, pos).toLowerCase();
			// Search for nick beginning with stub
			let nicks = onlineUsers.filter(nick => nick.toLowerCase().indexOf(stub) === 0);
			if (nicks.length == 1) {
				insertAtCursor(nicks[0].substr(stub.length) + " ");
			}
		}
	}
};


function updateInputSize() {
	let atBottom = isAtBottom();

	let input = $('#chatinput');
	input.style.height = 0;
	input.style.height = input.scrollHeight + 'px';
	document.body.style.marginBottom = $('#footer').offsetHeight + 'px';

	if (atBottom) {
		window.scrollTo(0, document.body.scrollHeight);
	}
}

$('#chatinput').oninput = _ => updateInputSize();

updateInputSize();


/* sidebar */

$('#sidebar').onmouseenter = $('#sidebar').ontouchstart = e => {
	$('#sidebar-content').classList.remove('hidden');
	e.stopPropagation();
};

$('#sidebar').onmouseleave = document.ontouchstart = _ => {
	if (!$('#pin-sidebar').checked) {
		$('#sidebar-content').classList.add('hidden');
	}
};

$('#clear-messages').onclick = _ => {
	// Delete children elements
	let messages = $('#messages');
	while (messages.firstChild) {
		messages.removeChild(messages.firstChild);
	}
};

// Restore settings from localStorage

if (localStorageGet('pin-sidebar') == 'true') {
	$('#pin-sidebar').checked = true;
	$('#sidebar-content').classList.remove('hidden');
}
if (localStorageGet('joined-left') == 'false') {
	$('#joined-left').checked = false;
}

$('#pin-sidebar').onchange = e => localStorageSet('pin-sidebar', !!e.target.checked);
$('#joined-left').onchange = e => localStorageSet('joined-left', !!e.target.checked);

// User list

let onlineUsers = [];
let ignoredUsers = [];

function userAdd(nick) {
	let user = document.createElement('a');
	user.textContent = nick;
	user.onclick = e => userInvite(nick);
	let userLi = document.createElement('li');
	userLi.appendChild(user);
	$('#users').appendChild(userLi);
	onlineUsers.push(nick);
}

function userRemove(nick) {
	let users = $('#users');
	let children = users.children;
	for (let i = 0; i < children.length; i++) {
		let user = children[i];
		if (user.textContent == nick) {
			users.removeChild(user);
		}
	}
	let index = onlineUsers.indexOf(nick);
	if (index >= 0) {
		onlineUsers.splice(index, 1);
	}
}

function usersClear() {
	let users = $('#users');
	while (users.firstChild) {
		users.removeChild(users.firstChild);
	}
	onlineUsers.length = 0;
}

function userInvite(nick) {
	if (nick !== myNick.split('#')[0]) {
		send({ cmd: 'invite', nick, channel: prompt("Channel to invite them to (leave blank for random):") || undefined });
	}
}

function userIgnore(nick) {
	ignoredUsers.push(nick);
}

/* color scheme switcher */

let schemes = [
	'android',
	'atelier-dune',
	'atelier-forest',
	'atelier-heath',
	'atelier-lakeside',
	'atelier-seaside',
	'bright',
	'chalk',
	'default',
	'eighties',
	'greenscreen',
	'mocha',
	'monokai',
	'nese',
	'ocean',
	'pop',
	'railscasts',
	'solarized',
	'tomorrow',
];

let currentScheme = 'atelier-dune';

function setScheme(scheme) {
	currentScheme = scheme;
	$('#scheme-link').href = "/schemes/" + scheme + ".css";
	localStorageSet('scheme', scheme);
}

// Add scheme options to dropdown selector
schemes.forEach(scheme => {
	let option = document.createElement('option');
	option.textContent = scheme;
	option.value = scheme;
	$('#scheme-selector').appendChild(option);
});

$('#scheme-selector').onchange = e => setScheme(e.target.value);

// Load sidebar configaration values from local storage if available
if (localStorageGet('scheme')) {
	setScheme(localStorageGet('scheme'));
}

$('#scheme-selector').value = currentScheme;


/* main */

if (myChannel === '') {
	pushMessage({ text: frontpage });
	$('#footer').classList.add('hidden');
	$('#sidebar').classList.add('hidden');
} else {
	join(myChannel);
}
