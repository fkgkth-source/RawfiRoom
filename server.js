// RawfiRoom 서버: 정적 파일 + WebRTC 시그널링 + Yjs 실시간 동기화 + 원본(무손실) 파일 보관
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8787;
const MAX_UPLOAD = 2 * 1024 ** 3; // 2GB (Logic 바운스 WAV/AIFF 원본)

fs.mkdirSync(path.join(DATA, 'rooms'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'files'), { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.caf': 'audio/x-caf', '.mid': 'audio/midi', '.midi': 'audio/midi',
  '.zip': 'application/zip', '.xml': 'application/xml', '.musicxml': 'application/vnd.recordare.musicxml+xml',
};

const ROOM_RE = /^[a-z0-9]{3,10}(-[a-z0-9]{3,10}){0,3}$/;
const rooms = new Map();

function roomPaths(id) {
  return { bin: path.join(DATA, 'rooms', id + '.bin'), meta: path.join(DATA, 'rooms', id + '.json') };
}

function getRoom(id) {
  let r = rooms.get(id);
  if (r) return r;
  const p = roomPaths(id);
  const doc = new Y.Doc();
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')); } catch {}
  try { Y.applyUpdate(doc, fs.readFileSync(p.bin)); } catch {}
  r = { id, doc, hostKey: meta.hostKey || null, created: meta.created || Date.now(), clients: new Map(), timer: null };
  rooms.set(id, r);
  return r;
}

function persist(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    const p = roomPaths(room.id);
    fs.writeFile(p.bin, Y.encodeStateAsUpdate(room.doc), () => {});
    fs.writeFile(p.meta, JSON.stringify({ hostKey: room.hostKey, created: room.created }), () => {});
  }, 800);
}

function newRoomCode() {
  const a = 'abcdefghijkmnopqrstuvwxyz';
  const pick = n => Array.from(crypto.randomBytes(n), b => a[b % a.length]).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

function iceServers() {
  const list = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
  if (process.env.TURN_URL) {
    list.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  }
  return list;
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }

async function serveFile(req, res, fp, download = false) {
  let st;
  try { st = await fsp.stat(fp); } catch { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  const ext = path.extname(fp).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': fp.startsWith(PUBLIC) ? 'no-cache' : 'private, max-age=86400',
  };
  if (download) {
    const name = path.basename(fp).replace(/^[a-f0-9]+__/, '');
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    let start = range[1] ? +range[1] : 0;
    let end = range[2] ? +range[2] : st.size - 1;
    if (!range[1] && range[2]) { start = Math.max(0, st.size - +range[2]); end = st.size - 1; }
    if (start > end || end >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(fp, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(fp).pipe(res);
}

function handleUpload(req, res, url) {
  const room = url.searchParams.get('room') || '';
  if (!ROOM_RE.test(room)) return json(res, { error: 'bad room' }, 400);
  const len = +req.headers['content-length'] || 0;
  if (len > MAX_UPLOAD) return json(res, { error: '파일이 너무 큽니다 (최대 2GB)' }, 413);
  const name = (url.searchParams.get('name') || 'file').normalize('NFC')
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(-150) || 'file';
  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(DATA, 'files', room);
  fs.mkdirSync(dir, { recursive: true });
  const fname = `${id}__${name}`;
  const fp = path.join(dir, fname);
  const out = fs.createWriteStream(fp);
  let size = 0, aborted = false;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_UPLOAD && !aborted) { aborted = true; req.destroy(); out.destroy(); fs.unlink(fp, () => {}); }
  });
  req.on('aborted', () => { aborted = true; out.destroy(); fs.unlink(fp, () => {}); });
  req.pipe(out);
  out.on('finish', () => { if (!aborted) json(res, { id, name, size, url: `/files/${room}/${encodeURIComponent(fname)}` }); });
  out.on('error', () => { if (!res.headersSent) json(res, { error: 'write failed' }, 500); });
}

function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsDate(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

function handleIcs(req, res, roomId, lessonId) {
  const room = getRoom(roomId);
  const l = room.doc.getMap('lessons').get(lessonId);
  if (!l) return notFound(res);
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const link = `${proto}://${req.headers.host}/r/${roomId}`;
  const start = new Date(l.start);
  const end = new Date(start.getTime() + (l.dur || 60) * 60000);
  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RawfiRoom//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${lessonId}@rawfiroom`, `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(l.title || '레슨')}`,
    `DESCRIPTION:${icsEscape((l.memo ? l.memo + '\n\n' : '') + 'RawfiRoom 입장 링크: ' + link)}`,
    `LOCATION:${icsEscape(link)}`, `URL:${link}`,
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:30분 후 레슨', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `inline; filename="lesson-${lessonId}.ics"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { return notFound(res); }
    let m;

    if (req.method === 'POST' && p === '/api/rooms') {
      let code;
      do { code = newRoomCode(); } while (rooms.has(code) || fs.existsSync(roomPaths(code).meta));
      const room = getRoom(code);
      room.hostKey = crypto.randomBytes(16).toString('hex');
      persist(room);
      return json(res, { room: code, hostKey: room.hostKey });
    }
    if (p === '/api/config') return json(res, { iceServers: iceServers() });
    if ((m = p.match(/^\/api\/rooms\/([a-z0-9-]+)$/)) && ROOM_RE.test(m[1])) {
      const r = getRoom(m[1]);
      return json(res, { mode: r.doc.getMap('room').get('mode') || 'lesson', online: r.clients.size });
    }
    if (req.method === 'POST' && p === '/api/upload') return handleUpload(req, res, url);
    if ((m = p.match(/^\/api\/ics\/([a-z0-9-]+)\/([a-z0-9]+)\.ics$/)) && ROOM_RE.test(m[1])) return handleIcs(req, res, m[1], m[2]);
    if ((m = p.match(/^\/files\/([a-z0-9-]+)\/([a-f0-9]+__[^/]+)$/)) && ROOM_RE.test(m[1])) {
      return serveFile(req, res, path.join(DATA, 'files', m[1], m[2]), url.searchParams.has('dl'));
    }
    if (p === '/' || /^\/r\/[a-z0-9-]+\/?$/.test(p)) return serveFile(req, res, path.join(PUBLIC, 'index.html'));
    const fp = path.join(PUBLIC, path.normalize(p));
    if (!fp.startsWith(PUBLIC + path.sep)) return notFound(res);
    return serveFile(req, res, fp);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500); res.end('error'); }
  }
});

