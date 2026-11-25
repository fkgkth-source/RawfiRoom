// 합주 탭: 지연 측정 → 저지연 모드 → 동기 메트로놈 → 마디 싱크(NINJAM 방식) 합주
import { app, h, icon, on, emit, setSetting, toast, isTeacher, canLead } from './util.js';
import { clock } from './clock.js';
import { media, openMic, setCamOn, listDevices } from './media.js';

const GRADES = [
  { max: 25, cls: 'ok', title: '실시간 합주 가능', desc: '같은 방에서 치는 것과 거의 비슷해요. 실시간 모드로 합주하세요.' },
  { max: 45, cls: 'warn', title: '느린 템포라면 실시간 합주 가능', desc: '빠른 곡은 박이 밀려요. 선생님이 리드하고 레슨생이 따라오는 방식, 또는 마디 싱크를 추천해요.' },
  { max: Infinity, cls: 'bad', title: '마디 싱크 합주 추천', desc: '지연이 커서 실시간으로 박을 맞추긴 어려워요. 마디 싱크로 바꾸면 거리와 상관없이 박이 딱 맞아요.' },
];

export function initJam(pane) {
  const S = app.settings, ctx = app.ctx;
  const jam = app.doc.getMap('jam');
  const st = () => ({ running: !!jam.get('running'), bpm: jam.get('bpm') || 90, beats: jam.get('beats') || 4, startAt: jam.get('startAt') || 0, mode: jam.get('mode') || 'live', bars: jam.get('bars') || 1 });
  let lastStats = null;
  on('stats', s => { lastStats = s; });

  // ── 지연 추정 ──
  const outLat = () => ((ctx.outputLatency || ctx.baseLatency || 0.01) * 1000);
  function estimate() {
    const rtt = lastStats?.rtt ?? clock.rtt;
    if (rtt == null) return null;
    const jb = lastStats?.jb ?? 20;
    const frame = S.jamLowLatency ? 10 : 20;
    return { audio: rtt / 2 + jb + frame + 8 + outLat(), midi: rtt / 2 + outLat(), rtt, jb };
  }
  const barMs = j => 60000 / j.bpm * j.beats;

  // ── 메트로놈 (각자 기기에서 같은 순간에 울림, 네트워크로 소리를 보내지 않음) ──
  const metroGain = ctx.createGain();
  metroGain.gain.value = S.metroVol;
  metroGain.connect(ctx.destination);
  function perfToCtx(perf) {
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime) return ts.contextTime + (perf - ts.performanceTime) / 1000;
    return ctx.currentTime + (perf - performance.now()) / 1000 - (ctx.outputLatency || 0);
  }
  function click(t, accent) {
    if (t < ctx.currentTime) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = accent ? 1760 : 1100;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, t + 0.001); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g); g.connect(metroGain); o.start(t); o.stop(t + 0.06);
  }
  let nextBeat = null;
  setInterval(() => {
    const j = st();
    if (!j.running) { nextBeat = null; return; }
    const beat = 60000 / j.bpm, nowM = clock.now();
    const due = Math.ceil((nowM - j.startAt) / beat);
    if (nextBeat == null || nextBeat < due - 1 || nextBeat > due + 2) nextBeat = Math.max(0, due);
    while (true) {
      const tM = j.startAt + nextBeat * beat;
      if (tM > nowM + 160) break;
      const perf = clock.toLocalPerf(tM), idx = nextBeat % j.beats;
      click(perfToCtx(perf), idx === 0);
      setTimeout(() => flash(idx), Math.max(0, perf - performance.now()));
      nextBeat++;
    }
  }, 20);

  // ── 마디 싱크: 상대 소리를 정확히 N마디 늦춰 박에 맞춤 ──
  const barActive = () => { const j = st(); return j.running && j.mode === 'bar'; };
  const remote = new Map();      // peerId -> {cam,daw,screen}
  const routes = new Map();      // streamId -> {src, delay, gain}
  on('remote-media', ({ id, media }) => { remote.set(id, media); setTimeout(syncRoutes, 0); });
  function syncRoutes() {
    const active = barActive(), want = new Map();
    if (active) for (const md of remote.values()) for (const k of ['cam', 'daw']) {
      const s = md[k];
      if (s && s.getAudioTracks().length) want.set(s.id, { s, k });
    }
    for (const [sid, r] of routes) if (!want.has(sid)) { try { r.src.disconnect(); r.gain.disconnect(); } catch {} routes.delete(sid); }
    for (const [sid, { s, k }] of want) {
      if (routes.has(sid)) continue;
      const src = ctx.createMediaStreamSource(s), delay = ctx.createDelay(20), gain = ctx.createGain();
      gain.gain.value = k === 'daw' ? S.dawVol : S.voiceVol;
      src.connect(delay); delay.connect(gain); gain.connect(ctx.destination);
      routes.set(sid, { src, delay, gain });
    }
    // 실시간 재생(audio 요소)은 마디 싱크 중 음소거 (WebAudio로 지연 재생)
    for (const el of document.querySelectorAll('audio.remote-audio')) el.muted = active;
    updateDelay(true);
  }
  function updateDelay(force) {
    const j = st(), e = estimate();
    if (!routes.size) return;
    const target = Math.max(0, Math.min(19.9, (barMs(j) * j.bars - (e?.audio ?? 60) + S.barAdj) / 1000));
    for (const r of routes.values()) {
      if (force) r.delay.delayTime.setValueAtTime(target, ctx.currentTime);
      else if (Math.abs(r.delay.delayTime.value - target) > 0.004) r.delay.delayTime.setTargetAtTime(target, ctx.currentTime, 0.4);
    }
  }
  setInterval(() => updateDelay(false), 1000);

  // 원격 MIDI: 마디 싱크면 보낸 순간 + N마디 시점에 재생 (타임스탬프 기반이라 매우 정확)
  app.jam = {
    remoteDelay(d) {
      if (!barActive() || d.ts == null) return 0;
      const j = st();
      const perf = clock.toLocalPerf(d.ts + barMs(j) * j.bars + S.barAdj);
      return Math.max(0, perf - performance.now() - outLat());
    },
  };


  // ── 자동 지연 진단 ──
  const diagBox = h('div', { class: 'diag' });
  const budgetBox = h('table', { class: 'budget' });
  let outLabel = '';
  async function refreshOutLabel() {
    const d = await listDevices();
    const o = d.outs.find(x => x.deviceId === (S.outId || 'default')) || d.outs[0];
    outLabel = o?.label || '';
  }
  refreshOutLabel();
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshOutLabel);
  const fixBtn = (label, fn) => h('button', { class: 'btn sm primary', onclick: async () => { await fn(); renderDiag(); } }, label);
  function renderDiag() {
    const rows = [];
    const add = (cls, txt, action) => rows.push(h('div', { class: 'diag-row ' + cls }, h('span', { class: 'd-ico' }, cls === 'ok' ? '✓' : cls === 'warn' ? '!' : '✕'), h('span', { class: 'd-txt' }, txt), action || null));
    const s = lastStats;
    if (!s?.local) add('warn', '연결 경로: 상대와 연결되면 확인해요');
    else if (s.local === 'relay' || s.remote === 'relay') add('warn', '연결 경로: TURN 중계 경유 (+10~40ms). 공유기 UPnP 켜기 / 회사·학교망 피하기');
    else add('ok', '연결 경로: 서버를 거치지 않는 직접 P2P');
    if (/airpods|bluetooth|buds|beats|bose|wh-1000|galaxy|jbl/i.test(outLabel)) add('bad', `출력 장치 "${outLabel}"는 블루투스예요 → 150~300ms 추가. 유선 헤드폰이나 오디오 인터페이스로 바꾸세요`);
    else add('ok', `출력 장치: ${outLabel || '기본 장치'} (유선)`);
    add(S.instrumentMode ? 'ok' : 'warn', S.instrumentMode ? '마이크: 에코·잡음 처리 꺼짐 (처리 지연 없음)' : '마이크: 에코 제거 처리 중 (약 10ms 추가)',
      S.instrumentMode ? null : fixBtn('원음 모드 켜기', async () => { setSetting('instrumentMode', true); await openMic(); }));
    add(S.jamLowLatency ? 'ok' : 'warn', S.jamLowLatency ? '저지연 모드: Opus 10ms 프레임 사용' : '저지연 모드 꺼짐 (프레임 20ms)',
      S.jamLowLatency ? null : fixBtn('켜기', () => { setSetting('jamLowLatency', true); lowToggle.checked = true; app.rtc.renegotiate(); }));
    const camOn = media.cam && media.camOn;
    add(camOn ? 'warn' : 'ok', camOn ? '카메라 켜짐: 끄면 대역폭·CPU가 오디오에 집중돼요' : '카메라 꺼짐: 대역폭을 오디오에 집중',
      camOn ? fixBtn('카메라 끄기', () => setCamOn(false)) : null);
    const ol = Math.round(outLat());
    add(ol <= 15 ? 'ok' : ol <= 30 ? 'warn' : 'bad', `내 기기 출력 버퍼: ${ol}ms${ol > 15 ? ' — 오디오 인터페이스 사용, 다른 오디오 앱 종료' : ''}`);
    add(ctx.sampleRate === 48000 ? 'ok' : 'warn', ctx.sampleRate === 48000 ? '샘플레이트 48kHz (리샘플링 없음)' : `샘플레이트 ${ctx.sampleRate}Hz → 48kHz로 맞추세요 (리샘플링 지연)`);
    if (s?.lossPct != null) add(s.lossPct < 0.5 ? 'ok' : s.lossPct < 2 ? 'warn' : 'bad', `패킷 손실 ${s.lossPct.toFixed(1)}%${s.lossPct >= 0.5 ? ' — 와이파이 대신 유선 랜' : ''}`);
    if (s?.jitter != null) add(s.jitter < 5 ? 'ok' : s.jitter < 15 ? 'warn' : 'bad', `네트워크 흔들림(지터) ${s.jitter.toFixed(1)}ms${s.jitter >= 5 ? ' — 지터가 클수록 버퍼가 커져 지연이 늘어요' : ''}`);
    diagBox.replaceChildren(...rows);

    const e = estimate(), fr = S.jamLowLatency ? 10 : 20;
    const row = (k, v) => h('tr', {}, h('td', {}, k), h('td', {}, v));
    const net = e ? Math.round(e.rtt / 2) : null, jb = e ? Math.round(e.jb) : null;
    budgetBox.replaceChildren(
      row('Logic·오디오 인터페이스 (버퍼 64 / 48kHz)', '≈ 3~6ms'),
      row('브라우저 마이크 캡처', '≈ 10ms'),
      row(`Opus 인코딩 (${fr}ms 프레임 + 룩어헤드)`, `≈ ${fr + 3}ms`),
      row('인터넷 편도 (측정)', net != null ? `${net}ms` : '–'),
      row('수신 지터 버퍼 (측정)', jb != null ? `${jb}ms` : '–'),
      row('내 기기 출력 (측정)', `${ol}ms`),
      h('tr', { class: 'total' }, h('td', {}, '합계 (상대 연주 → 내 귀)'), h('td', {}, e ? `≈ ${Math.round(e.audio + 5)}ms` : '–')));
  }
  setInterval(renderDiag, 2000);

  // ── UI ──
  const bigLat = h('div', { class: 'lat-big' }, '–');
  const latSub = h('div', { class: 'muted small' }, '상대와 연결되면 측정돼요');
  const gradeBadge = h('span', { class: 'badge' }, '측정 중');
  const gradeDesc = h('p', { class: 'small' }, '');
  const bpmIn = h('input', { class: 'input bpm', type: 'number', min: 30, max: 260, value: st().bpm });
  const beatsSel = h('select', { class: 'select sm' }, ...[2, 3, 4, 5, 6, 7].map(b => h('option', { value: b, selected: b === st().beats }, `${b}/4`)));
  const startBtn = h('button', { class: 'btn primary lg metro-btn', onclick: () => {
    if (st().running) jam.set('running', false);
    else app.doc.transact(() => { jam.set('bpm', +bpmIn.value || 90); jam.set('beats', +beatsSel.value); jam.set('startAt', clock.now() + 1200); jam.set('running', true); });
  } });
  const dots = h('div', { class: 'beat-dots' });
  const modeSeg = h('div', { class: 'seg' },
    h('button', { class: 'seg-btn', 'data-m': 'live', onclick: () => jam.set('mode', 'live') }, '실시간'),
    h('button', { class: 'seg-btn', 'data-m': 'bar', onclick: () => jam.set('mode', 'bar') }, '마디 싱크'));
  const barsSel = h('select', { class: 'select sm', onchange: () => jam.set('bars', +barsSel.value) }, h('option', { value: 1 }, '1마디 늦게'), h('option', { value: 2 }, '2마디 늦게'));
  const adjOut = h('span', { class: 'muted small' }, `${S.barAdj > 0 ? '+' : ''}${S.barAdj}ms`);
  const lowToggle = h('input', { type: 'checkbox', class: 'switch', checked: S.jamLowLatency, onchange: e => {
    setSetting('jamLowLatency', e.target.checked);
    app.rtc.renegotiate();
    toast(e.target.checked ? '저지연 합주 모드 ON — 오디오 10ms 프레임, 영상 화질을 낮춰 대역폭을 오디오에 몰아줘요' : '저지연 합주 모드 OFF');
  } });
  const tapTimes = [];
  const tapBtn = h('button', { class: 'btn', onclick: () => {
    const t = performance.now();
    if (tapTimes.length && t - tapTimes[tapTimes.length - 1] > 2000) tapTimes.length = 0;
    tapTimes.push(t); if (tapTimes.length > 5) tapTimes.shift();
    if (tapTimes.length >= 2) bpmIn.value = Math.round(60000 / ((tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1)));
  } }, '탭');
  for (const el of [bpmIn, beatsSel]) el.addEventListener('change', () => {
    if (!st().running) return;
    app.doc.transact(() => { jam.set('bpm', +bpmIn.value || 90); jam.set('beats', +beatsSel.value); jam.set('startAt', clock.now() + 600); });
  });

  const sec = (title, open, ...kids) => h('details', { class: 'fold', open }, h('summary', {}, title), h('div', { class: 'fold-body' }, ...kids));
  const leadNote = h('p', { class: 'muted small student-only' }, '메트로놈 시작·합주 방식은 선생님이 정해요. 볼륨과 미세 보정은 내 기기에서만 바뀌어요.');
  pane.append(h('div', { class: 'pane-scroll' },
    h('div', { class: 'card lat-card' },
      h('div', { class: 'row between' }, h('b', {}, '지금 연결의 합주 가능도'), gradeBadge),
      h('div', { class: 'row lat-row' }, bigLat, h('div', {}, h('div', { class: 'small' }, '오디오 단방향 예상 지연'), latSub)),
      gradeDesc),
    sec('지연 진단 (자동)', true, diagBox,
      h('p', { class: 'muted small' }, '빨간 항목부터 고치면 효과가 커요. 지연이 어디서 생기는지:'), budgetBox),
    sec('① 저지연 합주 모드', true,
      h('label', { class: 'switch-row' }, h('span', {}, h('span', {}, '저지연 합주 모드 (내 기기)'),
        h('span', { class: 'muted small block' }, 'Opus 10ms 프레임 · 지터 버퍼 최소 · 영상 저화질 · MIDI 무대기 전송. 양쪽 모두 켜면 가장 빨라요.')), lowToggle),
      h('ul', { class: 'tips' },
        h('li', {}, h('b', {}, '유선 랜'), ' 연결 (와이파이는 지터가 커서 10~30ms 손해)'),
        h('li', {}, h('b', {}, '헤드폰 필수'), ' · 설정 탭에서 "악기 원음 모드" 켜기'),
        h('li', {}, '내 악기 소리는 오디오 인터페이스 다이렉트 모니터로 듣기 (내 소리 지연 0)'),
        h('li', {}, 'Logic Pro: 오디오 I/O 버퍼 64~128 샘플, 48kHz, "I/O 안전 버퍼" 끄기'),
        h('li', {}, '다른 탭·클라우드 동기화·영상 스트리밍 끄기'))),
    sec('② 동기 메트로놈 (양쪽에서 같은 순간에 울림)', true,
      h('div', { class: 'row wrap' }, h('label', { class: 'row tight' }, 'BPM', bpmIn), tapBtn, beatsSel, h('span', { class: 'spacer' }), startBtn),
      dots,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '메트로놈 볼륨 (내 기기)'),
        h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: S.metroVol, oninput: e => { setSetting('metroVol', +e.target.value); metroGain.gain.value = +e.target.value; } })),
      h('p', { class: 'muted small' }, '클릭 소리는 네트워크로 보내지 않고, 시계를 맞춘 뒤 각자 기기에서 동시에 울려요. 그래서 메트로놈 자체에는 지연이 없어요.'),
      leadNote),
    sec('③ 합주 방식', true,
      modeSeg,
      h('div', { class: 'mode-explain' },
        h('p', { class: 'small' }, h('b', {}, '실시간: '), '상대 소리를 바로 들어요. 지연이 25ms 이하일 때 자연스러워요.'),
        h('p', { class: 'small' }, h('b', {}, '마디 싱크: '), '상대 소리를 정확히 1마디(또는 2마디) 늦춰서 들려줘요. 둘 다 메트로놈에 맞춰 치면 상대 연주가 항상 박에 딱 맞게 들려서, 지연과 상관없이 합주할 수 있어요. 반복 코드 진행·블루스·루프 잼에 좋아요. (NINJAM과 같은 원리)')),
      h('div', { class: 'row wrap bar-opts' }, barsSel,
        h('label', { class: 'row tight grow' }, h('span', { class: 'muted small' }, '미세 보정'),
          h('input', { type: 'range', min: -60, max: 60, step: 1, value: S.barAdj, oninput: e => { setSetting('barAdj', +e.target.value); adjOut.textContent = `${+e.target.value > 0 ? '+' : ''}${e.target.value}ms`; } }), adjOut)),
      h('p', { class: 'muted small' }, '마디 싱크는 메트로놈이 켜져 있을 때 동작해요. 상대 소리가 박보다 앞서 들리면 +, 뒤로 밀리면 −로 맞추세요.')),
    sec('Logic Pro 지연 줄이기', false, h('div', { class: 'guide' },
      h('ol', {},
        h('li', {}, h('b', {}, 'I/O 버퍼 64'), ' — Logic Pro › 설정 › 오디오 › 기기: I/O 버퍼 크기 64 (CPU 여유가 있으면 32), 처리 버퍼 범위 "작게". 아래 "결과 왕복 지연"을 10ms 이하로.'),
        h('li', {}, h('b', {}, '저지연 모드'), ' — 설정 › 오디오 › 일반에서 저지연 모드 최대 지연을 0~5ms로 → 컨트롤 막대 사용자화에서 "저지연 모드" 버튼을 추가해 켜면 지연 큰 플러그인이 자동 우회돼요.'),
        h('li', {}, h('b', {}, '플러그인 지연 보정'), ' — 합주 중엔 "끔"(또는 "오디오 및 소프트웨어 악기 트랙"). 믹스할 때 다시 "모두"로.'),
        h('li', {}, h('b', {}, '무거운 플러그인 바이패스'), ' — 리니어 페이즈 EQ, Adaptive Limiter 등 룩어헤드 리미터, 마스터 체인, 오버샘플링 앰프심은 합주 중 끄기.'),
        h('li', {}, h('b', {}, '내 소리는 다이렉트 모니터'), ' — 오디오 트랙은 인터페이스 다이렉트 모니터링으로 듣고 Logic 소프트웨어 모니터링은 끄기 (내 소리 지연 0).'),
        h('li', {}, h('b', {}, '통합 기기로 라우팅'), ' — 다중 출력 기기 대신 Audio MIDI 설정의 "통합 기기"에 오디오 인터페이스 + BlackHole 2ch를 묶고, 클럭 소스는 인터페이스, BlackHole에만 드리프트 보정. Logic 출력 1-2는 헤드폰, 마스터/버스를 출력 3-4(BlackHole)로 보내고 RawfiRoom DAW 입력에서 BlackHole 선택. 다중 출력 기기보다 버퍼 한 단계가 줄어요.'),
        h('li', {}, h('b', {}, '전부 48kHz'), ' — Logic 프로젝트, 인터페이스, BlackHole, 통합 기기 모두 48kHz. 44.1↔48 변환은 지연과 음질 손실을 만들어요.'),
        h('li', {}, h('b', {}, '여유 확보'), ' — "I/O 안전 버퍼" 끄기, 안 쓰는 트랙 Freeze, 클라우드 동기화·다른 브라우저 탭 종료, 맥은 전원 연결.'),
        h('li', {}, h('b', {}, '클릭은 RawfiRoom 메트로놈'), ' — Logic 메트로놈을 상대에게 보내면 지연이 쌓인 클릭이 들려요. 양쪽 동시에 울리는 RawfiRoom 동기 메트로놈을 쓰세요.')),
      h('p', { class: 'muted small' }, '이렇게 하면 Logic 쪽 지연은 약 3~6ms까지 줄어요. 나머지는 네트워크·브라우저 몫이라, 더 줄이려면 아래 전용 앱 조합을 쓰세요.'))),
    sec('더 낮은 지연이 필요하다면', false,
      h('p', { class: 'small' }, '브라우저(WebRTC)는 안정성을 위한 버퍼 때문에 최소 지연에 한계가 있어요. 실시간 오디오 합주가 핵심이면 전용 앱을 같이 쓰는 게 가장 확실해요:'),
      h('ul', { class: 'tips' },
        h('li', {}, h('b', {}, 'SonoBus'), ' (무료) — Mac·iPad 앱 + Logic Pro AU 플러그인. 압축 없는 PCM 전송 가능, 국내 유선 기준 약 15~30ms.'),
        h('li', {}, h('b', {}, 'JackTrip / Jamulus'), ' — 무손실·초저지연 합주 전용.'),
        h('li', {}, 'RawfiRoom은 그대로 켜두고 영상·악보·가사·건반 표시용으로 쓰고, 오디오만 전용 앱으로 보내면 둘의 장점을 함께 쓸 수 있어요 (이때 RawfiRoom 마이크는 꺼두세요).')),
      h('p', { class: 'muted small' }, '참고: 빛의 속도와 인터넷 경로 때문에 서울–부산도 왕복 약 10ms가 기본으로 들어가요. 사람은 보통 단방향 25~30ms 이하면 같은 공간처럼 느껴요.')),
  ));

  function flash(idx) {
    const d = dots.children[idx];
    if (!d) return;
    d.classList.add('on'); setTimeout(() => d.classList.remove('on'), 110);
  }
  function render() {
    const j = st(), lead = canLead() || ![...app.peers.values()].some(p => p.role === 'teacher');
    if (document.activeElement !== bpmIn) bpmIn.value = j.bpm;
    beatsSel.value = j.beats; barsSel.value = j.bars;
    dots.replaceChildren(...Array.from({ length: j.beats }, (_, i) => h('i', { class: i === 0 ? 'accent' : '' })));
    startBtn.replaceChildren(h('span', { html: icon(j.running ? 'stop' : 'play', 16) }), j.running ? '메트로놈 정지' : '메트로놈 시작');
    startBtn.classList.toggle('active', j.running);
    for (const b of modeSeg.children) b.classList.toggle('active', b.dataset.m === j.mode);
    for (const el of [startBtn, bpmIn, beatsSel, barsSel, tapBtn, ...modeSeg.children]) el.disabled = !lead;
    syncRoutes();
  }
  jam.observe(() => {
    const j = st();
    render();
    if (j.running && j.mode === 'bar') emit('tab-dot', 'jam');
  });
  function renderLat() {
    const e = estimate();
    if (!e) return;
    bigLat.textContent = `${Math.round(e.audio)}ms`;
    latSub.textContent = `MIDI·건반 ≈ ${Math.round(e.midi)}ms · 왕복 ${Math.round(e.rtt)}ms · 지터 버퍼 ${Math.round(e.jb)}ms`;
    const g = GRADES.find(x => e.audio <= x.max);
    gradeBadge.className = 'badge ' + g.cls; gradeBadge.textContent = g.title;
    gradeDesc.textContent = g.desc;
    bigLat.className = 'lat-big ' + g.cls;
  }
  on('stats', renderLat); on('clock', renderLat);
  on('setting', ({ k }) => { if (k === 'jamLowLatency') lowToggle.checked = S.jamLowLatency; });
  on('peers', render);
  render();
}
