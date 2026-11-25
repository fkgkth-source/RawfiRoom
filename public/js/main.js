// RawfiRoom 진입점: 랜딩(모드 선택) → 입장 전 확인 → 룸
import { app, $, $$, h, icon, toast, store, on, emit, setSetting, copyText, roomLink, menu, isTeacher, canLead, MODE_LABEL, modeKey } from './util.js';
import { initRecorder } from './recorder.js';
import { Net } from './net.js';
import { RTC } from './rtc.js';
import { media, openCam, openMic, openDaw, setMicOn, setCamOn } from './media.js';
import { Synth } from './synth.js';
import { MidiIO } from './midi.js';
import { initClock } from './clock.js';
import { initStage } from './stage.js';
import { initInstruments } from './instruments.js';
import { initJam } from './jam.js';
import { initScore } from './score.js';
import { initNotes } from './notes.js';
import { initFiles } from './files.js';
import { initSchedule } from './schedule.js';
import { initSettings } from './settings.js';

const TABS = [
  { id: 'score', label: '악보', icon: 'score' },
  { id: 'notes', label: '가사노트', icon: 'note' },
  { id: 'inst', label: '악기·MIDI', icon: 'keys' },
  { id: 'jam', label: '합주', icon: 'metronome' },
  { id: 'files', label: '자료함', icon: 'folder' },
  { id: 'sched', label: '일정', icon: 'calendar' },
  { id: 'settings', label: '설정', icon: 'gear' },
];
const MODE_TEXT = {
  teacher: { title: '선생님 모드로 입장', desc: 'Logic Pro 연결, 레슨생 필기·페이지·저장 권한을 내가 이끌어요.' },
  student: { title: '레슨생 모드로 입장', desc: '선생님이 띄운 악보·가사에 함께 쓰고, 건반으로 연주하고, 다음 레슨 일정을 정해요.' },
  jam: { title: '합주 모드로 입장', desc: '저지연 오디오(10ms 프레임)·악기 원음·영상 최소화가 자동으로 켜지고, 메트로놈과 마디 싱크로 함께 연주해요. 헤드폰·유선 랜 권장.' },
  meeting: { title: '미팅 모드로 입장', desc: '모두 같은 권한으로 화면 공유·가사노트·자료함을 함께 써요. 대화하기 좋게 에코 제거가 켜져요.' },
};

const m = location.pathname.match(/^\/r\/([a-z0-9-]+)\/?$/);
if (m) prejoin(m[1]); else landing();

// ── 랜딩 ─────────────────────────────────────
function landing() {
  $('#landing').hidden = false;
  for (const btn of $$('[data-create]')) btn.onclick = async () => {
    const kind = btn.dataset.create;
    btn.disabled = true;
    try {
      const r = await fetch('/api/rooms', { method: 'POST' }).then(r => r.json());
      store.set('lr.host.' + r.room, r.hostKey);
      store.set('lr.mode.' + r.room, kind === 'lesson' ? 'teacher' : kind);
      const mine = store.get('lr.myRooms', []).filter(x => x.room !== r.room);
      mine.unshift({ room: r.room, ts: Date.now(), kind });
      store.set('lr.myRooms', mine.slice(0, 8));
      location.href = '/r/' + r.room;
    } catch { toast('방을 만들지 못했어요. 서버를 확인하세요.', { kind: 'warn' }); btn.disabled = false; }
  };
  $('#joinForm').onsubmit = e => {
    e.preventDefault();
    const v = $('#joinCode').value.trim();
    const code = (v.match(/\/r\/([a-z0-9-]+)/i)?.[1] || v).toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (code) location.href = '/r/' + code; else toast('초대 링크나 코드를 입력하세요');
  };
  const mine = store.get('lr.myRooms', []);
  if (mine.length) {
    const KL = { lesson: '레슨', jam: '합주', meeting: '미팅' };
    $('#myRooms').replaceChildren(h('div', { class: 'muted small' }, '내가 만든 방 (매번 같은 링크로 재사용)'),
      ...mine.map(r => h('a', { class: 'room-link', href: '/r/' + r.room }, h('span', { html: icon('music', 16) }), h('b', {}, r.room),
        h('span', { class: 'mode-tag' }, KL[r.kind || 'lesson']),
        h('span', { class: 'muted small' }, new Date(r.ts).toLocaleDateString('ko-KR')))));
  }
}

