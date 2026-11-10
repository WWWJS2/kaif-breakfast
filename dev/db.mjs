// Local Postgres (PGlite) running the real supabase/schema.sql,
// with a minimal emulation of Supabase's auth schema and roles.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHIM = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text unique not null);
  create or replace function auth.uid() returns uuid language sql stable as
    $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant usage on schema public to anon, authenticated;
`;

export async function createDb() {
  const db = new PGlite();
  await db.exec(SHIM);
  await db.exec(readFileSync(join(root, 'supabase/schema.sql'), 'utf8'));
  return db;
}

// Call a function the way PostgREST would: as a role, with a JWT subject.
export async function rpc(db, fn, args = {}, { role = 'anon', sub = '' } = {}) {
  if (!/^[a-z_]+$/.test(fn)) throw new Error('bad fn');
  const keys = Object.keys(args).filter((k) => /^p_[a-z_]+$/.test(k));
  const call = `select to_json(public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})) as r`;
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role === 'authenticated' ? 'authenticated' : 'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    const res = await tx.query(call, keys.map((k) => args[k]));
    return res.rows[0]?.r ?? null;
  });
}
