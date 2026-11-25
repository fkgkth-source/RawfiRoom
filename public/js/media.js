// 로컬 장치: 카메라, 마이크(원음 모드), DAW 입력(Logic Pro → BlackHole/Loopback), 화면 공유
import { app, emit, toast } from './util.js';

export const media = { cam: null, mic: null, daw: null, screen: null, micOn: true, camOn: true };

export function audioConstraints(deviceId, raw) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw,
    channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 }, sampleSize: { ideal: 24 }, latency: { ideal: 0.003 },
  };
}
function videoConstraints(ignoreId) {
  const S = app.settings;
  return {
    deviceId: !ignoreId && S.camId ? { exact: S.camId } : undefined,
    width: { ideal: S.hd ? 1920 : 1280 }, height: { ideal: S.hd ? 1080 : 720 }, frameRate: { ideal: 30, max: 60 },
  };
}
const gum = c => navigator.mediaDevices.getUserMedia(c);

export async function listDevices() {
  try {
    const d = await navigator.mediaDevices.enumerateDevices();
    return {
      cams: d.filter(x => x.kind === 'videoinput'),
      mics: d.filter(x => x.kind === 'audioinput'),
      outs: d.filter(x => x.kind === 'audiooutput'),
    };
  } catch { return { cams: [], mics: [], outs: [] }; }
}

export async function openCam() {
  const old = media.cam;
  let t = null;
  try { t = (await gum({ video: videoConstraints() })).getVideoTracks()[0]; }
  catch (e) {
    old?.stop(); // iPad 등은 같은 카메라를 동시에 못 엶
    try { t = (await gum({ video: videoConstraints(true) })).getVideoTracks()[0]; }
    catch (e2) { toast('카메라를 열 수 없어요: ' + (e2.message || e2.name), { kind: 'warn' }); }
  }
  if (t) t.enabled = media.camOn;
  media.cam = t;
  app.rtc?.setTrack('cam', t, 'video');
  if (old && old !== t) old.stop();
  emit('local-media'); broadcastState();
  return t;
}
export function closeCam() {
  const old = media.cam; media.cam = null;
  app.rtc?.setTrack('cam', null, 'video'); old?.stop();
  emit('local-media'); broadcastState();
}

export async function openMic() {
  const S = app.settings, old = media.mic;
  let t = null;
  try { t = (await gum({ audio: audioConstraints(S.micId, S.instrumentMode) })).getAudioTracks()[0]; }
  catch (e) {
    old?.stop();
    try { t = (await gum({ audio: audioConstraints('', S.instrumentMode) })).getAudioTracks()[0]; }
    catch (e2) { toast('마이크를 열 수 없어요: ' + (e2.message || e2.name), { kind: 'warn' }); }
  }
  if (t) { if (S.instrumentMode) t.contentHint = 'music'; t.enabled = media.micOn; }
  media.mic = t;
  app.rtc?.setTrack('cam', t, 'audio');
  if (old && old !== t) old.stop();
  emit('local-media'); broadcastState();
  return t;
}
export function closeMic() {
  const old = media.mic; media.mic = null;
  app.rtc?.setTrack('cam', null, 'audio'); old?.stop();
  emit('local-media'); broadcastState();
}

// Logic Pro 출력 → 가상 오디오 장치 → 원음 그대로(처리 없음, 스테레오, 48kHz) 전송
export async function openDaw(deviceId) {
  const old = media.daw;
  if (!deviceId) { closeDaw(); return null; }
  let t = null;
  try { t = (await gum({ audio: audioConstraints(deviceId, true) })).getAudioTracks()[0]; t.contentHint = 'music'; }
  catch (e) { toast('DAW 입력을 열 수 없어요: ' + (e.message || e.name), { kind: 'warn' }); return null; }
  media.daw = t;
  app.rtc?.setTrack('daw', t, 'audio');
  if (old && old !== t) old.stop();
  emit('local-media');
  return t;
}
export function closeDaw() {
  const old = media.daw; media.daw = null;
  app.rtc?.setTrack('daw', null, 'audio'); old?.stop();
  emit('local-media');
}

export const screenSupported = () => !!navigator.mediaDevices?.getDisplayMedia;
export async function startScreen() {
  if (!screenSupported()) { toast('이 기기 브라우저는 화면 공유를 지원하지 않아요 (iPad Safari 제한). Mac/PC에서 공유해 주세요.', { kind: 'warn', timeout: 6000 }); return; }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    });
    stopScreen();
    media.screen = s;
    for (const t of s.getTracks()) {
      if (t.kind === 'video') t.contentHint = 'detail';
      else t.contentHint = 'music';
      t.addEventListener('ended', () => { if (media.screen === s) stopScreen(); });
      app.rtc?.setTrack('screen', t, t.kind);
    }
    emit('local-media');
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('화면 공유 실패: ' + e.message, { kind: 'warn' });
  }
}
export function stopScreen() {
  const s = media.screen;
  if (!s) return;
  media.screen = null;
  for (const t of s.getTracks()) { app.rtc?.setTrack('screen', null, t.kind); t.stop(); }
  emit('local-media');
}

export function setMicOn(on) {
  media.micOn = on;
  if (media.mic) media.mic.enabled = on;
  emit('local-media'); broadcastState();
}
export async function setCamOn(on) {
  media.camOn = on;
  if (on && !media.cam) await openCam();
  if (media.cam) media.cam.enabled = on;
  emit('local-media'); broadcastState();
}
export function broadcastState(to) {
  app.net?.eph({ t: 'mstate', mic: media.micOn && !!media.mic, cam: media.camOn && !!media.cam }, to);
}

// 입력 레벨 미터
export function makeMeter(track) {
  if (!track || !app.ctx) return () => 0;
  const src = app.ctx.createMediaStreamSource(new MediaStream([track]));
  const an = app.ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const fn = () => { an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); return p; };
  fn.dispose = () => { try { src.disconnect(); } catch {} };
  return fn;
}
