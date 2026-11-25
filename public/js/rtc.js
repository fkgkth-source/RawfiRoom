// WebRTC P2P: 고음질 스테레오 Opus, 저지연 재생, MIDI 데이터채널, 화면공유 (Perfect Negotiation)
import { app, emit } from './util.js';

// Opus를 스테레오·최대 비트레이트·FEC·DTX 꺼짐으로 설정 (음악용)
export function mungeSdp(sdp, kbps, low = app.settings.jamLowLatency) {
  if (low) sdp = sdp.replace(/a=(max)?ptime:\d+\r\n/g, '');
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const want = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(kbps * 1000), maxplaybackrate: '48000', useinbandfec: '1', usedtx: '0', minptime: '10' };
  const re = new RegExp(`a=fmtp:${pt} (.*)`, 'g');
  if (re.test(sdp)) {
    return sdp.replace(re, (_all, params) => {
      const kv = {};
      for (const p of params.split(';')) { const [k, v] = p.trim().split('='); if (k) kv[k] = v; }
      Object.assign(kv, want);
      // 합주 모드: Opus 프레임 20ms → 10ms (패킷당 지연 절반)
      return `a=fmtp:${pt} ` + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(';') + (low ? '\r\na=ptime:10\r\na=maxptime:10' : '');
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ` + Object.entries(want).map(([k, v]) => `${k}=${v}`).join(';'));
}

export class RTC {
  constructor(net, iceServers) {
    this.net = net; this.ice = iceServers;
    this.peers = new Map();
    this.local = { cam: null, daw: null, screen: null }; // kind -> MediaStream (컨테이너)
    this.audioKbps = app.settings.audioKbps;

    net.on('welcome', m => { this.closeAll(); for (const p of m.peers) this.addPeer(p.id); });
    net.on('peer-join', m => this.addPeer(m.id));
    net.on('peer-leave', m => this.removePeer(m.id));
    net.on('signal', m => this.onSignal(m.from, m.data));
    net.on('disconnected', () => this.closeAll());
    net.on('eph', m => {
      const d = m.d || {};
      if (d.t === 'streams') this.onStreamMap(m.from, d.map);
      else if (['midi', 'cc', 'cping', 'cpong', 'rping', 'rpong'].includes(d.t)) emit('remote-data', { from: m.from, d });
    });
    this.prevStats = new Map();
    setInterval(() => this.pollStats(), 2000);
  }

  sig(to, data) { this.net.send({ t: 'signal', to, data }); }

  addPeer(id) {
    if (this.peers.has(id)) return this.peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' });
    const p = { id, pc, polite: app.me.id < id, makingOffer: false, ignoreOffer: false, senders: new Map(), rstreams: new Map(), kinds: {} };
    this.peers.set(id, p);

    // 협상 없이 열리는 저지연 데이터채널 (MIDI·잉크)
    p.dc = pc.createDataChannel('rt', { negotiated: true, id: 0, ordered: true });
    p.dc.onmessage = e => { try { emit('remote-data', { from: id, d: JSON.parse(e.data) }); } catch {} };
    p.dc.onopen = () => emit('peer-state', { id, dc: 'open' });
    // 합주용: 순서 보장/재전송 최소화로 대기 없는 채널
    p.fast = pc.createDataChannel('fast', { negotiated: true, id: 1, ordered: false, maxRetransmits: 1 });
    p.fast.onmessage = p.dc.onmessage;

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription({ type: 'offer', sdp: mungeSdp(offer.sdp, this.audioKbps) });
        this.sig(id, { desc: pc.localDescription });
      } catch (e) { console.warn('offer', e); } finally { p.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.sig(id, { cand: candidate }); };
    pc.ontrack = e => this.onTrack(p, e);
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      emit('peer-state', { id, state: s });
      if (s === 'connected') for (const rec of p.senders.values()) this.tune(rec.s, rec.kind);
      if (s === 'failed') { try { pc.restartIce(); } catch {} }
    };

    for (const [kind, st] of Object.entries(this.local)) {
      if (st) for (const t of st.getTracks()) this.addSender(p, kind, t, st);
    }
    this.sendStreamMap(id);
    return p;
  }

  removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch {}
    this.peers.delete(id);
    this.prevStats.delete(id);
    emit('remote-media', { id, media: {} });
  }
  closeAll() { for (const id of [...this.peers.keys()]) this.removePeer(id); }

  async onSignal(from, data) {
    const p = this.peers.get(from) || this.addPeer(from);
    const pc = p.pc;
    try {
      if (data.desc) {
        const d = data.desc;
        const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription({ type: 'answer', sdp: mungeSdp(ans.sdp, this.audioKbps) });
          this.sig(from, { desc: pc.localDescription });
        }
      } else if (data.cand) {
        try { await pc.addIceCandidate(data.cand); } catch (e) { if (!p.ignoreOffer) console.warn(e); }
      }
    } catch (e) { console.warn('signal', e); }
  }

  onTrack(p, e) {
    const st = e.streams[0] || new MediaStream([e.track]);
    // 지터 버퍼 최소화 → 체감 지연 감소
    try {
      if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0;
      else if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
    } catch {}
    p.rstreams.set(st.id, st);
    st.onremovetrack = () => { if (!st.getTracks().length) p.rstreams.delete(st.id); this.emitMedia(p); };
    e.track.onunmute = () => this.emitMedia(p);
    this.emitMedia(p);
  }

  emitMedia(p) {
    const media = {};
    for (const [sid, st] of p.rstreams) {
      const kind = p.kinds[sid];
      if (kind && st.getTracks().length) media[kind] = st;
    }
    emit('remote-media', { id: p.id, media });
  }

  onStreamMap(from, map) {
    const p = this.peers.get(from);
    if (!p) return;
    p.kinds = map || {};
    for (const sid of [...p.rstreams.keys()]) if (!p.kinds[sid]) p.rstreams.delete(sid);
    this.emitMedia(p);
  }
  streamMap() {
    const map = {};
    for (const [k, s] of Object.entries(this.local)) if (s && s.getTracks().length) map[s.id] = k;
    return map;
  }
  sendStreamMap(to) { this.net.eph({ t: 'streams', map: this.streamMap() }, to); }

  addSender(p, kind, track, stream) {
    const s = p.pc.addTrack(track, stream);
    p.senders.set(track.id, { s, kind });
    this.tune(s, kind);
  }

  async tune(s, kind) {
    const track = s.track;
    if (!track) return;
    try {
      const prm = s.getParameters();
      if (!prm.encodings || !prm.encodings.length) return; // 협상 후 다시 호출됨
      const e = prm.encodings[0];
      if (track.kind === 'audio') {
        e.maxBitrate = this.audioKbps * 1000;
        e.priority = 'high'; e.networkPriority = 'high';
      } else {
        const jam = app.settings.jamLowLatency;
        e.maxBitrate = kind === 'screen' ? (jam ? 1_500_000 : 6_000_000) : jam ? 600_000 : (app.settings.hd ? 3_500_000 : 2_000_000);
        if (kind === 'cam') e.scaleResolutionDownBy = jam ? 2 : 1;
        e.networkPriority = jam ? 'very-low' : 'medium';
        prm.degradationPreference = kind === 'screen' ? 'maintain-resolution' : 'balanced';
      }
      await s.setParameters(prm);
    } catch (err) { /* 일부 브라우저 미지원 */ }
  }

  setAudioKbps(kbps) {
    this.audioKbps = kbps;
    for (const p of this.peers.values()) for (const rec of p.senders.values()) this.tune(rec.s, rec.kind);
  }

  // kind: cam|daw|screen, trackKind: audio|video. 같은 스트림 id를 유지해서 상대가 종류를 구분.
  setTrack(kind, newTrack, trackKind) {
    let st = this.local[kind];
    if (!st) { if (!newTrack) return; st = this.local[kind] = new MediaStream(); }
    const old = st.getTracks().find(t => t.kind === trackKind) || null;
    if (old === newTrack) return;
    if (old) st.removeTrack(old);
    if (newTrack) st.addTrack(newTrack);
    for (const p of this.peers.values()) {
      const rec = old && p.senders.get(old.id);
      if (rec) {
        p.senders.delete(old.id);
        if (newTrack) { rec.s.replaceTrack(newTrack).catch(() => {}); p.senders.set(newTrack.id, rec); this.tune(rec.s, kind); }
        else { try { p.pc.removeTrack(rec.s); } catch {} }
      } else if (newTrack) this.addSender(p, kind, newTrack, st);
    }
    if (!st.getTracks().length) this.local[kind] = null;
    this.sendStreamMap();
  }

  // 저지연 데이터 전송 (데이터채널 → 안 열렸으면 서버 경유)
  sendData(d, { fast = false } = {}) {
    for (const p of this.peers.values()) this.sendTo(p.id, d, { fast });
  }
  sendTo(id, d, { fast = false } = {}) {
    const p = this.peers.get(id);
    if (!p) return;
    const s = JSON.stringify(d);
    const ch = fast && app.settings.jamLowLatency && p.fast?.readyState === 'open' ? p.fast : p.dc;
    if (ch?.readyState === 'open') { try { ch.send(s); return; } catch {} }
    this.net.eph(d, id);
  }
  // 설정 변경(합주 모드 등)을 SDP에 반영하도록 재협상
  renegotiate() {
    for (const p of this.peers.values()) {
      try { p.pc.restartIce(); } catch {}
      for (const rec of p.senders.values()) this.tune(rec.s, rec.kind);
    }
  }

  async pollStats() {
    for (const p of this.peers.values()) {
      if (p.pc.connectionState !== 'connected') continue;
      try {
        const rep = await p.pc.getStats();
        const out = { id: p.id, rtt: null, jitter: null, jb: null, lossPct: null, inKbps: null, outKbps: null, codec: null, local: null, remote: null };
        let inBytes = 0, outBytes = 0, recv = 0, lost = 0, jbDelay = 0, jbCount = 0, jit = [];
        const codecs = new Map();
        rep.forEach(r => { if (r.type === 'codec') codecs.set(r.id, r); });
        rep.forEach(r => {
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
            out.rtt = r.currentRoundTripTime != null ? r.currentRoundTripTime * 1000 : null;
            const lc = rep.get(r.localCandidateId), rc = rep.get(r.remoteCandidateId);
            out.local = lc?.candidateType; out.remote = rc?.candidateType;
          }
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            inBytes += r.bytesReceived || 0; recv += r.packetsReceived || 0; lost += r.packetsLost || 0;
            if (r.jitter != null) jit.push(r.jitter * 1000);
            jbDelay += r.jitterBufferDelay || 0; jbCount += r.jitterBufferEmittedCount || 0;
            const c = codecs.get(r.codecId);
            if (c) out.codec = `${c.mimeType.split('/')[1]} ${c.clockRate / 1000}kHz ${c.channels || 1}ch`;
          }
          if (r.type === 'outbound-rtp' && r.kind === 'audio') outBytes += r.bytesSent || 0;
        });
        const prev = this.prevStats.get(p.id);
        const now = performance.now();
        if (prev) {
          const dt = (now - prev.t) / 1000;
          out.inKbps = Math.max(0, (inBytes - prev.inBytes) * 8 / 1000 / dt);
          out.outKbps = Math.max(0, (outBytes - prev.outBytes) * 8 / 1000 / dt);
          const dr = recv - prev.recv, dl = lost - prev.lost;
          out.lossPct = dr + dl > 0 ? Math.max(0, dl) / (dr + dl) * 100 : 0;
          if (jbCount - prev.jbCount > 0) out.jb = (jbDelay - prev.jbDelay) / (jbCount - prev.jbCount) * 1000;
        }
        out.jitter = jit.length ? Math.max(...jit) : null;
        this.prevStats.set(p.id, { t: now, inBytes, outBytes, recv, lost, jbDelay, jbCount });
        emit('stats', out);
      } catch {}
    }
  }
}
