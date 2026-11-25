// 가사노트: 폴더별 노트, 실시간 공동 편집(한글 IME 안전), 선생님이 허용하면 레슨생 저장 가능
import { app, h, icon, uid, toast, menu, on, store, promptDialog, confirmDialog, download, copyText, isTeacher, peerName, setSetting, canLead } from './util.js';
import { Y } from './net.js';

const LOCAL = 'local-textarea';

// 원격 변경(delta)에 맞춰 커서 위치 보정
function mapIdx(i, delta) {
  let old = 0, shift = 0;
  for (const op of delta) {
    if (op.retain != null) old += op.retain;
    else if (op.delete != null) { if (old < i) shift -= Math.min(op.delete, i - old); old += op.delete; }
    else if (op.insert != null) { if (old < i) shift += typeof op.insert === 'string' ? op.insert.length : 1; }
  }
  return i + shift;
}

function bindText(ta, ytext, onLocal) {
  let prev = ytext.toString();
  ta.value = prev;
  let composing = false;
  const pending = [];
  const onInput = () => {
    const cur = ta.value;
    if (cur === prev) return;
    let s = 0;
    const min = Math.min(prev.length, cur.length);
    while (s < min && prev[s] === cur[s]) s++;
    let e = 0;
    while (e < min - s && prev[prev.length - 1 - e] === cur[cur.length - 1 - e]) e++;
    const delLen = prev.length - s - e, ins = cur.slice(s, cur.length - e);
    let ys = s, ye = s + delLen;
    for (const d of pending) { ys = mapIdx(ys, d); ye = mapIdx(ye, d); }
    app.doc.transact(() => {
      if (ye > ys) ytext.delete(ys, ye - ys);
      if (ins) ytext.insert(ys, ins);
    }, LOCAL);
    prev = cur;
    onLocal?.();
  };
  const applyRemote = deltas => {
    const focused = document.activeElement === ta;
    let s = ta.selectionStart, e = ta.selectionEnd;
    const top = ta.scrollTop;
    for (const d of deltas) { s = mapIdx(s, d); e = mapIdx(e, d); }
    ta.value = ytext.toString(); prev = ta.value;
    if (focused) ta.setSelectionRange(s, e);
    ta.scrollTop = top;
  };
  const obs = ev => {
    if (ev.transaction.origin === LOCAL) return;
    if (composing) { pending.push(ev.delta); return; } // 한글 조합 중에는 깨지지 않게 보류
    applyRemote([ev.delta]);
  };
  ta.addEventListener('input', onInput);
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => {
    composing = false;
    setTimeout(() => { onInput(); if (pending.length) { applyRemote(pending.splice(0)); } }, 0);
  });
  ytext.observe(obs);
  return () => ytext.unobserve(obs);
}

