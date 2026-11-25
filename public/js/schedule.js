// 일정 탭: 다음 레슨을 함께 정하고(제안 → 수락) 바로 캘린더에 저장
import { app, h, icon, uid, toast, menu, isTeacher, peerName, confirmDialog, emit, roomLink, canLead } from './util.js';

const pad = n => String(n).padStart(2, '0');
const gDate = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;

export function initSchedule(pane) {
  const lessons = app.doc.getMap('lessons');

  const next = new Date(Date.now() + 7 * 864e5);
  const title = h('input', { class: 'input', value: '레슨', maxlength: 60 });
  const date = h('input', { class: 'input', type: 'date', value: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}` });
  const time = h('input', { class: 'input', type: 'time', value: '19:00', step: 900 });
  const dur = h('select', { class: 'select' }, ...[30, 45, 60, 90, 120].map(m => h('option', { value: m, selected: m === 60 }, `${m}분`)));
  const memo = h('input', { class: 'input', placeholder: '메모 (예: 2절 가사 완성해오기)', maxlength: 200 });
  const list = h('div', { class: 'lesson-list' });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  pane.append(h('div', { class: 'pane-scroll' },
    h('div', { class: 'card' },
      h('h3', { class: 'card-title' }, h('span', { html: icon('calendar', 18) }), '다음 레슨 잡기'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field span2' }, h('span', { class: 'field-label' }, '제목'), title),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '날짜'), date),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '시작 시간'), time),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '길이'), dur),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '시간대'), h('input', { class: 'input', value: tz, disabled: true })),
        h('label', { class: 'field span2' }, h('span', { class: 'field-label' }, '메모'), memo)),
      h('div', { class: 'row end wrap' },
        h('button', { class: 'btn', onclick: () => add('proposed') }, '상대에게 제안'),
        h('button', { class: 'btn primary teacher-only', onclick: () => add('confirmed') }, h('span', { html: icon('check', 16) }), '바로 확정'))),
    h('h3', { class: 'section-title' }, '예정된 레슨'), list));

  function add(status) {
    if (!date.value || !time.value) return toast('날짜와 시간을 입력하세요', { kind: 'warn' });
    const start = new Date(`${date.value}T${time.value}`);
    if (isNaN(start)) return toast('날짜 형식을 확인하세요', { kind: 'warn' });
    const id = uid();
    lessons.set(id, { id, title: title.value.trim() || '레슨', start: start.toISOString(), dur: +dur.value, memo: memo.value.trim(), by: app.me.id, byName: app.me.name, status, ts: Date.now() });
    memo.value = '';
    toast(status === 'confirmed' ? '레슨을 확정했어요' : '제안을 보냈어요. 상대가 수락하면 확정돼요');
  }
  const update = (l, patch) => lessons.set(l.id, { ...l, ...patch });

  const icsUrl = l => `/api/ics/${app.roomId}/${l.id}.ics`;
  const gcalUrl = l => {
    const s = new Date(l.start), e = new Date(s.getTime() + l.dur * 60000);
    const q = new URLSearchParams({ action: 'TEMPLATE', text: l.title, dates: `${gDate(s)}/${gDate(e)}`, details: `${l.memo ? l.memo + '\n\n' : ''}RawfiRoom 입장: ${roomLink()}`, location: roomLink() });
    return `https://calendar.google.com/calendar/render?${q}`;
  };
  function calMenu(anchor, l) {
    menu(anchor, [
      { title: '캘린더에 저장' },
      { label: 'Apple 캘린더 (Mac·iPad·iPhone)', icon: 'calendar', onClick: () => { location.href = icsUrl(l); } },
      { label: 'Google 캘린더', icon: 'calendar', onClick: () => window.open(gcalUrl(l), '_blank', 'noopener') },
      { label: 'Outlook 등 (.ics 파일)', icon: 'download', onClick: () => { const a = h('a', { href: icsUrl(l), download: `lesson-${l.id}.ics` }); document.body.append(a); a.click(); a.remove(); } },
    ]);
  }

  function render() {
    const now = Date.now() - 3 * 3600e3;
    const arr = [...lessons.values()].filter(l => new Date(l.start).getTime() > now && l.status !== 'declined' || l.status === 'proposed')
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    if (!arr.length) { list.replaceChildren(h('div', { class: 'empty-small' }, '아직 잡힌 레슨이 없어요')); return; }
    list.replaceChildren(...arr.map(l => {
      const s = new Date(l.start), mine = l.by === app.me?.id;
      const when = s.toLocaleString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      const badge = { proposed: ['제안됨', 'warn'], confirmed: ['확정', 'ok'], declined: ['거절됨', 'muted'] }[l.status];
      const actions = [];
      if (l.status === 'proposed' && !mine) {
        actions.push(h('button', { class: 'btn sm primary', onclick: () => { update(l, { status: 'confirmed', acceptedBy: app.me.name }); } }, '수락'));
        actions.push(h('button', { class: 'btn sm', onclick: () => update(l, { status: 'declined' }) }, '다른 시간'));
      }
      if (l.status === 'proposed' && mine) actions.push(h('span', { class: 'muted small' }, '상대 수락 대기 중'));
      if (l.status === 'confirmed') actions.push(h('button', { class: 'btn sm primary', onclick: e => calMenu(e.currentTarget, l) }, h('span', { html: icon('calendar', 16) }), '캘린더에 저장'));
      if (mine || canLead()) actions.push(h('button', { class: 'icon-btn sm', title: '삭제', html: icon('trash', 16), onclick: async () => { if (await confirmDialog('이 일정을 삭제할까요?', { ok: '삭제', danger: true })) lessons.delete(l.id); } }));
      return h('div', { class: 'lesson ' + l.status },
        h('div', { class: 'lesson-date' }, h('b', {}, s.getDate()), h('span', {}, `${s.getMonth() + 1}월`)),
        h('div', { class: 'lesson-meta' },
          h('div', { class: 'row tight' }, h('b', {}, l.title), h('span', { class: 'badge ' + badge[1] }, badge[0])),
          h('div', { class: 'muted small' }, `${when} · ${l.dur}분 · ${l.byName} 제안`),
          l.memo ? h('div', { class: 'small' }, l.memo) : null),
        h('div', { class: 'lesson-actions' }, ...actions));
    }));
  }

  let known = null;
  lessons.observe(e => {
    if (known) {
      for (const [k, ch] of e.changes.keys) {
        const l = lessons.get(k);
        if (!l || e.transaction.local) continue;
        if (ch.action === 'add' && l.status === 'proposed') {
          emit('tab-dot', 'sched');
          toast(`${l.byName}님이 다음 레슨을 제안했어요`, { actions: [{ label: '보기', fn: () => app.showTab('sched') }] });
        } else if (l.status === 'confirmed' && known.get(k) !== 'confirmed') {
          emit('tab-dot', 'sched');
          toast(`레슨 확정: ${new Date(l.start).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, { actions: [{ label: '캘린더에 저장', fn: () => { app.showTab('sched'); location.href = icsUrl(l); } }], timeout: 8000 });
        }
      }
    }
    known = new Map([...lessons.entries()].map(([k, l]) => [k, l.status]));
    render();
  });
  app.net.on('welcome', () => { known = new Map([...lessons.entries()].map(([k, l]) => [k, l.status])); render(); });
  render();
}