// ── 입장 전 ──────────────────────────────────
async function prejoin(roomId) {
  app.roomId = roomId;
  // 선생님의 다른 기기용 링크 (#t=키)
  const hk = new URLSearchParams(location.hash.slice(1)).get('t');
  if (hk) { store.set('lr.host.' + roomId, hk); history.replaceState(null, '', location.pathname); }
  const hostKey = store.get('lr.host.' + roomId, null);
  let info = { mode: 'lesson', online: 0 };
  try { info = await fetch('/api/rooms/' + roomId).then(r => r.json()); } catch {}
  const stored = store.get('lr.mode.' + roomId, null);
  let mode = stored && (stored !== 'teacher' || hostKey) ? stored
    : info.mode !== 'lesson' ? info.mode : hostKey ? 'teacher' : 'student';

  $('#prejoin').hidden = false;
  $('#pjCode').textContent = roomId;
  const seg = $('#pjModeSel');
  seg.querySelector('[data-mode="teacher"]').hidden = !hostKey;
  const paintMode = () => {
    $('#pjRole').textContent = MODE_TEXT[mode].title;
    $('#pjRoleDesc').textContent = MODE_TEXT[mode].desc + (info.online && info.mode !== 'lesson' && mode !== info.mode && !hostKey ? ` (지금 이 방은 ${MODE_LABEL[info.mode]}로 진행 중이에요)` : '');
    document.body.dataset.role = mode === 'student' ? 'student' : 'teacher';
    document.body.dataset.mode = mode === 'teacher' || mode === 'student' ? 'lesson' : mode;
    for (const b of seg.children) b.classList.toggle('active', b.dataset.mode === mode);
  };
  for (const b of seg.children) b.onclick = () => { mode = b.dataset.mode; store.set('lr.mode.' + roomId, mode); paintMode(); };
  paintMode();

  const nameIn = $('#pjName');
  nameIn.value = store.get('lr.name', '');
  const video = $('#pjVideo'), pjMic = $('#pjMic'), pjCam = $('#pjCam');
  const paint = () => {
    pjMic.innerHTML = icon(media.micOn ? 'mic' : 'micOff', 22); pjMic.classList.toggle('off', !media.micOn);
    pjCam.innerHTML = icon(media.camOn ? 'cam' : 'camOff', 22); pjCam.classList.toggle('off', !media.camOn);
    video.srcObject = media.cam && media.camOn ? new MediaStream([media.cam]) : null;
    $('#pjVideoWrap').classList.toggle('novideo', !(media.cam && media.camOn));
  };
  pjMic.onclick = () => { setMicOn(!media.micOn); paint(); };
  pjCam.onclick = async () => { await setCamOn(!media.camOn); paint(); };
  on('local-media', paint);

  if (!window.isSecureContext) $('#pjMsg').textContent = '⚠️ HTTPS가 아니어서 카메라·마이크를 쓸 수 없어요. HTTPS 주소로 접속하세요.';
  else {
    $('#pjMsg').textContent = '카메라·마이크 권한을 허용해 주세요. 헤드폰 사용을 권장해요.';
    await Promise.all([openCam(), openMic()]);
    $('#pjMsg').textContent = media.cam || media.mic ? '헤드폰을 쓰면 하울링 없이 원음 그대로 들려요.' : '장치 없이도 입장할 수 있어요 (필기·가사·건반 사용 가능).';
  }
  paint();
  $('#pjForm').onsubmit = e => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); return toast('이름을 입력하세요'); }
    join(roomId, name, mode === 'student' ? null : hostKey, mode === 'teacher' || mode === 'student' ? 'lesson' : mode);
  };
}

