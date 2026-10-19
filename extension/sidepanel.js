'use strict';

const DEFAULTS = { serverUrl: 'ws://localhost:8080', name: '', room: 'lobby', token: '' };
const GROUP_WINDOW_MS = 5 * 60 * 1000;   // merge consecutive messages from one sender
const TYPING_SEND_INTERVAL_MS = 2000;
const TYPING_SHOW_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const WAKE_TIMEOUT_MS = 90_000;          // keep retrying the first connect while a sleeping free host boots
const KEEPALIVE_MS = 4 * 60 * 1000;      // free hosts sleep after ~15 min without inbound messages
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

const $ = (id) => document.getElementById(id);
const els = {
  joinView: $('join-view'),
  joinForm: $('join-form'),
  serverUrl: $('server-url'),
  name: $('name'),
  room: $('room'),
  token: $('token'),
  joinError: $('join-error'),
  joinStatus: $('join-status'),
  joinBtn: $('join-btn'),
  cancelBtn: $('cancel-btn'),
  chatView: $('chat-view'),
  roomName: $('room-name'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  usersBtn: $('users-btn'),
  userCount: $('user-count'),
  usersPanel: $('users-panel'),
  usersList: $('users-list'),
  leaveBtn: $('leave-btn'),
  messages: $('messages'),
  typing: $('typing'),
  composer: $('composer'),
  input: $('input'),
  sendBtn: $('send-btn'),
};

const state = {
  settings: { ...DEFAULTS },
  ws: null,
  me: null,            // { id, name, room } from the server's welcome
  myIds: new Set(),    // every id this panel has had, so own messages survive reconnects
  seen: new Set(),     // rendered message ids, so history isn't duplicated on reconnect
  joined: false,       // welcomed at least once this session (reconnect vs. give up)
  online: false,       // currently connected and joined
  leaving: false,      // user chose to leave; don't reconnect
  retries: 0,
  retryTimer: null,
  connectStartedAt: 0,
  lastTypingSent: 0,
  typers: new Map(),   // user id -> { name, timer }
  lastMsg: null,       // { fromId, ts } of the previous message, for grouping
};

init();

async function init() {
  state.settings = await chrome.storage.local.get(DEFAULTS);
  els.serverUrl.value = state.settings.serverUrl;
  els.name.value = state.settings.name;
  els.room.value = state.settings.room;
  els.token.value = state.settings.token;
  (els.name.value ? els.joinBtn : els.name).focus();
}

// ---------- Join / leave ----------

els.joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings = {
    serverUrl: els.serverUrl.value.trim(),
    name: els.name.value.trim(),
    room: els.room.value.trim() || 'lobby',
    token: els.token.value,
  };
  if (!/^wss?:\/\/\S+$/i.test(settings.serverUrl)) {
    return showJoinError('Server URL must start with ws:// or wss:// (for example ws://localhost:8080).');
  }
  if (!settings.name) return showJoinError('Please enter a nickname.');

  state.settings = settings;
  await chrome.storage.local.set(settings);

  state.leaving = false;
  state.joined = false;
  state.retries = 0;
  state.connectStartedAt = Date.now();
  els.joinBtn.disabled = true;
  els.joinBtn.textContent = 'Connecting…';
  els.cancelBtn.hidden = false;
  els.joinError.hidden = true;
  connect();
});

els.leaveBtn.addEventListener('click', disconnect);
els.cancelBtn.addEventListener('click', disconnect);

function disconnect() {
  state.leaving = true;
  clearTimeout(state.retryTimer);
  if (state.ws) state.ws.close(1000, 'Left');
  state.ws = null;
  showJoinView();
}

// ---------- Connection ----------

