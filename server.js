'use strict';
/*
  Açıq Yol Yarışı - oyun serveri.
  Heç bir paket tələb etmir: yalnız Node.js (18 və ya yuxarı).
  Oyun səhifəsini verir və sürücülərin vəziyyətini WebSocket ilə hamıya ötürür.
*/
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 24;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const page = fs.readFileSync(path.join(__dirname, 'index.html'));

const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'hesablar.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch (e) { accounts = {}; }
let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(accounts)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { /* disk yoxdur */ }
  }, 2000);
}
function akey(n) { return String(n || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 14).toLowerCase(); }
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function cleanProfile(d) {
  if (!d || typeof d !== 'object') return null;
  let t; try { t = JSON.stringify(d); } catch (e) { return null; }
  if (t.length > 3500) return null;
  return JSON.parse(t);
}
function account(c, m) {
  const k = akey(m.n), pin = typeof m.pin === 'string' ? m.pin.slice(0, 40) : '';
  const rep = (r, extra) => send(c, Object.assign({ t: m.t, r: r }, extra || {}));
  if (!k || k.length < 3) { rep('name'); return; }
  if (pin.length < 4) { rep('short'); return; }
  const now = Date.now();
  if (now - (c.accT || 0) > 60000) { c.accT = now; c.accN = 0; }
  if (++c.accN > 12) { rep('slow'); return; }
  let a = accounts[k];
  if (m.t === 'rg') {
    if (a) { rep('exists'); return; }
    if (Object.keys(accounts).length >= 3000) { rep('full'); return; }
    const d = cleanProfile(m.d);
    if (!d) { rep('err'); return; }
    const salt = crypto.randomBytes(8).toString('hex');
    a = accounts[k] = { s: salt, h: hashPin(pin, salt), d: d, t: Date.now() };
    persist(); rep('ok', { ts: a.t }); return;
  }
  if (!a) { rep('nouser'); return; }
  if (hashPin(pin, a.s) !== a.h) { rep('bad'); return; }
  if (m.t === 'ld') { rep('ok', { d: a.d, ts: a.t }); return; }
  if (m.t === 'pw') {
    const np = typeof m.np === 'string' ? m.np.slice(0, 40) : '';
    if (np.length < 4) { rep('short'); return; }
    a.s = crypto.randomBytes(8).toString('hex'); a.h = hashPin(np, a.s);
    persist(); rep('ok'); return;
  }
  const d = cleanProfile(m.d);
  if (!d) { rep('err'); return; }
  a.d = d; a.t = Date.now();
  persist(); rep('ok', { ts: a.t });
}

const clients = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (p !== '/' && p !== '/index.html') { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Tapılmadı'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(page);
});