// ── 룸 ───────────────────────────────────────
async function join(roomId, name, hostKey, wantMode) {
  store.set('lr.name', name);
  $('#prejoin').hidden = true;
  $('#room').hidden = false;
  document.title = `RawfiRoom · ${roomId}`;

  // 합주에선 가능한 가장 작은 출력 버퍼 요청
  try { app.ctx = new AudioContext({ latencyHint: wantMode === 'jam' || app.settings.jamLowLatency ? 0 : 'interactive', sampleRate: 48000 }); }
  catch { app.ctx = new AudioContext({ latencyHint: 'interactive' }); }
  app.ctx.resume();
  addEventListener('pointerdown', () => { if (app.ctx.state !== 'running') app.ctx.resume(); }, { capture: true });
  if (app.settings.outId) app.ctx.setSinkId?.(app.settings.outId).catch(() => {});
  app.synth = new Synth(app.ctx);

  let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
  try { ice = (await fetch('/api/config').then(r => r.json())).iceServers; } catch {}

  const net = app.net = new Net(roomId, name, hostKey);
  app.doc = net.doc;
  app.me = { id: null, name, role: hostKey ? 'teacher' : 'student' };
  net.on('welcome', msg => {
    const wasTeacher = isTeacher();
    app.me = { id: msg.id, name, role: msg.role };
    app.peers = new Map(msg.peers.map(p => [p.id, p]));
    document.body.dataset.role = msg.role;
    if (wasTeacher && msg.role !== 'teacher') toast('선생님 키가 이 방과 맞지 않아 레슨생 모드로 입장했어요', { kind: 'warn' });
    setConn(true); emit('peers'); emit('role');
    // 방 모드 맞추기: 레슨 중(선생님 있음)엔 선생님만 바꿀 수 있음
    const roomMap = app.doc.getMap('room'), cur = roomMap.get('mode') || 'lesson';
    const teacherHere = [...app.peers.values()].some(p => p.role === 'teacher');
    if (wantMode && wantMode !== cur) {
      if (cur !== 'lesson' || isTeacher() || !teacherHere) roomMap.set('mode', wantMode);
      else toast('선생님이 레슨 모드로 진행 중이라 레슨 모드로 들어왔어요');
    }
    wantMode = null;
    applyMode(roomMap.get('mode') || 'lesson');
  });
  net.on('peer-join', msg => { app.peers.set(msg.id, msg); emit('peers'); toast(`${msg.name}님이 들어왔어요`); });
  net.on('peer-leave', msg => {
    const p = app.peers.get(msg.id);
    app.peers.delete(msg.id); app.peerState.delete(msg.id);
    emit('peers'); emit('peer-left', msg.id);
    if (p) toast(`${p.name}님이 나갔어요`);
  });
  net.on('disconnected', () => { setConn(false); app.peers.clear(); emit('peers'); });

  app.rtc = new RTC(net, ice);
  if (media.cam) app.rtc.setTrack('cam', media.cam, 'video');
  if (media.mic) app.rtc.setTrack('cam', media.mic, 'audio');
  if (app.settings.dawId) openDaw(app.settings.dawId);
  app.midi = new MidiIO();

  buildTabs();
  initClock();
  initRecorder();
  initStage();
  initInstruments(pane('inst'));
  initJam(pane('jam'));
  initScore(pane('score'));
  initNotes(pane('notes'));
  initFiles(pane('files'));
  initSchedule(pane('sched'));
  initSettings(pane('settings'));
  initTopbar();
  initGutter();
  showTab(TABS.some(t => t.id === app.settings.tab) ? app.settings.tab : 'score');

  if (app.midi.supported) app.midi.init().then(() => emit('midi-devices'));
  app.doc.getMap('room').observe(() => applyMode(app.doc.getMap('room').get('mode') || 'lesson'));
  net.connect();

  const dock = $('#dock');
  new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', dock.offsetHeight + 'px')).observe(dock);
}

