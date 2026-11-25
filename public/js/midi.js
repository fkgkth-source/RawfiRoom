// Web MIDI: 컨트롤러/Logic Pro(IAC 버스) ↔ 브라우저
import { app, emit } from './util.js';

export class MidiIO {
  constructor() {
    this.supported = !!navigator.requestMIDIAccess;
    this.access = null; this.onNote = null; this.onCC = null;
  }
  async init() {
    if (!this.supported) return false;
    try { this.access = await navigator.requestMIDIAccess({ sysex: false }); }
    catch (e) { this.error = e.message; return false; }
    this.access.onstatechange = () => { this.bind(); emit('midi-devices'); };
    this.bind();
    return true;
  }
  inputs() { return this.access ? [...this.access.inputs.values()] : []; }
  outputs() { return this.access ? [...this.access.outputs.values()] : []; }
  out() { const id = app.settings.midiOut; return id && this.access ? this.access.outputs.get(id) : null; }

  // 선택한 출력과 같은 이름의 입력은 자동 제외 (IAC 피드백 루프 방지)
  isEnabled(inp) {
    const o = this.out();
    if (o && o.name === inp.name) return false;
    const list = app.settings.midiInputs;
    return list == null ? true : list.includes(inp.id);
  }
  bind() {
    for (const inp of this.inputs()) inp.onmidimessage = this.isEnabled(inp) ? e => this.handle(e.data) : null;
  }
  handle(d) {
    const st = d[0] & 0xf0;
    if (st === 0x90 && d[2] > 0) this.onNote?.(d[1], d[2], true);
    else if (st === 0x80 || st === 0x90) this.onNote?.(d[1], 0, false);
    else if (st === 0xB0) this.onCC?.(d[1], d[2]);
    else return;
    emit('midi-activity', 'in');
  }
  send(bytes) {
    const o = this.out();
    if (!o) return;
    try { o.send(bytes); emit('midi-activity', 'out'); } catch {}
  }
  noteOut(n, v, on, ch = 0) { this.send(on ? [0x90 | ch, n, v] : [0x80 | ch, n, 0]); }
  ccOut(c, v, ch = 0) { this.send([0xB0 | ch, c, v]); }
  panicOut() { for (let ch = 0; ch < 16; ch++) { this.send([0xB0 | ch, 64, 0]); this.send([0xB0 | ch, 123, 0]); } }
}
