// 악보 탭: PDF/이미지/빈 오선지 + 실시간 공동 필기 (Apple Pencil 지원)
import { app, h, icon, uid, toast, menu, on, confirmDialog, promptDialog, setSetting, download, isTeacher, canLead } from './util.js';

// 선생님이 정하는 권한 (Y 'perm'): studentInk(레슨생 필기 허용), lockPages(레슨생 페이지 고정)
import { uploadFile, addFileRecord } from './files.js';

let pdfjsReady;
function loadPdfJs() {
  if (!pdfjsReady) pdfjsReady = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(window.pdfjsLib); };
    s.onerror = () => { pdfjsReady = null; rej(new Error('PDF 뷰어를 불러오지 못했어요')); };
    document.head.append(s);
  });
  return pdfjsReady;
}

const COLORS = ['#e5484d', '#2f6fed', '#18a058', '#111111', '#f59e0b', '#a855f7'];

export function initScore(pane) {
  const doc = app.doc, S = app.settings;
  const ys = doc.getMap('score');        // current, page
  const scores = doc.getMap('scores');   // id -> {name,url,kind,pages}
  const strokes = doc.getArray('strokes');
  const perm = doc.getMap('perm');
  const locked = () => !canLead() && !!perm.get('lockPages');
  const inkBlocked = () => !canLead() && perm.get('studentInk') === false;
  const st = { tool: 'pen', color: COLORS[0], width: 3, zoom: 1, page: 1, follow: true, pdf: null, pdfUrl: null, imgs: new Map(),
    penOnly: S.penOnly === 'on', drawing: null, live: new Map(), W: 0, H: 0, dpr: 1, token: 0, scroller: null };

  // ── 툴바 ──
  const libBtn = h('button', { class: 'btn sm', onclick: e => openLib(e.currentTarget) }, h('span', { html: icon('folder', 16) }), h('span', { class: 'lib-name' }, '악보함'), h('span', { html: icon('chevD', 14) }));
  const pageLbl = h('span', { class: 'page-lbl' }, '–');
  const prevB = h('button', { class: 'icon-btn sm', title: '이전 페이지', html: icon('chevL', 18), onclick: () => setPage(st.page - 1) });
  const nextB = h('button', { class: 'icon-btn sm', title: '다음 페이지', html: icon('chevR', 18), onclick: () => setPage(st.page + 1) });
  const followB = h('button', { class: 'chip active', title: '페이지 넘김을 서로 맞춤', onclick: () => { st.follow = !st.follow; followB.classList.toggle('active', st.follow); if (st.follow) syncFromShared(); } }, '함께 넘기기');
  const toolBtns = [['hand', '이동'], ['pen', '펜'], ['marker', '형광펜'], ['eraser', '지우개']].map(([t, label]) =>
    h('button', { class: 'tool-btn', 'data-tool': t, title: label, 'aria-label': label, html: icon(t, 20), onclick: () => setTool(t) }));
  const colorBtn = h('button', { class: 'tool-btn', title: '색·굵기', onclick: e => openColors(e.currentTarget) }, h('span', { class: 'swatch' }));
  const undoB = h('button', { class: 'tool-btn', title: '내 마지막 필기 취소', html: icon('undo', 20), onclick: undo });
  const moreB = h('button', { class: 'tool-btn', title: '더보기', html: icon('more', 20), onclick: e => openMore(e.currentTarget) });
  const bar = h('div', { class: 'toolbar' },
    libBtn, h('div', { class: 'pager' }, prevB, pageLbl, nextB), followB, h('span', { class: 'spacer' }),
    h('div', { class: 'tools' }, ...toolBtns, colorBtn, undoB, moreB));

  const bg = h('canvas', { class: 'page-bg' }), ink = h('canvas', { class: 'page-ink' });
  const wrap = h('div', { class: 'page-wrap' }, bg, ink);
  const view = h('div', { class: 'score-view' }, wrap);
  const fileIn = h('input', { type: 'file', accept: 'application/pdf,image/*', hidden: true, onchange: () => { if (fileIn.files[0]) openFile(fileIn.files[0]); fileIn.value = ''; } });
  const empty = h('div', { class: 'empty' },
    h('div', { class: 'empty-icon', html: icon('score', 40) }),
    h('h3', {}, '악보를 띄워 함께 필기하세요'),
    h('p', { class: 'muted' }, 'PDF·이미지 악보를 올리거나 빈 오선지를 만들면, 두 사람의 필기가 실시간으로 공유돼요.'),
    h('div', { class: 'row center wrap' },
      h('button', { class: 'btn primary', onclick: () => fileIn.click() }, h('span', { html: icon('upload', 16) }), '악보 올리기 (PDF·이미지)'),
      h('button', { class: 'btn', onclick: newStaff }, h('span', { html: icon('plus', 16) }), '빈 오선지')));
  pane.append(bar, view, empty, fileIn);

  function setTool(t) {
    st.tool = t;
    for (const b of toolBtns) b.classList.toggle('active', b.dataset.tool === t);
    ink.classList.toggle('hand', t === 'hand');
  }
  function paintSwatch() { colorBtn.firstChild.style.background = st.color; colorBtn.firstChild.style.transform = `scale(${0.6 + st.width / 10})`; }
  setTool('pen'); paintSwatch();

  const cur = () => scores.get(ys.get('current'));
  const pageCount = () => { const s = cur(); if (!s) return 0; if (s.kind === 'pdf') return st.pdf && st.pdfUrl === s.url ? st.pdf.numPages : (s.pages || 1); return s.pages || 1; };

  // ── 악보함(폴더) ──
  function openLib(anchor) {
    const items = [{ title: '악보함' }];
    const list = [...scores.entries()].sort((a, b) => b[1].ts - a[1].ts);
    for (const [id, s] of list) items.push({ label: s.name, icon: s.kind === 'staff' ? 'score' : 'file', checked: id === ys.get('current'), onClick: () => select(id) });
    if (!list.length) items.push({ label: '아직 악보가 없어요', disabled: true });
    items.push({ sep: true },
      { label: 'PDF·이미지 올리기', icon: 'upload', onClick: () => fileIn.click() },
      { label: '빈 오선지 만들기', icon: 'plus', onClick: newStaff },
      cur() ? { label: '이 악보 이름 바꾸기', icon: 'edit', onClick: renameCur } : null,
      cur() && (canLead() || cur().by === app.me.id) ? { label: '악보함에서 삭제', icon: 'trash', danger: true, onClick: removeCur } : null);
    menu(anchor, items);
  }
  function select(id) { doc.transact(() => { ys.set('current', id); ys.set('page', 1); }); }
  async function openFile(file) {
    const kind = file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'pdf' : 'image';
    const t = toast(`'${file.name}' 올리는 중…`, { timeout: 0 });
    try {
      const info = await uploadFile(file);
      addFileRecord(info);
      addScore({ name: file.name.replace(/\.[^.]+$/, ''), url: info.url, kind });
    } catch (e) { toast('업로드 실패: ' + e.message, { kind: 'warn' }); }
    t.remove();
  }
  function addScore(s) {
    const id = uid();
    doc.transact(() => { scores.set(id, { ...s, pages: s.pages || 1, by: app.me.id, ts: Date.now() }); ys.set('current', id); ys.set('page', 1); });
  }
  on('open-score', f => addScore({ name: f.name.replace(/\.[^.]+$/, ''), url: f.url, kind: /\.pdf$/i.test(f.name) ? 'pdf' : 'image' }));
  function newStaff() { addScore({ name: `오선지 ${new Date().toLocaleDateString('ko-KR')}`, kind: 'staff', pages: 1 }); }
  async function renameCur() {
    const s = cur(); if (!s) return;
    const name = await promptDialog({ title: '악보 이름', value: s.name });
    if (name) scores.set(ys.get('current'), { ...s, name });
  }
  async function removeCur() {
    const id = ys.get('current'), s = cur();
    if (!s || !(await confirmDialog(`'${s.name}'과(와) 필기를 악보함에서 지울까요? (자료함의 원본 파일은 남아요)`, { ok: '삭제', danger: true }))) return;
    doc.transact(() => {
      const arr = strokes.toArray();
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].sid === id) strokes.delete(i, 1);
      scores.delete(id);
      const next = [...scores.keys()][0];
      if (next) ys.set('current', next); else ys.delete('current');
      ys.set('page', 1);
    });
  }

  function openColors(anchor) {
    const sw = h('div', { class: 'swatches' }, ...COLORS.map(c => h('button', { class: 'sw' + (c === st.color ? ' active' : ''), style: `background:${c}`, 'aria-label': c, onclick: e => { st.color = c; paintSwatch(); if (st.tool === 'hand' || st.tool === 'eraser') setTool('pen'); for (const b of sw.children) b.classList.toggle('active', b === e.currentTarget); } })));
    const wd = h('div', { class: 'widths' }, ...[1.5, 3, 5, 8].map(w => h('button', { class: 'wbtn' + (w === st.width ? ' active' : ''), onclick: e => { st.width = w; paintSwatch(); for (const b of wd.children) b.classList.toggle('active', b === e.currentTarget); } }, h('i', { style: `height:${w}px` }))));
    menu(anchor, [{ title: '색' }, { el: sw }, { title: '굵기' }, { el: wd }], { align: 'right' });
  }
  function openMore(anchor) {
    const s = cur();
    menu(anchor, [
      { label: '확대', icon: 'zoomIn', keepOpen: true, onClick: () => zoom(1.2) },
      { label: '축소', icon: 'zoomOut', keepOpen: true, onClick: () => zoom(1 / 1.2) },
      { label: '폭에 맞추기', icon: 'expand', onClick: () => { st.zoom = 1; render(); } },
      { sep: true },
      { label: '펜(Apple Pencil)으로만 필기', hint: '손가락은 스크롤', checked: st.penOnly, onClick: () => { st.penOnly = !st.penOnly; setSetting('penOnly', st.penOnly ? 'on' : 'off'); } },
      s?.kind === 'staff' ? { label: '오선지 페이지 추가', icon: 'plus', onClick: () => { scores.set(ys.get('current'), { ...s, pages: (s.pages || 1) + 1 }); setPage((s.pages || 1) + 1); } } : null,
      { label: '필기 포함 이미지로 저장', icon: 'download', disabled: !s, onClick: exportPng },
      { sep: true },
      { label: canLead() ? '이 페이지 필기 모두 지우기' : '이 페이지 내 필기 지우기', icon: 'trash', danger: true, disabled: !s, onClick: clearPage },
    ], { align: 'right' });
  }
  function zoom(f) { st.zoom = Math.min(4, Math.max(0.5, st.zoom * f)); render(); }

  // ── 페이지 ──
  function setPage(n) {
    if (locked()) { toast('선생님이 페이지를 넘겨요 (페이지 고정 중)'); return; }
    const max = pageCount();
    n = Math.max(1, Math.min(max || 1, n));
    if (n === st.page) return;
    st.page = n;
    if (st.follow) ys.set('page', n);
    render();
  }
  function syncFromShared() {
    st.page = ys.get('page') || 1;
    render();
  }
  ys.observe(e => {
    if (e.keysChanged.has('current')) { st.page = ys.get('page') || 1; render(); return; }
    if (st.follow || locked()) syncFromShared();
  });
  let prevPerm = null;
  perm.observe(() => {
    const sig = `${locked()}|${inkBlocked()}`, first = prevPerm === null || !app.peers.size;
    const changed = sig !== prevPerm; prevPerm = sig;
    if (locked()) { st.follow = true; followB.classList.add('active'); syncFromShared(); }
    followB.disabled = locked(); prevB.disabled = nextB.disabled = locked() || prevB.disabled;
    bar.classList.toggle('ink-locked', inkBlocked());
    if (!canLead() && changed && !first) toast(locked() ? '선생님이 페이지를 고정했어요' : inkBlocked() ? '선생님이 필기를 잠갔어요' : '필기·페이지 넘김이 자유로워졌어요');
  });
  scores.observe(() => render());

  // ── 렌더링 ──
  async function render() {
    const s = cur();
    const token = ++st.token;
    empty.hidden = !!s; view.hidden = !s; bar.classList.toggle('disabled', !s);
    libBtn.querySelector('.lib-name').textContent = s ? s.name : '악보함';
    if (!s) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const W = Math.max(200, Math.floor((view.clientWidth - 24) * st.zoom));
    let aspect = 1.414, draw;
    try {
      if (s.kind === 'pdf') {
        if (st.pdfUrl !== s.url) {
          const lib = await loadPdfJs();
          st.pdf = await lib.getDocument(s.url).promise; st.pdfUrl = s.url;
          if (s.pages !== st.pdf.numPages) scores.set(ys.get('current'), { ...s, pages: st.pdf.numPages });
        }
        if (token !== st.token) return;
        st.page = Math.min(st.page, st.pdf.numPages);
        const page = await st.pdf.getPage(st.page);
        const vp1 = page.getViewport({ scale: 1 });
        aspect = vp1.height / vp1.width;
        draw = async ctx => {
          st.task?.cancel?.();
          st.task = page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: W * dpr / vp1.width }) });
          await st.task.promise.catch(() => {});
        };
      } else if (s.kind === 'image') {
        let img = st.imgs.get(s.url);
        if (!img) { img = new Image(); img.src = s.url; await img.decode(); st.imgs.set(s.url, img); }
        aspect = img.naturalHeight / img.naturalWidth;
        draw = ctx => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, bg.width, bg.height); ctx.drawImage(img, 0, 0, bg.width, bg.height); };
      } else {
        draw = ctx => drawStaff(ctx, bg.width, bg.height);
      }
    } catch (e) { toast(e.message || '악보를 열 수 없어요', { kind: 'warn' }); return; }
    if (token !== st.token) return;
    const H = Math.round(W * aspect);
    st.W = W; st.H = H; st.dpr = dpr;
    for (const c of [bg, ink]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + 'px'; c.style.height = H + 'px'; }
    wrap.style.width = W + 'px'; wrap.style.height = H + 'px';
    pageLbl.textContent = `${st.page} / ${pageCount()}`;
    prevB.disabled = st.page <= 1; nextB.disabled = st.page >= pageCount();
    await draw(bg.getContext('2d'));
    drawInk();
  }
  function drawStaff(ctx, w, hgt) {
    ctx.fillStyle = '#fffef9'; ctx.fillRect(0, 0, w, hgt);
    ctx.strokeStyle = '#555'; ctx.lineWidth = Math.max(1, w / 900);
    const mx = w * 0.07, top = hgt * 0.07, gap = w * 0.011, sys = 11;
    const step = (hgt - top * 2) / sys;
    for (let s = 0; s < sys; s++) {
      for (let l = 0; l < 5; l++) {
        const y = top + s * step + l * gap;
        ctx.beginPath(); ctx.moveTo(mx, y); ctx.lineTo(w - mx, y); ctx.stroke();
      }
    }
  }
  let inkRaf = 0;
  const reqInk = () => { if (!inkRaf) inkRaf = requestAnimationFrame(() => { inkRaf = 0; drawInk(); }); };
  function drawInk() {
    const s = ys.get('current');
    const ctx = ink.getContext('2d');
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.clearRect(0, 0, st.W, st.H);
    for (const k of strokes.toArray()) if (k.sid === s && k.pg === st.page) drawStroke(ctx, k);
    for (const k of st.live.values()) if (k.sid === s && k.pg === st.page) drawStroke(ctx, k);
    if (st.drawing) drawStroke(ctx, st.drawing);
  }
  function drawStroke(ctx, k) {
    const W = st.W, p = k.p;
    if (!p || p.length < 2) return;
    ctx.save();
    ctx.globalAlpha = k.a; ctx.strokeStyle = k.c; ctx.fillStyle = k.c;
    ctx.lineWidth = k.w * W / 1000; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (k.a < 1) ctx.globalCompositeOperation = 'multiply';
    if (p.length === 2) { ctx.beginPath(); ctx.arc(p[0] * W, p[1] * W, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return; }
    ctx.beginPath(); ctx.moveTo(p[0] * W, p[1] * W);
    for (let i = 2; i < p.length - 2; i += 2) {
      const mx = (p[i] + p[i + 2]) / 2 * W, my = (p[i + 1] + p[i + 3]) / 2 * W;
      ctx.quadraticCurveTo(p[i] * W, p[i + 1] * W, mx, my);
    }
    ctx.lineTo(p[p.length - 2] * W, p[p.length - 1] * W);
    ctx.stroke(); ctx.restore();
  }
  strokes.observe(e => {
    for (const item of e.changes.added) for (const c of item.content.getContent()) st.live.delete(c.id);
    reqInk();
  });
  new ResizeObserver(() => { clearTimeout(st.rt); st.rt = setTimeout(() => { if (Math.abs(view.clientWidth - st.lastVW) > 4) { st.lastVW = view.clientWidth; render(); } }, 120); }).observe(view);

  // ── 필기 입력 ──
  const pt = e => {
    const r = ink.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) / st.W * 10000) / 10000, Math.round((e.clientY - r.top) / st.W * 10000) / 10000];
  };
  ink.addEventListener('pointerdown', e => {
    if (!cur() || st.tool === 'hand') return;
    if (inkBlocked() && !(e.pointerType === 'touch' && st.penOnly)) { toast('선생님이 지금은 필기를 잠가뒀어요'); return; }
    if (e.pointerType === 'pen' && !st.penOnly && S.penOnly === 'auto') {
      st.penOnly = true; setSetting('penOnly', 'on');
      toast('Apple Pencil 감지 — 이제 펜으로 쓰고, 손가락으로는 스크롤해요 (더보기 메뉴에서 변경)');
    }
    e.preventDefault();
    if (e.pointerType === 'touch' && st.penOnly) { // 손가락: 직접 스크롤
      st.scroller = { id: e.pointerId, x: e.clientX, y: e.clientY, sl: view.scrollLeft, stp: view.scrollTop };
      return;
    }
    if (st.drawing) return;
    try { ink.setPointerCapture(e.pointerId); } catch {}
    if (st.tool === 'eraser') { st.erasing = e.pointerId; eraseAt(pt(e)); return; }
    const marker = st.tool === 'marker';
    st.drawing = { id: uid(), pid: e.pointerId, sid: ys.get('current'), pg: st.page, c: st.color, w: marker ? st.width * 5 : st.width, a: marker ? 0.35 : 1, p: pt(e), by: app.me.id, sent: 0 };
    sendLive(); reqInk();
  });
  ink.addEventListener('pointermove', e => {
    if (st.scroller?.id === e.pointerId) {
      view.scrollLeft = st.scroller.sl - (e.clientX - st.scroller.x);
      view.scrollTop = st.scroller.stp - (e.clientY - st.scroller.y);
      return;
    }
    if (st.erasing === e.pointerId) { eraseAt(pt(e)); return; }
    const d = st.drawing;
    if (!d || d.pid !== e.pointerId) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const [x, y] = pt(ev), n = d.p.length;
      if (Math.hypot(x - d.p[n - 2], y - d.p[n - 1]) > 0.0012) d.p.push(x, y);
    }
    sendLive(); reqInk();
  });
  const end = e => {
    if (st.scroller?.id === e.pointerId) { st.scroller = null; return; }
    if (st.erasing === e.pointerId) { st.erasing = null; return; }
    const d = st.drawing;
    if (!d || d.pid !== e.pointerId) return;
    st.drawing = null;
    strokes.push([{ id: d.id, sid: d.sid, pg: d.pg, c: d.c, w: d.w, a: d.a, p: d.p, by: d.by }]);
    app.net.eph({ t: 'ink-end', id: d.id });
    reqInk();
  };
  ink.addEventListener('pointerup', end);
  ink.addEventListener('pointercancel', end);

  let liveRaf = 0;
  function sendLive() {
    if (liveRaf) return;
    liveRaf = requestAnimationFrame(() => {
      liveRaf = 0;
      const d = st.drawing; if (!d) return;
      const from = Math.max(0, d.sent - 2);
      app.net.eph({ t: 'ink', id: d.id, sid: d.sid, pg: d.pg, c: d.c, w: d.w, a: d.a, from, p: d.p.slice(from) });
      d.sent = d.p.length;
    });
  }
  app.net.on('eph', m => {
    const d = m.d;
    if (d?.t === 'ink') {
      let k = st.live.get(d.id);
      if (!k) { k = { ...d, p: [] }; st.live.set(d.id, k); }
      k.p.length = Math.min(k.p.length, d.from); k.p.push(...d.p);
      clearTimeout(k.timer); k.timer = setTimeout(() => { st.live.delete(d.id); reqInk(); }, 8000);
      reqInk();
    } else if (d?.t === 'ink-end') { setTimeout(() => { st.live.delete(d.id); reqInk(); }, 1500); }
  });

  function eraseAt([x, y]) {
    const r = 14 / st.W, sid = ys.get('current');
    const arr = strokes.toArray(), del = [];
    arr.forEach((k, i) => {
      if (k.sid !== sid || k.pg !== st.page || (!canLead() && k.by !== app.me.id)) return;
      for (let j = 0; j < k.p.length; j += 2) if (Math.hypot(k.p[j] - x, k.p[j + 1] - y) < r + k.w / 2000) { del.push(i); return; }
    });
    if (del.length) doc.transact(() => { for (const i of del.reverse()) strokes.delete(i, 1); });
  }
  function undo() {
    const arr = strokes.toArray();
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].by === app.me.id && arr[i].sid === ys.get('current')) { strokes.delete(i, 1); return; }
    toast('되돌릴 내 필기가 없어요');
  }
  async function clearPage() {
    const all = canLead();
    if (!(await confirmDialog(all ? '이 페이지의 모든 필기(양쪽 모두)를 지울까요?' : '이 페이지의 내 필기를 지울까요?', { ok: '지우기', danger: true }))) return;
    const sid = ys.get('current'), arr = strokes.toArray();
    doc.transact(() => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].sid === sid && arr[i].pg === st.page && (all || arr[i].by === app.me.id)) strokes.delete(i, 1); });
  }
  function exportPng() {
    const c = h('canvas', { width: bg.width, height: bg.height });
    const ctx = c.getContext('2d'); ctx.drawImage(bg, 0, 0); ctx.drawImage(ink, 0, 0);
    c.toBlob(b => download(`${cur().name}-p${st.page}.png`, b), 'image/png');
  }

  // 키보드로 페이지 넘김 (블루투스 페이지 터너 호환)
  addEventListener('keydown', e => {
    if (pane.hidden || !pane.classList.contains('active') || e.target.closest?.('input,textarea,select')) return;
    if (e.key === 'PageDown' || e.key === 'ArrowRight') { e.preventDefault(); setPage(st.page + 1); }
    if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); setPage(st.page - 1); }
  });
  on('tab', t => { if (t === 'score') render(); });
  st.page = ys.get('page') || 1;
  render();
}
