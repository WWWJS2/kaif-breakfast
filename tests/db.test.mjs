// node --test tests/db.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, rpc } from '../dev/db.mjs';

const ADMIN = randomUUID();
const STRANGER = randomUUID();

async function setup() {
  const db = await createDb();
  await db.query(`insert into auth.users (id,email) values ($1,'a@kaif.test'),($2,'b@kaif.test')`, [ADMIN, STRANGER]);
  await db.query(`insert into public.admins (user_id) values ($1)`, [ADMIN]);
  const av = await rpc(db, 'get_availability');
  return { db, av, slot: av.slots[0].id };
}
const book = (db, day, slot, party, name = 'ضيف تجربة', token = randomUUID()) =>
  rpc(db, 'create_booking', { p_name: name, p_day: day, p_slot: slot, p_party: party, p_token: token });

test('seed: three days, slots 06–09, capacity 10', async () => {
  const { av } = await setup();
  assert.deepEqual(av.days.map((d) => d.label), ['الأربعاء', 'الخميس', 'الجمعة']);
  assert.deepEqual(av.slots.map((s) => `${s.starts_at}-${s.ends_at}`), ['06:00-07:00', '07:00-08:00', '08:00-09:00']);
  assert.ok(av.days.every((d) => d.remaining === 10 && d.available));
  assert.equal(av.max_party, 9);
});

test('day closes at exactly 10 people (guest + companions)', async () => {
  const { db, slot } = await setup();
  for (const p of [4, 4]) assert.equal((await book(db, 'wed', slot, p)).ok, true);
  const over = await book(db, 'wed', slot, 3);
  assert.equal(over.ok, false); assert.equal(over.error, 'not_enough_seats'); assert.equal(over.remaining, 2);
  assert.equal((await book(db, 'wed', slot, 2)).ok, true);
  const full = await book(db, 'wed', slot, 1);
  assert.equal(full.error, 'day_full');
  const av = await rpc(db, 'get_availability');
  const wed = av.days.find((d) => d.id === 'wed');
  assert.equal(wed.remaining, 0); assert.equal(wed.available, false);
  assert.equal(av.days.find((d) => d.id === 'thu').remaining, 10);
});

test('burst of 30 simultaneous requests never exceeds capacity', async () => {
  const { db, slot } = await setup();
  const res = await Promise.all(Array.from({ length: 30 }, (_, i) => book(db, 'thu', slot, (i % 9) + 1)));
  const sum = res.filter((r) => r.ok).reduce((a, _, i) => a, 0);
  const { rows } = await db.query(`select coalesce(sum(party_size),0)::int n from public.bookings where day_id='thu'`);
  assert.ok(rows[0].n <= 10, `booked ${rows[0].n}`);
  assert.equal(rows[0].n, 10);
  assert.ok(res.some((r) => !r.ok));
  void sum;
});

test('same submission twice = one booking (double-submit)', async () => {
  const { db, slot } = await setup();
  const t = randomUUID();
  const [a, b] = await Promise.all([book(db, 'fri', slot, 2, 'س', t).then(() => book(db, 'fri', slot, 2, 'سارة', t)), book(db, 'fri', slot, 2, 'سارة', t)]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  const { rows } = await db.query(`select count(*)::int n from public.bookings where client_token=$1`, [t]);
  assert.equal(rows[0].n, 1);
});

test('validation: party range, name, closed day, inactive slot', async () => {
  const { db, slot } = await setup();
  assert.equal((await book(db, 'wed', slot, 10)).error, 'invalid_party');
  assert.equal((await book(db, 'wed', slot, 0)).error, 'invalid_party');
  assert.equal((await book(db, 'wed', slot, 1, ' ')).error, 'invalid_name');
  assert.equal((await book(db, 'sat', slot, 1)).error, 'invalid_day');
  await rpc(db, 'admin_update_day', { p_id: 'wed', p_is_open: false }, { role: 'authenticated', sub: ADMIN });
  assert.equal((await book(db, 'wed', slot, 1)).error, 'day_closed');
  await rpc(db, 'admin_save_slot', { p_id: slot, p_active: false }, { role: 'authenticated', sub: ADMIN });
  assert.equal((await book(db, 'thu', slot, 1)).error, 'invalid_slot');
  await rpc(db, 'admin_update_settings', { p_open: false }, { role: 'authenticated', sub: ADMIN });
  const av = await rpc(db, 'get_availability');
  assert.equal(av.open, false);
});

test('anon cannot read tables or call admin functions', async () => {
  const { db } = await setup();
  await assert.rejects(db.transaction(async (tx) => { await tx.query('set local role anon'); await tx.query('select * from public.bookings'); }));
  await assert.rejects(rpc(db, 'admin_dashboard'));
  await assert.rejects(rpc(db, 'admin_dashboard', {}, { role: 'authenticated', sub: STRANGER }), /not_admin/);
});

test('admin: dashboard, capacity edit, cancel frees seats, reactivation respects capacity', async () => {
  const { db, slot } = await setup();
  const as = { role: 'authenticated', sub: ADMIN };
  await book(db, 'wed', slot, 4); await book(db, 'wed', slot, 4); await book(db, 'wed', slot, 2);
  let d = await rpc(db, 'admin_dashboard', {}, as);
  assert.equal(d.days.find((x) => x.id === 'wed').booked, 10);
  const victim = d.bookings.find((b) => b.party_size === 4);
  assert.equal((await rpc(db, 'admin_set_booking_status', { p_id: victim.id, p_status: 'cancelled' }, as)).ok, true);
  assert.equal((await rpc(db, 'get_availability')).days.find((x) => x.id === 'wed').remaining, 4);
  assert.equal((await book(db, 'wed', slot, 3)).ok, true);
  const re = await rpc(db, 'admin_set_booking_status', { p_id: victim.id, p_status: 'confirmed' }, as);
  assert.equal(re.error, 'not_enough_seats');
  await rpc(db, 'admin_update_settings', { p_capacity: 14 }, as);
  assert.equal((await rpc(db, 'admin_set_booking_status', { p_id: victim.id, p_status: 'confirmed' }, as)).ok, true);
  await rpc(db, 'admin_update_day', { p_id: 'thu', p_capacity_override: 6 }, as);
  assert.equal((await rpc(db, 'get_availability')).days.find((x) => x.id === 'thu').remaining, 6);
  const id = await rpc(db, 'admin_save_slot', { p_id: null, p_starts: '09:00', p_ends: '09:30', p_active: true, p_sort: 4 }, as);
  assert.ok(id);
  d = await rpc(db, 'admin_dashboard', {}, as);
  assert.equal(d.slots.length, 4);
});