const pane = id => $(`.tab-pane[data-pane="${id}"]`);

function buildTabs() {
  const nav = $('#tabs'), body = $('#tabBody');
  for (const t of TABS) {
    nav.append(h('button', { class: 'tab', role: 'tab', 'data-tab': t.id, onclick: () => showTab(t.id) },
      h('span', { html: icon(t.icon, 18) }), h('span', { class: 'tab-label' }, t.label), h('i', { class: 'dot' })));
    body.append(h('div', { class: 'tab-pane', 'data-pane': t.id, role: 'tabpanel' }));
  }
  on('tab-dot', id => { if (app.settings.tab !== id) $(`.tab[data-tab="${id}"]`)?.classList.add('has-dot'); });
}
function showTab(id) {
  setSetting('tab', id);
  for (const b of $$('.tab')) { const a = b.dataset.tab === id; b.classList.toggle('active', a); b.setAttribute('aria-selected', a); if (a) b.classList.remove('has-dot'); }
  for (const p of $$('.tab-pane')) p.classList.toggle('active', p.dataset.pane === id);
  emit('tab', id);
}
app.showTab = showTab;
window.__rawfi = app; // 디버깅용

function setConn(ok) {
  const d = $('#connDot');
  d.classList.toggle('ok', ok); d.classList.toggle('down', !ok);
  d.title = ok ? '서버 연결됨' : '재연결 중…';
}

// ── 모드 적용 ────────────────────────────────
let appliedMode = null;
function applyMode(mode) {
  app.mode = mode;
  document.body.dataset.mode = mode;
  emit('mode', mode); emit('role');
  if (appliedMode === mode) return;
  const first = appliedMode === null;
  appliedMode = mode;
  const S = app.settings;
  const renego = v => { if (S.jamLowLatency !== v) { setSetting('jamLowLatency', v); app.rtc.renegotiate(); } };
  if (mode === 'jam') {
    renego(true);
    if (!S.instrumentMode) { setSetting('instrumentMode', true); openMic(); }
    $('#dock').classList.remove('closed');
    showTab('jam');
    toast('합주 모드: 저지연 오디오·악기 원음·영상 최소화를 켰어요. 헤드폰과 유선 랜을 쓰세요.', { timeout: 6000 });
  } else if (mode === 'meeting') {
    renego(false);
    if (S.instrumentMode) { setSetting('instrumentMode', false); openMic(); }
    showTab('notes');
    toast('미팅 모드: 모두 같은 권한이에요. 대화용으로 에코 제거를 켰어요 (악기 소리를 보낼 땐 설정에서 원음 모드).', { timeout: 6000 });
  } else {
    renego(false);
    if (!S.instrumentMode) { setSetting('instrumentMode', true); openMic(); }
    if (!first) { showTab('score'); toast('레슨 모드로 바뀌었어요'); }
  }
}

function modeMenu(anchor) {
  const roomMap = app.doc.getMap('room');
  const teacherHere = isTeacher() || [...app.peers.values()].some(p => p.role === 'teacher');
  const can = app.mode !== 'lesson' || isTeacher() || !teacherHere;
  const set = m => () => roomMap.set('mode', m);
  menu(anchor, [
    { title: `지금: ${MODE_LABEL[modeKey()]}` },
    { label: '레슨 모드 (선생님·레슨생)', icon: 'crown', checked: app.mode === 'lesson', disabled: !can, onClick: set('lesson') },
    { label: '합주 모드', hint: '최저 지연', icon: 'metronome', checked: app.mode === 'jam', disabled: !can, onClick: set('jam') },
    { label: '미팅 모드', hint: '함께 작업', icon: 'users', checked: app.mode === 'meeting', disabled: !can, onClick: set('meeting') },
    !can ? { el: h('p', { class: 'menu-note' }, '레슨 중에는 선생님만 모드를 바꿀 수 있어요.') } : null,
    { sep: true },
    { el: h('p', { class: 'menu-note' }, '모드는 방 전체에 함께 적용돼요. 선생님↔레슨생 화면 전환은 나갔다가 입장 화면에서 고르세요.') },
  ], { align: 'left' });
}

