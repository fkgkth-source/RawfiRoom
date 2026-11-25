// 하단 독(건반/지판) + 악기·MIDI 탭: 노트 라우팅, 가상악기, MIDI 장치, MIDI 녹음(.mid → Logic Pro)
import { app, $, h, icon, on, setSetting, toast, download, isTeacher } from './util.js';
import { Keyboard, Fretboard, noteName } from './keyboard.js';
import { INSTRUMENTS } from './synth.js';
import { uploadFile, addFileRecord } from './files.js';

const KEYMAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };

export function initInstruments(pane) {
  const S = app.settings, synth = app.synth, midi = app.midi;
  synth.setVolume(S.synthVol); synth.setReverb(S.reverb);

  // ── 노트 라우팅 ──────────────────────────────
  const rec = { on: false, t0: 0, ev: [] };
  const recAdd = (who, type, a, b) => { if (rec.on) rec.ev.push({ t: performance.now() - rec.t0, who, type, a, b }); };

  function local(n, v, isOn, origin) {
    if (origin !== 'midi' || S.monitorMidiIn) isOn ? synth.noteOn('me', n, v, S.inst) : synth.noteOff('me', n);
    light(n, 'me', isOn);
    if (origin !== 'midi' || S.sendMidiIn) app.rtc.sendData({ t: 'midi', n, v, on: isOn, inst: S.inst, s: S.letPeerSynth, ts: app.clock?.now() }, { fast: true });
    if (origin !== 'midi' && S.localToMidiOut) midi.noteOut(n, v, isOn);
    recAdd('me', isOn ? 'on' : 'off', n, v);
  }
  function localCC(c, v, origin) {
    if (c === 64) { synth.setSustain('me', v >= 64); setPedalUI(v >= 64); }
    if (origin !== 'midi' || S.sendMidiIn) app.rtc.sendData({ t: 'cc', c, v, ts: app.clock?.now() }, { fast: true });
    if (origin !== 'midi' && S.localToMidiOut) midi.ccOut(c, v);
    recAdd('me', 'cc', c, v);
  }
  midi.onNote = (n, v, isOn) => local(n, v, isOn, 'midi');
  midi.onCC = (c, v) => localCC(c, v, 'midi');

  const pendingUntil = new Map();
  const lastTs = new Map(); // 순서 없는 빠른 채널에서 늦게 도착한 옛 이벤트 무시
  on('remote-data', ({ from, d }) => {
    if (d.t !== 'midi' && d.t !== 'cc') return;
    const key = `${from}:${d.t}:${d.n ?? d.c}`;
    if (d.ts != null) { if (d.ts < (lastTs.get(key) ?? -Infinity)) return; lastTs.set(key, d.ts); }
    const nk = `${from}:${d.n ?? 'cc' + d.c}`, now = performance.now();
    // 대기 중인 앞선 이벤트보다 먼저 재생되지 않게 (마디 싱크 ↔ 실시간 전환 시 음 끊김/남음 방지)
    const wait = Math.max(app.jam?.remoteDelay(d) || 0, (pendingUntil.get(nk) ?? 0) - now + 1);
    if (wait > 1) { pendingUntil.set(nk, now + wait); setTimeout(() => playRemote(from, d), wait); } else playRemote(from, d);
  });
  function playRemote(from, d) {
    const src = 'p' + from;
    if (d.t === 'midi') {
      if (S.remoteToSynth && d.s !== false) d.on ? synth.noteOn(src, d.n, d.v, d.inst || S.inst) : synth.noteOff(src, d.n);
      if (S.remoteToMidiOut) midi.noteOut(d.n, d.v, d.on);
      light(d.n, 'peer', d.on);
      recAdd(from, d.on ? 'on' : 'off', d.n, d.v);
    } else if (d.t === 'cc') {
      if (d.c === 64) synth.setSustain(src, d.v >= 64);
      if (S.remoteToMidiOut) midi.ccOut(d.c, d.v);
      recAdd(from, 'cc', d.c, d.v);
    }
  }
  on('peer-left', id => { synth.allOff('p' + id); kb.clear('peer'); fb.clear('peer'); });

  // ── 하단 독 ──────────────────────────────────
  const kb = new Keyboard($('#keyboard'), { start: S.kbStart, onNote: (n, v, o) => local(n, v, o, 'touch'), onRange: (a, b) => { rangeLbl.textContent = `${noteName(a)}–${noteName(b)}`; } });
  const fb = new Fretboard($('#fretboard'), { onNote: (n, v, o) => local(n, v, o, 'touch') });
  const light = (n, who, o) => { kb.light(n, who, o); fb.light(n, who, o); };

  const rangeLbl = h('span', { class: 'range-lbl' }, '');
  const pedal = h('button', { class: 'chip', title: '서스테인 페달 (Space)', onclick: () => localCC(64, pedal.classList.contains('active') ? 0 : 127, 'touch') }, '페달');
  const setPedalUI = o => pedal.classList.toggle('active', o);
  const instSel = h('select', { class: 'select sm', title: '가상악기', onchange: () => setInst(instSel.value) },
    ...INSTRUMENTS.map(i => h('option', { value: i.id, selected: i.id === S.inst }, i.name)));
  const midiDot = h('span', { class: 'midi-dot', title: 'MIDI 신호' });
  const viewSeg = h('div', { class: 'seg sm' },
    h('button', { class: 'seg-btn', 'data-v': 'keys', onclick: () => setView('keys') }, '건반'),
    h('button', { class: 'seg-btn', 'data-v': 'fret', onclick: () => setView('fret') }, '기타 지판'));
  const octGroup = h('div', { class: 'oct' },
    h('button', { class: 'icon-btn sm', title: '옥타브 내림 (Z)', html: icon('chevL', 18), onclick: () => shift(-1) }), rangeLbl,
    h('button', { class: 'icon-btn sm', title: '옥타브 올림 (X)', html: icon('chevR', 18), onclick: () => shift(1) }));
  const collapse = h('button', { class: 'icon-btn sm', title: '건반 접기/펴기', onclick: () => setDock(!S.dockOpen) });
  $('#dockBar').append(viewSeg, octGroup, pedal, instSel, h('span', { class: 'spacer' }), midiDot, collapse);

  function shift(o) { setSetting('kbStart', kb.shift(o)); }
  function setView(v) {
    setSetting('dockView', v);
    $('#keyboard').hidden = v !== 'keys'; $('#fretboard').hidden = v !== 'fret';
    octGroup.style.visibility = v === 'keys' ? '' : 'hidden';
    for (const b of viewSeg.children) b.classList.toggle('active', b.dataset.v === v);
    if (v === 'keys') kb.render(true);
  }
  function setDock(open) {
    setSetting('dockOpen', open);
    $('#dock').classList.toggle('closed', !open);
    collapse.innerHTML = icon(open ? 'chevD' : 'chevU', 18);
  }
  setView(S.dockView); setDock(S.dockOpen);

  let midiTimer;
  on('midi-activity', () => { midiDot.classList.add('on'); clearTimeout(midiTimer); midiTimer = setTimeout(() => midiDot.classList.remove('on'), 120); });

  // 컴퓨터 키보드로 연주 (한글 입력 상태에서도 동작하도록 e.code 사용)
  const held = new Map();
  const typing = t => t.closest?.('input,textarea,select,[contenteditable="true"]');
  addEventListener('keydown', e => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if (e.code === 'KeyZ') return shift(-1);
    if (e.code === 'KeyX') return shift(1);
    if (e.code === 'Space') { e.preventDefault(); return localCC(64, 127, 'key'); }
    const off = KEYMAP[e.code];
    if (off == null) return;
    const n = kb.start + 12 + off;
    held.set(e.code, n);
    local(n, 96, true, 'key');
  });
  addEventListener('keyup', e => {
    if (e.code === 'Space' && !typing(e.target)) return localCC(64, 0, 'key');
    const n = held.get(e.code);
    if (n == null) return;
    held.delete(e.code);
    local(n, 0, false, 'key');
  });
  addEventListener('blur', () => { for (const [c, n] of held) local(n, 0, false, 'key'); held.clear(); });

  function setInst(id) {
    setSetting('inst', id); instSel.value = id;
    for (const c of instGrid.children) c.classList.toggle('active', c.dataset.id === id);
  }
  function panic() {
    synth.allOff(); midi.panicOut(); kb.releaseAll(); fb.releaseAll(); kb.clear(); fb.clear(); setPedalUI(false);
    app.rtc.sendData({ t: 'cc', c: 64, v: 0 });
    toast('모든 음을 껐어요');
  }

  // ── 악기·MIDI 탭 ─────────────────────────────
  const instGrid = h('div', { class: 'inst-grid' }, ...INSTRUMENTS.map(i =>
    h('button', { class: 'inst-card' + (i.id === S.inst ? ' active' : ''), 'data-id': i.id, onclick: () => setInst(i.id) },
      h('span', { class: 'inst-emoji' }, i.emoji), h('span', {}, i.name))));

  const slider = (label, key, min, max, step, apply) => {
    const out = h('span', { class: 'muted small' }, Math.round(S[key] * 100) + '%');
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
      h('input', { type: 'range', min, max, step, value: S[key], oninput: e => { const v = +e.target.value; setSetting(key, v); apply(v); out.textContent = Math.round(v * 100) + '%'; } }), out);
  };
  const toggle = (label, key, hint, after) => h('label', { class: 'switch-row' },
    h('span', {}, h('span', {}, label), hint ? h('span', { class: 'muted small block' }, hint) : null),
    h('input', { type: 'checkbox', class: 'switch', checked: !!S[key], onchange: e => { setSetting(key, e.target.checked); after?.(e.target.checked); } }));

  // MIDI 장치
  const midiBox = h('div', { class: 'midi-box' });
  function renderMidi() {
    if (!midi.supported) {
      midiBox.replaceChildren(h('p', { class: 'note warn' }, '이 브라우저는 Web MIDI를 지원하지 않아요 (iPad Safari 등). 화면 건반·기타 지판은 그대로 쓸 수 있고, 외부 MIDI 장치는 Mac/PC의 Chrome·Edge에서 연결하세요.'));
      return;
    }
    if (!midi.access) {
      midiBox.replaceChildren(h('button', { class: 'btn', onclick: async () => { await midi.init(); renderMidi(); } }, 'MIDI 장치 연결 허용'),
        h('p', { class: 'muted small' }, midi.error || ''));
      return;
    }
    const ins = midi.inputs(), outs = midi.outputs();
    midiBox.replaceChildren(
      h('div', { class: 'field-label' }, '입력 (컨트롤러 / Logic에서 보내는 MIDI)'),
      ins.length ? h('div', { class: 'check-list' }, ...ins.map(inp => {
        const loop = midi.out()?.name === inp.name;
        return h('label', { class: 'check-row' + (loop ? ' disabled' : '') },
          h('input', { type: 'checkbox', checked: midi.isEnabled(inp), disabled: loop, onchange: e => {
            let list = S.midiInputs ?? ins.map(i => i.id);
            list = e.target.checked ? [...new Set([...list, inp.id])] : list.filter(x => x !== inp.id);
            setSetting('midiInputs', list); midi.bind();
          } }), h('span', {}, inp.name), loop ? h('span', { class: 'muted small' }, ' (출력과 같아 루프 방지로 제외)') : null);
      })) : h('p', { class: 'muted small' }, '연결된 MIDI 입력이 없어요'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '출력 → Logic Pro (IAC 드라이버 버스 선택)'),
        h('select', { class: 'select', onchange: e => { setSetting('midiOut', e.target.value); midi.bind(); renderMidi(); } },
          h('option', { value: '' }, '사용 안 함'), ...outs.map(o => h('option', { value: o.id, selected: o.id === S.midiOut }, o.name)))),
    );
  }
  on('midi-devices', renderMidi);

  // MIDI 녹음
  const recBtn = h('button', { class: 'btn rec', onclick: () => (rec.on ? stopRec() : startRec()) });
  const recInfo = h('span', { class: 'muted small' }, '');
  const bpm = h('input', { class: 'input xs', type: 'number', min: 30, max: 300, value: 120, title: 'BPM' });
  const saveBtn = h('button', { class: 'btn', disabled: true, onclick: () => download(recName(), new Blob([toSmf()], { type: 'audio/midi' })) }, h('span', { html: icon('download', 16) }), '.mid 저장');
  const upBtn = h('button', { class: 'btn', disabled: true, onclick: async () => {
    upBtn.disabled = true;
    try {
      const f = new File([toSmf()], recName(), { type: 'audio/midi' });
      addFileRecord(await uploadFile(f));
      toast('자료함에 올렸어요 — 상대도 바로 받을 수 있어요');
    } catch (e) { toast('업로드 실패: ' + e.message, { kind: 'warn' }); }
    upBtn.disabled = false;
  } }, h('span', { html: icon('upload', 16) }), '자료함에 올리기');
  let recTimer;
  function setRecUI() {
    recBtn.replaceChildren(h('span', { html: icon(rec.on ? 'stop' : 'record', 16) }), rec.on ? '정지' : '녹음');
    recBtn.classList.toggle('active', rec.on);
    const notes = rec.ev.filter(e => e.type === 'on').length;
    const sec = rec.on ? (performance.now() - rec.t0) / 1000 : (rec.ev.at(-1)?.t || 0) / 1000;
    recInfo.textContent = rec.ev.length || rec.on ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')} · ${notes}음` : '';
    saveBtn.disabled = upBtn.disabled = rec.on || !notes;
  }
  function startRec() { rec.on = true; rec.t0 = performance.now(); rec.ev = []; setRecUI(); recTimer = setInterval(setRecUI, 500); }
  function stopRec() { rec.on = false; clearInterval(recTimer); setRecUI(); }
  const recName = () => `레슨-MIDI-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.mid`;
  function toSmf() {
    const tempo = Math.max(30, Math.min(300, +bpm.value || 120));
    const ppq = 480, tpm = ppq * tempo / 60000, us = Math.round(60000000 / tempo);
    const enc = new TextEncoder();
    const vlq = n => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
    const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const chunk = (body) => [0x4D, 0x54, 0x72, 0x6B, ...u32(body.length), ...body];
    const tracks = [chunk([0, 0xFF, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255, 0, 0xFF, 0x58, 4, 4, 2, 24, 8, 0, 0xFF, 0x2F, 0])];
    const whos = [...new Set(rec.ev.map(e => e.who))];
    whos.forEach((who, ti) => {
      const ch = ti % 16, body = [];
      const name = [...enc.encode(who === 'me' ? `${app.me.name}` : (app.peers.get(who)?.name || '상대'))];
      body.push(0, 0xFF, 0x03, ...vlq(name.length), ...name);
      let last = 0; const open = new Set();
      for (const e of rec.ev.filter(x => x.who === who)) {
        const tick = Math.round(e.t * tpm);
        body.push(...vlq(Math.max(0, tick - last))); last = tick;
        if (e.type === 'on') { body.push(0x90 | ch, e.a, Math.max(1, e.b)); open.add(e.a); }
        else if (e.type === 'off') { body.push(0x80 | ch, e.a, 0); open.delete(e.a); }
        else body.push(0xB0 | ch, e.a, e.b);
      }
      for (const n of open) body.push(0, 0x80 | ch, n, 0);
      body.push(0, 0xFF, 0x2F, 0);
      tracks.push(chunk(body));
    });
    const head = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255];
    return new Uint8Array([...head, ...tracks.flat()]);
  }
  setRecUI();

  const tOnly = el => { el.classList.add('teacher-only'); return el; };
  const sec = (title, open, ...kids) => h('details', { class: 'fold', open }, h('summary', {}, title), h('div', { class: 'fold-body' }, ...kids));
  pane.append(h('div', { class: 'pane-scroll' },
    sec('가상악기', true, instGrid,
      slider('볼륨', 'synthVol', 0, 1.2, 0.01, v => synth.setVolume(v)),
      slider('리버브', 'reverb', 0, 0.6, 0.01, v => synth.setReverb(v)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: panic }, h('span', { html: icon('panic', 16) }), '모든 음 끄기'),
        h('span', { class: 'muted small' }, '단축키: A~; 연주 · Z/X 옥타브 · Space 페달'))),
    sec('연주 공유 방식', true,
      tOnly(toggle('상대 기기에서 내장 악기로 소리내기', 'letPeerSynth', 'Logic 소리를 DAW 오디오로 보내는 중이면 끄세요 (이중 재생 방지). 건반 표시는 그대로 보여요.')),
      toggle('상대 연주를 내장 악기로 듣기', 'remoteToSynth'),
      tOnly(toggle('상대 연주를 MIDI 출력(Logic)으로 보내기', 'remoteToMidiOut', '레슨생이 화면 건반을 치면 내 Logic 가상악기가 연주돼요')),
      tOnly(toggle('내 화면 건반을 MIDI 출력(Logic)으로도 보내기', 'localToMidiOut')),
      toggle('내 MIDI 입력을 상대에게 전송', 'sendMidiIn'),
      toggle('내 MIDI 입력을 내장 악기로도 듣기', 'monitorMidiIn', 'Logic에서 이미 소리가 난다면 꺼두세요')),
    sec('MIDI 장치 · Logic Pro', isTeacher(), midiBox),
    sec('MIDI 녹음 → Logic Pro', true,
      h('div', { class: 'row wrap' }, recBtn, recInfo, h('span', { class: 'spacer' }), h('label', { class: 'row tight muted small' }, 'BPM', bpm)),
      h('div', { class: 'row wrap' }, saveBtn, upBtn),
      h('p', { class: 'muted small' }, '양쪽 연주가 참가자별 트랙으로 저장돼요. .mid 파일을 Logic Pro 트랙 영역으로 끌어다 놓으면 바로 편집할 수 있어요.')),
  ));
  renderMidi();
}
