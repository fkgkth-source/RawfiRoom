// 공용 유틸: 상태, 이벤트 버스, DOM 헬퍼, 아이콘, 토스트, 메뉴, 다이얼로그
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const DEFAULTS = {
  audioKbps: 510, instrumentMode: true, hd: true,
  camId: '', micId: '', dawId: '', outId: '',
  voiceVol: 1, dawVol: 1,
  inst: 'piano', synthVol: 0.8, reverb: 0.18,
  midiInputs: null, midiOut: '',
  sendMidiIn: true, monitorMidiIn: false, remoteToSynth: true, remoteToMidiOut: false, localToMidiOut: false, letPeerSynth: true,
  penOnly: 'auto', dockView: 'keys', kbStart: 48, dockOpen: true, focus: false, tab: 'score', noteFont: 18,
  jamLowLatency: false, metroVol: 0.7, barAdj: 0,
};

export const app = {
  settings: Object.assign({}, DEFAULTS, store.get('lr.settings', {})),
  me: null, peers: new Map(), peerState: new Map(), roomId: null,
};
export function setSetting(k, v) {
  app.settings[k] = v;
  store.set('lr.settings', app.settings);
  emit('setting', { k, v });
}
export const isTeacher = () => app.me?.role === 'teacher';
export const isStudent = () => app.me?.role !== 'teacher';
// 방 모드: lesson(선생님·레슨생) | jam(합주) | meeting(미팅). 합주·미팅은 모두 같은 권한.
app.mode = 'lesson';
export const canLead = () => app.mode !== 'lesson' || isTeacher();
export const MODE_LABEL = { teacher: '선생님 모드', student: '레슨생 모드', jam: '합주 모드', meeting: '미팅 모드' };
export const modeKey = () => (app.mode === 'lesson' ? (isTeacher() ? 'teacher' : 'student') : app.mode);
export const peerName = id => (id === app.me?.id ? app.me.name : app.peers.get(id)?.name) || '상대';

const bus = new EventTarget();
export function emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); }
export function on(type, fn) {
  const f = e => fn(e.detail);
  bus.addEventListener(type, f);
  return () => bus.removeEventListener(type, f);
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => (b % 36).toString(36)).join('');
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

const P = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>',
  micOff: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8M3 3l18 18"/>',
  cam: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>',
  camOff: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3zM2 3l20 18"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  screenReq: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M12 13V7M9 10l3 3 3-3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  leave: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  marker: '<path d="M9 11l-6 6v3h9l3-3"/><path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  eraser: '<path d="M7 21l-4-4 10-10 8 8-6 6H7z"/><path d="M22 21H7M5 13l6 6"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevL: '<path d="M15 18l-6-6 6-6"/>',
  chevR: '<path d="M9 18l6-6-6-6"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  chevU: '<path d="M6 15l6-6 6 6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  score: '<path d="M3 6h18M3 10h18M3 14h18M3 18h18"/><circle cx="9" cy="16" r="2" fill="currentColor"/><path d="M11 16V7"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  keys: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 4v10M16 4v10M12 14v6M6 14h4M14 14h4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  share: '<path d="M4 12v8h16v-8M12 3v13M7 8l5-5 5 5"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  panic: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  wave: '<path d="M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h-2"/>',
  rec: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
  crown: '<path d="M2 18l2-11 5 5 3-7 3 7 5-5 2 11z"/><path d="M4 21h16"/>',
  handUp: '<path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0"/>',
  metronome: '<path d="M9 3h6l4 18H5z"/><path d="M12 17l5-10M8 17h8"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
};
export function icon(name, size = 20) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
export const iconEl = (name, size) => h('span', { class: 'ico-wrap', html: icon(name, size) });

export function toast(msg, { actions = [], timeout = 4200, kind = '' } = {}) {
  const box = $('#toasts');
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, h('span', { class: 'toast-msg' }, msg));
  for (const a of actions) t.append(h('button', { class: 'btn sm primary', onclick: () => { t.remove(); a.fn(); } }, a.label));
  t.append(h('button', { class: 'icon-btn sm', 'aria-label': '닫기', html: icon('x', 16), onclick: () => t.remove() }));
  box.append(t);
  if (timeout) setTimeout(() => t.remove(), timeout + actions.length * 5000);
  return t;
}

// 팝오버 메뉴 (폴더처럼 옵션을 숨겨둠)
let openMenuEl = null, openAnchor = null, closedAt = 0, closedAnchor = null;
export function menu(anchor, items, { align = 'left', className = '' } = {}) {
  if (closedAnchor === anchor && performance.now() - closedAt < 250) return;
  closeMenu();
  const m = h('div', { class: 'menu ' + className, role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { m.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.title) { m.append(h('div', { class: 'menu-title' }, it.title)); continue; }
    if (it.el) { m.append(it.el); continue; }
    m.append(h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''), role: 'menuitem', disabled: !!it.disabled,
      onclick: () => { if (!it.keepOpen) closeMenu(); it.onClick?.(); },
    }, h('span', { class: 'mi-icon', html: it.icon ? icon(it.icon, 18) : '' }), h('span', { class: 'mi-label' }, it.label),
    it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null,
    it.checked ? h('span', { class: 'mi-check', html: icon('check', 16) }) : null));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  let x = align === 'right' ? r.right - m.offsetWidth : r.left;
  x = clamp(x, 8, innerWidth - m.offsetWidth - 8);
  let y = r.bottom + 6;
  if (y + m.offsetHeight > innerHeight - 8) y = Math.max(8, r.top - m.offsetHeight - 6);
  m.style.left = x + 'px'; m.style.top = y + 'px';
  openMenuEl = m; openAnchor = anchor;
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  return m;
}
function outside(e) {
  if (openMenuEl && !openMenuEl.contains(e.target)) {
    if (openAnchor?.contains(e.target)) { closedAnchor = openAnchor; closedAt = performance.now(); }
    closeMenu();
  }
}
export function closeMenu() {
  openMenuEl?.remove(); openMenuEl = null; openAnchor = null;
  document.removeEventListener('pointerdown', outside, true);
}

// 간단한 입력/확인 다이얼로그 (iPad에서도 깔끔하게)
export function promptDialog({ title, value = '', placeholder = '', ok = '확인', type = 'text' }) {
  return new Promise(resolve => {
    const dlg = $('#dlg');
    const input = h('input', { class: 'input', type, value, placeholder });
    const form = h('form', { method: 'dialog', class: 'dlg-body' },
      h('h3', {}, title), input,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); resolve(null); } }, '취소'),
        h('button', { class: 'btn primary', type: 'submit' }, ok)));
    form.addEventListener('submit', e => { e.preventDefault(); dlg.close(); resolve(input.value.trim() || null); });
    dlg.replaceChildren(form);
    dlg.showModal();
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
export function confirmDialog(msg, { ok = '확인', danger = false } = {}) {
  return new Promise(resolve => {
    const dlg = $('#dlg');
    dlg.replaceChildren(h('div', { class: 'dlg-body' }, h('p', {}, msg),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', onclick: () => { dlg.close(); resolve(false); } }, '취소'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { dlg.close(); resolve(true); } }, ok))));
    dlg.showModal();
  });
}

export function download(filename, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta);
    ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
export function fmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const roomLink = () => `${location.origin}/r/${app.roomId}`;
