import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool, pingDb, migrate } from "./db.js";
import { signAccessToken } from "./auth.js";
import { requireAuth } from "./middleware.js";

const PORT = Number(process.env.PORT ?? "4000");

// CORS: Render/GitHub Pages i prod, localhost i dev.
// Robust: om du råkar sätta CORS_ORIGIN till en hel URL (med path) så plockar vi ut origin.
// Stöd: flera origins via kommaseparerad lista i CORS_ORIGIN.
function normalizeOrigin(value: string): string {
  const v = (value || "").trim();
  if (!v) return "";
  try {
    return new URL(v).origin;
  } catch {
    // fallback: ta bort ev. trailing slash
    return v.replace(/\/+$/, "");
  }
}

const rawCors = process.env.CORS_ORIGIN || "http://localhost:5173";
const allowedOrigins = Array.from(
  new Set(
    rawCors
      .split(",")
      .map(normalizeOrigin)
      .filter(Boolean)
      .concat(["http://localhost:5173"])
  )
);

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    // same-origin / server-to-server / curl saknar ofta Origin-header -> tillåt
    if (!origin) return cb(null, true);
    const o = normalizeOrigin(origin);
    if (allowedOrigins.includes(o)) return cb(null, true);
    return cb(null, false);
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
};

const app = express();

app.use(helmet());
app.use(express.json({ limit: "200kb" }));
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.get("/health", async (_req, res) => {
  try {
    await pingDb();
    return res.json({ ok: true, id: treeId, treeId, name, treeName: name });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "DB fel" });
  }
});

const RegisterSchema = z.object({
  email: z.string().email("Ange en giltig e-postadress."),
  password: z.string().min(8, "Lösenordet måste vara minst 8 tecken."),
  displayName: z.string().max(80).optional()
});

app.post("/auth/register", async (req, res) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ogiltig input." });

  const { email, password, displayName } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const existing = await pool.query("select id from users where email=$1", [email]);
    if (existing.rowCount) return res.status(409).json({ error: "Kontot finns redan." });

    const inserted = await pool.query(
      "insert into users(email,password_hash,display_name) values($1,$2,$3) returning id,email,display_name",
      [email, passwordHash, displayName ?? null]
    );
    const user = inserted.rows[0];
    const accessToken = signAccessToken({ id: user.id, email: user.email });
    return res.json({ accessToken });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "Kunde inte skapa konto." });
  }
});

const LoginSchema = z.object({
  email: z.string().email("Ange en giltig e-postadress."),
  password: z.string().min(1, "Ange lösenord.")
});

app.post("/auth/login", async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ogiltig input." });

  const { email, password } = parsed.data;
  try {
    const found = await pool.query("select id,email,password_hash from users where email=$1", [email]);
    const row = found.rows[0];
    if (!row) return res.status(401).json({ error: "Fel e-post eller lösenord." });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: "Fel e-post eller lösenord." });

    const accessToken = signAccessToken({ id: row.id, email: row.email });
    return res.json({ accessToken });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "Kunde inte logga in." });
  }
});

app.get("/me", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const r = await pool.query("select id,email,display_name from users where id=$1", [userId]);
  const row = r.rows[0];
  return res.json({ id: row?.id ?? userId, email: row?.email ?? req.user!.email, displayName: row?.display_name ?? null });
});

// Trees
app.get("/trees", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const r = await pool.query("select id,name,created_at,updated_at from trees where user_id=$1 order by created_at desc", [userId]);
  return res.json(r.rows.map((x) => ({ id: x.id, treeId: x.id, name: x.name, treeName: x.name, createdAt: x.created_at, updatedAt: x.updated_at })));
});

app.post("/trees", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Ange ett namn för släkten." });
  const r = await pool.query("insert into trees(user_id,name) values($1,$2) returning id,name", [userId, name]);
  return res.status(201).json({ id: r.rows[0].id, treeId: r.rows[0].id, name: r.rows[0].name, treeName: r.rows[0].name });
});

app.put("/trees/:treeId", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const treeId = req.params.treeId;
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Ange ett namn." });

  const owns = await pool.query("select id from trees where id=$1 and user_id=$2", [treeId, userId]);
  if (!owns.rowCount) return res.status(404).json({ error: "Trädet finns inte." });

  await pool.query("update trees set name=$1, updated_at=now() where id=$2", [name, treeId]);
  return res.json({ ok: true });
});

