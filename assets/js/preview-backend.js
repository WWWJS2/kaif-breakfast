// PREVIEW ONLY — an in-browser stand-in for supabase/schema.sql so the design
// can be reviewed without a database. Same rules, but data stays in this
// browser. The real site never loads this file.
const KEY = 'kaif-preview-db-v2';
const seed = () => ({
  settings: { id: 1, capacity_per_day: 10, max_party: 9, booking_open: true },
  days: [
    { id: 'wed', label: 'الأربعاء', event_date: '2026-11-11', sort: 1, is_open: true, capacity_override: null },
    { id: 'thu', label: 'الخميس', event_date: '2026-11-12', sort: 2, is_open: true, capacity_override: null },
    { id: 'fri', label: 'الجمعة', event_date: '2026-11-13', sort: 3, is_open: true, capacity_override: null },
  ],
  slots: [
    { id: 's1', starts_at: '06:00', ends_at: '07:00', sort: 1, is_active: true },
    { id: 's2', starts_at: '07:00', ends_at: '08:00', sort: 2, is_active: true },
    { id: 's3', starts_at: '08:00', ends_at: '09:00', sort: 3, is_active: true },
  ],
  bookings: [],
});
let db;
try { db = JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { db = seed(); }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
const cap = (d) => d.capacity_override ?? db.settings.capacity_per_day;
const used = (id) => db.bookings.filter((b) => b.day_id === id && b.status !== 'cancelled').reduce((a, b) => a + b.party_size, 0);
const sorted = (a) => [...a].sort((x, y) => x.sort - y.sort || (x.starts_at || '').localeCompare(y.starts_at || ''));

const fns = {
  get_availability: () => ({
    open: db.settings.booking_open, max_party: db.settings.max_party,
    days: sorted(db.days).map((d) => ({ id: d.id, label: d.label, event_date: d.event_date, is_open: d.is_open,
      remaining: Math.max(cap(d) - used(d.id), 0), available: d.is_open && cap(d) - used(d.id) > 0 })),
    slots: sorted(db.slots).filter((s) => s.is_active).map(({ id, starts_at, ends_at }) => ({ id, starts_at, ends_at })),
  }),
  create_booking: ({ p_name, p_day, p_slot, p_party, p_token }) => {
    const dup = db.bookings.find((b) => b.client_token === p_token);
    if (dup) return { ok: true, duplicate: true, booking: dup };
    const name = String(p_name || '').trim();
    if (name.length < 2 || name.length > 80) return { ok: false, error: 'invalid_name' };
    if (!db.settings.booking_open) return { ok: false, error: 'closed' };
    if (!(p_party >= 1 && p_party <= db.settings.max_party)) return { ok: false, error: 'invalid_party' };
    const d = db.days.find((x) => x.id === p_day); if (!d) return { ok: false, error: 'invalid_day' };
    if (!d.is_open) return { ok: false, error: 'day_closed', remaining: 0 };
    const s = db.slots.find((x) => x.id === p_slot && x.is_active); if (!s) return { ok: false, error: 'invalid_slot' };
    const u = used(p_day);
    if (u + p_party > cap(d)) return { ok: false, error: u >= cap(d) ? 'day_full' : 'not_enough_seats', remaining: Math.max(cap(d) - u, 0) };
    const b = { id: crypto.randomUUID?.() || String(Date.now()), guest_name: name, day_id: p_day, party_size: p_party,
      starts_at: s.starts_at, ends_at: s.ends_at, status: 'confirmed', admin_note: null, client_token: p_token, created_at: new Date().toISOString() };
    db.bookings.push(b); save();
    return { ok: true, remaining: cap(d) - u - p_party, booking: b };
  },
  is_admin: () => true,
  admin_dashboard: () => ({
    settings: db.settings,
    days: sorted(db.days).map((d) => ({ ...d, capacity: cap(d), booked: used(d.id),
      bookings: db.bookings.filter((b) => b.day_id === d.id && b.status !== 'cancelled').length })),
    slots: sorted(db.slots),
    bookings: [...db.bookings].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  }),
  admin_update_settings: ({ p_capacity, p_max_party, p_open }) => {
    if (p_capacity != null) db.settings.capacity_per_day = p_capacity;
    if (p_max_party != null) db.settings.max_party = p_max_party;
    if (p_open != null) db.settings.booking_open = p_open; save();
  },
  admin_update_day: ({ p_id, p_is_open, p_capacity_override, p_clear_override }) => {
    const d = db.days.find((x) => x.id === p_id); if (!d) return;
    if (p_is_open != null) d.is_open = p_is_open;
    if (p_clear_override) d.capacity_override = null; else if (p_capacity_override != null) d.capacity_override = p_capacity_override; save();
  },
  admin_save_slot: ({ p_id, p_starts, p_ends, p_active, p_sort }) => {
    let s = db.slots.find((x) => x.id === p_id);
    if (!s) { s = { id: 's' + Date.now(), starts_at: p_starts, ends_at: p_ends, is_active: p_active ?? true, sort: p_sort ?? 0 }; db.slots.push(s); }
    else { if (p_starts) s.starts_at = p_starts; if (p_ends) s.ends_at = p_ends; if (p_active != null) s.is_active = p_active; if (p_sort != null) s.sort = p_sort; }
    save(); return s.id;
  },
  admin_delete_slot: ({ p_id }) => { db.slots = db.slots.filter((s) => s.id !== p_id); save(); },
  admin_set_booking_status: ({ p_id, p_status }) => {
    const b = db.bookings.find((x) => x.id === p_id); if (!b) return { ok: false, error: 'not_found' };
    if (b.status === 'cancelled' && p_status !== 'cancelled') {
      const d = db.days.find((x) => x.id === b.day_id);
      if (used(b.day_id) + b.party_size > cap(d)) return { ok: false, error: 'not_enough_seats' };
    }
    b.status = p_status; save(); return { ok: true };
  },
  admin_set_note: ({ p_id, p_note }) => { const b = db.bookings.find((x) => x.id === p_id); if (b) { b.admin_note = String(p_note || '').trim() || null; save(); } },
};
export const previewCall = async (fn, args = {}) => { await new Promise((r) => setTimeout(r, 180)); return fns[fn](args); };
export const resetPreview = () => { db = seed(); save(); };
