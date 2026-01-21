import { Pool } from "pg";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} saknas i env.`);
  return v;
}

const DATABASE_URL = mustEnv("DATABASE_URL");

export const pool = new Pool({
  connectionString: DATABASE_URL,
  // Render Postgres kräver ofta SSL i produktion.
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
});

export async function pingDb(): Promise<void> {
  const res = await pool.query("select 1 as ok");
  if (!res?.rows?.[0]?.ok) throw new Error("DB ping misslyckades.");
}

export async function migrate(): Promise<void> {
  await pool.query(`
    create extension if not exists pgcrypto;

    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      password_hash text not null,
      display_name text,
      created_at timestamptz not null default now()
    );

    create table if not exists trees (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      name text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists people (
      id uuid primary key default gen_random_uuid(),
      tree_id uuid not null references trees(id) on delete cascade,
      first_name text not null,
      last_name text not null,
      gender text,
      birth_year int,
      death_year int,
      place_name text,
      lat double precision,
      lng double precision,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists relations (
      id uuid primary key default gen_random_uuid(),
      tree_id uuid not null references trees(id) on delete cascade,
      from_person_id uuid not null references people(id) on delete cascade,
      to_person_id uuid not null references people(id) on delete cascade,
      relation_type text not null,
      created_at timestamptz not null default now()
    );

    create index if not exists idx_trees_user_id on trees(user_id);
    create index if not exists idx_people_tree_id on people(tree_id);
    create index if not exists idx_relations_tree_id on relations(tree_id);
  `);
}
