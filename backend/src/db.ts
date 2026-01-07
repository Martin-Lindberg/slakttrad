import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL saknas. Skapa backend/.env och sätt DATABASE_URL.");
}

export const pool = new Pool({
  connectionString: databaseUrl
});

export async function pingDb(): Promise<void> {
  const res = await pool.query("select 1 as ok");
  if (!res?.rows?.[0]?.ok) throw new Error("DB ping misslyckades.");
}

export async function migrate(): Promise<void> {
  await pool.query(`
    create table if not exists users (
      id uuid primary key,
      email text not null unique,
      password_hash text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists trees (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      name text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists people (
      id uuid primary key,
      tree_id uuid not null references trees(id) on delete cascade,
      first_name text not null,
      last_name text not null,
      gender text null,
      birth_year int null,
      death_year int null,
      lat double precision null,
      lng double precision null,
      place_label text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists relations (
      id uuid primary key,
      tree_id uuid not null references trees(id) on delete cascade,
      from_person_id uuid not null references people(id) on delete cascade,
      to_person_id uuid not null references people(id) on delete cascade,
      relation_type text not null,
      created_at timestamptz not null default now()
    );

    create index if not exists idx_trees_user_id on trees(user_id);
    create index if not exists idx_people_tree_id on people(tree_id);
    create index if not exists idx_relations_tree_id on relations(tree_id);
    create index if not exists idx_people_updated_at on people(updated_at);
  `);
}
