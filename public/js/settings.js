// 설정 탭: 오디오·비디오 장치, 음질, 출력, 연결 상태, Logic Pro 연결 가이드 (모두 접이식 폴더)
import { app, h, icon, on, setSetting, peerName } from './util.js';
import { media, listDevices, openMic, openCam, openDaw, makeMeter } from './media.js';

export function initSettings(pane) {
  const S = app.settings;
  const sec = (title, open, ...kids) => h('details', { class: 'fold', open }, h('summary', {}, title), h('div', { class: 'fold-body' }, ...kids));
  const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el, hint ? h('span', { class: 'muted small' }, hint) : null);
  const toggle = (label, key, hint, after) => h('label', { class: 'switch-row' },
    h('span', {}, h('span', {}, label), hint ? h('span', { class: 'muted small block' }, hint) : null),
    h('input', { type: 'checkbox', class: 'switch', checked: !!S[key], onchange: e => { setSetting(key, e.target.checked); after?.(e.target.checked); } }));

  const micSel = h('select', { class: 'select', onchange: () => { setSetting('micId', micSel.value); openMic(); } });
  const dawSel = h('select', { class: 'select', onchange: () => { setSetting('dawId', dawSel.value); openDaw(dawSel.value); } });
  const camSel = h('select', { class: 'select', onchange: () => { setSetting('camId', camSel.value); openCam(); } });
  const outSel = h('select', { class: 'select', onchange: () => { setSetting('outId', outSel.value); applySink(); } });
  const kbpsSel = h('select', { class: 'select', onchange: () => { setSetting('audioKbps', +kbpsSel.value); app.rtc.setAudioKbps(+kbpsSel.value); } },
    ...[[510, '최고 (510kbps 스테레오) — 음악 레슨 권장'], [320, '높음 (320kbps)'], [192, '보통 (192kbps) — 느린 회선'], [96, '절약 (96kbps)']].map(([v, l]) => h('option', { value: v, selected: v === S.audioKbps }, l)));
  const micMeter = h('div', { class: 'meter' }, h('i')), dawMeter = h('div', { class: 'meter' }, h('i'));
  const stats = h('div', { class: 'stats' }, h('p', { class: 'muted small' }, '상대와 연결되면 실시간 지연·음질 정보가 표시돼요.'));

  async function fillDevices() {
    const d = await listDevices();
    const opts = (sel, list, cur, none) => sel.replaceChildren(
      ...(none ? [h('option', { value: '' }, none)] : [h('option', { value: '' }, '기본 장치')]),
      ...list.filter(x => x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications').map(x => h('option', { value: x.deviceId, selected: x.deviceId === cur }, x.label || '장치')));
    opts(micSel, d.mics, S.micId);
    opts(dawSel, d.mics, S.dawId, '사용 안 함');
    opts(camSel, d.cams, S.camId);
    if ('setSinkId' in HTMLMediaElement.prototype) opts(outSel, d.outs, S.outId);
    else outSel.replaceChildren(h('option', {}, '이 브라우저는 출력 장치 선택을 지원하지 않아요')), outSel.disabled = true;
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', fillDevices);

  function applySink() {
    for (const el of document.querySelectorAll('audio.remote-audio')) el.setSinkId?.(S.outId || '').catch(() => {});
    app.ctx?.setSinkId?.(S.outId || '').catch(() => {});
  }
  const vol = (label, key, kind) => {
    const out = h('span', { class: 'muted small' }, Math.round(S[key] * 100) + '%');
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
      h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: S[key], oninput: e => {
        setSetting(key, +e.target.value); out.textContent = Math.round(+e.target.value * 100) + '%';
        for (const el of document.querySelectorAll(`audio.remote-audio[data-kind="${kind}"]`)) el.volume = +e.target.value;
      } }), out);
  };

  pane.append(h('div', { class: 'pane-scroll' },
    sec('오디오 입력', true,
      field('마이크 / 오디오 인터페이스 (목소리·기타)', micSel), micMeter,
      toggle('악기 원음 모드', 'instrumentMode', '에코 제거·잡음 제거·자동 음량을 꺼서 기타·노래를 원음 그대로 보내요. 반드시 헤드폰을 사용하세요.', () => openMic()),
      field('DAW 입력 (Logic Pro 출력)', dawSel, 'BlackHole 2ch 또는 Loopback을 선택하면 Logic Pro 소리가 처리 없이 스테레오로 전송돼요.'), dawMeter,
      field('전송 음질', kbpsSel, 'Opus 48kHz 스테레오. 510kbps는 원음과 구분이 어려운 수준이에요. 완전 무손실 원본은 자료함으로 주고받으세요.')),
    sec('비디오', false,
      field('카메라', camSel),
      toggle('고화질 (1080p)', 'hd', '기타 손가락이 선명하게 보여요. 회선이 느리면 끄세요.', () => openCam())),
    sec('소리 출력', false,
      field('출력 장치 (헤드폰)', outSel),
      vol('상대 목소리·악기 볼륨', 'voiceVol', 'cam'),
      vol('상대 DAW(Logic) 볼륨', 'dawVol', 'daw')),
    sec('연결 상태', true, stats),
    Object.assign(sec('Logic Pro 연결 가이드', false, guide()), { className: 'fold teacher-only' }),
    sec('태블릿 팁', false, h('ul', { class: 'tips' },
      h('li', {}, 'Safari 공유 버튼 → "홈 화면에 추가"로 설치하면 전체 화면 앱처럼 쓸 수 있어요.'),
      h('li', {}, 'Apple Pencil로 악보에 쓰면 자동으로 "펜으로만 필기" 모드가 켜져 손가락으로 스크롤할 수 있어요.'),
      h('li', {}, 'iPad는 Web MIDI·화면 공유를 지원하지 않아요. 화면 건반·지판, 필기, 가사, 영상·음성은 모두 동작해요.'),
      h('li', {}, '가로 모드에서 영상·탭·건반이 한 화면에 모두 보여요. 오른쪽 위 확대 버튼으로 탭을 크게 볼 수 있어요.'))),
  ));

  function guide() {
    return h('div', { class: 'guide' },
      h('h4', {}, '① Logic 소리를 레슨생에게 보내기 (오디오)'),
      h('ol', {},
        h('li', {}, '무료 가상 오디오 드라이버 BlackHole 2ch(또는 Rogue Amoeba Loopback)를 설치합니다.'),
        h('li', {}, '“Audio MIDI 설정” 앱에서 “다중 출력 기기”를 만들고 헤드폰 + BlackHole 2ch를 체크합니다 (샘플레이트 48kHz). 합주처럼 지연이 중요하면 “통합 기기” 방식이 더 빨라요 — 합주 탭 › Logic Pro 지연 줄이기 참고.'),
        h('li', {}, 'Logic Pro → 설정 → 오디오 → 출력 장치를 이 다중 출력 기기로 지정합니다.'),
        h('li', {}, '여기 “DAW 입력”에서 BlackHole 2ch를 선택하면 끝! 목소리(마이크)와 별도 채널로 전송돼 상대가 따로 볼륨을 조절할 수 있어요.')),
      h('h4', {}, '② 레슨생 건반으로 내 Logic 가상악기 연주하기 (MIDI)'),
      h('ol', {},
        h('li', {}, '“Audio MIDI 설정” → 윈도우 → MIDI 스튜디오 보기 → IAC 드라이버 더블클릭 → “기기가 온라인 상태임” 체크.'),
        h('li', {}, '악기·MIDI 탭 → MIDI 장치에서 출력을 “IAC 드라이버 버스 1”로 선택하고 “상대 연주를 MIDI 출력으로 보내기”를 켭니다.'),
        h('li', {}, 'Logic에서 소프트웨어 악기 트랙을 녹음 대기하면 레슨생 연주가 그대로 들어와요. 소리는 ①로 다시 전달돼요.'),
        h('li', {}, '이중 재생을 막으려면 “상대 기기에서 내장 악기로 소리내기”를 꺼두세요.')),
      h('h4', {}, '③ 내 컨트롤러 연주를 레슨생 화면에 보여주기'),
      h('ol', {},
        h('li', {}, 'MIDI 입력에서 내 키보드를 체크하면 레슨생 화면 하단 건반에 내 연주가 주황색으로 표시돼요.'),
        h('li', {}, 'Logic을 함께 쓰는 동안 macOS가 같은 MIDI 장치를 두 앱에 동시에 전달하므로 따로 설정할 필요가 없어요.')),
      h('h4', {}, '④ 작업 결과 무손실로 전달하기'),
      h('p', {}, 'Logic에서 바운스한 WAV/AIFF나 MIDI 리전(파일 → 내보내기 → 선택 영역을 MIDI 파일로)을 자료함에 올리면 원본 그대로 전달돼요. MIDI 녹음 기능으로 레슨 중 연주를 .mid로 받아 Logic에 끌어다 놓을 수도 있어요.'));
  }

  // 미터
  let meters = null, raf = 0;
  function startMeters() {
    stopMeters();
    meters = { mic: makeMeter(media.mic), daw: makeMeter(media.daw) };
    const loop = () => {
      micMeter.firstChild.style.width = Math.min(100, meters.mic() * 140) + '%';
      dawMeter.firstChild.style.width = Math.min(100, meters.daw() * 140) + '%';
      raf = requestAnimationFrame(loop);
    };
    loop();
  }
  function stopMeters() { cancelAnimationFrame(raf); meters?.mic.dispose?.(); meters?.daw.dispose?.(); meters = null; }
  on('tab', t => { if (t === 'settings') { fillDevices(); startMeters(); } else stopMeters(); });
  on('local-media', () => { if (meters) startMeters(); });

  // 연결 통계
  const latest = new Map();
  on('stats', s => { latest.set(s.id, s); renderStats(); });
  on('peers', () => { for (const id of latest.keys()) if (!app.peers.has(id)) latest.delete(id); renderStats(); });
  function renderStats() {
    if (!latest.size) return;
    stats.replaceChildren(...[...latest.values()].map(s => {
      const oneWay = s.rtt != null ? s.rtt / 2 + (s.jb ?? 20) + 10 : null;
      const grade = oneWay == null ? '' : oneWay < 40 ? 'ok' : oneWay < 80 ? 'warn' : 'bad';
      const row = (k, v) => h('div', { class: 'stat' }, h('span', { class: 'muted' }, k), h('b', {}, v));
      return h('div', { class: 'stat-card ' + grade },
        h('div', { class: 'row between' }, h('b', {}, peerName(s.id)), h('span', { class: 'badge ' + grade }, oneWay == null ? '측정 중' : `예상 지연 ≈ ${Math.round(oneWay)}ms`)),
        h('div', { class: 'stat-grid' },
          row('왕복 시간(RTT)', s.rtt != null ? `${Math.round(s.rtt)} ms` : '–'),
          row('지터 버퍼', s.jb != null ? `${Math.round(s.jb)} ms` : '–'),
          row('패킷 손실', s.lossPct != null ? `${s.lossPct.toFixed(1)} %` : '–'),
          row('받는 오디오', s.inKbps != null ? `${Math.round(s.inKbps)} kbps` : '–'),
          row('보내는 오디오', s.outKbps != null ? `${Math.round(s.outKbps)} kbps` : '–'),
          row('코덱', s.codec || '–'),
          row('연결 경로', s.local ? (s.local === 'relay' || s.remote === 'relay' ? 'TURN 중계' : '직접 P2P') : '–')));
    }));
  }
  fillDevices();
}