// ── WebSocket: 시그널링 + 동기화 ─────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 * 1024 });
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (room, obj, exceptId) => {
  const s = JSON.stringify(obj);
  for (const [id, c] of room.clients) if (id !== exceptId && c.ws.readyState === 1) c.ws.send(s);
};

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room') || '';
  if (!ROOM_RE.test(roomId)) return ws.close(1008, 'bad room');
  const room = getRoom(roomId);
  const id = crypto.randomBytes(4).toString('hex');
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !me) {
      let role = 'student';
      if (m.hostKey && typeof m.hostKey === 'string') {
        if (!room.hostKey) { room.hostKey = m.hostKey; persist(room); }
        if (room.hostKey === m.hostKey) role = 'teacher';
      }
      me = { ws, id, name: String(m.name || '게스트').slice(0, 40), role };
      const peers = [...room.clients.values()].map(c => ({ id: c.id, name: c.name, role: c.role }));
      room.clients.set(id, me);
      send(ws, { t: 'welcome', id, role, peers, y: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64') });
      broadcast(room, { t: 'peer-join', id, name: me.name, role }, id);
      return;
    }
    if (!me) return;
    switch (m.t) {
      case 'signal': {
        const to = room.clients.get(m.to);
        if (to) send(to.ws, { t: 'signal', from: id, data: m.data });
        break;
      }
      case 'y': {
        try {
          Y.applyUpdate(room.doc, Buffer.from(m.u, 'base64'));
          broadcast(room, { t: 'y', u: m.u }, id);
          persist(room);
        } catch (e) { console.warn('bad y update', e.message); }
        break;
      }
      case 'eph': {
        const msg = { t: 'eph', from: id, d: m.d };
        if (m.to) { const to = room.clients.get(m.to); if (to) send(to.ws, msg); }
        else broadcast(room, msg, id);
        break;
      }
      case 'ping': send(ws, { t: 'pong', ts: m.ts }); break;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    room.clients.delete(id);
    broadcast(room, { t: 'peer-leave', id });
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

server.listen(PORT, () => {
  console.log(`\n  🎹 RawfiRoom 서버 실행 중 → http://localhost:${PORT}\n`);
});
