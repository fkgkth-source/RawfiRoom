// 영상 무대: 참가자 카메라·화면공유 타일, 원격 오디오 재생, 하단 컨트롤
import { app, $, h, icon, on, toast, isTeacher, setSetting, canLead } from './util.js';
import { media, setMicOn, setCamOn, startScreen, stopScreen, screenSupported, broadcastState } from './media.js';

export function initStage() {
  const S = app.settings;
  const mainEl = $('#stageMain'), strip = $('#stageStrip');
  const remote = new Map(), tiles = new Map(), audios = new Map();
  let pinned = null, preview = null, previewTrack = null;

  on('remote-media', ({ id, media: md }) => {
    if (Object.keys(md).length) remote.set(id, md); else remote.delete(id);
    syncAudio(); render();
  });
  for (const ev of ['local-media', 'peers', 'mstate', 'mode']) on(ev, render);
  app.net.on('eph', m => {
    const d = m.d || {};
    if (d.t === 'mstate') { app.peerState.set(m.from, { mic: d.mic, cam: d.cam }); render(); }
    if (d.t === 'mute-req' && !canLead()) { setMicOn(false); toast('선생님이 마이크를 껐어요. 말할 때 다시 켜세요.'); }
    if (d.t === 'share-req') {
      toast(`${app.peers.get(m.from)?.name || '상대'}님이 화면 공유를 요청했어요`, { timeout: 15000, actions: [{ label: '화면 공유 시작', fn: startScreen }] });
    }
  });
  app.net.on('peer-join', m => broadcastState(m.id));
  app.net.on('welcome', () => broadcastState());

  function syncAudio() {
    const want = new Map();
    for (const [id, md] of remote) for (const kind of ['cam', 'daw', 'screen']) {
      const s = md[kind];
      if (s && s.getAudioTracks().length) want.set(`${id}:${kind}`, { s, kind });
    }
    for (const [k, el] of audios) if (!want.has(k) || el.srcObject !== want.get(k).s) { el.srcObject = null; el.remove(); audios.delete(k); }
    for (const [k, { s, kind }] of want) {
      if (audios.has(k)) continue;
      const el = h('audio', { autoplay: true, class: 'remote-audio', 'data-kind': kind === 'daw' ? 'daw' : 'cam' });
      el.srcObject = s;
      el.volume = kind === 'daw' ? S.dawVol : S.voiceVol;
      if (S.outId && el.setSinkId) el.setSinkId(S.outId).catch(() => {});
      document.body.append(el);
      el.play().catch(() => toast('소리를 켜려면 눌러주세요', { timeout: 0, actions: [{ label: '소리 켜기', fn: () => { for (const a of audios.values()) a.play().catch(() => {}); app.ctx?.resume(); } }] }));
      audios.set(k, el);
    }
  }

  function render() {
    const items = [];
    for (const [id, p] of app.peers) {
      const md = remote.get(id) || {}, ps = app.peerState.get(id) || {};
      if (md.screen?.getVideoTracks().length) items.push({ key: id + ':screen', name: `${p.name}의 화면`, stream: md.screen, screen: true });
      items.push({ key: id + ':cam', name: p.name + (p.role === 'teacher' && app.mode === 'lesson' ? ' · 선생님' : ''), stream: md.cam || null,
        video: !!md.cam?.getVideoTracks().length && ps.cam !== false, micOff: ps.mic === false, daw: !!md.daw, remote: true });
    }
    if (media.screen) items.push({ key: 'me:screen', name: '내 화면 (공유 중)', stream: media.screen, screen: true, local: true });
    if (previewTrack !== media.cam) { previewTrack = media.cam; preview = media.cam ? new MediaStream([media.cam]) : null; }
    items.push({ key: 'me:cam', name: `${app.me?.name || '나'} (나)`, stream: preview, video: !!media.cam && media.camOn, micOff: !media.micOn || !media.mic, mirror: true, local: true, daw: !!media.daw });

    const pick = pinned && items.find(i => i.key === pinned)
      || items.find(i => i.screen && !i.local) || items.find(i => i.remote && i.video) || items.find(i => i.remote)
      || items.find(i => i.screen) || items[items.length - 1];
    const keep = new Set(items.map(i => i.key));
    for (const [k, t] of tiles) if (!keep.has(k)) { t.v.srcObject = null; t.el.remove(); tiles.delete(k); }
    mainEl.replaceChildren(tileFor(pick, true));
    strip.replaceChildren(...items.filter(i => i !== pick).map(i => tileFor(i, false)));
    for (const t of tiles.values()) if (t.v.srcObject && t.v.paused) t.v.play().catch(() => {});
    $('#stage').classList.toggle('has-strip', items.length > 1);
    renderControls();
  }

  function tileFor(it, isMain) {
    let t = tiles.get(it.key);
    if (!t) {
      const v = h('video', { autoplay: true, playsInline: true, muted: true });
      v.muted = true; v.setAttribute('playsinline', '');
      const el = h('div', { class: 'tile', onclick: () => { pinned = pinned === it.key ? null : it.key; render(); } },
        v, h('div', { class: 'avatar' }), h('div', { class: 'tile-label' }));
      t = { el, v }; tiles.set(it.key, t);
    }
    if (t.v.srcObject !== it.stream) t.v.srcObject = it.stream || null;
    t.el.classList.toggle('main', isMain);
    t.el.classList.toggle('novideo', !it.screen && !it.video);
    t.el.classList.toggle('mirror', !!it.mirror);
    t.el.classList.toggle('screen', !!it.screen);
    t.el.classList.toggle('pinned', pinned === it.key);
    t.el.querySelector('.avatar').textContent = (it.name || '?').trim().charAt(0);
    t.el.querySelector('.tile-label').replaceChildren(...[
      it.micOff ? h('span', { class: 'lbl-ico warn', html: icon('micOff', 14) }) : null,
      h('span', {}, it.name),
      it.daw ? h('span', { class: 'lbl-tag' }, 'DAW') : null].filter(Boolean));
    return t.el;
  }

  // 컨트롤
  const btnMic = $('#btnMic'), btnCam = $('#btnCam'), btnScreen = $('#btnScreen'), btnReq = $('#btnReqScreen'), btnFocus = $('#btnFocus');
  btnMic.onclick = () => setMicOn(!media.micOn);
  btnCam.onclick = () => setCamOn(!(media.camOn && media.cam));
  btnScreen.onclick = () => (media.screen ? stopScreen() : startScreen());
  btnReq.onclick = () => {
    if (!app.peers.size) return toast('아직 들어온 레슨생이 없어요');
    app.net.eph({ t: 'share-req' }); toast('화면 공유를 요청했어요');
  };
  btnFocus.onclick = () => setFocus(!S.focus);
  function setFocus(f) {
    setSetting('focus', f);
    $('#room').classList.toggle('focus', f);
    $('#stage').style.cssText = '';
    btnFocus.innerHTML = icon(f ? 'shrink' : 'expand', 20);
    btnFocus.title = f ? '영상 크게' : '탭 크게 (영상은 작은 창으로)';
  }
  setFocus(S.focus);
  if (!screenSupported()) btnScreen.classList.add('unsupported');
  function renderControls() {
    const micOn = media.micOn && !!media.mic, camOn = media.camOn && !!media.cam;
    btnMic.innerHTML = icon(micOn ? 'mic' : 'micOff', 20); btnMic.classList.toggle('off', !micOn); btnMic.title = micOn ? '마이크 끄기' : '마이크 켜기';
    btnCam.innerHTML = icon(camOn ? 'cam' : 'camOff', 20); btnCam.classList.toggle('off', !camOn); btnCam.title = camOn ? '카메라 끄기' : '카메라 켜기';
    btnScreen.classList.toggle('active', !!media.screen); btnScreen.title = media.screen ? '화면 공유 중지' : '내 화면 공유';
    btnReq.hidden = !(isTeacher() && app.mode === 'lesson');
  }
  // PiP 창 드래그 (포커스 모드)
  const stage = $('#stage');
  let drag = null;
  stage.addEventListener('pointerdown', e => {
    if (!$('#room').classList.contains('focus') || e.target.closest('button')) return;
    const r = stage.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
  });
  addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    drag.moved = true;
    stage.style.left = Math.max(4, Math.min(innerWidth - stage.offsetWidth - 4, e.clientX - drag.dx)) + 'px';
    stage.style.top = Math.max(4, Math.min(innerHeight - stage.offsetHeight - 4, e.clientY - drag.dy)) + 'px';
    stage.style.right = 'auto'; stage.style.bottom = 'auto';
  });
  addEventListener('pointerup', () => { drag = null; });
  render();
}
