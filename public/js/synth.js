// 브라우저 내장 가상악기 (Web Audio). 네트워크로는 MIDI만 오가서 지연·음질 손실이 거의 없음.
export const INSTRUMENTS = [
  { id: 'piano', name: '그랜드 피아노', emoji: '🎹' },
  { id: 'epiano', name: '일렉트릭 피아노', emoji: '✨' },
  { id: 'guitar', name: '어쿠스틱 기타', emoji: '🎸' },
  { id: 'nylon', name: '나일론 기타', emoji: '🪕' },
  { id: 'bass', name: '베이스', emoji: '🎚️' },
  { id: 'organ', name: '오르간', emoji: '⛪' },
  { id: 'pad', name: '신스 패드', emoji: '🌫️' },
  { id: 'strings', name: '스트링', emoji: '🎻' },
];
const mtof = n => 440 * Math.pow(2, (n - 69) / 12);

export class Synth {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    this.revSend = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = this.impulse(2.4);
    this.bus.connect(this.revSend); this.revSend.connect(conv); conv.connect(this.master);
    // 기타 바디 공명
    this.gtr = ctx.createBiquadFilter(); this.gtr.type = 'peaking'; this.gtr.frequency.value = 180; this.gtr.Q.value = 1.2; this.gtr.gain.value = 4;
    const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 5000; shelf.gain.value = -3;
    this.gtr.connect(shelf); shelf.connect(this.bus);

