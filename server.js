'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const BASE_WORDS = require('./words');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 12, W = 800, H = 600;
const rooms = new Map();

const rnd = n => Math.floor(Math.random() * n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = s => String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/* ---------- serwer HTTP (pliki statyczne) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(PUBLIC_DIR, path.normalize(p));
  if (!f.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------- pomocnicze ---------- */
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const broadcast = (room, o, exceptId) => { for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, o); };
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c;
  do { c = Array.from({ length: 5 }, () => A[rnd(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function newRoom(isPublic) {
  const room = {
    code: genCode(), public: isPublic, players: new Map(), hostId: null,
    settings: { rounds: 3, time: 80, customRaw: '' },
    phase: 'lobby', round: 0, queue: [], drawerId: null, word: '', choices: [], revealed: new Set(),
    hint: '', hist: [], guessed: new Set(), gains: {}, used: new Set(),
    timer: null, tick: null, endsAt: 0, total: 0
  };
  rooms.set(room.code, room);
  return room;
}
function phase(room, name, secs, fn) {
  clearTimeout(room.timer);
  room.phase = name; room.total = secs * 1000; room.endsAt = secs ? Date.now() + secs * 1000 : 0;
  room.timer = secs && fn ? setTimeout(fn, secs * 1000) : null;
}
function stateOf(room) {
  return {
    t: 'state', code: room.code, public: room.public, host: room.hostId, phase: room.phase,
    round: room.round, rounds: room.settings.rounds, drawer: room.drawerId, hint: room.hint,
    remaining: room.endsAt ? Math.max(0, room.endsAt - Date.now()) : 0, total: room.total,
    settings: { rounds: room.settings.rounds, time: room.settings.time, custom: room.settings.customRaw },
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, color: p.color,
      guessed: room.guessed.has(p.id), drawing: p.id === room.drawerId
    }))
  };
}
const broadcastState = room => broadcast(room, stateOf(room));
const sys = (room, text, kind = 'sys') => broadcast(room, { t: 'chat', kind, text });

function wordPool(room) {
  const custom = room.settings.customRaw.split(/[,\n]/).map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 30).slice(0, 200);
  return [...BASE_WORDS, ...custom, ...custom, ...custom];
}
function pickChoices(room) {
  let pool = [...new Set(wordPool(room))].filter(w => !room.used.has(w));
  if (pool.length < 3) { room.used.clear(); pool = [...new Set(wordPool(room))]; }
  return shuffle(pool).slice(0, 3);
}
const maskOf = room => [...room.word].map((ch, i) => ch === ' ' ? ' ' : ch === '-' ? '-' : room.revealed.has(i) ? ch : '_').join('');
const allGuessed = room => [...room.players.keys()].every(id => id === room.drawerId || room.guessed.has(id));