function initTopbar() {
  const people = $('#people');
  const render = () => {
    const teacher = isTeacher();
    $('#modeBadge').textContent = MODE_LABEL[modeKey()];
    $('#modeBadge').dataset.m = modeKey();
    const list = [{ ...app.me, me: true }, ...app.peers.values()];
    people.replaceChildren(...list.map(p => h('span', { class: 'person ' + (p.role || ''), title: `${p.name}${p.role === 'teacher' ? ' (선생님)' : ' (레슨생)'}` },
      h('span', { class: 'p-avatar' }, (p.name || '?').charAt(0)), h('span', { class: 'p-name' }, p.me ? '나' : p.name))));
    $('#waiting').hidden = app.peers.size > 0;
    $('#waitingText').textContent = app.mode !== 'lesson' ? '함께할 사람을 기다리는 중…' : teacher ? '레슨생을 기다리는 중…' : '선생님을 기다리는 중…';
    $('#waitingInvite').hidden = !canLead();
  };
  on('peers', render); on('role', render); render();
  $('#modeBadge').onclick = e => modeMenu(e.currentTarget);

  const tools = $('#btnTeacherTools');
  tools.replaceChildren(h('span', { html: icon('crown', 16) }), h('span', { class: 'hide-narrow' }, '선생님 도구'));
  tools.onclick = () => teacherMenu(tools);
  const hand = $('#btnHand');
  hand.replaceChildren(h('span', { html: icon('handUp', 16) }), h('span', { class: 'hide-narrow' }, '손들기'));
  hand.onclick = () => { app.net.eph({ t: 'hand' }); toast('선생님에게 질문 신호를 보냈어요'); };
  app.net.on('eph', msg => {
    if (msg.d?.t === 'hand' && isTeacher()) {
      chime();
      toast(`🙋 ${app.peers.get(msg.from)?.name || '레슨생'}님이 질문이 있어요`, { timeout: 12000 });
    }
  });

  const inv = $('#btnInvite');
  inv.classList.add('teacher-only');
  inv.replaceChildren(h('span', { html: icon('link', 16) }), h('span', { class: 'hide-narrow' }, '초대'));
  inv.onclick = openInvite;
  $('#waitingInvite').onclick = openInvite;
  $('#btnLeave').onclick = () => {
    app.net.close();
    for (const t of [media.cam, media.mic, media.daw, ...(media.screen?.getTracks() || [])]) t?.stop();
    location.href = '/';
  };
}

function chime() {
  const c = app.ctx, t = c.currentTime;
  for (const [f, d] of [[880, 0], [1320, 0.12]]) {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = f; g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(0.15, t + d + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.4);
    o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + 0.5);
  }
}

