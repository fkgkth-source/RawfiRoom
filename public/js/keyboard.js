// 하단 터치 건반 + 기타 지판 (멀티터치, 글리산도, 상대 연주 실시간 표시)
import { h } from './util.js';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = n => NAMES[n % 12] + (Math.floor(n / 12) - 1);
const isBlack = n => [1, 3, 6, 8, 10].includes(n % 12);

class Surface {
  constructor(el, { onNote }) {
    this.el = el; this.onNote = onNote;
    this.ptr = new Map(); this.down = new Map(); this.lit = new Map();
    el.addEventListener('pointerdown', e => this.pd(e));
    el.addEventListener('pointermove', e => this.pm(e));
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, e => this.pu(e));
    el.addEventListener('contextmenu', e => e.preventDefault());
  }
  hit(e) {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const k = t && t.closest && t.closest('[data-note]');
    return k && this.el.contains(k) ? { n: +k.dataset.note, k } : null;
  }
  vel(e, k) {
    const r = k.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return Math.round(48 + f * 79); // 건반 아래쪽을 누를수록 세게
  }
  pd(e) {
    if (e.button > 0) return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch {}
    const hit = this.hit(e);
    if (!hit) return;
    this.ptr.set(e.pointerId, hit.n);
    this.press(hit.n, this.vel(e, hit.k));
  }
  pm(e) {
    if (!this.ptr.has(e.pointerId)) return;
    const hit = this.hit(e), cur = this.ptr.get(e.pointerId), n = hit ? hit.n : null;
    if (n === cur) return;
    if (cur != null) this.release(cur);
    if (n != null) this.press(n, this.vel(e, hit.k));
    this.ptr.set(e.pointerId, n);
  }
  pu(e) {
    if (!this.ptr.has(e.pointerId)) return;
    const cur = this.ptr.get(e.pointerId);
    this.ptr.delete(e.pointerId);
    if (cur != null) this.release(cur);
  }
  press(n, v) {
    const c = (this.down.get(n) || 0) + 1;
    this.down.set(n, c);
    if (c === 1) this.onNote(n, v, true);
  }
  release(n) {
    const c = (this.down.get(n) || 0) - 1;
    if (c <= 0) { this.down.delete(n); this.onNote(n, 0, false); } else this.down.set(n, c);
  }
  releaseAll() { for (const n of [...this.down.keys()]) { this.down.set(n, 1); this.release(n); } this.ptr.clear(); }
  light(n, who, on) {
    let s = this.lit.get(n);
    if (!s) { s = { me: 0, peer: 0 }; this.lit.set(n, s); }
    s[who] = Math.max(0, s[who] + (on ? 1 : -1));
    this.paint(n);
  }
  paint(n) {
    const s = this.lit.get(n) || { me: 0, peer: 0 };
    for (const k of this.el.querySelectorAll(`[data-note="${n}"]`)) {
      k.classList.toggle('on-me', s.me > 0);
      k.classList.toggle('on-peer', s.peer > 0);
    }
  }
  clear(who) {
    for (const [n, s] of this.lit) { if (who) s[who] = 0; else { s.me = 0; s.peer = 0; } this.paint(n); }
  }
  repaint() { for (const n of this.lit.keys()) this.paint(n); }
}

export class Keyboard extends Surface {
  constructor(el, opts) {
    super(el, opts);
    this.start = opts.start ?? 48;
    this.onRange = opts.onRange;
    el.classList.add('kb');
    new ResizeObserver(() => this.render()).observe(el);
  }
  whiteCount() {
    const w = this.el.clientWidth || 800;
    const min = matchMedia('(pointer: coarse)').matches ? 42 : 30;
    return Math.max(10, Math.min(52, Math.floor(w / min)));
  }
  render(force) {
    const W = this.whiteCount();
    if (!force && W === this.lastW && this.start === this.lastStart) return;
    this.lastW = W; this.lastStart = this.start;
    const whites = [];
    let n = this.start;
    while (whites.length < W && n <= 108) { if (!isBlack(n)) whites.push(n); n++; }
    this.end = whites[whites.length - 1];
    const ww = 100 / whites.length;
    const frag = document.createDocumentFragment();
    whites.forEach((note, i) => frag.append(h('div', { class: 'key white', 'data-note': note, style: `left:${i * ww}%;width:${ww}%` },
      note % 12 === 0 ? h('span', { class: 'lbl' }, noteName(note)) : null)));
    whites.forEach((note, i) => {
      const b = note + 1;
      if (isBlack(b) && b < this.end) frag.append(h('div', { class: 'key black', 'data-note': b, style: `left:${(i + 1) * ww - ww * 0.31}%;width:${ww * 0.62}%` }));
    });
    this.el.replaceChildren(frag);
    this.repaint();
    this.onRange?.(this.start, this.end);
  }
  shift(oct) {
    this.start = Math.max(24, Math.min(84, this.start + 12 * oct));
    this.render(true);
    return this.start;
  }
}

const TUNING = [64, 59, 55, 50, 45, 40]; // 1번줄(E4) ~ 6번줄(E2)
const FRETS = 15;
export class Fretboard extends Surface {
  constructor(el, opts) {
    super(el, opts);
    el.classList.add('fb');
    this.render();
  }
  render() {
    const frag = document.createDocumentFragment();
    TUNING.forEach((open, s) => {
      for (let f = 0; f <= FRETS; f++) {
        const n = open + f;
        frag.append(h('div', { class: 'fret' + (f === 0 ? ' open' : ''), 'data-note': n, 'data-name': noteName(n).replace(/-?\d+$/, ''), style: `grid-row:${s + 1};grid-column:${f + 1}` },
          h('i', { class: 'string', style: `height:${1 + s * 0.45}px` })));
      }
    });
    for (let f = 0; f <= FRETS; f++) {
      frag.append(h('div', { class: 'fret-num', style: `grid-row:7;grid-column:${f + 1}` }, f === 0 ? '개방' : [3, 5, 7, 9, 12, 15].includes(f) ? String(f) : ''));
    }
    this.el.replaceChildren(frag);
    this.repaint();
  }
}