function frame(str) {
  const payload = Buffer.from(str);
  const n = payload.length;
  let head;
  if (n < 126) { head = Buffer.from([0x81, n]); }
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

function send(c, obj) {
  if (!c.open || c.socket.destroyed) return;
  try { c.socket.write(frame(JSON.stringify(obj))); } catch (e) { /* ignore */ }
}

function broadcast(obj, except) {
  const f = frame(JSON.stringify(obj));
  for (const c of clients.values()) {
    if (c === except || !c.open || c.socket.destroyed) continue;
    try { c.socket.write(f); } catch (e) { /* ignore */ }
  }
}

function num(v, lo, hi, d) {
  return (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
}

function clean(m) {
  return {
    n: typeof m.n === 'string' ? m.n.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 14) : '',
    k: Math.round(num(m.k, 0, 7, 0)),
    m: Math.round(num(m.m, 0, 3, 0)),
    p: Math.round(num(m.p, -1, 11, -1)),
    w: Math.round(num(m.w, 0, 4, 0)),
    s2: Math.round(num(m.s2, 0, 2, 0)),
    g: Math.round(num(m.g, 0, 5, 0)),
    y: num(m.y, -5, 400, 0),
    x: num(m.x, -1500, 1500, 0),
    z: num(m.z, -1500, 1500, 0),
    h: num(m.h, -100, 100, 0),
    v: num(m.v, -100, 100, 0),
    s: num(m.s, -1, 1, 0),
    f: m.f === 1 ? 1 : 0,
    l: Math.round(num(m.l, 0, 9999, 0)),
    b: (typeof m.b === 'number' && m.b > 0 && m.b < 3.6e6) ? Math.round(m.b) : null,
    r: m.r === 1 ? 1 : 0,
    q: Math.round(num(m.q, 0, 9999, 0)),
    mo: Math.round(num(m.mo, 0, 1e9, 0)),
    ro: Math.round(num(m.ro, 0, 2, 0)),
    ne: Math.round(num(m.ne, 0, 5, 0))
  };
}

function close(c) {
  if (!c.open) return;
  c.open = false;
  clients.delete(c.id);
  try { c.socket.destroy(); } catch (e) { /* ignore */ }
  if (c.state) broadcast({ t: 'l', i: c.id });
}

function handle(c, text) {
  c.alive = true;
  const now = Date.now();
  if (text.length < 400 && text.charAt(0) === '{' && text.indexOf('"t":"c"') !== -1) {
    let cm;
    try { cm = JSON.parse(text); } catch (e) { return; }
    if (!cm || cm.t !== 'c' || typeof cm.x !== 'string') return;
    if (now - (c.lastChat || 0) < 700) return;
    c.lastChat = now;
    const msg = cm.x.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
    if (!msg || !c.state || !c.state.n) return;
    broadcast({ t: 'c', i: c.id, n: c.state.n, x: msg }, c);
    return;
  }
  if (text.length < 4000 && text.charAt(0) === '{' && /"t":"(ld|sv|rg|pw)"/.test(text)) {
    let am;
    try { am = JSON.parse(text); } catch (e) { return; }
    if (am && (am.t === 'ld' || am.t === 'sv' || am.t === 'rg' || am.t === 'pw')) account(c, am);
    return;
  }
  if (now - c.last < 30) return;
  c.last = now;
  let m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  c.state = clean(m);
  broadcast({ t: 'u', i: c.id, d: c.state }, c);
}

function parse(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1];
    const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) {
      if (c.buf.length < 4) return;
      len = c.buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (c.buf.length < 10) return;
      const big = c.buf.readBigUInt64BE(2);
      if (big > 12000n) { close(c); return; }
      len = Number(big); off = 10;
    }
    if (!masked || len > 12000) { close(c); return; }
    if (c.buf.length < off + 4 + len) return;
    const mask = c.buf.subarray(off, off + 4);
    const data = Buffer.from(c.buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    c.buf = c.buf.subarray(off + 4 + len);
    if (op === 0x8) { close(c); return; }
    if (op === 0x9) {
      if (data.length <= 125) { try { c.socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); } catch (e) { /* ignore */ } }
      continue;
    }
    if (op === 0xA) { c.alive = true; continue; }
    if (op !== 0x1 || !fin) continue;
    handle(c, data.toString('utf8'));
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const path0 = req.url.split('?')[0];
  if (path0 !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || clients.size >= MAX_PLAYERS) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  const id = String(nextId++);
  const c = { id, socket, open: true, state: null, last: 0, alive: true, buf: Buffer.alloc(0) };
  clients.set(id, c);

  const others = [];
  for (const o of clients.values()) if (o !== c && o.state) others.push({ i: o.id, d: o.state });
  send(c, { t: 'hello', i: id, v: 5, peers: others });

  socket.on('data', (chunk) => {
    c.buf = Buffer.concat([c.buf, chunk]);
    if (c.buf.length > 40000) { close(c); return; }
    parse(c);
  });
  socket.on('close', () => close(c));
  socket.on('error', () => close(c));
  socket.on('end', () => close(c));
});

setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { close(c); continue; }
    c.alive = false;
    try { c.socket.write(Buffer.from([0x89, 0])); } catch (e) { /* ignore */ }
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Açıq Yol Yarışı serveri işləyir: http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) console.log('Eyni Wi-Fi-dakı dostlar üçün: http://' + n.address + ':' + PORT);
    }
  }
});