/* ---------- przebieg gry ---------- */
function maybeAutostart(room) {
  if (!room.public || room.phase !== 'lobby') return;
  if (room.players.size >= 2 && !room.endsAt) phase(room, 'lobby', 10, () => startGame(room));
  else if (room.players.size < 2 && room.endsAt) phase(room, 'lobby', 0);
}
function startGame(room) {
  if (room.phase !== 'lobby' || room.players.size < 2) return;
  for (const p of room.players.values()) p.score = 0;
  room.round = 0; room.queue = []; room.used.clear();
  sys(room, 'Gra się zaczyna! Powodzenia!');
  nextTurn(room);
}
function nextTurn(room) {
  while (room.queue.length && !room.players.has(room.queue[0])) room.queue.shift();
  if (!room.queue.length) {
    if (room.round >= room.settings.rounds) return endGame(room);
    room.round++; room.queue = [...room.players.keys()];
  }
  room.drawerId = room.queue.shift();
  room.hist = []; room.guessed = new Set(); room.gains = {}; room.word = ''; room.hint = ''; room.revealed = new Set();
  room.choices = pickChoices(room);
  broadcast(room, { t: 'canvas', hist: [] });
  send(room.players.get(room.drawerId).ws, { t: 'choices', words: room.choices });
  phase(room, 'choosing', 15, () => chooseWord(room, rnd(3)));
  broadcastState(room);
}
function chooseWord(room, idx) {
  if (room.phase !== 'choosing') return;
  room.word = room.choices[idx] || room.choices[0];
  room.used.add(room.word); room.revealed = new Set(); room.hint = maskOf(room);
  phase(room, 'drawing', room.settings.time, () => endTurn(room));
  clearInterval(room.tick); room.tick = setInterval(() => tick(room), 1000);
  const d = room.players.get(room.drawerId);
  send(d.ws, { t: 'word', word: room.word });
  sys(room, `${d.name} rysuje!`);
  broadcastState(room);
}
function tick(room) {
  if (room.phase !== 'drawing') return;
  const el = 1 - (room.endsAt - Date.now()) / room.total;
  const idxs = [...room.word].map((c, i) => (c !== ' ' && c !== '-') ? i : -1).filter(i => i >= 0);
  const want = Math.min(Math.floor(idxs.length / 3), [0.4, 0.6, 0.8].filter(t => el >= t).length);
  let changed = false;
  while (room.revealed.size < want) {
    const free = idxs.filter(i => !room.revealed.has(i));
    room.revealed.add(free[rnd(free.length)]); changed = true;
  }
  if (changed) { room.hint = maskOf(room); broadcastState(room); }
}
function endTurn(room) {
  clearInterval(room.tick);
  let sum = 0; for (const id of room.guessed) sum += room.gains[id] || 0;
  const d = room.players.get(room.drawerId);
  const pts = room.guessed.size ? Math.round(sum / Math.max(1, room.players.size - 1)) : 0;
  if (d && pts) { d.score += pts; room.gains[d.id] = pts; }
  room.hint = room.word;
  const names = {}; for (const p of room.players.values()) names[p.id] = p.name;
  broadcast(room, { t: 'turnEnd', word: room.word, gains: room.gains, names });
  phase(room, 'turnEnd', 6, () => nextTurn(room));
  broadcastState(room);
}
function endGame(room) {
  const ranking = [...room.players.values()].sort((a, b) => b.score - a.score).map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color }));
  broadcast(room, { t: 'gameOver', ranking });
  room.drawerId = null; room.hint = '';
  phase(room, 'gameover', 12, () => toLobby(room));
  broadcastState(room);
}
function toLobby(room) {
  clearInterval(room.tick);
  phase(room, 'lobby', 0);
  room.round = 0; room.drawerId = null; room.word = ''; room.hint = ''; room.hist = []; room.guessed = new Set();
  broadcast(room, { t: 'canvas', hist: [] });
  maybeAutostart(room);
  broadcastState(room);
}

/* ---------- czat i zgadywanie ---------- */
function onChat(room, p, text) {
  text = String(text || '').trim().slice(0, 100);
  if (!text) return;
  const now = Date.now(); if (now - (p.last || 0) < 400) return; p.last = now;
  if (room.phase === 'drawing' && p.id !== room.drawerId && !room.guessed.has(p.id)) {
    const g = norm(text), w = norm(room.word);
    if (g && g === w) {
      const frac = Math.max(0, (room.endsAt - now) / room.total);
      const pts = Math.round(60 + 440 * frac);
      p.score += pts; room.gains[p.id] = pts; room.guessed.add(p.id);
      sys(room, `${p.name} odgadł(a) hasło! (+${pts})`, 'ok');
      send(p.ws, { t: 'word', word: room.word });
      broadcastState(room);
      if (allGuessed(room)) endTurn(room);
      return;
    }
    if (g && w.length > 3 && lev(g, w) === 1) send(p.ws, { t: 'chat', kind: 'close', text: `„${text}” – blisko!` });
  }
  const priv = room.phase === 'drawing' && (p.id === room.drawerId || room.guessed.has(p.id));
  const msg = { t: 'chat', kind: 'msg', name: p.name, text, team: priv };
  for (const q of room.players.values()) if (!priv || q.id === room.drawerId || room.guessed.has(q.id)) send(q.ws, msg);
}