app.delete("/trees/:treeId", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const treeId = req.params.treeId;

  const owns = await pool.query("select id from trees where id=$1 and user_id=$2", [treeId, userId]);
  if (!owns.rowCount) return res.status(404).json({ error: "Trädet finns inte." });

  await pool.query("delete from trees where id=$1", [treeId]);
  return res.json({ ok: true, id: treeId, treeId });
});

// People
app.get("/trees/:treeId/people", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const treeId = req.params.treeId;

  const owns = await pool.query("select id from trees where id=$1 and user_id=$2", [treeId, userId]);
  if (!owns.rowCount) return res.status(404).json({ error: "Trädet finns inte." });

  const r = await pool.query(
    `select id, first_name, last_name, gender, birth_year, death_year, place_name, lat, lng, created_at, updated_at
     from people where tree_id=$1 order by created_at asc`,
    [treeId]
  );
  return res.json(r.rows.map((p) => ({
    id: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    gender: p.gender ?? null,
    birthYear: p.birth_year ?? null,
    deathYear: p.death_year ?? null,
    placeName: p.place_name ?? null,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at
  })));
});

app.post("/trees/:treeId/people", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const treeId = req.params.treeId;

  const owns = await pool.query("select id from trees where id=$1 and user_id=$2", [treeId, userId]);
  if (!owns.rowCount) return res.status(404).json({ error: "Trädet finns inte." });

  const body = req.body ?? {};
  const firstName = String(body.firstName ?? "").trim();
  const lastName = String(body.lastName ?? "").trim();
  const gender = body.gender === "man" || body.gender === "kvinna" ? body.gender : null;

  const birthYear = body.birthYear === null || body.birthYear === undefined || body.birthYear === "" ? null : Number(body.birthYear);
  const deathYear = body.deathYear === null || body.deathYear === undefined || body.deathYear === "" ? null : Number(body.deathYear);

  const placeName = typeof body.placeName === "string" ? body.placeName.trim() : null;
  const lat = body.lat === null || body.lat === undefined || body.lat === "" ? null : Number(body.lat);
  const lng = body.lng === null || body.lng === undefined || body.lng === "" ? null : Number(body.lng);

  if (!firstName || !lastName) return res.status(400).json({ error: "Ange förnamn och efternamn." });
  if (birthYear !== null && !Number.isFinite(birthYear)) return res.status(400).json({ error: "Ogiltigt födelseår." });
  if (deathYear !== null && !Number.isFinite(deathYear)) return res.status(400).json({ error: "Ogiltigt dödsår." });

  const r = await pool.query(
    `insert into people(tree_id,first_name,last_name,gender,birth_year,death_year,place_name,lat,lng)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id`,
    [treeId, firstName, lastName, gender, birthYear, deathYear, placeName, lat, lng]
  );

  await pool.query("update trees set updated_at=now() where id=$1", [treeId]);
  return res.json({ id: r.rows[0].id });
});

app.put("/trees/:treeId/people/:personId", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { treeId, personId } = req.params;

  const owns = await pool.query("select id from trees where id=$1 and user_id=$2", [treeId, userId]);
  if (!owns.rowCount) return res.status(404).json({ error: "Trädet finns inte." });

  const exists = await pool.query("select id from people where id=$1 and tree_id=$2", [personId, treeId]);
  if (!exists.rowCount) return res.status(404).json({ error: "Personen finns inte." });

  const body = req.body ?? {};
  const firstName = String(body.firstName ?? "").trim();
  const lastName = String(body.lastName ?? "").trim();
  const gender = body.gender === "man" || body.gender === "kvinna" ? body.gender : null;

  const birthYear = body.birthYear === null || body.birthYear === undefined || body.birthYear === "" ? null : Number(body.birthYear);
  const deathYear = body.deathYear === null || body.deathYear === undefined || body.deathYear === "" ? null : Number(body.deathYear);

  const placeName = typeof body.placeName === "string" ? body.placeName.trim() : null;
  const lat = body.lat === null || body.lat === undefined || body.lat === "" ? null : Number(body.lat);
  const lng = body.lng === null || body.lng === undefined || body.lng === "" ? null : Number(body.lng);

  if (!firstName || !lastName) return res.status(400).json({ error: "Ange förnamn och efternamn." });
  if (birthYear !== null && !Number.isFinite(birthYear)) return res.status(400).json({ error: "Ogiltigt födelseår." });
  if (deathYear !== null && !Number.isFinite(deathYear)) return res.status(400).json({ error: "Ogiltigt dödsår." });

  await pool.query(
    `update people set
      first_name=$1,last_name=$2,gender=$3,birth_year=$4,death_year=$5,place_name=$6,lat=$7,lng=$8,updated_at=now()
     where id=$9 and tree_id=$10`,
    [firstName, lastName, gender, birthYear, deathYear, placeName, lat, lng, personId, treeId]
  );

  await pool.query("update trees set updated_at=now() where id=$1", [treeId]);
  return res.json({ ok: true });
});

