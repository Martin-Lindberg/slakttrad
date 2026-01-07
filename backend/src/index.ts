import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import { z } from "zod";
import crypto from "crypto";
import { pool, pingDb, migrate } from "./db.js";
import { signAccessToken } from "./auth.js";
import { authGuard } from "./middleware.js";

const PORT = Number(process.env.PORT ?? "4000");
const app = express();

app.use(helmet());
app.use(express.json({ limit: "300kb" }));

app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: false
  })
);

app.get("/health", async (_req, res) => {
  try {
    await pingDb();
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "DB fel" });
  }
});

// =======================
// Auth
// =======================
const RegisterSchema = z.object({
  email: z.string().email("Ange en giltig e-postadress."),
  password: z.string().min(8, "Lösenordet måste vara minst 8 tecken.")
});

app.post("/auth/register", async (req, res) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ogiltig input." });

  const { email, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = crypto.randomUUID();

  try {
    await pool.query("insert into users (id, email, password_hash) values ($1, $2, $3)", [
      userId,
      email.toLowerCase(),
      passwordHash
    ]);
  } catch (e: any) {
    if (String(e?.code) === "23505") return res.status(409).json({ error: "E-postadressen finns redan." });
    return res.status(500).json({ error: "Kunde inte skapa konto." });
  }

  const token = signAccessToken({ sub: userId, email: email.toLowerCase() });
  return res.json({ accessToken: token });
});

const LoginSchema = z.object({
  email: z.string().email("Ange en giltig e-postadress."),
  password: z.string().min(1, "Ange lösenord.")
});

app.post("/auth/login", async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ogiltig input." });

  const { email, password } = parsed.data;

  const result = await pool.query("select id, email, password_hash from users where email = $1", [email.toLowerCase()]);
  const row = result.rows[0];
  if (!row) return res.status(401).json({ error: "Fel e-post eller lösenord." });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: "Fel e-post eller lösenord." });

  const token = signAccessToken({ sub: row.id, email: row.email });
  return res.json({ accessToken: token });
});

app.get("/me", authGuard, async (req, res) => {
  return res.json({ id: req.user!.sub, email: req.user!.email });
});

// =======================
// Trees
// =======================
const CreateTreeSchema = z.object({
  name: z.string().min(1, "Ange ett namn för släktträdet.").max(80, "Namnet får vara max 80 tecken.")
});

async function assertTreeOwnedByUser(treeId: string, userId: string): Promise<void> {
  const result = await pool.query("select 1 from trees where id = $1 and user_id = $2", [treeId, userId]);
  if (result.rowCount === 0) {
    const err: any = new Error("Släktträd hittades inte.");
    err.status = 404;
    throw err;
  }
}

app.get("/trees", authGuard, async (req, res) => {
  const userId = req.user!.sub;
  const result = await pool.query("select id, name, created_at from trees where user_id = $1 order by created_at desc", [
    userId
  ]);
  return res.json({ trees: result.rows });
});

app.post("/trees", authGuard, async (req, res) => {
  const parsed = CreateTreeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ogiltig input." });

  const userId = req.user!.sub;
  const treeId = crypto.randomUUID();
  const name = parsed.data.name.trim();

  await pool.query("insert into trees (id, user_id, name) values ($1, $2, $3)", [treeId, userId, name]);
  return res.json({ id: treeId, name });
});

app.get("/trees/:treeId", authGuard, async (req, res) => {
  const userId = req.user!.sub;
  const treeId = req.params.treeId;

  try {
    await assertTreeOwnedByUser(treeId, userId);
    const result = await pool.query("select id, name, created_at from trees where id = $1 and user_id = $2", [
      treeId,
      userId
    ]);
    return res.json(result.rows[0]);
  } catch (e: any) {
    return res.status(e?.status ?? 500).json({ error: e?.message ?? "Fel vid hämtning av träd." });
  }
});

// =======================
// People
// =======================
const PersonSchema = z.object({
  first_name: z.string().min(1, "Ange förnamn.").max(80, "Förnamn får vara max 80 tecken."),
  last_name: z.string().min(1, "Ange efternamn.").max(80, "Efternamn får vara max 80 tecken."),
  gender: z.string().max(30, "Kön får vara max 30 tecken.").optional().nullable(),
  birth_year: z.number().int().min(0).max(3000).optional().nullable(),
  death_year: z.number().int().min(0).max(3000).optional().nullable(),
  lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(),
  place_label: z.string().max(120, "Platsnamn får vara max 120 tecken.").optional().nullable()
});


