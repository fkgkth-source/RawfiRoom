// 자료함: Logic 바운스(WAV/AIFF), MIDI, 악보 등 원본 파일을 무손실 그대로 주고받기
import { app, h, icon, fmtBytes, fmtWhen, uid, toast, isTeacher, confirmDialog, emit, canLead } from './util.js';

export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/upload?room=${encodeURIComponent(app.roomId)}&name=${encodeURIComponent(file.name)}`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      if (x.status === 200) resolve(JSON.parse(x.responseText));
      else { try { reject(new Error(JSON.parse(x.responseText).error)); } catch { reject(new Error('업로드 실패')); } }
    };
    x.onerror = () => reject(new Error('네트워크 오류'));
    x.send(file);
  });
}

export function addFileRecord(info, extra = {}) {
  app.doc.getArray('files').push([{
    id: uid(), name: info.name, size: info.size, url: info.url, by: app.me.id, byName: app.me.name, ts: Date.now(), ...extra,
  }]);
}

const CATS = [
  { id: 'all', label: '전체' },
  { id: 'audio', label: '오디오', re: /\.(wav|aiff?|flac|mp3|m4a|caf|ogg)$/i },
  { id: 'midi', label: 'MIDI', re: /\.(mid|midi)$/i },
  { id: 'doc', label: '악보·문서', re: /\.(pdf|png|jpe?g|gif|webp|heic|txt|md|xml|musicxml|mxl|gp\d?|docx?)$/i },
  { id: 'etc', label: '기타' },
];
const catOf = name => (CATS.find(c => c.re && c.re.test(name)) || { id: 'etc' }).id;

export function initFiles(pane) {
  const files = app.doc.getArray('files');
  let cat = 'all';

  const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { upload([...input.files]); input.value = ''; } });
  const prog = h('div', { class: 'upload-list' });
  const seg = h('div', { class: 'seg' });
  const list = h('div', { class: 'file-list' });
  const drop = h('div', { class: 'dropzone' },
    h('div', { class: 'dz-icon', html: icon('upload', 28) }),
    h('div', {}, h('b', {}, '파일을 끌어다 놓거나 '), h('button', { class: 'btn sm primary', onclick: () => input.click() }, '선택')),
    h('div', { class: 'muted small' }, 'Logic Pro 바운스(WAV·AIFF), MIDI, 악보 PDF 등 원본 그대로 전달돼요 — 재인코딩 없음, 음질 손실 0'));

  pane.append(h('div', { class: 'pane-scroll' }, drop, prog, h('div', { class: 'row between' }, seg), list), input);

  for (const ev of ['dragenter', 'dragover']) pane.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) pane.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); });
  pane.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) upload([...e.dataTransfer.files]); });

  async function upload(fs) {
    for (const f of fs) {
      const bar = h('i'), row = h('div', { class: 'upload-row' }, h('span', {}, f.name), h('div', { class: 'bar' }, bar));
      prog.append(row);
      try {
        const info = await uploadFile(f, p => { bar.style.width = (p * 100).toFixed(0) + '%'; });
        addFileRecord(info);
        toast(`업로드 완료: ${f.name}`);
      } catch (e) { toast(`업로드 실패: ${f.name} (${e.message})`, { kind: 'warn' }); }
      row.remove();
    }
  }

  function renderSeg() {
    const counts = { all: files.length };
    for (const f of files.toArray()) counts[catOf(f.name)] = (counts[catOf(f.name)] || 0) + 1;
    seg.replaceChildren(...CATS.map(c => h('button', { class: 'seg-btn' + (cat === c.id ? ' active' : ''), onclick: () => { cat = c.id; render(); } },
      c.label, counts[c.id] ? h('span', { class: 'count' }, counts[c.id]) : null)));
  }

  function render() {
    renderSeg();
    const arr = files.toArray().filter(f => cat === 'all' || catOf(f.name) === cat).reverse();
    if (!arr.length) { list.replaceChildren(h('div', { class: 'empty-small' }, '아직 파일이 없어요')); return; }
    list.replaceChildren(...arr.map(f => {
      const c = catOf(f.name);
      const canDel = canLead() || f.by === app.me?.id;
      const row = h('div', { class: 'file-row' },
        h('div', { class: 'file-ico', html: icon(c === 'audio' ? 'wave' : c === 'midi' ? 'keys' : c === 'doc' ? 'file' : 'folder', 20) }),
        h('div', { class: 'file-meta' }, h('div', { class: 'file-name', title: f.name }, f.name),
          h('div', { class: 'muted small' }, `${fmtBytes(f.size)} · ${f.byName} · ${fmtWhen(f.ts)}`)),
        h('div', { class: 'file-actions' },
          c === 'audio' ? h('button', { class: 'icon-btn', title: '미리듣기', html: icon('play', 18), onclick: () => togglePreview(row, f) }) : null,
          c === 'doc' && /\.(pdf|png|jpe?g|gif|webp)$/i.test(f.name) ? h('button', { class: 'icon-btn', title: '악보로 열기', html: icon('score', 18), onclick: () => emit('open-score', f) }) : null,
          h('a', { class: 'icon-btn', title: '원본 다운로드', href: f.url + '?dl=1', download: f.name, html: icon('download', 18) }),
          canDel ? h('button', { class: 'icon-btn', title: '삭제', html: icon('trash', 18), onclick: async () => {
            if (!(await confirmDialog(`'${f.name}'을(를) 자료함에서 삭제할까요?`, { ok: '삭제', danger: true }))) return;
            const i = files.toArray().findIndex(x => x.id === f.id);
            if (i >= 0) files.delete(i, 1);
          } }) : null));
      return row;
    }));
  }
  function togglePreview(row, f) {
    const ex = row.nextElementSibling;
    if (ex && ex.classList.contains('preview')) { ex.remove(); return; }
    const a = h('audio', { controls: true, src: f.url, preload: 'metadata', class: 'preview' });
    row.after(a); a.play().catch(() => {});
  }

  files.observe(render);
  render();
}