    this.voices = new Map(); this.sus = new Map(); this.held = new Map(); this.ks = new Map();
    this.waves = {
      piano: this.wave([0, 1, 0.55, 0.32, 0.2, 0.12, 0.08, 0.05, 0.035, 0.02, 0.012]),
      organ: this.wave([0, 1, 0.9, 0.5, 0.55, 0, 0.35, 0, 0.3]),
    };
  }
  setVolume(v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setReverb(v) { this.revSend.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  wave(amps) {
    const imag = new Float32Array(amps), real = new Float32Array(amps.length);
    return this.ctx.createPeriodicWave(real, imag);
  }
  impulse(sec) {
    const sr = this.ctx.sampleRate, len = Math.floor(sr * sec), b = this.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2) * (i < sr * 0.01 ? i / (sr * 0.01) : 1);
    }
    return b;
  }

  noteOn(src, note, vel, inst) {
    if (this.ctx.state !== 'running') this.ctx.resume();
    const k = src + ':' + note;
    const prev = this.voices.get(k);
    if (prev) prev.stop(this.ctx.currentTime, true);
    this.held.get(src)?.delete(note);
    const v = this.make(inst, note, Math.max(1, vel));
    if (!v) return;
    v.born = this.ctx.currentTime;
    this.voices.set(k, v);
    if (this.voices.size > 72) {
      const [ok, ov] = [...this.voices.entries()].sort((a, b) => a[1].born - b[1].born)[0];
      ov.stop(this.ctx.currentTime, true); this.voices.delete(ok);
    }
  }
  noteOff(src, note) {
    if (this.sus.get(src)) {
      if (!this.held.has(src)) this.held.set(src, new Set());
      this.held.get(src).add(note);
      return;
    }
    this.release(src, note);
  }
  release(src, note) {
    const k = src + ':' + note, v = this.voices.get(k);
    if (v) { v.stop(this.ctx.currentTime); this.voices.delete(k); }
  }
  setSustain(src, on) {
    this.sus.set(src, on);
    if (!on) { const h = this.held.get(src); if (h) { for (const n of h) this.release(src, n); h.clear(); } }
  }
  allOff(src) {
    for (const [k, v] of this.voices) if (!src || k.startsWith(src + ':')) { v.stop(this.ctx.currentTime, true); this.voices.delete(k); }
    if (src) { this.sus.delete(src); this.held.delete(src); } else { this.sus.clear(); this.held.clear(); }
  }

  env(g, t, peak, attack) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
  }
  stopper(g, nodes, rel) {
    const ctx = this.ctx;
    return {
      stop(t, fast) {
        const r = fast ? 0.015 : rel;
        try {
          if (g.gain.cancelAndHoldAtTime) g.gain.cancelAndHoldAtTime(t);
          else { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); }
          g.gain.setTargetAtTime(0, t, r / 4);
          for (const n of nodes) n.stop?.(t + r * 1.5 + 0.05);
        } catch {}
        setTimeout(() => { try { g.disconnect(); } catch {} }, (r * 1.5 + 0.2) * 1000 + (t - ctx.currentTime) * 1000);
      },
    };
  }

  make(inst, note, vel) {
    const ctx = this.ctx, t = ctx.currentTime, f = mtof(note), vn = vel / 127;
    const g = ctx.createGain();
    switch (inst) {
      case 'guitar': case 'nylon': case 'bass-pluck': {
        const src = ctx.createBufferSource();
        src.buffer = this.karplus(note, vel, inst);
        g.gain.value = Math.pow(vn, 1.2) * (inst === 'nylon' ? 1.0 : 0.85);
        src.connect(g); g.connect(this.gtr); src.start(t);
        return this.stopper(g, [src], 0.12);
      }
      case 'epiano': {
        const car = ctx.createOscillator(), mod = ctx.createOscillator(), tine = ctx.createOscillator();
        const mg = ctx.createGain(), tg = ctx.createGain();
        car.frequency.value = f; mod.frequency.value = f; tine.frequency.value = f * 14;
        mg.gain.setValueAtTime(f * (0.6 + 2.8 * vn), t); mg.gain.setTargetAtTime(f * 0.25, t, 0.35);
        tg.gain.setValueAtTime(f * 1.6 * vn, t); tg.gain.setTargetAtTime(0, t, 0.03);
        mod.connect(mg); mg.connect(car.frequency); tine.connect(tg); tg.connect(car.frequency);
        const a = Math.pow(vn, 1.4) * 0.42, dec = Math.max(0.8, 4 - (note - 40) * 0.045);
        this.env(g, t, a, 0.004); g.gain.setTargetAtTime(a * 0.5, t + 0.004, 0.25); g.gain.setTargetAtTime(0, t + 0.5, dec / 3);
        car.connect(g); g.connect(this.bus);
        for (const o of [car, mod, tine]) { o.start(t); o.stop(t + 12); }
        return this.stopper(g, [car, mod, tine], 0.25);
      }
      case 'organ': {
        const o = ctx.createOscillator(); o.setPeriodicWave(this.waves.organ); o.frequency.value = f;
        const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 6.2; lg.gain.value = f * 0.004;
        lfo.connect(lg); lg.connect(o.frequency);
        this.env(g, t, 0.14 + 0.08 * vn, 0.012);
        o.connect(g); g.connect(this.bus); o.start(t); lfo.start(t);
        return this.stopper(g, [o, lfo], 0.08);
      }
      case 'pad': case 'strings': {
        const isStr = inst === 'strings';
        const nodes = [];
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = isStr ? 0.7 : 1.2;
        lp.frequency.setValueAtTime(isStr ? 1800 + 2500 * vn : 700 + 1600 * vn, t);
        for (const d of isStr ? [-9, -3, 4, 10] : [-8, 0, 8]) {
          const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d;
          o.connect(lp); o.start(t); nodes.push(o);
        }
        if (isStr) {
          const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 5.3; lg.gain.value = 6;
          lfo.connect(lg); for (const o of nodes) lg.connect(o.detune); lfo.start(t); nodes.push(lfo);
        }
        this.env(g, t, (isStr ? 0.09 : 0.08) + 0.05 * vn, isStr ? 0.18 : 0.45);
        lp.connect(g); g.connect(this.bus);
        return this.stopper(g, nodes, isStr ? 0.5 : 1.1);
      }
      case 'bass': {
        const o = ctx.createOscillator(), s = ctx.createOscillator(); o.type = 'sawtooth'; s.type = 'sine';
        o.frequency.value = f; s.frequency.value = f;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
        lp.frequency.setValueAtTime(300 + 2600 * vn, t); lp.frequency.setTargetAtTime(220 + f, t, 0.12);
        const sg = ctx.createGain(); sg.gain.value = 0.7;
        o.connect(lp); s.connect(sg); sg.connect(g); lp.connect(g); g.connect(this.bus);
        const a = 0.22 + 0.2 * vn;
        this.env(g, t, a, 0.005); g.gain.setTargetAtTime(a * 0.6, t + 0.005, 0.3);
        o.start(t); s.start(t);
        return this.stopper(g, [o, s], 0.09);
      }
      case 'piano': default: {
        const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
        o1.setPeriodicWave(this.waves.piano); o2.setPeriodicWave(this.waves.piano);
        o1.frequency.value = f; o2.frequency.value = f; o1.detune.value = -2.5; o2.detune.value = 3;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.4;
        lp.frequency.setValueAtTime(Math.min(18000, f * (3 + 9 * vn)), t);
        lp.frequency.setTargetAtTime(Math.min(14000, f * 2.4), t, 0.5);
        const a = Math.pow(vn, 1.5) * 0.32, dec = Math.min(7, Math.max(0.9, 7 - (note - 21) * 0.075));
        this.env(g, t, a, 0.003);
        g.gain.setTargetAtTime(a * 0.45, t + 0.003, 0.12);
        g.gain.setTargetAtTime(0, t + 0.25, dec / 4);
        // 해머 노이즈
        const nb = ctx.createBufferSource(); nb.buffer = this.noise(); const ng = ctx.createGain(); const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = Math.min(8000, f * 4); bp.Q.value = 1.5;
        ng.gain.setValueAtTime(0.06 * vn, t); ng.gain.setTargetAtTime(0, t, 0.012);
        nb.connect(bp); bp.connect(ng); ng.connect(this.bus); nb.start(t); nb.stop(t + 0.1);
        o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(this.bus);
        o1.start(t); o2.start(t); o1.stop(t + dec * 2.5); o2.stop(t + dec * 2.5);
        return this.stopper(g, [o1, o2], 0.28);
      }
    }
  }

  noise() {
    if (!this._noise) {
      const b = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.1, this.ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this._noise = b;
    }
    return this._noise;
  }

  // Karplus-Strong 현 모델 (분수 지연 올패스로 정확한 음정), 노트별 캐시
  karplus(note, vel, inst) {
    const bucket = Math.min(3, Math.floor(vel / 32));
    const key = `${inst}:${note}:${bucket}`;
    if (this.ks.has(key)) return this.ks.get(key);
    const sr = this.ctx.sampleRate, f = mtof(note);
    const dur = Math.min(5, Math.max(1.4, 5.5 - (note - 40) * 0.07));
    const P = sr / f - 0.5;
    let N = Math.floor(P), frac = P - N;
    if (frac < 0.1) { N -= 1; frac += 1; }
    const C = (1 - frac) / (1 + frac);
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    const ring = new Float32Array(N);
    const bright = (inst === 'nylon' ? 0.25 : 0.45) + 0.5 * ((bucket + 1) / 4);
    let last = 0, mean = 0;
    for (let i = 0; i < N; i++) { const r = Math.random() * 2 - 1; last += bright * (r - last); ring[i] = last; mean += last; }
    mean /= N; for (let i = 0; i < N; i++) ring[i] -= mean;
    const decay = Math.pow(0.001, 1 / (f * dur * (inst === 'nylon' ? 0.8 : 1)));
    let idx = 0, prevX = 0, apX = 0, apY = 0, peak = 0;
    for (let i = 0; i < len; i++) {
      const x = ring[idx];
      const avg = 0.5 * (x + prevX); prevX = x;
      const ap = C * avg + apX - C * apY; apX = avg; apY = ap;
      ring[idx] = ap * decay;
      d[i] = x;
      const a = Math.abs(x); if (a > peak) peak = a;
      if (++idx >= N) idx = 0;
    }
    const norm = peak > 0 ? 0.9 / peak : 1;
    for (let i = 0; i < len; i++) d[i] *= norm * (i > len - 2000 ? (len - i) / 2000 : 1);
    this.ks.set(key, buf);
    return buf;
  }
}
