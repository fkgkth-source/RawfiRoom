// 서버 연결 (WebSocket) + Yjs 공유 문서
import * as Y from 'https://cdn.jsdelivr.net/npm/yjs@13.6.20/+esm';
export { Y };

const b64e = u8 => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export class Net {
  constructor(roomId, name, hostKey) {
    this.roomId = roomId; this.name = name; this.hostKey = hostKey;
    this.doc = new Y.Doc();
    this.handlers = new Map();
    this.ready = false; this.joinedOnce = false; this.closed = false;
    this.doc.on('update', (u, origin) => {
      if (origin !== 'remote') this.send({ t: 'y', u: b64e(u) });
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  dispatch(m) { for (const fn of this.handlers.get(m.t) || []) { try { fn(m); } catch (e) { console.error(e); } } }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(this.roomId)}`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: this.name, hostKey: this.hostKey }));
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome') {
        Y.applyUpdate(this.doc, b64d(m.y), 'remote');
        this.ready = true;
        // 재접속이면 오프라인 중 편집한 내용을 서버에 합침
        if (this.joinedOnce) this.send({ t: 'y', u: b64e(Y.encodeStateAsUpdate(this.doc)) });
        this.joinedOnce = true;
      } else if (m.t === 'y') {
        try { Y.applyUpdate(this.doc, b64d(m.u), 'remote'); } catch (err) { console.warn(err); }
      }
      this.dispatch(m);
    };
    ws.onclose = () => {
      const was = this.ready;
      this.ready = false;
      if (was) this.dispatch({ t: 'disconnected' });
      if (!this.closed) setTimeout(() => this.connect(), 1500);
    };
  }

  send(m) {
    if (this.ready && this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }
  eph(d, to) { this.send({ t: 'eph', d, to }); }
  close() { this.closed = true; try { this.ws?.close(); } catch {} }
}