function connect() {
  clearTimeout(state.retryTimer);

  let ws;
  try {
    ws = new WebSocket(state.settings.serverUrl);
  } catch {
    return fail('That server URL is not valid.');
  }
  state.ws = ws;
  setStatus('connecting');

  ws.addEventListener('open', () => {
    const { name, room, token } = state.settings;
    ws.send(JSON.stringify({ type: 'join', name, room, token }));
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', (e) => {
    if (state.ws !== ws) return; // an older socket we already replaced
    state.ws = null;
    state.online = false;
    setComposerEnabled(false);
    clearAllTypers();

    if (state.leaving) return;
    if (e.code >= 4000 && e.code < 4100) return fail(e.reason || 'The server closed the connection.');
    if (!state.joined) {
      if (Date.now() - state.connectStartedAt < WAKE_TIMEOUT_MS) return scheduleReconnect();
      return fail(`Could not connect to ${state.settings.serverUrl}. Check the URL and that the server is running.`);
    }
    if (state.retries === 0) addSystem('Connection lost. Reconnecting…');
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** state.retries) + Math.random() * 500;
  const seconds = Math.round(delay / 1000);
  state.retries++;
  if (state.joined) {
    setStatus('reconnecting', seconds);
  } else {
    els.joinStatus.textContent =
      `No answer from the server yet. Free hosting can take about a minute to wake up. Retrying in ${seconds}s…`;
    els.joinStatus.hidden = false;
  }
  state.retryTimer = setTimeout(connect, delay);
}

setInterval(() => {
  if (state.online) state.ws.send(JSON.stringify({ type: 'ping' }));
}, KEEPALIVE_MS);

// Reconnect right away when the network comes back instead of waiting out the backoff.
window.addEventListener('online', () => {
  if (state.joined && !state.ws && !state.leaving) {
    state.retries = 0;
    connect();
  }
});

function fail(message) {
  clearTimeout(state.retryTimer);
  state.leaving = true;
  if (state.ws) state.ws.close();
  state.ws = null;
  showJoinView();
  showJoinError(message);
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome': return onWelcome(msg);
    case 'message': return onChat(msg);
    case 'system': return addSystem(msg.text);
    case 'users': return renderUsers(msg.users);
    case 'typing': return onTyping(msg.from);
    case 'error': return state.joined ? addSystem(msg.message, true) : showJoinError(msg.message);
  }
}

// ---------- Incoming events ----------

function onWelcome({ you, users, history }) {
  const firstJoin = !state.joined;
  state.me = you;
  state.myIds.add(you.id);
  state.joined = true;
  state.online = true;
  state.retries = 0;

  if (firstJoin) {
    els.messages.replaceChildren();
    state.seen.clear();
    state.lastMsg = null;
    showChatView();
  }

  els.roomName.textContent = `#${you.room}`;
  history.forEach(onChat);
  renderUsers(users);
  setStatus('online');
  setComposerEnabled(true);

  if (firstJoin) {
    const renamed = you.name !== state.settings.name ? ` (“${state.settings.name}” was taken)` : '';
    addSystem(`You joined #${you.room} as ${you.name}${renamed}`);
  } else {
    addSystem('Reconnected');
  }
  els.input.focus();
}

function onChat(msg) {
  if (state.seen.has(msg.id)) return;
  state.seen.add(msg.id);
  clearTyper(msg.from.id);

  const mine = state.myIds.has(msg.from.id);
  const grouped = state.lastMsg?.fromId === msg.from.id && msg.ts - state.lastMsg.ts < GROUP_WINDOW_MS;
  const stick = isNearBottom();

  const el = document.createElement('div');
  el.className = `msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`;

  if (!grouped) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = mine ? 'You' : msg.from.name;
    const time = document.createElement('time');
    time.dateTime = new Date(msg.ts).toISOString();
    time.textContent = formatTime(msg.ts);
    meta.append(author, time);
    el.append(meta);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.title = new Date(msg.ts).toLocaleString();
  appendLinkified(bubble, msg.text);
  el.append(bubble);

  els.messages.append(el);
  state.lastMsg = { fromId: msg.from.id, ts: msg.ts };
  if (stick || mine) scrollToBottom();
}

function addSystem(text, isError = false) {
  const stick = isNearBottom();
  const el = document.createElement('div');
  el.className = `system${isError ? ' error' : ''}`;
  el.textContent = text;
  els.messages.append(el);
  state.lastMsg = null;
  if (stick) scrollToBottom();
}

