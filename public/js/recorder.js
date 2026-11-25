// 수업 녹화: ① 영상+소리(MP4/WebM, 화면 합성) ② 소리만 무손실 WAV
// 소리는 내 마이크·DAW(원음), 상대 소리, 내장 악기를 한 스테레오 버스로 믹스해서 기록.
// 녹화 시작/정지는 모든 참가자에게 표시돼요.
import { app, $, h, icon, on, toast, menu, download, setSetting, fmtBytes, peerName } from './util.js';
import { media } from './media.js';
import { uploadFile, addFileRecord } from './files.js';

const WORKLET = `class P extends AudioWorkletProcessor{process(i){const x=i[0];if(x&&x.length){const L=x[0],R=x[1]||x[0],o=new Int16Array(L.length*2);for(let k=0;k<L.length;k++){let a=Math.max(-1,Math.min(1,L[k])),b=Math.max(-1,Math.min(1,R[k]));o[2*k]=a<0?a*32768:a*32767;o[2*k+1]=b<0?b*32768:b*32767}this.port.postMessage(o,[o.buffer])}return true}}registerProcessor('rawfi-rec',P)`;

const pickMime = () => ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  .find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';

export function initRecorder() {
  const ctx = app.ctx, S = app.settings;
  const btn = $('#btnRec'), badge = $('#recBadge');
  const remote = new Map(), remoteRec = new Map();
  let rec = null, workletReady = null;

  on('remote-media', ({ id, media: md }) => { remote.set(id, md); if (rec) rewire(); });
  on('local-media', () => { if (rec) rewire(); });

  // ── 믹스 버스 ──
  function buildMix() {
    const bus = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    bus.connect(dest);
    app.synth.master.connect(bus); // 내장 악기
    return { bus, dest, srcs: new Map() };
  }
  function rewire() {
    const want = new Map();
    if (media.mic) want.set('mic', media.mic);
    if (media.daw) want.set('daw', media.daw);
    for (const [id, md] of remote) for (const k of ['cam', 'daw', 'screen']) {
      const t = md[k]?.getAudioTracks()[0];
      if (t) want.set(id + k, t);
    }
    for (const [k, n] of rec.mix.srcs) if (want.get(k) !== n.track) { try { n.node.disconnect(); } catch {} rec.mix.srcs.delete(k); }
    for (const [k, t] of want) if (!rec.mix.srcs.has(k)) {
      const node = ctx.createMediaStreamSource(new MediaStream([t]));
      node.connect(rec.mix.bus);
      rec.mix.srcs.set(k, { node, track: t });
    }
  }
  function teardownMix(mix) {
    for (const n of mix.srcs.values()) try { n.node.disconnect(); } catch {}
    try { app.synth.master.disconnect(mix.bus); } catch {}
    try { mix.bus.disconnect(); } catch {}
  }

  // ── 화면 합성 (영상 녹화) ──
  function compositor(layout) {
    const W = 1280, H = 720;
    const c = h('canvas', { width: W, height: H }), g = c.getContext('2d');
    const fit = (src, sw, sh, x, y, w, hh, cover) => {
      if (!sw || !sh) return;
      const r = cover ? Math.max(w / sw, hh / sh) : Math.min(w / sw, hh / sh);
      const dw = sw * r, dh = sh * r;
      g.save(); g.beginPath(); g.rect(x, y, w, hh); g.clip();
      g.drawImage(src, x + (w - dw) / 2, y + (hh - dh) / 2, dw, dh); g.restore();
    };
    const draw = () => {
      g.fillStyle = '#0d0d10'; g.fillRect(0, 0, W, H);
      const tiles = [...document.querySelectorAll('#stage .tile')].filter(t => !t.classList.contains('novideo'));
      const vids = tiles.map(t => t.querySelector('video')).filter(v => v?.srcObject && v.videoWidth);
      const mainV = document.querySelector('#stageMain .tile:not(.novideo) video');
      const bg = document.querySelector('.page-bg'), ink = document.querySelector('.page-ink');
      const hasScore = bg && bg.width > 10 && !document.querySelector('.score-view')?.hidden;
      const useScore = hasScore && (layout === 'score' || (layout === 'auto' && S.tab === 'score'));
      if (useScore) {
        g.fillStyle = '#1b1b20'; g.fillRect(0, 0, 960, H);
        fit(bg, bg.width, bg.height, 10, 10, 940, H - 20);
        fit(ink, ink.width, ink.height, 10, 10, 940, H - 20);
        vids.slice(0, 3).forEach((v, i) => fit(v, v.videoWidth, v.videoHeight, 970, 10 + i * 236, 300, 226, true));
      } else {
        if (mainV?.videoWidth) fit(mainV, mainV.videoWidth, mainV.videoHeight, 0, 0, W, H, false);
        vids.filter(v => v !== mainV).slice(0, 3).forEach((v, i) => {
          const x = W - 256 - 16, y = H - (i + 1) * (144 + 12) - 4;
          g.fillStyle = '#000'; g.fillRect(x - 2, y - 2, 260, 148);
          fit(v, v.videoWidth, v.videoHeight, x, y, 256, 144, true);
        });
      }
      // 시그니처 레드 워터마크
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(16, 16, 230, 34);
      g.fillStyle = '#ff3b4e'; g.beginPath(); g.arc(34, 33, 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = '600 16px -apple-system, "Apple SD Gothic Neo", sans-serif';
      g.fillText(`RawfiRoom  ${clockText()}`, 50, 39);
    };
    draw();
    const timer = setInterval(draw, 1000 / 30);
    return { stream: c.captureStream(30), stop: () => clearInterval(timer) };
  }

  const clockText = () => {
    if (!rec) return '';
    const s = Math.floor((performance.now() - rec.t0) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  // ── 시작/정지 ──
  async function start(kind, layout = 'auto') {
    if (ctx.state !== 'running') await ctx.resume();
    const mix = buildMix();
    rec = { kind, mix, t0: performance.now(), chunks: [], bytes: 0 };
    rewire();
    try {
      if (kind === 'video') {
        const mime = pickMime();
        if (!mime) throw new Error('이 브라우저는 영상 녹화를 지원하지 않아요');
        const comp = compositor(layout);
        const stream = new MediaStream([...comp.stream.getVideoTracks(), ...mix.dest.stream.getAudioTracks()]);
        const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 320_000 });
        const r = rec; // stop() 이후 마지막 조각도 받도록 현재 녹화 객체를 붙잡아 둠
        mr.ondataavailable = e => { if (e.data.size) { r.chunks.push(e.data); r.bytes += e.data.size; } };
        mr.start(1000);
        Object.assign(rec, { mr, comp, mime });
      } else {
        if (!workletReady) workletReady = ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
        await workletReady;
        const node = new AudioWorkletNode(ctx, 'rawfi-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
        const sink = ctx.createGain(); sink.gain.value = 0;
        mix.bus.connect(node); node.connect(sink); sink.connect(ctx.destination);
        const r = rec;
        node.port.onmessage = e => { r.chunks.push(e.data); r.bytes += e.data.byteLength; };
        Object.assign(rec, { node, sink });
      }
    } catch (e) {
      teardownMix(mix); rec = null;
      toast('녹화를 시작할 수 없어요: ' + e.message, { kind: 'warn' });
      return paint();
    }
    rec.timer = setInterval(paint, 500);
    app.net.eph({ t: 'rec', on: true, kind });
    toast(kind === 'video' ? '영상 녹화를 시작했어요 — 상대에게도 녹화 중으로 표시돼요' : '무손실 WAV 녹음을 시작했어요 — 상대에게도 녹음 중으로 표시돼요');
    paint();
  }

  async function stop() {
    if (!rec) return;
    const r = rec; rec = null;
    clearInterval(r.timer);
    const dur = (performance.now() - r.t0) / 1000;
    let blob, ext;
    if (r.kind === 'video') {
      await new Promise(res => { r.mr.onstop = res; r.mr.stop(); });
      r.comp.stop();
      blob = new Blob(r.chunks, { type: r.mime.split(';')[0] });
      ext = r.mime.includes('mp4') ? 'mp4' : 'webm';
    } else {
      r.node.port.onmessage = null;
      try { r.mix.bus.disconnect(r.node); r.node.disconnect(); r.sink.disconnect(); } catch {}
      blob = wav(r.chunks, ctx.sampleRate);
      ext = 'wav';
    }
    teardownMix(r.mix);
    app.net.eph({ t: 'rec', on: false });
    paint();
    const name = `RawfiRoom-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.${ext}`;
    finished(blob, name, dur);
  }

  function wav(chunks, sr) {
    const len = chunks.reduce((s, c) => s + c.length, 0) * 2;
    const buf = new ArrayBuffer(44), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + len, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, len, true);
    return new Blob([buf, ...chunks], { type: 'audio/wav' });
  }

  function finished(blob, name, dur) {
    const dlg = $('#dlg');
    const upBtn = h('button', { class: 'btn', onclick: async () => {
      upBtn.disabled = true; upBtn.textContent = '올리는 중…';
      try { addFileRecord(await uploadFile(new File([blob], name, { type: blob.type }))); toast('자료함에 올렸어요 — 상대도 받을 수 있어요'); dlg.close(); }
      catch (e) { toast('업로드 실패: ' + e.message, { kind: 'warn' }); upBtn.disabled = false; upBtn.textContent = '자료함에 올리기'; }
    } }, '자료함에 올리기');
    dlg.replaceChildren(h('div', { class: 'dlg-body' },
      h('h3', {}, '녹화 완료'),
      h('p', { class: 'muted small' }, `${name} · ${Math.floor(dur / 60)}분 ${Math.round(dur % 60)}초 · ${fmtBytes(blob.size)}`),
      blob.type.startsWith('video') ? h('video', { class: 'rec-preview', controls: true, src: URL.createObjectURL(blob), playsInline: true }) : h('audio', { controls: true, src: URL.createObjectURL(blob), style: 'width:100%' }),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', onclick: () => dlg.close() }, '닫기'), upBtn,
        h('button', { class: 'btn primary', onclick: () => download(name, blob) }, h('span', { html: icon('download', 16) }), '다운로드'))));
    dlg.showModal();
  }

  // ── UI ──
  function paint() {
    if (rec) {
      btn.classList.add('recording');
      btn.replaceChildren(h('span', { html: icon('stop', 14) }), h('span', {}, clockText()), h('span', { class: 'muted small hide-narrow' }, ` · ${fmtBytes(rec.bytes)}`));
      btn.title = '녹화 정지';
    } else {
      btn.classList.remove('recording');
      btn.replaceChildren(h('span', { html: icon('rec', 16) }), h('span', { class: 'hide-narrow' }, '녹화'));
      btn.title = '수업 녹화';
    }
    const others = [...remoteRec.values()].filter(Boolean);
    badge.hidden = !rec && !others.length;
    badge.textContent = rec ? '● REC' : `● ${others[0]} 녹화 중`;
  }
  btn.onclick = () => {
    if (rec) return stop();
    let layout = 'auto';
    const lay = (v, l) => ({ label: l, checked: layout === v, keepOpen: true, onClick: () => { layout = v; m.remove(); open(); } });
    let m;
    const open = () => {
      m = menu(btn, [
        { title: '수업 녹화' },
        { label: '영상 + 소리 녹화', hint: pickMime().includes('mp4') ? 'MP4' : 'WebM', icon: 'cam', onClick: () => start('video', layout) },
        { label: '소리만 무손실 녹음', hint: 'WAV', icon: 'wave', onClick: () => start('wav') },
        { sep: true }, { title: '영상 화면 구성' },
        lay('auto', '자동 (악보 탭이면 악보 + 영상)'), lay('video', '영상 중심'), lay('score', '악보 + 영상'),
        { sep: true },
        { el: h('p', { class: 'menu-note' }, '내 마이크·DAW는 원음 그대로, 상대 소리는 받은 품질 그대로 한 파일에 담겨요. WAV는 1시간에 약 690MB예요.') },
      ], { align: 'right' });
    };
    open();
  };
  app.net.on('eph', m => {
    if (m.d?.t !== 'rec') return;
    remoteRec.set(m.from, m.d.on ? peerName(m.from) : null);
    if (m.d.on) toast(`${peerName(m.from)}님이 ${m.d.kind === 'wav' ? '녹음' : '녹화'}을 시작했어요`, { kind: 'warn' });
    paint();
  });
  app.net.on('peer-join', m => { if (rec) app.net.eph({ t: 'rec', on: true, kind: rec.kind }, m.id); });
  app.net.on('peer-leave', m => { remoteRec.delete(m.id); paint(); });
  addEventListener('beforeunload', e => { if (rec) { e.preventDefault(); e.returnValue = ''; } });
  paint();
}