export function initNotes(pane) {
  const doc = app.doc, notes = doc.getMap('notes'), S = app.settings;
  let curId = store.get('lr.note.' + app.roomId, null), unbind = null, openFolders = new Set(store.get('lr.folders', ['가사']));

  const listEl = h('div', { class: 'note-list' });
  const side = h('aside', { class: 'note-side' },
    h('div', { class: 'row between pad' }, h('b', {}, '노트'),
      h('button', { class: 'icon-btn sm', title: '새 노트/폴더', html: icon('plus', 18), onclick: e => newMenu(e.currentTarget) })),
    listEl);
  const titleIn = h('input', { class: 'note-title', placeholder: '제목', maxlength: 80 });
  const folderBtn = h('button', { class: 'chip', title: '폴더 이동', onclick: e => moveMenu(e.currentTarget) });
  const typingEl = h('span', { class: 'typing muted small' });
  const lockBtn = h('button', { class: 'chip teacher-only lesson-only', onclick: toggleAllow });
  const saveBtn = h('button', { class: 'btn sm', onclick: e => saveMenu(e.currentTarget) }, h('span', { html: icon('download', 16) }), '저장');
  const moreBtn = h('button', { class: 'icon-btn sm', title: '더보기', html: icon('more', 18), onclick: e => moreMenu(e.currentTarget) });
  const sideToggle = h('button', { class: 'icon-btn sm side-toggle', title: '노트 목록', html: icon('menu', 18), onclick: () => root.classList.toggle('side-open') });
  const edHead = h('div', { class: 'note-head' }, sideToggle, titleIn, folderBtn, h('span', { class: 'spacer' }), typingEl, lockBtn, saveBtn, moreBtn);
  const edBody = h('div', { class: 'note-body' });
  const emptyEl = h('div', { class: 'empty' }, h('div', { class: 'empty-icon', html: icon('note', 40) }),
    h('h3', {}, '가사를 함께 써요'), h('p', { class: 'muted' }, '두 사람이 동시에 입력해도 실시간으로 합쳐져요.'),
    h('button', { class: 'btn primary', onclick: () => createNote('가사') }, h('span', { html: icon('plus', 16) }), '새 가사 노트'));
  const editor = h('section', { class: 'note-editor' }, edHead, edBody);
  const root = h('div', { class: 'notes' }, side, editor, emptyEl);
  pane.append(root);

  const folders = () => [...new Set([...notes.values()].map(m => m.get('folder') || '가사'))].sort((a, b) => a.localeCompare(b, 'ko'));
  const curNote = () => (curId && notes.get(curId)) || null;
  const canSave = m => canLead() || !!m?.get('allowSave');

  function createNote(folder, title = '새 가사') {
    const id = uid(), m = new Y.Map();
    doc.transact(() => {
      notes.set(id, m);
      m.set('title', title); m.set('folder', folder); m.set('text', new Y.Text());
      m.set('allowSave', false); m.set('by', app.me.name); m.set('ts', Date.now());
    });
    openFolders.add(folder); store.set('lr.folders', [...openFolders]);
    open(id);
    setTimeout(() => { titleIn.focus(); titleIn.select(); }, 50);
  }
  async function newMenu(anchor) {
    menu(anchor, [
      { label: '새 노트', icon: 'note', onClick: () => createNote(curNote()?.get('folder') || '가사') },
      { label: '새 폴더 + 노트', icon: 'folder', onClick: async () => { const f = await promptDialog({ title: '새 폴더 이름', placeholder: '예: 2곡 - 봄노래' }); if (f) createNote(f); } },
    ]);
  }
  function moveMenu(anchor) {
    const m = curNote(); if (!m) return;
    menu(anchor, [{ title: '폴더로 이동' }, ...folders().map(f => ({ label: f, icon: 'folder', checked: m.get('folder') === f, onClick: () => m.set('folder', f) })),
      { sep: true }, { label: '새 폴더…', icon: 'plus', onClick: async () => { const f = await promptDialog({ title: '새 폴더 이름' }); if (f) { m.set('folder', f); openFolders.add(f); } } }]);
  }
  function moreMenu(anchor) {
    const m = curNote(); if (!m) return;
    menu(anchor, [
      { label: '글자 크게', icon: 'zoomIn', keepOpen: true, onClick: () => font(2) },
      { label: '글자 작게', icon: 'zoomOut', keepOpen: true, onClick: () => font(-2) },
      { sep: true },
      { label: '노트 삭제', icon: 'trash', danger: true, disabled: !(canLead() || m.get('by') === app.me.name), onClick: async () => {
        if (!(await confirmDialog(`'${m.get('title')}' 노트를 삭제할까요? 양쪽 모두에서 사라져요.`, { ok: '삭제', danger: true }))) return;
        notes.delete(curId); curId = null; render();
      } },
    ], { align: 'right' });
  }
  function font(d) { setSetting('noteFont', Math.max(12, Math.min(36, S.noteFont + d))); edBody.querySelector('textarea')?.style.setProperty('font-size', S.noteFont + 'px'); }
  function toggleAllow() { const m = curNote(); if (m && isTeacher()) m.set('allowSave', !m.get('allowSave')); }

  function textOf(m) { return m.get('text')?.toString() || ''; }
  function saveMenu(anchor) {
    const m = curNote(); if (!m) return;
    if (!canSave(m)) { toast('선생님이 이 노트의 저장을 허용하면 저장할 수 있어요', { kind: 'warn' }); return; }
    const title = m.get('title') || '가사', text = textOf(m);
    const safe = title.replace(/[\\/:*?"<>|]/g, '_');
    menu(anchor, [
      { label: '텍스트 파일 (.txt)', icon: 'download', onClick: () => download(`${safe}.txt`, `${title}\n\n${text}\n`, 'text/plain;charset=utf-8') },
      { label: '마크다운 (.md)', icon: 'download', onClick: () => download(`${safe}.md`, `# ${title}\n\n${text}\n`, 'text/markdown;charset=utf-8') },
      { label: '클립보드에 복사', icon: 'copy', onClick: async () => toast((await copyText(text)) ? '복사했어요' : '복사 실패') },
      navigator.share ? { label: '공유 (메모·메시지 등)', icon: 'share', onClick: () => navigator.share({ title, text }).catch(() => {}) } : null,
      { label: '인쇄 / PDF로 저장', icon: 'print', onClick: () => printNote(title, text) },
    ], { align: 'right' });
  }
  function printNote(title, text) {
    const w = open_('');
    if (!w) return toast('팝업이 차단됐어요', { kind: 'warn' });
    const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:16px/1.8 -apple-system,"Apple SD Gothic Neo",sans-serif;padding:40px;white-space:pre-wrap}h1{font-size:22px}</style><h1>${esc(title)}</h1>${esc(text)}`);
    w.document.close(); setTimeout(() => w.print(), 200);
  }
  const open_ = u => window.open(u, '_blank');

  function open(id) {
    curId = id; store.set('lr.note.' + app.roomId, id);
    root.classList.remove('side-open');
    render();
  }

  function renderList() {
    const byFolder = new Map();
    for (const [id, m] of notes) {
      const f = m.get('folder') || '가사';
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f).push([id, m]);
    }
    listEl.replaceChildren(...folders().map(f => {
      const d = h('details', { class: 'folder', open: openFolders.has(f), ontoggle: () => { d.open ? openFolders.add(f) : openFolders.delete(f); store.set('lr.folders', [...openFolders]); } },
        h('summary', {}, h('span', { html: icon('folder', 16) }), h('span', { class: 'folder-name' }, f), h('span', { class: 'count' }, byFolder.get(f).length)),
        ...byFolder.get(f).sort((a, b) => b[1].get('ts') - a[1].get('ts')).map(([id, m]) =>
          h('button', { class: 'note-item' + (id === curId ? ' active' : ''), onclick: () => open(id) },
            h('span', { class: 'note-item-title' }, m.get('title') || '제목 없음'),
            m.get('allowSave') ? h('span', { class: 'mini-ico', title: '레슨생 저장 허용됨', html: icon('unlock', 13) }) : null)));
      return d;
    }));
  }

  let boundId = null;
  function renderEditor() {
    const m = curNote();
    editor.hidden = !m;
    emptyEl.hidden = !!m;
    if (!m) { if (unbind) { unbind(); unbind = null; } boundId = null; edBody.replaceChildren(); return; }
    if (document.activeElement !== titleIn) titleIn.value = m.get('title') || '';
    folderBtn.replaceChildren(h('span', { html: icon('folder', 14) }), m.get('folder') || '가사');
    const allow = !!m.get('allowSave');
    lockBtn.replaceChildren(h('span', { html: icon(allow ? 'unlock' : 'lock', 14) }), allow ? '레슨생 저장 허용됨' : '레슨생 저장 잠금');
    lockBtn.classList.toggle('active', allow);
    lockBtn.title = '클릭해서 레슨생이 이 노트를 저장할 수 있게/없게';
    saveBtn.classList.toggle('locked', !canSave(m));
    saveBtn.title = canSave(m) ? '노트 저장' : '선생님이 허용하면 저장할 수 있어요';
    if (boundId !== curId) {
      unbind?.();
      const ta = h('textarea', { class: 'note-text', spellcheck: false, placeholder: '여기에 가사를 입력하세요…\n\n[Verse 1]\n…', style: `font-size:${S.noteFont}px` });
      edBody.replaceChildren(ta);
      unbind = bindText(ta, m.get('text'), () => sendTyping());
      boundId = curId;
    }
  }
  function render() {
    if (curId && !notes.get(curId)) curId = null;
    if (!curId && notes.size) curId = [...notes.keys()][0];
    renderList(); renderEditor();
  }

  titleIn.addEventListener('input', () => { const m = curNote(); if (m) m.set('title', titleIn.value); });

  // 상대 입력 중 표시
  let lastTyping = 0, typingTimer;
  function sendTyping() {
    const now = Date.now();
    if (now - lastTyping < 1200) return;
    lastTyping = now;
    app.net.eph({ t: 'typing', note: curId });
  }
  app.net.on('eph', m => {
    if (m.d?.t !== 'typing' || m.d.note !== curId) return;
    typingEl.textContent = `${peerName(m.from)} 입력 중…`;
    clearTimeout(typingTimer); typingTimer = setTimeout(() => { typingEl.textContent = ''; }, 2500);
  });

  // 허용 상태 변화 알림 (레슨생)
  let lastAllow = new Map();
  notes.observeDeep(() => {
    for (const [id, m] of notes) {
      const a = !!m.get('allowSave');
      if (lastAllow.has(id) && lastAllow.get(id) !== a && !canLead() && a) toast(`'${m.get('title')}' 노트를 저장할 수 있게 됐어요`, { actions: [{ label: '열기', fn: () => { open(id); app.showTab?.('notes'); } }] });
      lastAllow.set(id, a);
    }
    render();
  });
  on('role', render);
  render();
}