function renderUsers(users) {
  els.userCount.textContent = users.length;
  els.usersList.replaceChildren(
    ...users.map((u) => {
      const li = document.createElement('li');
      const isMe = u.id === state.me?.id;
      li.textContent = isMe ? `${u.name} (you)` : u.name;
      if (isMe) li.className = 'me';
      return li;
    }),
  );
  const present = new Set(users.map((u) => u.id));
  for (const id of state.typers.keys()) {
    if (!present.has(id)) clearTyper(id);
  }
}

function onTyping(from) {
  if (state.myIds.has(from.id)) return;
  const existing = state.typers.get(from.id);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => clearTyper(from.id), TYPING_SHOW_MS);
  state.typers.set(from.id, { name: from.name, timer });
  renderTyping();
}

function clearTyper(id) {
  const typer = state.typers.get(id);
  if (!typer) return;
  clearTimeout(typer.timer);
  state.typers.delete(id);
  renderTyping();
}

function clearAllTypers() {
  for (const id of [...state.typers.keys()]) clearTyper(id);
}

function renderTyping() {
  const names = [...state.typers.values()].map((t) => t.name);
  els.typing.textContent =
    names.length === 0 ? '' :
    names.length === 1 ? `${names[0]} is typing…` :
    names.length === 2 ? `${names[0]} and ${names[1]} are typing…` :
    'Several people are typing…';
}

// ---------- Composer ----------

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

els.input.addEventListener('keydown', (e) => {
  // isComposing: don't send while an IME (e.g. Vietnamese Telex) is still composing.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

els.input.addEventListener('input', () => {
  autoGrow();
  updateSendBtn();
  sendTyping();
});

function sendMessage() {
  const text = els.input.value.trim();
  if (!text || !state.online) return;
  state.ws.send(JSON.stringify({ type: 'message', text }));
  els.input.value = '';
  state.lastTypingSent = 0;
  autoGrow();
  updateSendBtn();
}

function sendTyping() {
  if (!state.online || !els.input.value.trim()) return;
  const now = Date.now();
  if (now - state.lastTypingSent < TYPING_SEND_INTERVAL_MS) return;
  state.lastTypingSent = now;
  state.ws.send(JSON.stringify({ type: 'typing' }));
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight + 2, 140)}px`;
}

function updateSendBtn() {
  els.sendBtn.disabled = !state.online || !els.input.value.trim();
}

function setComposerEnabled(enabled) {
  els.input.disabled = !enabled;
  updateSendBtn();
}

// ---------- Users panel ----------

els.usersBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleUsersPanel(els.usersPanel.hidden);
});

document.addEventListener('click', (e) => {
  if (!els.usersPanel.hidden && !els.usersPanel.contains(e.target)) toggleUsersPanel(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.usersPanel.hidden) toggleUsersPanel(false);
});

function toggleUsersPanel(open) {
  els.usersPanel.hidden = !open;
  els.usersBtn.setAttribute('aria-expanded', String(open));
}

// ---------- View helpers ----------

function showJoinView() {
  state.online = false;
  clearAllTypers();
  toggleUsersPanel(false);
  els.chatView.hidden = true;
  els.joinView.hidden = false;
  els.joinBtn.disabled = false;
  els.joinBtn.textContent = 'Join room';
  els.cancelBtn.hidden = true;
  els.joinStatus.hidden = true;
}

function showChatView() {
  els.joinView.hidden = true;
  els.chatView.hidden = false;
  els.joinError.hidden = true;
}

function showJoinError(message) {
  els.joinError.textContent = message;
  els.joinError.hidden = false;
}

function setStatus(kind, seconds) {
  els.statusDot.className = `status-dot${kind === 'online' ? ' online' : kind === 'reconnecting' ? ' offline' : ''}`;
  els.statusText.textContent =
    kind === 'online' ? `Connected as ${state.me.name}` :
    kind === 'reconnecting' ? `Disconnected · retrying in ${seconds}s` :
    'Connecting…';
}

function isNearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function formatTime(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Builds text + <a> nodes (never innerHTML), so message content can't inject markup.
function appendLinkified(parent, text) {
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?)\]]+$/, '');
    parent.append(text.slice(last, match.index));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    parent.append(a);
    last = match.index + url.length;
  }
  parent.append(text.slice(last));
}