app.delete("/trees/:treeId/people/:personId", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { treeId, personId } = req.params;

  const owns = await pool.query("select id from trees where id=$1 and user_id=$2", [treeId, userId]);
  if (!owns.rowCount) return res.status(404).json({ error: "Trädet finns inte." });

  await pool.query("delete from people where id=$1 and tree_id=$2", [personId, treeId]);
  await pool.query("update trees set updated_at=now() where id=$1", [treeId]);
  return res.json({ ok: true });
});

// Relations
app.get("/trees/:treeId/relations", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const treeId = req.params.treeId;

  const owns = await pool.query("select id from trees where id=$1 and user_id=$2", [treeId, userId]);
  if (!owns.rowCount) return res.status(404).json({ error: "Trädet finns inte." });

  const r = await pool.query(
    `select id, from_person_id, to_person_id, relation_type, created_at
     from relations where tree_id=$1 order by created_at asc`,
    [treeId]
  );
  return res.json(r.rows.map((x) => ({
    id: x.id,
    fromPersonId: x.from_person_id,
    toPersonId: x.to_person_id,
    relationType: x.relation_type,
    createdAt: x.created_at
  })));
});

app.post("/trees/:treeId/relations", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const treeId = req.params.treeId;

  const owns = await pool.query("select id from trees where id=$1 and user_id=$2", [treeId, userId]);
  if (!owns.rowCount) return res.status(404).json({ error: "Trädet finns inte." });

  const fromPersonId = String(req.body?.fromPersonId ?? "");
  const toPersonId = String(req.body?.toPersonId ?? "");
  const relationType = String(req.body?.relationType ?? "").trim();

  if (!fromPersonId || !toPersonId) return res.status(400).json({ error: "Välj två personer." });
  if (fromPersonId === toPersonId) return res.status(400).json({ error: "En person kan inte ha relation till sig själv." });
  if (!relationType) return res.status(400).json({ error: "Välj relationstyp." });

  // basic existence check
  const ppl = await pool.query("select id from people where tree_id=$1 and id in ($2,$3)", [treeId, fromPersonId, toPersonId]);
  if (ppl.rowCount !== 2) return res.status(400).json({ error: "Ogiltig person." });

  const r = await pool.query(
    `insert into relations(tree_id,from_person_id,to_person_id,relation_type)
     values($1,$2,$3,$4) returning id`,
    [treeId, fromPersonId, toPersonId, relationType]
  );

  await pool.query("update trees set updated_at=now() where id=$1", [treeId]);
  return res.json({ id: r.rows[0].id });
});

app.delete("/trees/:treeId/relations/:relationId", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { treeId, relationId } = req.params;

  const owns = await pool.query("select id from trees where id=$1 and user_id=$2", [treeId, userId]);
  if (!owns.rowCount) return res.status(404).json({ error: "Trädet finns inte." });

  await pool.query("delete from relations where id=$1 and tree_id=$2", [relationId, treeId]);
  await pool.query("update trees set updated_at=now() where id=$1", [treeId]);
  return res.json({ ok: true });
});

async function main() {
  await pingDb();
  await migrate();

  app.listen(PORT, () => {
    console.log(`Backend kör på port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Kunde inte starta backend:", err);
  process.exit(1);
});
