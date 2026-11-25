// 공유 시계: 선생님(없으면 id가 가장 작은 참가자)을 기준으로 NTP 방식 오프셋 계산
// → 메트로놈을 두 기기에서 같은 순간에 울리고, MIDI 이벤트에 정확한 타임스탬프를 붙임
import { app, on, emit } from './util.js';

const wall = () => performance.timeOrigin + performance.now();

export const clock = {
  offset: 0,      // master시간 - 내시간 (ms)
  rtt: null,      // 데이터채널 왕복 (ms)
  master: null,
  samples: [],
  now() { return wall() + this.offset; },
  toLocalPerf(masterMs) { return masterMs - this.offset - performance.timeOrigin; },
  isMaster() { return this.master === app.me?.id; },
};

function pickMaster() {
  const all = [{ id: app.me.id, role: app.me.role }, ...[...app.peers.values()]];
  const t = all.filter(p => p.role === 'teacher').sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  const m = (t || all.sort((a, b) => (a.id < b.id ? -1 : 1))[0]).id;
  if (m !== clock.master) { clock.master = m; clock.samples = []; if (m === app.me.id) { clock.offset = 0; } emit('clock'); }
}

export function initClock() {
  app.clock = clock;
  on('peers', () => { if (app.me?.id) pickMaster(); });
  on('remote-data', ({ from, d }) => {
    if (d.t === 'cping') app.rtc.sendTo(from, { t: 'cpong', a: d.a, b: clock.now() }, { fast: true });
    else if (d.t === 'cpong' && from === clock.master) {
      const c = wall(), rtt = c - d.a;
      if (rtt < 0 || rtt > 3000) return;
      clock.samples.push({ rtt, off: d.b + rtt / 2 - c });
      if (clock.samples.length > 12) clock.samples.shift();
      const best = [...clock.samples].sort((x, y) => x.rtt - y.rtt)[0]; // 가장 빠른 왕복이 가장 정확
      clock.offset = best.off;
      clock.rtt = clock.samples.slice(-5).reduce((s, x) => s + x.rtt, 0) / Math.min(5, clock.samples.length);
      emit('clock');
    }
  });
  setInterval(() => {
    if (!app.me?.id || !clock.master || clock.isMaster() || !app.peers.has(clock.master)) return;
    app.rtc.sendTo(clock.master, { t: 'cping', a: wall() }, { fast: true });
  }, clock.samples.length < 6 ? 400 : 1500);
  // 기준이 아닌 쪽도 상대와의 RTT를 알 수 있게 기준 쪽도 측정
  setInterval(() => {
    if (!clock.isMaster()) return;
    for (const id of app.peers.keys()) app.rtc.sendTo(id, { t: 'rping', a: wall() }, { fast: true });
  }, 1500);
  on('remote-data', ({ from, d }) => {
    if (d.t === 'rping') app.rtc.sendTo(from, { t: 'rpong', a: d.a }, { fast: true });
    else if (d.t === 'rpong') { clock.rtt = wall() - d.a; emit('clock'); }
  });
}
