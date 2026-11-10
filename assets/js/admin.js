import { sb, admin, configured, preview } from './api.js';
import { ORIGINAL as T, FUNCTIONAL as F } from './strings.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { confirmed: 'مؤكد', attended: 'حضر', cancelled: 'ملغي' };
const ERR = { not_enough_seats: 'لا توجد مقاعد كافية لإعادة تفعيل هذا الحجز', not_admin: 'هذا الحساب لا يملك صلاحية الإدارة' };
const fmt = (t) => { const [h, m] = t.split(':').map(Number); return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? T.am : F.pm}`; };
const fmtDate = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '');
const when = (iso) => new Date(iso).toLocaleString('ar-SA-u-nu-latn', { weekday: 'short', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

let data = null, filterDay = 'all', filterStatus = 'active', q = '', timer = null;

function toast(msg, err = false) {
  const t = $('[data-toast]'); t.textContent = msg; t.classList.toggle('is-err', err); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}
const show = (v) => $$('[data-view]').forEach((el) => (el.hidden = el.dataset.view !== v));

async function guard(fn, okMsg) {
  try { const r = await fn(); if (r && r.ok === false) { toast(ERR[r.error] || r.error, true); } else if (okMsg) toast(okMsg); await load(); return r; }
  catch (e) { toast(ERR[e.message] || e.message, true); if (/not_admin|JWT|401/.test(e.message)) logout(); }
}

// ---------- auth ----------
async function start() {
  if (!configured) { show('login'); $('[data-login-err]').textContent = 'لم يتم ربط قاعدة البيانات بعد (assets/js/config.js)'; $('[data-login-err]').hidden = false; return; }
  if (preview) return enter();
  const { data: s } = await sb.auth.getSession();
  if (s?.session && (await admin.isAdmin().catch(() => false))) enter(); else show('login');
}
$('[data-login]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target), err = $('[data-login-err]'), btn = e.target.querySelector('button');
  err.hidden = true; btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: `${String(f.get('username')).trim().toLowerCase()}@kaif-breakfast.invalid`, password: String(f.get('password')) });
  btn.disabled = false;
  if (error) { err.textContent = 'بيانات الدخول غير صحيحة'; err.hidden = false; return; }
  if (!(await admin.isAdmin().catch(() => false))) { await sb.auth.signOut(); err.textContent = ERR.not_admin; err.hidden = false; return; }
  e.target.reset(); enter();
});
async function logout() { clearInterval(timer); if (preview) return location.reload(); await sb.auth.signOut().catch(() => {}); show('login'); }
$('[data-logout]').addEventListener('click', logout);

async function enter() { show('app'); await load(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden && !document.activeElement?.matches('input,select')) load(); }, 15000); }

// ---------- load + render ----------
async function load() {
  try { data = await admin.dashboard(); render(); $('[data-sync]').textContent = 'آخر تحديث ' + new Date().toLocaleTimeString('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit' }); }
  catch (e) { if (/not_admin/.test(e.message)) logout(); else toast(e.message, true); }
}

function render() {
  const { settings: s, days, slots, bookings } = data;
  const active = bookings.filter((b) => b.status !== 'cancelled');
  $('[data-k="bookings"]').textContent = active.length;
  $('[data-k="guests"]').textContent = active.reduce((a, b) => a + b.party_size, 0);
  $('[data-k="remaining"]').textContent = days.filter((d) => d.is_open).reduce((a, d) => a + Math.max(d.capacity - d.booked, 0), 0);
  const g = $('[data-global-open]'); g.checked = s.booking_open; $('[data-global-open-label]').textContent = s.booking_open ? 'مفتوح' : 'مغلق';

  $('[data-days]').innerHTML = days.map((d) => {
    const full = d.booked >= d.capacity, rem = Math.max(d.capacity - d.booked, 0);
    const badge = !d.is_open ? '<span class="badge badge--closed">مغلق</span>' : full ? '<span class="badge badge--full">مكتمل</span>' : '<span class="badge badge--open">متاح</span>';
    return `<article class="day ${d.is_open ? '' : 'is-closed'}" data-day="${esc(d.id)}">
      <div class="day__top"><div><div class="day__name">${esc(d.label)}</div><div class="day__date num">${fmtDate(d.event_date)}</div><div style="margin-top:8px">${badge}</div></div>
        <div class="day__count"><b class="num">${rem}</b><small>متبقٍ من ${d.capacity}</small></div></div>
      <div class="seats" aria-label="${d.booked} من ${d.capacity}">${Array.from({ length: d.capacity }, (_, i) => `<i class="${i < d.booked ? 'on' : ''}"></i>`).join('')}</div>
      <div class="day__foot">
        <label class="switch"><input type="checkbox" data-day-open ${d.is_open ? 'checked' : ''}><i></i><em>${d.is_open ? 'الحجز مفتوح' : 'الحجز مغلق'}</em></label>
        <label class="day__cap">سعة هذا اليوم <input type="number" min="0" max="1000" value="${d.capacity}" data-day-cap></label>
      </div>
      <div class="when">${d.bookings} حجز · ${d.booked} شخص</div>
    </article>`;
  }).join('');

  $('[data-slots]').innerHTML = slots.map((t, i) => `<li class="slot ${t.is_active ? '' : 'is-off'}" data-slot="${t.id}">
      <span class="slot__idx num">${i + 1}</span>
      <input type="time" value="${t.starts_at}" data-slot-start step="300" aria-label="من">
      <span class="slot__dash">—</span>
      <input type="time" value="${t.ends_at}" data-slot-end step="300" aria-label="إلى">
      <label class="switch"><input type="checkbox" data-slot-active ${t.is_active ? 'checked' : ''}><i></i><em>${t.is_active ? 'ظاهر' : 'مخفي'}</em></label>
      <button class="icon-btn" type="button" data-slot-del aria-label="حذف"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </li>`).join('') || '<li class="empty">لا توجد أوقات</li>';

  const lim = $('[data-limits]');
  if (!lim.contains(document.activeElement)) { lim.capacity.value = s.capacity_per_day; lim.max_party.value = s.max_party; }

  $('[data-filter-day]').innerHTML = [['all', 'كل الأيام'], ...days.map((d) => [d.id, d.label])]
    .map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${filterDay === v}">${esc(l)}</button>`).join('');
  $('[data-filter-status]').innerHTML = [['active', 'الحالية'], ['confirmed', STATUS.confirmed], ['attended', STATUS.attended], ['cancelled', STATUS.cancelled], ['all', 'الكل']]
    .map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${filterStatus === v}">${l}</button>`).join('');
  renderTable();
}