/* ---------- rysowanie ---------- */
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const okColor = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
function onDraw(room, p, m) {
  if (room.phase !== 'drawing' || p.id !== room.drawerId) return;
  const h = room.hist;
  switch (m.op) {
    case 'ss': {
      if (!okColor(m.c) || h.length > 2000) return;
      const x = num(m.x, 0, W), y = num(m.y, 0, H), w = num(m.w, 1, 60);
      h.push({ k: 's', c: m.c, w, p: [[x, y]] });
      broadcast(room, { t: 'draw', op: 'ss', c: m.c, w, x, y }, p.id); break;
    }
    case 'sp': {
      const s = h[h.length - 1]; if (!s || s.k !== 's' || !Array.isArray(m.pts)) return;
      const pts = m.pts.slice(0, 100).map(q => [num(q[0], 0, W), num(q[1], 0, H)]);
      if (s.p.length + pts.length > 6000) return;
      s.p.push(...pts);
      broadcast(room, { t: 'draw', op: 'sp', pts }, p.id); break;
    }
    case 'fill': {
      if (!okColor(m.c) || h.length > 2000) return;
      const o = { k: 'f', x: num(m.x, 0, W - 1), y: num(m.y, 0, H - 1), c: m.c };
      h.push(o); broadcast(room, { t: 'draw', op: 'fill', x: o.x, y: o.y, c: o.c }, p.id); break;
    }
    case 'undo': h.pop(); broadcast(room, { t: 'canvas', hist: h }); break;
    case 'clear': room.hist = []; broadcast(room, { t: 'canvas', hist: [] }); break;
  }
}

/* ---------- połączenia ---------- */
function joinRoom(ws, room, name) {
  if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', msg: 'Pokój jest pełny.' });
  const p = { id: ws.id, ws, name, score: 0, color: rnd(8), last: 0 };
  room.players.set(p.id, p); ws.room = room;
  if (!room.hostId) room.hostId = p.id;
  send(ws, { t: 'joined', code: room.code, public: room.public });
  send(ws, { t: 'canvas', hist: room.hist });
  sys(room, `${name} dołączył(a) do gry`);
  if (room.phase === 'lobby') maybeAutostart(room);
  broadcastState(room);
}
function leave(ws) {
  const room = ws.room; if (!room) return; ws.room = null;
  const p = room.players.get(ws.id); room.players.delete(ws.id);
  if (!room.players.size) { clearTimeout(room.timer); clearInterval(room.tick); rooms.delete(room.code); return; }
  if (room.hostId === ws.id) room.hostId = room.players.keys().next().value;
  if (p) sys(room, `${p.name} opuścił(a) grę`);
  if (room.phase === 'lobby') maybeAutostart(room);
  else if (room.players.size < 2) { sys(room, 'Za mało graczy – wracamy do poczekalni.'); toLobby(room); return; }
  else if (ws.id === room.drawerId && room.phase === 'choosing') return nextTurn(room);
  else if (ws.id === room.drawerId && room.phase === 'drawing') return endTurn(room);
  else if (room.phase === 'drawing' && allGuessed(room)) return endTurn(room);
  broadcastState(room);
}

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  ws.id = Math.random().toString(36).slice(2, 10); ws.alive = true; ws.room = null;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', id: ws.id });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room, p = room && room.players.get(ws.id);
    if (m.t === 'join' && !room) {
      const name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Gracz' + (100 + rnd(900));
      if (m.mode === 'create') return joinRoom(ws, newRoom(false), name);
      if (m.mode === 'code') {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        return r ? joinRoom(ws, r, name) : send(ws, { t: 'err', msg: 'Nie ma pokoju o takim kodzie.' });
      }
      const open = [...rooms.values()].find(r => r.public && r.players.size < MAX_PLAYERS && (r.phase === 'lobby' || r.players.size < 8));
      return joinRoom(ws, open || newRoom(true), name);
    }
    if (!room || !p) return;
    switch (m.t) {
      case 'chat': onChat(room, p, m.text); break;
      case 'draw': onDraw(room, p, m); break;
      case 'choose': if (room.phase === 'choosing' && p.id === room.drawerId) chooseWord(room, num(m.idx, 0, 2)); break;
      case 'start': if (p.id === room.hostId && !room.public) startGame(room); break;
      case 'settings':
        if (p.id === room.hostId && room.phase === 'lobby' && !room.public) {
          room.settings.rounds = num(m.rounds, 1, 10);
          room.settings.time = num(m.time, 20, 180);
          room.settings.customRaw = String(m.custom || '').slice(0, 3000);
          broadcastState(room);
        }
        break;
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 30000);

server.listen(PORT, () => console.log('Kreślak działa na porcie ' + PORT));
