// Thin data layer over Supabase RPCs (works against the local preview server too).
const cfg = window.KAIF_CONFIG || {};
export const preview = window.KAIF_PREVIEW === true;
const previewMod = preview ? await import('./preview-backend.js') : null;
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const url = cfg.supabaseUrl || (local ? location.origin : '');
const key = cfg.supabaseAnonKey || (local ? 'local-preview' : '');

export const configured = preview || Boolean(url && key);
export const sb = !preview && url && key
  ? window.supabase.createClient(url, key, { auth: { persistSession: true, storageKey: 'kaif-admin-auth' } })
  : null;

async function call(fn, args) {
  if (previewMod) return previewMod.previewCall(fn, args);
  if (!sb) throw Object.assign(new Error('not_configured'), { code: 'not_configured' });
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data;
}

export const getAvailability = (month) => call('get_calendar_availability', { p_month: month });
export const createBooking = ({ name, phone, day, slot, party, token }) =>
  call('create_booking_with_phone', { p_name: name, p_phone: phone, p_day: day, p_slot: slot, p_party: party, p_token: token });

export const admin = {
  dashboard: () => call('admin_dashboard'),
  calendar: (month) => call('admin_calendar', { p_month: month }),
  isAdmin: () => call('is_admin'),
  updateSettings: (o) => call('admin_update_settings', o),
  updateDay: (o) => call('admin_update_day', o),
  saveSlot: (o) => call('admin_save_slot', o),
  deleteSlot: (id) => call('admin_delete_slot', { p_id: id }),
  setStatus: (id, status) => call('admin_set_booking_status', { p_id: id, p_status: status }),
  setNote: (id, note) => call('admin_set_note', { p_id: id, p_note: note }),
};

export const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