function rowsFiltered() {
  const dayName = Object.fromEntries(data.days.map((d) => [d.id, d.label]));
  return data.bookings.filter((b) =>
    (filterDay === 'all' || b.day_id === filterDay) &&
    (filterStatus === 'all' || (filterStatus === 'active' ? b.status !== 'cancelled' : b.status === filterStatus)) &&
    (!q || b.guest_name.includes(q))).map((b) => ({ ...b, day: dayName[b.day_id] || b.day_id }));
}
function renderTable() {
  const rows = rowsFiltered();
  $('[data-table]').innerHTML = `<div class="row row--head"><span>الاسم</span><span>اليوم</span><span>الوقت</span><span>العدد</span><span>الحالة</span><span>ملاحظة</span><span>وقت الحجز</span></div>` +
    (rows.map((b) => `<div class="row ${b.status === 'cancelled' ? 'is-cancelled' : ''}" data-b="${b.id}">
      <b>${esc(b.guest_name)}</b>
      <span class="r-day">${esc(b.day)}</span>
      <span class="r-time tnum">${fmt(b.starts_at)} - ${fmt(b.ends_at)}</span>
      <span class="r-party num">${b.party_size}</span>
      <span class="r-meta"><span>${esc(b.day)}</span><span class="tnum">${fmt(b.starts_at)} - ${fmt(b.ends_at)}</span><span>${esc(T.people(b.party_size))}</span></span>
      <span class="r-status"><select data-status aria-label="الحالة" class="st-${b.status}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${v}</option>`).join('')}</select></span>
      <span class="r-note"><input class="note" data-note value="${esc(b.admin_note || '')}" placeholder="—" aria-label="ملاحظة"></span>
      <span class="r-when when">${when(b.created_at)}</span>
    </div>`).join('') || '<div class="empty">لا توجد حجوزات</div>');
}

// ---------- interactions ----------
$('[data-global-open]').addEventListener('change', (e) => guard(() => admin.updateSettings({ p_open: e.target.checked }), e.target.checked ? 'تم فتح الحجز' : 'تم إغلاق الحجز'));
$('[data-days]').addEventListener('change', (e) => {
  const id = e.target.closest('[data-day]')?.dataset.day; if (!id) return;
  if (e.target.matches('[data-day-open]')) guard(() => admin.updateDay({ p_id: id, p_is_open: e.target.checked }), 'تم الحفظ');
  if (e.target.matches('[data-day-cap]')) {
    const v = Number(e.target.value); const def = data.settings.capacity_per_day;
    guard(() => admin.updateDay(v === def ? { p_id: id, p_clear_override: true } : { p_id: id, p_capacity_override: v }), 'تم تحديث سعة اليوم');
  }
});
$('[data-limits]').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(() => admin.updateSettings({ p_capacity: Number(e.target.capacity.value), p_max_party: Number(e.target.max_party.value) }), 'تم حفظ الحدود');
});
$('[data-add-slot]').addEventListener('click', () => {
  const last = data.slots.at(-1); const s = last ? last.ends_at : '06:00';
  const [h, m] = s.split(':').map(Number); const e = `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  guard(() => admin.saveSlot({ p_id: null, p_starts: s, p_ends: e, p_active: true, p_sort: data.slots.length + 1 }), 'تمت إضافة وقت');
});
$('[data-slots]').addEventListener('change', (e) => {
  const li = e.target.closest('[data-slot]'); if (!li) return;
  const id = li.dataset.slot;
  if (e.target.matches('[data-slot-active]')) return guard(() => admin.saveSlot({ p_id: id, p_active: e.target.checked }), 'تم الحفظ');
  const st = $('[data-slot-start]', li).value, en = $('[data-slot-end]', li).value;
  if (!st || !en || en <= st) { toast('وقت النهاية يجب أن يكون بعد وقت البداية', true); return; }
  guard(() => admin.saveSlot({ p_id: id, p_starts: st, p_ends: en }), 'تم تحديث الوقت');
});
$('[data-slots]').addEventListener('click', (e) => {
  if (!e.target.closest('[data-slot-del]')) return;
  const li = e.target.closest('[data-slot]');
  if (li.dataset.armed) return guard(() => admin.deleteSlot(li.dataset.slot), 'تم حذف الوقت');
  li.dataset.armed = '1'; toast('اضغط مرة أخرى للتأكيد'); setTimeout(() => delete li.dataset.armed, 3000);
});
$('[data-filter-day]').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { filterDay = b.dataset.v; render(); } });
$('[data-filter-status]').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { filterStatus = b.dataset.v; render(); } });
$('[data-search]').addEventListener('input', (e) => { q = e.target.value.trim(); renderTable(); });
$('[data-table]').addEventListener('change', (e) => {
  const id = e.target.closest('[data-b]')?.dataset.b; if (!id) return;
  if (e.target.matches('[data-status]')) guard(() => admin.setStatus(id, e.target.value), 'تم تحديث الحالة');
  if (e.target.matches('[data-note]')) guard(() => admin.setNote(id, e.target.value), 'تم حفظ الملاحظة');
});
$('[data-export]').addEventListener('click', () => {
  const rows = rowsFiltered();
  const head = ['الاسم', 'اليوم', 'من', 'إلى', 'العدد', 'الحالة', 'ملاحظة', 'وقت الحجز'];
  const csv = [head, ...rows.map((b) => [b.guest_name, b.day, b.starts_at, b.ends_at, b.party_size, STATUS[b.status], b.admin_note || '', b.created_at])]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: 'kaif-bookings.csv' });
  a.click(); URL.revokeObjectURL(a.href);
});

start();