// PATCH tree name (owner-only)
app.patch("/trees/:treeId", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user as { userId: string; role: string };
    const treeId = String(req.params.treeId || "");
    const name = String((req.body?.name ?? "")).trim();

    if (!treeId) return res.status(400).json({ error: "Ogiltigt träd-ID." });
    if (!name) return res.status(400).json({ error: "Ange ett namn." });
    if (name.length > 80) return res.status(400).json({ error: "Namnet är för långt (max 80 tecken)." });

    const ownerCheck = await db.query("SELECT id FROM trees WHERE id = $1 AND user_id = $2", [treeId, user.userId]);
    if (ownerCheck.rowCount === 0) return res.status(404).json({ error: "Trädet hittades inte." });

    const upd = await db.query(
      "UPDATE trees SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name",
      [name, treeId]
    );
    return res.json(upd.rows[0]);
  } catch (e) {
    console.error("PATCH /trees/:treeId failed", e);
    return res.status(500).json({ error: "Serverfel." });
  }
});

app.delete("/trees/:treeId", authGuard, async (req, res) => {
  const userId = req.user.id;

  const parsed = z.string().uuid().safeParse(req.params.treeId);
  if (!parsed.success) return res.status(400).json({ error: "Ogiltigt treeId." });

  const treeId = parsed.data;

  try {
    const del = await pool.query("delete from trees where id = $1 and user_id = $2", [treeId, userId]);
    if (del.rowCount === 0) return res.status(404).json({ error: "Släkten hittades inte." });

    // CASCADE tar hand om people + relations
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /trees/:treeId failed:", err);
    return res.status(500).json({ error: "Kunde inte ta bort släkt." });
  }
});


app.get("/trees/:treeId/people", authGuard, async (req, res) => {
  const userId = req.user!.sub;
  const treeId = req.params.treeId;

  try {
    await assertTreeOwnedByUser(treeId, userId);
    const result = await pool.query(
      `select id, first_name, last_name, gender, birth_year, death_year, lat, lng, place_label, created_at, updated_at
       from people where tree_id = $1
       order by updated_at desc`,
      [treeId]
    );
    return res.json({ people: result.rows });
  } catch (e: any) {
    return res.status(e?.status ?? 500).json({ error: e?.message ?? "Fel vid hämtning av personer." });
  }
});

app.post("/trees/:treeId/people", authGuard, async (req, res) => {
  const userId = req.user!.sub;
  const treeId = req.params.treeId;

  const parsed = PersonSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ogiltig input." });

  try {
    await assertTreeOwnedByUser(treeId, userId);

    const id = crypto.randomUUID();
    const p = parsed.data;

    const result = await pool.query(
      `insert into people (id, tree_id, first_name, last_name, gender, birth_year, death_year, lat, lng, place_label, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now())
       returning id, first_name, last_name, gender, birth_year, death_year, lat, lng, place_label, created_at, updated_at`,
      [
        id,
        treeId,
        p.first_name.trim(),
        p.last_name.trim(),
        p.gender ?? null,
        p.birth_year ?? null,
        p.death_year ?? null,
        p.lat ?? null,
        p.lng ?? null,
        p.place_label ?? null
      ]
    );

    return res.json(result.rows[0]);
  } catch (e: any) {
    return res.status(e?.status ?? 500).json({ error: e?.message ?? "Fel vid skapande av person." });
  }
});

app.patch("/trees/:treeId/people/:personId", authGuard, async (req, res) => {
  const userId = req.user!.sub;
  const { treeId, personId } = req.params;

  const parsed = PersonSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ogiltig input." });

  try {
    await assertTreeOwnedByUser(treeId, userId);

    const exists = await pool.query("select 1 from people where id = $1 and tree_id = $2", [personId, treeId]);
    if (exists.rowCount === 0) return res.status(404).json({ error: "Person hittades inte." });

    const p = parsed.data;

    const result = await pool.query(
      `update people
       set first_name=$1, last_name=$2, gender=$3, birth_year=$4, death_year=$5, lat=$6, lng=$7, place_label=$8, updated_at=now()
       where id=$9 and tree_id=$10
       returning id, first_name, last_name, gender, birth_year, death_year, lat, lng, place_label, created_at, updated_at`,
      [
        p.first_name.trim(),
        p.last_name.trim(),
        p.gender ?? null,
        p.birth_year ?? null,
        p.death_year ?? null,
        p.lat ?? null,
        p.lng ?? null,
        p.place_label ?? null,
        personId,
        treeId
      ]
    );

    return res.json(result.rows[0]);
  } catch (e: any) {
    return res.status(e?.status ?? 500).json({ error: e?.message ?? "Fel vid uppdatering av person." });
  }
});