// 선생님 도구: 레슨 진행 권한을 한 곳에 모음
function teacherMenu(anchor) {
  const perm = app.doc.getMap('perm'), notes = app.doc.getMap('notes');
  const hasStudent = [...app.peers.values()].some(p => p.role !== 'teacher');
  const allAllowed = notes.size && [...notes.values()].every(n => n.get('allowSave'));
  menu(anchor, [
    { title: '레슨 진행' },
    { label: '레슨생 화면 공유 요청', icon: 'screenReq', disabled: !hasStudent, onClick: () => { app.net.eph({ t: 'share-req' }); toast('화면 공유를 요청했어요'); } },
    { label: '레슨생 마이크 끄기', icon: 'micOff', disabled: !hasStudent, onClick: () => { app.net.eph({ t: 'mute-req' }); toast('레슨생 마이크를 껐어요'); } },
    { sep: true },
    { title: '악보' },
    { label: '레슨생 페이지 고정 (내 페이지를 따라옴)', icon: 'lock', checked: !!perm.get('lockPages'), onClick: () => perm.set('lockPages', !perm.get('lockPages')) },
    { label: '레슨생 필기 허용', icon: 'pen', checked: perm.get('studentInk') !== false, onClick: () => perm.set('studentInk', perm.get('studentInk') === false) },
    { sep: true },
    { title: '가사노트' },
    { label: allAllowed ? '모든 노트 저장 잠금' : '모든 노트 레슨생 저장 허용', icon: allAllowed ? 'lock' : 'unlock', disabled: !notes.size,
      onClick: () => app.doc.transact(() => { for (const n of notes.values()) n.set('allowSave', !allAllowed); }) },
    { sep: true },
    { label: '내 다른 기기(iPad)에서 선생님으로 입장', icon: 'link', hint: '링크 복사', onClick: async () => {
      const key = store.get('lr.host.' + app.roomId);
      const ok = await copyText(`${roomLink()}#t=${key}`);
      toast(ok ? '선생님 전용 링크를 복사했어요. 내 기기에서만 여세요 (레슨생에게 보내면 안 돼요)' : '복사 실패', { timeout: 7000 });
    } },
  ], { align: 'right' });
}

function openInvite() {
  const link = roomLink();
  const dlg = $('#dlg');
  const what = { lesson: '레슨', jam: '합주', meeting: '미팅' }[app.mode];
  const msg = `🎵 RawfiRoom ${what} 초대\n아래 링크를 눌러 입장하세요 (Chrome·Safari, 헤드폰 권장)\n${link}`;
  dlg.replaceChildren(h('div', { class: 'dlg-body' },
    h('h3', {}, app.mode === 'lesson' ? '레슨생 초대하기' : `${what}에 초대하기`),
    h('p', { class: 'muted small' }, app.mode === 'lesson' ? '이 링크로 들어오면 레슨생 모드로 입장해요. 매주 같은 링크를 다시 쓸 수 있어요.' : `이 링크로 들어오면 ${what} 모드로 함께 입장해요.`),
    h('div', { class: 'invite-link' }, h('input', { class: 'input', value: link, readOnly: true, onfocus: e => e.target.select() }),
      h('button', { class: 'btn primary', onclick: async () => toast((await copyText(link)) ? '링크를 복사했어요' : '복사 실패') }, h('span', { html: icon('copy', 16) }), '복사')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: async () => toast((await copyText(msg)) ? '초대 메시지를 복사했어요 — 카톡·문자에 붙여넣으세요' : '복사 실패') }, '초대 메시지 복사'),
      navigator.share ? h('button', { class: 'btn', onclick: () => navigator.share({ title: 'RawfiRoom 초대', text: msg }).catch(() => {}) }, h('span', { html: icon('share', 16) }), '공유…') : null),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', onclick: () => dlg.close() }, '닫기'))));
  dlg.showModal();
}

// 영상/탭 경계 드래그로 크기 조절
function initGutter() {
  const g = $('#gutter'), main = $('.main');
  const saved = store.get('lr.stageW', null);
  if (saved) main.style.setProperty('--stage-w', saved);
  let drag = false;
  g.addEventListener('pointerdown', e => { drag = true; g.setPointerCapture(e.pointerId); });
  g.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = main.getBoundingClientRect();
    const pct = Math.max(20, Math.min(70, (e.clientX - r.left) / r.width * 100));
    main.style.setProperty('--stage-w', pct + '%');
  });
  g.addEventListener('pointerup', () => { drag = false; store.set('lr.stageW', main.style.getPropertyValue('--stage-w')); });
  g.addEventListener('dblclick', () => { main.style.removeProperty('--stage-w'); store.set('lr.stageW', null); });
}