app.delete("/trees/:treeId/people/:personId", authGuard, async (req, res) => {
  const userId = req.user!.sub;
  const { treeId, personId } = req.params;

  try {
    await assertTreeOwnedByUser(treeId, userId);
    const result = await pool.query("delete from people where id = $1 and tree_id = $2", [personId, treeId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Person hittades inte." });
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(e?.status ?? 500).json({ error: e?.message ?? "Fel vid borttagning av person." });
  }
});

// =======================
// Relations (NYTT I 4E)
// =======================
const RelationCreateSchema = z.object({
  from_person_id: z.string().uuid("Ogiltig from_person_id."),
  to_person_id: z.string().uuid("Ogiltig to_person_id."),
  relation_type: z.string().min(1, "Ange relationstyp.").max(40, "Relationstyp får vara max 40 tecken.")
});

async function assertPersonInTree(treeId: string, personId: string): Promise<void> {
  const r = await pool.query("select 1 from people where id = $1 and tree_id = $2", [personId, treeId]);
  if (r.rowCount === 0) {
    const err: any = new Error("Personen finns inte i valt släktträd.");
    err.status = 400;
    throw err;
  }
}

app.get("/trees/:treeId/relations", authGuard, async (req, res) => {
  const userId = req.user!.sub;
  const treeId = req.params.treeId;

  try {
    await assertTreeOwnedByUser(treeId, userId);

    const result = await pool.query(
      `select r.id, r.from_person_id, r.to_person_id, r.relation_type, r.created_at
       from relations r
       where r.tree_id = $1
       order by r.created_at desc`,
      [treeId]
    );

    return res.json({ relations: result.rows });
  } catch (e: any) {
    return res.status(e?.status ?? 500).json({ error: e?.message ?? "Fel vid hämtning av relationer." });
  }
});

app.post("/trees/:treeId/relations", authGuard, async (req, res) => {
  const userId = req.user!.sub;
  const treeId = req.params.treeId;

  const parsed = RelationCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ogiltig input." });

  const { from_person_id, to_person_id, relation_type } = parsed.data;

  if (from_person_id === to_person_id) return res.status(400).json({ error: "En person kan inte relateras till sig själv." });

  try {
    await assertTreeOwnedByUser(treeId, userId);
    await assertPersonInTree(treeId, from_person_id);
    await assertPersonInTree(treeId, to_person_id);

    // enkel dedup: om exakt relation redan finns, returnera 409
    const dup = await pool.query(
      `select 1 from relations
       where tree_id=$1 and from_person_id=$2 and to_person_id=$3 and relation_type=$4`,
      [treeId, from_person_id, to_person_id, relation_type.trim()]
    );
    if (dup.rowCount > 0) return res.status(409).json({ error: "Relationen finns redan." });

    const id = crypto.randomUUID();
    const result = await pool.query(
      `insert into relations (id, tree_id, from_person_id, to_person_id, relation_type, created_at)
       values ($1,$2,$3,$4,$5, now())
       returning id, from_person_id, to_person_id, relation_type, created_at`,
      [id, treeId, from_person_id, to_person_id, relation_type.trim()]
    );

    return res.json(result.rows[0]);
  } catch (e: any) {
    return res.status(e?.status ?? 500).json({ error: e?.message ?? "Fel vid skapande av relation." });
  }
});

app.delete("/trees/:treeId/relations/:relationId", authGuard, async (req, res) => {
  const userId = req.user!.sub;
  const { treeId, relationId } = req.params;

  try {
    await assertTreeOwnedByUser(treeId, userId);
    const result = await pool.query("delete from relations where id = $1 and tree_id = $2", [relationId, treeId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Relation hittades inte." });
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(e?.status ?? 500).json({ error: e?.message ?? "Fel vid borttagning av relation." });
  }
});

async function main() {
  await pingDb();
  await migrate();
  app.listen(PORT, () => console.log(`Backend kör på http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error("Kunde inte starta backend:", err);
  process.exit(1);
});
