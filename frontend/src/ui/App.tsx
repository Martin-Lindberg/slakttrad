import React, { useEffect, useMemo, useState } from "react";
import "./polish.css";
import { MapContainer, TileLayer, CircleMarker, Tooltip, Polyline, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";

type View = "login" | "hub" | "people" | "relations";

const API_BASE = (import.meta as any).env?.VITE_API_BASE || "http://localhost:4000";

function getToken(): string | null {
  return localStorage.getItem("accessToken");
}
function setToken(token: string | null) {
  if (!token) localStorage.removeItem("accessToken");
  else localStorage.setItem("accessToken", token);
}

function getActiveTreeId(): string | null {
  return localStorage.getItem("activeTreeId");
}
function setActiveTreeId(id: string | null) {
  if (!id) localStorage.removeItem("activeTreeId");
  else localStorage.setItem("activeTreeId", id);
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { ...headers, ...(opts.headers ?? {}) }
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any)?.error ?? "Okänt fel.";
    throw new Error(msg);
  }
  return data as T;
}

type Me = { id: string; email: string };
type Tree = { id: string; name: string; created_at?: string; updated_at?: string };
type Person = {
  id: string;
  first_name: string;
  last_name: string;
  gender: string | null;
  birth_year: number | null;
  death_year: number | null;
  lat: number | null;
  lng: number | null;
  place_label: string | null;
  updated_at?: string;
};
type Relation = {
  id: string;
  from_person_id: string;
  to_person_id: string;
  relation_type: string;
  created_at?: string;
};

type RelationCatalogItem = { key: string; label: string; color: string; aliases: string[] };
const RELATION_CATALOG: RelationCatalogItem[] = [
  { key: "förälder/barn", label: "Förälder/Barn", color: "#2563eb", aliases: ["förälder", "barn"] },
  { key: "partner", label: "Partner", color: "#db2777", aliases: ["partner", "make", "maka", "man", "fru", "sambo", "gift"] },
  { key: "syskon", label: "Syskon", color: "#16a34a", aliases: ["syskon", "bror", "syster"] },
  { key: "kusin", label: "Kusin", color: "#f59e0b", aliases: ["kusin"] },
  { key: "annan", label: "Annan", color: "#6b7280", aliases: ["annan", "övrig", "other"] }
];

function normalizeRelationType(raw: string): string {
  const t = (raw || "").trim().toLowerCase();
  if (!t) return "annan";
  for (const item of RELATION_CATALOG) {
    if (t === item.key) return item.key;
    if (item.aliases.some((a) => a.toLowerCase() === t)) return item.key;
  }
  return "annan";
}
function relationLabel(raw: string): string {
  const key = normalizeRelationType(raw);
  return RELATION_CATALOG.find((x) => x.key === key)?.label ?? "Annan";
}
function relationColor(raw: string): string {
  const key = normalizeRelationType(raw);
  return RELATION_CATALOG.find((x) => x.key === key)?.color ?? "#6b7280";
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

type MapPick = { lat: number; lng: number };

function MapClicker(props: { value: MapPick | null; onPick: (p: MapPick) => void }) {
  useMapEvents({
    click(e) {
      props.onPick({ lat: round6(e.latlng.lat), lng: round6(e.latlng.lng) });
    }
  });
  return props.value ? <CircleMarker center={[props.value.lat, props.value.lng]} radius={8} /> : null;
}

function FitBounds(props: { points: Array<{ lat: number; lng: number }> }) {
  const map = useMap();
  useEffect(() => {
    if (!props.points.length) return;
    const bounds = new L.LatLngBounds(props.points.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [map, props.points]);
  return null;
}

function toIntOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isInteger(n)) return null;
  return n;
}

function displayNameFromEmail(email: string | null | undefined): string {
  if (!email) return "Inloggad";
  const head = email.split("@")[0] || email;
  return head.trim() || "Inloggad";
}

function csvEscape(v: any): string {
  const s = (v === null || v === undefined) ? "" : String(v);
  const needs = /[;"\n\r]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needs ? `"${escaped}"` : escaped;
}

function toCsv(rows: any[][], delimiter: string = ";"): string {
  return rows.map((r) => r.map(csvEscape).join(delimiter)).join("\r\n");
}

function downloadTextFile(filename: string, content: string) {
  // Add UTF-8 BOM for Excel compatibility
  const blob = new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function safeFileSlug(name: string): string {
  return (name || "slakt")
    .toLowerCase()
    .replace(/[^a-z0-9åäö_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseCsv(text: string, delimiter: string = ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;

  const pushCell = () => {
    row.push(cur);
    cur = "";
  };
  const pushRow = () => {
    // ignore completely empty trailing rows
    if (row.length === 1 && row[0] === "" && rows.length > 0) return;
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      pushCell();
      continue;
    }

    if (ch === "\n") {
      // handle CRLF: remove trailing CR
      if (cur.endsWith("\r")) cur = cur.slice(0, -1);
      pushCell();
      pushRow();
      continue;
    }

    cur += ch;
  }

  // last cell/row
  pushCell();
  pushRow();

  // trim BOM from first cell if present
  if (rows.length > 0 && rows[0].length > 0) {
    rows[0][0] = rows[0][0].replace(/^\ufeff/, "");
  }
  return rows;
}

function normalizeHeader(h: string): string {
  return (h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\wåäö]/g, "");
}


export function App() {
  const [view, setView] = useState<View>(() => (getToken() ? "hub" : "login"));

  const [me, setMe] = useState<Me | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState<string | null>(null);

  const [trees, setTrees] = useState<Tree[]>([]);
  const [activeTreeId, setActiveTreeIdState] = useState<string | null>(() => getActiveTreeId());

  const [createTreeOpen, setCreateTreeOpen] = useState(false);
  const [treeName, setTreeName] = useState("");

  const [importCsvOpen, setImportCsvOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<{ rows: any[]; warnings: string[] } | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const [importRelOpen, setImportRelOpen] = useState(false);
  const [importRelPreview, setImportRelPreview] = useState<{ rows: any[]; warnings: string[] } | null>(null);
  const [importRelMap, setImportRelMap] = useState<Record<string, string>>({});
  const [importRelBusy, setImportRelBusy] = useState(false);

  const [renamingTreeId, setRenamingTreeId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [peopleSearch, setPeopleSearch] = useState("");
  const [relationsSearch, setRelationsSearch] = useState("");

  const [people, setPeople] = useState<Person[]>([]);
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);
  const [editBaseline, setEditBaseline] = useState<string>("");

  const [pFirst, setPFirst] = useState("");
  const [pLast, setPLast] = useState("");
  const [pGender, setPGender] = useState("");
  const [pBirth, setPBirth] = useState("");
  const [pDeath, setPDeath] = useState("");

  const [relations, setRelations] = useState<Relation[]>([]);
  const [relFrom, setRelFrom] = useState<string>("");
  const [relTo, setRelTo] = useState<string>("");
  const [relType, setRelType] = useState<string>("förälder/barn");

  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [mapPersonId, setMapPersonId] = useState<string | null>(null);
  const [mapPick, setMapPick] = useState<MapPick | null>(null);
  const [mapPlaceLabel, setMapPlaceLabel] = useState("");

  const authed = !!getToken();

  function setActiveTree(id: string | null) {
    setActiveTreeIdState(id);
    setActiveTreeId(id);
  }

  const activeTreeName = useMemo(
    () => (activeTreeId ? trees.find((t) => t.id === activeTreeId)?.name ?? null : null),
    [trees, activeTreeId]
  );

  const personFormKey = useMemo(() => {
    return JSON.stringify({
      editingPersonId,
      pFirst: pFirst.trim(),
      pLast: pLast.trim(),
      pGender: pGender.trim(),
      pBirth: pBirth.trim(),
      pDeath: pDeath.trim()
    });
  }, [editingPersonId, pFirst, pLast, pGender, pBirth, pDeath]);

  const personDirty = useMemo(() => {
    const current = personFormKey;
    if (!editingPersonId) {
      return !!(pFirst.trim() || pLast.trim() || pGender.trim() || pBirth.trim() || pDeath.trim());
    }
    return current !== editBaseline;
  }, [personFormKey, editingPersonId, editBaseline, pFirst, pLast, pGender, pBirth, pDeath]);

  const relationsDirty = useMemo(() => {
    return !!(relFrom || relTo || (relType && normalizeRelationType(relType) !== "förälder/barn"));
  }, [relFrom, relTo, relType]);

  const createTreeDirty = useMemo(() => {
    return createTreeOpen && !!treeName.trim();
  }, [createTreeOpen, treeName]);

  const renameDirty = useMemo(() => {
    return !!(renamingTreeId && renameValue.trim());
  }, [renamingTreeId, renameValue]);

  const hasUnsaved = personDirty || relationsDirty || createTreeDirty || renameDirty;

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!hasUnsaved) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsaved]);

  function confirmLeaveIfDirty(): boolean {
    if (!hasUnsaved) return true;
    return window.confirm("Du har ändringar som inte är sparade. Vill du lämna vyn ändå?");
  }

  function safeNavigate(next: View, fn?: () => void) {
    if (!confirmLeaveIfDirty()) return;
    setError(null);
    fn?.();
    setView(next);
  }

  useEffect(() => {
    const t = getToken();
    if (!t) return;
    (async () => {
      try {
        const data = await api<Me>("/me", { method: "GET" });
        setMe(data);
        setView("hub");
      } catch {
        setToken(null);
        setMe(null);
        setView("login");
      }
    })();
  }, []);

  async function submitAuth() {
    setError(null);
    try {
      const endpoint = mode === "login" ? "/auth/login" : "/auth/register";
      const data = await api<{ accessToken: string }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ email, password })
      });

      setToken(data.accessToken);
      const meData = await fetch(`${API_BASE}/me`, {
        headers: { Authorization: `Bearer ${data.accessToken}` }
      }).then((r) => r.json().catch(() => ({})));

      if (!(meData as any)?.id) throw new Error((meData as any)?.error ?? "Kunde inte läsa /me.");
      setMe(meData as Me);
      setView("hub");
      await refreshTrees(true);
    } catch (e: any) {
      setError(e?.message ?? "Något gick fel.");
    }
  }

  function resetAllForms() {
    resetPersonForm(true);
    resetRelationForm(true);
    setCreateTreeOpen(false);
    setTreeName("");
    setImportCsvOpen(false);
    setImportPreview(null);
    setImportBusy(false);
    setImportRelOpen(false);
    setImportRelPreview(null);
    setImportRelMap({});
    setImportRelBusy(false);
    setRenamingTreeId(null);
    setRenameValue("");
    setPeopleSearch("");
    setRelationsSearch("");
  }

  function logout() {
    if (!confirmLeaveIfDirty()) return;
    setToken(null);
    setMe(null);
    setActiveTree(null);
    setTrees([]);
    setPeople([]);
    setRelations([]);
    resetAllForms();
    setEmail("");
    setPassword("");
    setError(null);
    setView("login");
  }

  async function refreshTrees(setDefaultActive = false) {
    setError(null);
    try {
      const data = await api<any>("/trees");

      const list: Tree[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.trees)
        ? data.trees
        : [];

      setTrees(list);

      if (setDefaultActive && !getActiveTreeId() && list.length > 0) {
        setActiveTree(list[0].id);
      }

      // if activeTreeId no longer exists, clear it
      const current = getActiveTreeId();
      if (current && !list.some((t) => t.id === current)) {
        setActiveTree(null);
      }
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte hämta släktträd.");
    }
  }

  async function refreshPeople(treeId: string | null) {
    setError(null);
    if (!treeId) return setPeople([]);
    try {
      const data = await api<any>(`/trees/${treeId}/people`);

      const list: Person[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.people)
        ? data.people
        : [];

      setPeople(list);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte hämta personer.");
    }
  }

  async function refreshRelations(treeId: string | null) {
    setError(null);
    if (!treeId) return setRelations([]);
    try {
      const data = await api<{ relations: Relation[] }>(`/trees/${treeId}/relations`);
      setRelations(data.relations ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte hämta relationer.");
    }
  }

  useEffect(() => {
    if (!authed) return;
    refreshTrees(false);
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    refreshPeople(activeTreeId);
    refreshRelations(activeTreeId);
  }, [activeTreeId, authed]);

  async function createTree() {
    setError(null);
    try {
      const name = treeName.trim();
      if (!name) return setError("Ange ett namn för släkten.");
      const created = await api<{ id: string; name: string }>("/trees", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      setCreateTreeOpen(false);
      setTreeName("");
      await refreshTrees(false);
      setActiveTree(created.id);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte skapa släkt.");
    }
  }

  async function renameTree(treeId: string) {
    setError(null);
    const name = renameValue.trim();
    if (!name) return setError("Ange ett namn.");
    try {
      await api<{ id: string; name: string }>(`/trees/${treeId}`, {
        method: "PATCH",
        body: JSON.stringify({ name })
      });
      setRenamingTreeId(null);
      setRenameValue("");
      await refreshTrees(false);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte byta namn på släkt.");
    }
  }

  async function deleteTree(treeId: string) {
    setError(null);
    const t = trees.find((x) => x.id === treeId);
    const label = t?.name ? `“${t.name}”` : "denna släkt";
    if (!window.confirm(`Ta bort ${label}? Alla personer och relationer raderas permanent.`)) return;

    try {
      await api<{ ok: true }>(`/trees/${treeId}`, { method: "DELETE" });
      if (activeTreeId === treeId) setActiveTree(null);
      if (renamingTreeId === treeId) {
        setRenamingTreeId(null);
        setRenameValue("");
      }
      await refreshTrees(false);
      await refreshPeople(activeTreeId === treeId ? null : activeTreeId);
      await refreshRelations(activeTreeId === treeId ? null : activeTreeId);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte ta bort släkt.");
    }
  }


  function exportActiveTreeCsv() {
    setError(null);
    if (!activeTreeId) return setError("Välj en släkt först.");
    const t = trees.find((x) => x.id === activeTreeId);
    const treeLabel = t?.name ?? "släkt";
    const slug = safeFileSlug(treeLabel);

    // Persons
    const personRows: any[][] = [
      ["person_id", "förnamn", "efternamn", "kön", "födelseår", "dödsår", "platsnamn", "lat", "lng"]
    ];
    for (const p of people) {
      personRows.push([
        p.id,
        p.first_name ?? "",
        p.last_name ?? "",
        p.gender ?? "",
        p.birth_year ?? "",
        p.death_year ?? "",
        p.place_label ?? "",
        p.lat ?? "",
        p.lng ?? ""
      ]);
    }

    // Relations
    const relRows: any[][] = [
      ["relation_id", "person_a_id", "person_a", "relationstyp", "person_b_id", "person_b"]
    ];
    for (const r of relations) {
      const a = peopleById[r.from_person_id];
      const b = peopleById[r.to_person_id];
      relRows.push([
        r.id,
        r.from_person_id,
        a ? `${a.first_name} ${a.last_name}` : "",
        relationLabel(r.relation_type),
        r.to_person_id,
        b ? `${b.first_name} ${b.last_name}` : ""
      ]);
    }

    const personsCsv = toCsv(personRows, ";");
    const relationsCsv = toCsv(relRows, ";");

    const base = `slakttrad-${slug}`;
    downloadTextFile(`${base}-personer.csv`, personsCsv);
    downloadTextFile(`${base}-relationer.csv`, relationsCsv);
  }


  async function handleImportPersonsCsv(file: File) {
    setError(null);
    setImportPreview(null);

    if (!activeTreeId) return setError("Välj en släkt först.");

    const text = await file.text();
    const table = parseCsv(text, ";");
    if (table.length < 2) return setError("CSV verkar tom (ingen data).");

    const header = table[0].map(normalizeHeader);
    const idx = (key: string) => header.indexOf(key);

    const required = ["förnamn", "efternamn"];
    const missing = required.filter((k) => idx(k) === -1);
    if (missing.length) {
      return setError(`CSV saknar kolumner: ${missing.join(", ")}.`);
    }

    const warnings: string[] = [];
    if (idx("person_id") !== -1) warnings.push("Obs: person_id i CSV ignoreras vid import (nya ID skapas).");

    const rows: any[] = [];
    for (let r = 1; r < table.length; r++) {
      const row = table[r];
      const first = (row[idx("förnamn")] ?? "").trim();
      const last = (row[idx("efternamn")] ?? "").trim();
      if (!first && !last) continue; // skip empty line
      if (!first || !last) {
        warnings.push(`Rad ${r + 1}: saknar förnamn eller efternamn (hoppas över).`);
        continue;
      }

      const gender = idx("kön") !== -1 ? (row[idx("kön")] ?? "").trim().toLowerCase() : "";
      const birth = idx("födelseår") !== -1 ? (row[idx("födelseår")] ?? "").trim() : "";
      const death = idx("dödsår") !== -1 ? (row[idx("dödsår")] ?? "").trim() : "";
      const place_label = idx("platsnamn") !== -1 ? (row[idx("platsnamn")] ?? "").trim() : "";
      const lat = idx("lat") !== -1 ? (row[idx("lat")] ?? "").trim() : "";
      const lng = idx("lng") !== -1 ? (row[idx("lng")] ?? "").trim() : "";

      const birth_year = birth ? Number(birth) : null;
      const death_year = death ? Number(death) : null;
      const latNum = lat ? Number(lat) : null;
      const lngNum = lng ? Number(lng) : null;

      if (birth && !Number.isFinite(birth_year)) warnings.push(`Rad ${r + 1}: ogiltigt födelseår "${birth}" (sätts som tomt).`);
      if (death && !Number.isFinite(death_year)) warnings.push(`Rad ${r + 1}: ogiltigt dödsår "${death}" (sätts som tomt).`);
      if ((lat || lng) && (!Number.isFinite(latNum) || !Number.isFinite(lngNum))) {
        warnings.push(`Rad ${r + 1}: ogiltig lat/lng (plats ignoreras).`);
      }

      rows.push({
        first_name: first,
        last_name: last,
        gender: (gender === "man" || gender === "kvinna") ? gender : (gender ? gender : null),
        birth_year: birth && Number.isFinite(birth_year) ? Math.trunc(birth_year) : null,
        death_year: death && Number.isFinite(death_year) ? Math.trunc(death_year) : null,
        place_label: place_label || null,
        lat: (lat && lng && Number.isFinite(latNum) && Number.isFinite(lngNum)) ? latNum : null,
        lng: (lat && lng && Number.isFinite(latNum) && Number.isFinite(lngNum)) ? lngNum : null
      });
    }

    if (!rows.length) return setError("Ingen importerbar data hittades i CSV.");

    setImportPreview({ rows, warnings });
  }

  async function confirmImportPersons() {
    setError(null);
    if (!activeTreeId) return setError("Välj en släkt först.");
    if (!importPreview) return setError("Ingen import att köra.");
    if (importBusy) return;

    const ok = window.confirm(`Importera ${importPreview.rows.length} personer till vald släkt?`);
    if (!ok) return;

    setImportBusy(true);
    try {
      for (const p of importPreview.rows) {
        await api<Person>(`/trees/${activeTreeId}/people`, {
          method: "POST",
          body: JSON.stringify({
            first_name: p.first_name,
            last_name: p.last_name,
            gender: p.gender ?? null,
            birth_year: p.birth_year ?? null,
            death_year: p.death_year ?? null,
            place_label: p.place_label ?? null,
            lat: p.lat ?? null,
            lng: p.lng ?? null
          })
        });
      }
      setImportPreview(null);
      setImportCsvOpen(false);
      await refreshPeople(activeTreeId);
    } catch (e: any) {
      setError(e?.message ?? "Importen misslyckades.");
    } finally {
      setImportBusy(false);
    }
  }


  function fullName(p: Person): string {
    return `${(p.first_name ?? "").trim()} ${(p.last_name ?? "").trim()}`.trim();
  }

  function buildAutoNameMap(): Record<string, string> {
    const map: Record<string, string> = {};
    const byName: Record<string, string> = {};
    for (const p of people) {
      const n = fullName(p).toLowerCase();
      if (!n) continue;
      // If duplicates, keep first; user can override manually
      if (!byName[n]) byName[n] = p.id;
    }
    for (const key of Object.keys(map)) {
      // noop
    }
    return byName;
  }

  async function handleImportRelationsCsv(file: File) {
    setError(null);
    setImportRelPreview(null);
    setImportRelMap({});
    if (!activeTreeId) return setError("Välj en släkt först.");

    const text = await file.text();
    const table = parseCsv(text, ";");
    if (table.length < 2) return setError("CSV verkar tom (ingen data).");

    const header = table[0].map(normalizeHeader);
    const idx = (key: string) => header.indexOf(key);

    // Accept either exported headers or simpler ones
    // exported: person_a, relationstyp, person_b
    const aKey = idx("person_a") !== -1 ? "person_a" : (idx("person_a_namn") !== -1 ? "person_a_namn" : "");
    const bKey = idx("person_b") !== -1 ? "person_b" : (idx("person_b_namn") !== -1 ? "person_b_namn" : "");
    const tKey = idx("relationstyp") !== -1 ? "relationstyp" : (idx("typ") !== -1 ? "typ" : "");

    const missing = [];
    if (!aKey) missing.push("person_a");
    if (!bKey) missing.push("person_b");
    if (!tKey) missing.push("relationstyp");
    if (missing.length) return setError(`CSV saknar kolumner: ${missing.join(", ")}.`);

    const warnings: string[] = [];
    if (idx("relation_id") !== -1) warnings.push("Obs: relation_id i CSV ignoreras vid import.");

    const rows: any[] = [];
    const seen = new Set<string>();

    for (let r = 1; r < table.length; r++) {
      const row = table[r];
      const a = (row[idx(aKey)] ?? "").trim();
      const b = (row[idx(bKey)] ?? "").trim();
      const rawType = (row[idx(tKey)] ?? "").trim();
      if (!a && !b && !rawType) continue;
      if (!a || !b) {
        warnings.push(`Rad ${r + 1}: saknar person_a eller person_b (hoppas över).`);
        continue;
      }
      const typeKey = normalizeRelationType(rawType || "annan");
      const dedupeKey = `${a.toLowerCase()}|${typeKey}|${b.toLowerCase()}`;
      if (seen.has(dedupeKey)) {
        warnings.push(`Rad ${r + 1}: dubblett (hoppas över).`);
        continue;
      }
      seen.add(dedupeKey);

      rows.push({ aName: a, bName: b, type: typeKey, rawType });
    }

    if (!rows.length) return setError("Ingen importerbar data hittades i CSV.");

    // Build initial mapping by exact match
    const byName = buildAutoNameMap();
    const uniqNames = Array.from(new Set(rows.flatMap((x) => [x.aName, x.bName]))).sort((x, y) => x.localeCompare(y));
    const initialMap: Record<string, string> = {};
    for (const n of uniqNames) {
      const hit = byName[n.toLowerCase()];
      if (hit) initialMap[n] = hit;
    }

    if (uniqNames.length !== Object.keys(initialMap).length) {
      warnings.push("Matcha alla namn i listan nedan för att importera relationer korrekt.");
    }

    setImportRelMap(initialMap);
    setImportRelPreview({ rows, warnings });
  }

  function autoMatchRelations() {
    if (!importRelPreview) return;
    const byName: Record<string, string> = {};
    for (const p of people) {
      const n = fullName(p).toLowerCase();
      if (!n) continue;
      if (!byName[n]) byName[n] = p.id;
    }
    const next = { ...importRelMap };
    const uniqNames = Array.from(new Set(importRelPreview.rows.flatMap((x) => [x.aName, x.bName])));
    for (const n of uniqNames) {
      if (next[n]) continue;
      const hit = byName[n.toLowerCase()];
      if (hit) next[n] = hit;
    }
    setImportRelMap(next);
  }

  function countImportableRelations(): number {
    if (!importRelPreview) return 0;
    let c = 0;
    for (const r of importRelPreview.rows) {
      const aId = importRelMap[r.aName];
      const bId = importRelMap[r.bName];
      if (!aId || !bId) continue;
      if (aId === bId) continue;
      c++;
    }
    return c;
  }

  async function confirmImportRelations() {
    setError(null);
    if (!activeTreeId) return setError("Välj en släkt först.");
    if (!importRelPreview) return setError("Ingen import att köra.");
    if (importRelBusy) return;

    const total = countImportableRelations();
    if (total === 0) return setError("Inga relationer är möjliga att importera (saknar matchning eller self-relations).");

    const ok = window.confirm(`Importera ${total} relationer till vald släkt?`);
    if (!ok) return;

    setImportRelBusy(true);
    try {
      for (const r of importRelPreview.rows) {
        const fromId = importRelMap[r.aName];
        const toId = importRelMap[r.bName];
        if (!fromId || !toId) continue;
        if (fromId === toId) continue;

        await api<Relation>(`/trees/${activeTreeId}/relations`, {
          method: "POST",
          body: JSON.stringify({
            from_person_id: fromId,
            to_person_id: toId,
            relation_type: r.type
          })
        });
      }
      setImportRelPreview(null);
      setImportRelOpen(false);
      setImportRelMap({});
      await refreshRelations(activeTreeId);
    } catch (e: any) {
      setError(e?.message ?? "Importen misslyckades.");
    } finally {
      setImportRelBusy(false);
    }
  }

  function openTree(tree: Tree) {
    if (!confirmLeaveIfDirty()) return;
    setError(null);
    setRenamingTreeId(null);
    setRenameValue("");
    setCreateTreeOpen(false);
    setTreeName("");
    setImportCsvOpen(false);
    setImportPreview(null);
    setImportBusy(false);
    setImportRelOpen(false);
    setImportRelPreview(null);
    setImportRelMap({});
    setImportRelBusy(false);
    setPeopleSearch("");
    setRelationsSearch("");
    setActiveTree(tree.id);
    resetPersonForm(true);
    resetRelationForm(true);
    setView("people");
  }

  function resetPersonForm(forceClean = false) {
    setEditingPersonId(null);
    setPFirst("");
    setPLast("");
    setPGender("");
    setPBirth("");
    setPDeath("");
    if (forceClean) setEditBaseline("");
  }

  function startEdit(p: Person) {
    setError(null);
    setEditingPersonId(p.id);
    setPFirst(p.first_name ?? "");
    setPLast(p.last_name ?? "");
    setPGender(p.gender ?? "");
    setPBirth(p.birth_year == null ? "" : String(p.birth_year));
    setPDeath(p.death_year == null ? "" : String(p.death_year));

    const baseline = JSON.stringify({
      editingPersonId: p.id,
      pFirst: (p.first_name ?? "").trim(),
      pLast: (p.last_name ?? "").trim(),
      pGender: (p.gender ?? "").trim(),
      pBirth: p.birth_year == null ? "" : String(p.birth_year),
      pDeath: p.death_year == null ? "" : String(p.death_year)
    });
    setEditBaseline(baseline);
  }

  async function savePerson() {
    setError(null);
    if (!activeTreeId) return setError("Välj en släkt först.");

    const first_name = pFirst.trim();
    const last_name = pLast.trim();
    if (!first_name) return setError("Ange förnamn.");
    if (!last_name) return setError("Ange efternamn.");

    const birth_year = toIntOrNull(pBirth);
    const death_year = toIntOrNull(pDeath);
    if (pBirth.trim() && birth_year === null) return setError("Födelseår måste vara ett heltal (eller tomt).");
    if (pDeath.trim() && death_year === null) return setError("Dödsår måste vara ett heltal (eller tomt).");

    const base = {
      first_name,
      last_name,
      gender: pGender.trim() ? pGender.trim() : null,
      birth_year,
      death_year
    };

    try {
      if (!editingPersonId) {
        await api<Person>(`/trees/${activeTreeId}/people`, {
          method: "POST",
          body: JSON.stringify({ ...base, lat: null, lng: null, place_label: null })
        });
      } else {
        const current = people.find((x) => x.id === editingPersonId);
        await api<Person>(`/trees/${activeTreeId}/people/${editingPersonId}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...base,
            lat: current?.lat ?? null,
            lng: current?.lng ?? null,
            place_label: current?.place_label ?? null
          })
        });
      }
      await refreshPeople(activeTreeId);
      resetPersonForm(true);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte spara person.");
    }
  }

  async function deletePerson(personId: string) {
    setError(null);
    if (!activeTreeId) return setError("Välj en släkt först.");
    if (!window.confirm("Ta bort personen? Detta går inte att ångra.")) return;

    try {
      await api<{ ok: true }>(`/trees/${activeTreeId}/people/${personId}`, { method: "DELETE" });
      await refreshPeople(activeTreeId);
      await refreshRelations(activeTreeId);
      if (editingPersonId === personId) resetPersonForm(true);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte ta bort person.");
    }
  }

  function openMapForPerson(personId: string) {
    setError(null);
    const p = people.find((x) => x.id === personId);
    setMapPersonId(personId);
    if (p?.lat != null && p?.lng != null) setMapPick({ lat: p.lat, lng: p.lng });
    else setMapPick(null);
    setMapPlaceLabel(p?.place_label ?? "");
    setMapModalOpen(true);
  }

  async function confirmMapPick() {
    if (!activeTreeId || !mapPersonId) return;
    if (!mapPick) return setError("Klicka i kartan för att sätta en markör.");
    setError(null);

    const p = people.find((x) => x.id === mapPersonId);
    if (!p) return setError("Personen finns inte längre i listan.");

    try {
      await api<Person>(`/trees/${activeTreeId}/people/${mapPersonId}`, {
        method: "PATCH",
        body: JSON.stringify({
          first_name: p.first_name,
          last_name: p.last_name,
          gender: p.gender,
          birth_year: p.birth_year,
          death_year: p.death_year,
          lat: mapPick.lat,
          lng: mapPick.lng,
          place_label: mapPlaceLabel.trim() ? mapPlaceLabel.trim() : null
        })
      });
      setMapModalOpen(false);
      setMapPersonId(null);
      await refreshPeople(activeTreeId);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte spara plats.");
    }
  }

  function resetRelationForm() {
    setRelFrom("");
    setRelTo("");
    setRelType("förälder/barn");
  }

  useEffect(() => {
    if (relFrom && relTo && relFrom === relTo) setRelTo("");
  }, [relFrom]);

  useEffect(() => {
    if (relFrom && relTo && relFrom === relTo) setRelFrom("");
  }, [relTo]);

  async function createRelation() {
    setError(null);
    if (!activeTreeId) return setError("Välj en släkt först.");
    if (!relFrom || !relTo) return setError("Välj två personer.");
    if (relFrom === relTo) return setError("Du måste välja två olika personer.");

    try {
      await api<Relation>(`/trees/${activeTreeId}/relations`, {
        method: "POST",
        body: JSON.stringify({
          from_person_id: relFrom,
          to_person_id: relTo,
          relation_type: normalizeRelationType(relType)
        })
      });
      resetRelationForm();
      await refreshRelations(activeTreeId);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte skapa relation.");
    }
  }

  async function deleteRelation(relationId: string) {
    setError(null);
    if (!activeTreeId) return setError("Välj en släkt först.");
    if (!window.confirm("Ta bort relationen?")) return;
    try {
      await api<{ ok: true }>(`/trees/${activeTreeId}/relations/${relationId}`, { method: "DELETE" });
      await refreshRelations(activeTreeId);
    } catch (e: any) {
      setError(e?.message ?? "Kunde inte ta bort relation.");
    }
  }

  const filteredPeople = useMemo(() => {
    const q = peopleSearch.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => (`${p.first_name ?? ""} ${p.last_name ?? ""}`).toLowerCase().includes(q));
  }, [people, peopleSearch]);

  const peopleById = useMemo(() => {
    const m: Record<string, Person> = {};
    for (const p of people) m[p.id] = p;
    return m;
  }, [people]);

  const filteredRelations = useMemo(() => {
    const q = relationsSearch.trim().toLowerCase();
    if (!q) return relations;
    return relations.filter((r) => {
      const a = peopleById[r.from_person_id];
      const b = peopleById[r.to_person_id];
      const label = `${a ? `${a.first_name} ${a.last_name}` : ""} ${relationLabel(r.relation_type)} ${b ? `${b.first_name} ${b.last_name}` : ""}`.toLowerCase();
      return label.includes(q);
    });
  }, [relations, relationsSearch, peopleById]);

  const mapPoints = useMemo(
    () =>
      people
        .filter((p) => p.lat != null && p.lng != null)
        .map((p) => ({ lat: p.lat as number, lng: p.lng as number, person: p })),
    [people]
  );

  const mapLines = useMemo(() => {
    return relations
      .map((r) => {
        const a = peopleById[r.from_person_id];
        const b = peopleById[r.to_person_id];
        if (!a || !b) return null;
        if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
        return {
          id: r.id,
          type: r.relation_type,
          a: { lat: a.lat, lng: a.lng, name: `${a.first_name} ${a.last_name}` },
          b: { lat: b.lat, lng: b.lng, name: `${b.first_name} ${b.last_name}` }
        };
      })
      .filter(Boolean) as Array<any>;
  }, [relations, peopleById]);

  function goHome() {
    if (!authed) return;
    safeNavigate("hub", () => {
      resetAllForms();
    });
  }

  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <div style={styles.topbarSlotLeft} />
        <button
          style={{
            ...styles.brandBtn,
            cursor: authed && view !== "login" ? "pointer" : "default",
            opacity: view === "login" ? 0.95 : 1
          }}
          onClick={() => (authed && view !== "login" ? goHome() : undefined)}
          aria-label="Släktträdet"
          title={authed && view !== "login" ? "Till Mina släktträd" : "Släktträdet"}
        >
          Släktträdet
        </button>
        <div style={styles.topbarSlotRight}>
          {authed && view !== "login" ? (
            <>
              <div style={styles.userPill} title={me?.email ?? ""}>
                {displayNameFromEmail(me?.email)}
              </div>
              <button style={styles.navBtn} onClick={logout}>
                Logga ut
              </button>
            </>
          ) : null}
        </div>
      </header>

      <main style={styles.main}>
        {view === "login" && (
          <section style={styles.card}>
            <h1 style={styles.h1}>{mode === "login" ? "Logga in" : "Skapa konto"}</h1>

            <div style={styles.row}>
              <button style={mode === "login" ? styles.tabActive : styles.tab} onClick={() => setMode("login")}>
                Logga in
              </button>
              <button style={mode === "register" ? styles.tabActive : styles.tab} onClick={() => setMode("register")}>
                Skapa konto
              </button>
            </div>

            <label style={styles.label}>
              E-post
              <input style={styles.input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="namn@exempel.se" />
            </label>

            <label style={styles.label}>
              Lösenord
              <input
                style={styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder={mode === "register" ? "minst 8 tecken" : "ditt lösenord"}
              />
            </label>

            {error && <div style={styles.error}>{error}</div>}

            <div style={{ marginTop: 18 }}>
              <button style={styles.primary} onClick={submitAuth}>
                {mode === "login" ? "Logga in" : "Skapa konto"}
              </button>
            </div>
          </section>
        )}

        {view === "hub" && (
          <section style={styles.card}>
            <div style={styles.grid2Hub}>
              <div style={{ ...styles.panel, padding: 12 }}>
                <div style={styles.panelHeader}>
                  <h2 style={styles.h2}>Karta</h2>
                  <div style={styles.smallMuted}>{activeTreeName ? `Visar: ${activeTreeName}` : "Välj en släkt till höger"}</div>
                </div>

                <div style={{ height: "clamp(380px, 60vh, 620px)", borderRadius: 14, overflow: "hidden", border: "1px solid var(--border)" }}>
                  <MapContainer center={[62.5, 15.0]} zoom={5} style={{ width: "100%", height: "100%" }} scrollWheelZoom={true}>
                    <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                    <FitBounds points={mapPoints.map((x) => ({ lat: x.lat, lng: x.lng }))} />

                    {mapLines.map((ln) => (
                      <Polyline
                        key={ln.id}
                        positions={[
                          [ln.a.lat, ln.a.lng],
                          [ln.b.lat, ln.b.lng]
                        ]}
                        pathOptions={{ color: relationColor(ln.type), weight: 3, opacity: 0.9 }}
                      >
                        <Tooltip sticky opacity={1}>
                          <div style={{ fontSize: 13 }}>
                            <div style={{ fontWeight: 700 }}>
                              {ln.a.name} — {relationLabel(ln.type)} → {ln.b.name}
                            </div>
                          </div>
                        </Tooltip>
                      </Polyline>
                    ))}

                    {mapPoints.map(({ lat, lng, person }) => {
                      const years = person.birth_year || person.death_year ? `(${person.birth_year ?? "?"}–${person.death_year ?? "?"})` : "";
                      return (
                        <CircleMarker key={person.id} center={[lat, lng]} radius={8}>
                          <Tooltip direction="top" offset={[0, -8]} opacity={1} sticky>
                            <div style={{ fontSize: 13 }}>
                              <div style={{ fontWeight: 700 }}>
                                {person.first_name} {person.last_name} {years}
                              </div>
                              {person.place_label ? <div>{person.place_label}</div> : null}
                            </div>
                          </Tooltip>
                        </CircleMarker>
                      );
                    })}
                  </MapContainer>
                </div>

                {!activeTreeId ? (
                  <div style={{ marginTop: 10 }}>
                    <div style={styles.hintBox}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>Ingen släkt vald</div>
                      <div>Välj en släkt i listan för att visa personer och relationer på kartan.</div>
                    </div>
                  </div>
                ) : null}
              </div>

              <div style={styles.panel}>
  <div style={styles.panelHeader}>
    <h2 style={styles.h2}>Mina släkter</h2>
    <div style={styles.rowTight}>
      <button
        style={styles.secondary}
        onClick={() => {
          if (!confirmLeaveIfDirty()) return;
          exportActiveTreeCsv();
        }}
        disabled={!activeTreeId}
        title={!activeTreeId ? "Välj en släkt först" : "Exportera personer och relationer"}
      >
        Exportera (CSV)
      </button>

      <button
        style={styles.secondary}
        onClick={() => {
          if (!confirmLeaveIfDirty()) return;
          setError(null);
          setImportCsvOpen((v) => !v);
          setImportPreview(null);
          setImportBusy(false);
          // Stäng andra formulär när vi öppnar import
          setImportRelOpen(false);
          setImportRelPreview(null);
          setImportRelMap({});
          setImportRelBusy(false);
          setCreateTreeOpen(false);
          setTreeName("");
          setRenamingTreeId(null);
          setRenameValue("");
        }}
      >
        {importCsvOpen ? "Stäng import personer" : "Importera personer"}
      </button>

      <button
        style={styles.secondary}
        onClick={() => {
          if (!confirmLeaveIfDirty()) return;
          setError(null);
          setImportRelOpen((v) => !v);
          setImportRelPreview(null);
          setImportRelMap({});
          setImportRelBusy(false);
          // Stäng andra formulär när vi öppnar import
          setImportCsvOpen(false);
          setImportPreview(null);
          setImportBusy(false);
          setCreateTreeOpen(false);
          setTreeName("");
          setRenamingTreeId(null);
          setRenameValue("");
        }}
        disabled={!activeTreeId}
        title={!activeTreeId ? "Välj en släkt först" : "Importera relationer via CSV"}
      >
        {importRelOpen ? "Stäng import relationer" : "Importera relationer"}
      </button>

      <button
        style={styles.secondary}
        onClick={() => {
          if (!confirmLeaveIfDirty()) return;
          setError(null);
          setCreateTreeOpen((v) => !v);
          setTreeName("");
          setRenamingTreeId(null);
          setRenameValue("");
          // stäng importpaneler
          setImportCsvOpen(false);
          setImportPreview(null);
          setImportBusy(false);
          setImportRelOpen(false);
          setImportRelPreview(null);
          setImportRelMap({});
          setImportRelBusy(false);
        }}
      >
        {createTreeOpen ? "Stäng" : "Skapa ny släkt"}
      </button>
    </div>
  </div>

  {createTreeOpen ? (
    <div style={{ marginTop: 10 }}>
      <label style={styles.label}>
        Namn på släkt
        <input
          style={styles.input}
          value={treeName}
          onChange={(e) => setTreeName(e.target.value)}
          placeholder="t.ex. Jarbrant"
        />
      </label>
      <div style={styles.row}>
        <button style={styles.primary} onClick={createTree}>
          Spara
        </button>
        <button
          style={styles.secondary}
          onClick={() => {
            if (treeName.trim() && !window.confirm("Du har osparat namn. Vill du stänga ändå?")) return;
            setCreateTreeOpen(false);
            setTreeName("");
          }}
        >
          Avbryt
        </button>
      </div>
    </div>
  ) : null}

  {importCsvOpen ? (
    <div style={{ marginTop: 10 }}>
      <div style={styles.hintBox}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Importera personer (CSV light)</div>
        <div style={{ marginBottom: 8 }}>
          CSV ska ha minst kolumnerna <strong>förnamn</strong> och <strong>efternamn</strong>. Övriga stöds: kön,
          födelseår, dödsår, platsnamn, lat, lng.
        </div>
        <div style={{ marginBottom: 10, fontSize: 12, color: "var(--muted)" }}>
          Obs: person_id i CSV ignoreras – nya ID skapas vid import.
        </div>

        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            handleImportPersonsCsv(f);
          }}
        />

        {importPreview ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Förhandsvisning</div>
            <div style={styles.smallMuted}>Hittade {importPreview.rows.length} personer att importera.</div>

            {importPreview.warnings.length ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Varningar</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {importPreview.warnings.slice(0, 8).map((w, i) => (
                    <li key={i} style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                      {w}
                    </li>
                  ))}
                </ul>
                {importPreview.warnings.length > 8 ? (
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
                    …och {importPreview.warnings.length - 8} till.
                  </div>
                ) : null}
              </div>
            ) : null}

            <div style={styles.row}>
              <button style={styles.primary} onClick={confirmImportPersons} disabled={importBusy}>
                {importBusy ? "Importerar…" : "Importera"}
              </button>
              <button
                style={styles.secondary}
                onClick={() => {
                  if (importBusy) return;
                  setImportPreview(null);
                }}
              >
                Rensa
              </button>
              <button
                style={styles.secondary}
                onClick={() => {
                  if (importBusy) return;
                  if (importPreview && !window.confirm("Stäng import? Förhandsvisningen försvinner.")) return;
                  setImportCsvOpen(false);
                  setImportPreview(null);
                }}
              >
                Stäng
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
            Välj en CSV-fil för att skapa en förhandsvisning.
          </div>
        )}
      </div>
    </div>
  ) : null}

  {importRelOpen ? (
    <div style={{ marginTop: 10 }}>
      <div style={styles.hintBox}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Importera relationer (CSV mapping)</div>
        <div style={{ marginBottom: 8 }}>
          CSV ska innehålla kolumnerna <strong>person_a</strong>, <strong>relationstyp</strong>, <strong>person_b</strong>.
          (Det matchar vår export-fil.)
        </div>

        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            handleImportRelationsCsv(f);
          }}
        />

        {importRelPreview ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Mapping</div>
            <div style={styles.smallMuted}>Matcha namnen från CSV till personer i släkten. Sedan importeras relationerna.</div>

            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              {Array.from(new Set(importRelPreview.rows.flatMap((x) => [x.aName, x.bName])))
                .sort((a, b) => a.localeCompare(b))
                .map((name) => (
                  <label key={name} style={{ ...styles.label, marginTop: 0 }}>
                    {name}
                    <select
                      style={styles.select}
                      value={importRelMap[name] ?? ""}
                      onChange={(e) => setImportRelMap((prev) => ({ ...prev, [name]: e.target.value }))}
                    >
                      <option value="">(ej matchad)</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.first_name} {p.last_name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
            </div>

            {importRelPreview.warnings.length ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Varningar</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {importRelPreview.warnings.slice(0, 8).map((w, i) => (
                    <li key={i} style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                      {w}
                    </li>
                  ))}
                </ul>
                {importRelPreview.warnings.length > 8 ? (
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
                    …och {importRelPreview.warnings.length - 8} till.
                  </div>
                ) : null}
              </div>
            ) : null}

            <div style={{ marginTop: 10 }}>
              <div style={styles.smallMuted}>Importbara relationer: {countImportableRelations()}</div>
            </div>

            <div style={styles.row}>
              <button style={styles.secondary} onClick={autoMatchRelations} disabled={importRelBusy}>
                Auto-match
              </button>
              <button style={styles.primary} onClick={confirmImportRelations} disabled={importRelBusy}>
                {importRelBusy ? "Importerar…" : "Importera"}
              </button>
              <button
                style={styles.secondary}
                onClick={() => {
                  if (importRelBusy) return;
                  setImportRelPreview(null);
                  setImportRelMap({});
                }}
              >
                Rensa
              </button>
              <button
                style={styles.secondary}
                onClick={() => {
                  if (importRelBusy) return;
                  if (importRelPreview && !window.confirm("Stäng import? Mapping försvinner.")) return;
                  setImportRelOpen(false);
                  setImportRelPreview(null);
                  setImportRelMap({});
                }}
              >
                Stäng
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
            Välj en relations-CSV för att börja.
          </div>
        )}
      </div>
    </div>
  ) : null}

                {error && <div style={styles.error}>{error}</div>}

                {trees.length === 0 ? (
                  <div style={{ marginTop: 10 }}>
                    <p style={styles.p}>Du har inga släkter ännu. Börja med att skapa din första släkt.</p>
                  </div>
                ) : (
                  <ul style={styles.list}>
                    {trees.map((t) => {
                      const isActive = activeTreeId === t.id;
                      const isRenaming = renamingTreeId === t.id;

                      return (
                        <li key={t.id} style={styles.listItem}>
                          <div style={{ minWidth: 0 }}>
                            <div style={styles.titleLine}>
                              <span style={styles.titleText}>{t.name}</span>
                              {isActive ? <span style={styles.badgeSoft}>Vald</span> : null}
                            </div>

                            {isRenaming ? (
                              <div style={{ marginTop: 8 }}>
                                <label style={{ ...styles.label, marginTop: 0 }}>
                                  Nytt namn
                                  <input
                                    style={styles.input}
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    placeholder="Skriv nytt namn…"
                                  />
                                </label>
                                <div style={styles.row}>
                                  <button style={styles.primarySmall} onClick={() => renameTree(t.id)}>
                                    Spara
                                  </button>
                                  <button
                                    style={styles.secondarySmall}
                                    onClick={() => {
                                      if (renameValue.trim() && !window.confirm("Du har osparat namn. Vill du avbryta?")) return;
                                      setRenamingTreeId(null);
                                      setRenameValue("");
                                    }}
                                  >
                                    Avbryt
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>

                          <div style={styles.rowTight}>
                            {!isRenaming ? (
                              <>
                                <button
                                  style={styles.navBtn}
                                  onClick={() => {
                                    if (!confirmLeaveIfDirty()) return;
                                    setError(null);
                                    setActiveTree(t.id);
                                  }}
                                >
                                  Visa på karta
                                </button>
                                <button
                                  style={styles.navBtn}
                                  onClick={() => {
                                    if (!confirmLeaveIfDirty()) return;
                                    setError(null);
                                    setRenamingTreeId(t.id);
                                    setRenameValue(t.name);
                                  }}
                                >
                                  Byt namn
                                </button>
                                <button style={styles.primarySmall} onClick={() => openTree(t)}>
                                  Öppna
                                </button>
                                <button style={styles.dangerBtn} onClick={() => deleteTree(t.id)}>
                                  Ta bort
                                </button>
                              </>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </section>
        )}

        {view === "people" && (
          <section style={styles.card}>
            <div style={styles.subHeader}>
              <button style={styles.backBtn} onClick={() => safeNavigate("hub", () => setPeopleSearch(""))} aria-label="Tillbaka" title="Tillbaka">
                ←
              </button>
              <div style={{ minWidth: 0 }}>
                <h1 style={{ ...styles.h1, margin: 0 }}>
                  Personer{activeTreeName ? ` – ${activeTreeName}` : ""}
                </h1>
                <div style={styles.smallMuted}>Lägg till personer och sätt plats. Relationer bygger du efter att du har minst två personer.</div>
              </div>
              <div style={{ marginLeft: "auto" }}>
                <button
                  style={styles.secondary}
                  onClick={() => {
                    if (!confirmLeaveIfDirty()) return;
                    setError(null);
                    setRelationsSearch("");
                    setView("relations");
                  }}
                  disabled={!activeTreeId}
                >
                  Relationer →
                </button>
              </div>
            </div>

            {!activeTreeId ? (
              <div style={{ marginTop: 12 }}>
                <p style={styles.p}>Du måste välja en släkt först.</p>
                <button style={styles.secondary} onClick={() => safeNavigate("hub")}>
                  Till Mina släktträd
                </button>
              </div>
            ) : (
              <div style={styles.grid2}>
                <div style={styles.panel}>
                  <h2 style={styles.h2}>{editingPersonId ? "Redigera person" : "Skapa person"}</h2>

                  <label style={styles.label}>
                    Förnamn
                    <input style={styles.input} value={pFirst} onChange={(e) => setPFirst(e.target.value)} />
                  </label>
                  <label style={styles.label}>
                    Efternamn
                    <input style={styles.input} value={pLast} onChange={(e) => setPLast(e.target.value)} />
                  </label>

                  <label style={styles.label}>
                    Kön (valfritt)
                    <select style={styles.select} value={pGender} onChange={(e) => setPGender(e.target.value)}>
                      <option value="">Välj…</option>
                      <option value="man">man</option>
                      <option value="kvinna">kvinna</option>
                    </select>
                  </label>

                  <div style={styles.row2}>
                    <label style={{ ...styles.label, marginTop: 0 }}>
                      Födelseår (valfritt)
                      <input style={styles.input} value={pBirth} onChange={(e) => setPBirth(e.target.value)} />
                    </label>
                    <label style={{ ...styles.label, marginTop: 0 }}>
                      Dödsår (valfritt)
                      <input style={styles.input} value={pDeath} onChange={(e) => setPDeath(e.target.value)} />
                    </label>
                  </div>

                  {error && <div style={styles.error}>{error}</div>}

                  <div style={styles.row}>
                    <button style={styles.primary} onClick={savePerson}>
                      {editingPersonId ? "Spara ändringar" : "Skapa person"}
                    </button>
                    <button
                      style={styles.secondary}
                      onClick={() => {
                        if (personDirty && !window.confirm("Du har osparade ändringar. Vill du rensa formuläret?")) return;
                        resetPersonForm(true);
                        setError(null);
                      }}
                    >
                      Rensa
                    </button>
                  </div>
                </div>

                <div style={styles.panel}>
                  <div style={styles.panelHeader}>
                    <h2 style={styles.h2}>Lista på personer</h2>
                  </div>

                  <label style={{ ...styles.label, marginTop: 0 }}>
                    Sök i listan
                    <input
                      style={styles.input}
                      value={peopleSearch}
                      onChange={(e) => setPeopleSearch(e.target.value)}
                      placeholder="Sök på namn…"
                    />
                  </label>

                  {filteredPeople.length === 0 ? (
                    <p style={styles.p}>{people.length === 0 ? "Inga personer ännu. Börja med att lägga till den första." : "Inga träffar."}</p>
                  ) : (
                    <ul style={styles.list}>
                      {filteredPeople.map((p) => {
                        const hasLoc = p.lat != null && p.lng != null;
                        return (
                          <li key={p.id} style={styles.listItem}>
                            <div style={{ minWidth: 0 }}>
                              <div style={styles.titleLine}>
                                <span style={styles.titleText}>
                                  {p.first_name} {p.last_name}
                                </span>
                                {editingPersonId === p.id ? <span style={styles.badgeSoft}>Redigeras</span> : null}
                              </div>
                              <div style={styles.smallMuted}>{hasLoc ? "📍 Plats satt" : "– Ingen plats"}</div>
                            </div>
                            <div style={styles.rowTight}>
                              <button style={styles.navBtn} onClick={() => startEdit(p)}>
                                Redigera
                              </button>
                              <button style={styles.navBtn} onClick={() => openMapForPerson(p.id)}>
                                Ange plats
                              </button>
                              <button style={styles.dangerBtn} onClick={() => deletePerson(p.id)}>
                                Ta bort
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {view === "relations" && (
          <section style={styles.card}>
            <div style={styles.subHeader}>
              <button style={styles.backBtn} onClick={() => safeNavigate("people", () => setRelationsSearch(""))} aria-label="Tillbaka" title="Tillbaka">
                ←
              </button>
              <div style={{ minWidth: 0 }}>
                <h1 style={{ ...styles.h1, margin: 0 }}>
                  Relationer{activeTreeName ? ` – ${activeTreeName}` : ""}
                </h1>
                <div style={styles.smallMuted}>Skapa relationer mellan personer. Linjer visas på kartan när båda har plats.</div>
                {people.length < 2 ? (
                  <div style={{ ...styles.hintBox, marginTop: 10 }}>Du behöver minst två personer för att kunna skapa relationer.</div>
                ) : null}
              </div>
            </div>

            {!activeTreeId ? (
              <div style={{ marginTop: 12 }}>
                <p style={styles.p}>Du måste välja en släkt först.</p>
                <button style={styles.secondary} onClick={() => safeNavigate("hub")}>
                  Till Mina släktträd
                </button>
              </div>
            ) : (
              <div style={styles.grid2}>
                <div style={styles.panel}>
                  <h2 style={styles.h2}>Skapa relation</h2>

                  <label style={styles.label}>
                    Person A
                    <select style={styles.select} value={relFrom} onChange={(e) => setRelFrom(e.target.value)}>
                      <option value="">Välj person…</option>
                      {people
                        .filter((p) => p.id !== relTo)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.first_name} {p.last_name}
                          </option>
                        ))}
                    </select>
                  </label>

                  <label style={styles.label}>
                    Relationstyp
                    <select style={styles.select} value={relType} onChange={(e) => setRelType(e.target.value)}>
                      {RELATION_CATALOG.map((rt) => (
                        <option key={rt.key} value={rt.key}>
                          {rt.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={styles.label}>
                    Person B
                    <select style={styles.select} value={relTo} onChange={(e) => setRelTo(e.target.value)}>
                      <option value="">Välj person…</option>
                      {people
                        .filter((p) => p.id !== relFrom)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.first_name} {p.last_name}
                          </option>
                        ))}
                    </select>
                  </label>

                  {error && <div style={styles.error}>{error}</div>}

                  <div style={styles.row}>
                    <button style={styles.primary} onClick={createRelation} disabled={people.length < 2}>
                      Skapa relation
                    </button>
                    <button
                      style={styles.secondary}
                      onClick={() => {
                        if (relationsDirty && !window.confirm("Du har osparade val. Vill du rensa formuläret?")) return;
                        resetRelationForm();
                        setError(null);
                      }}
                    >
                      Rensa
                    </button>
                  </div>
                </div>

                <div style={styles.panel}>
                  <h2 style={styles.h2}>Lista</h2>

                  <label style={{ ...styles.label, marginTop: 0 }}>
                    Sök i relationer
                    <input
                      style={styles.input}
                      value={relationsSearch}
                      onChange={(e) => setRelationsSearch(e.target.value)}
                      placeholder="Sök på namn eller typ…"
                    />
                  </label>

                  {filteredRelations.length === 0 ? (
                    <p style={styles.p}>{relations.length === 0 ? "Inga relationer ännu." : "Inga träffar."}</p>
                  ) : (
                    <ul style={styles.list}>
                      {filteredRelations.map((r) => {
                        const a = peopleById[r.from_person_id];
                        const b = peopleById[r.to_person_id];
                        const label = `${a ? `${a.first_name} ${a.last_name}` : r.from_person_id} — ${relationLabel(r.relation_type)} → ${
                          b ? `${b.first_name} ${b.last_name}` : r.to_person_id
                        }`;
                        const col = relationColor(r.relation_type);

                        return (
                          <li key={r.id} style={styles.listItem}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ width: 10, height: 10, borderRadius: 999, background: col, display: "inline-block" }} />
                                <span style={styles.titleText}>{label}</span>
                              </div>
                            </div>
                            <div style={styles.rowTight}>
                              <button style={styles.dangerBtn} onClick={() => deleteRelation(r.id)}>
                                Ta bort
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {mapModalOpen && (
          <div style={styles.modalOverlay} role="dialog" aria-modal="true" aria-label="Ange plats">
            <div style={styles.modalCard}>
              <div style={styles.modalHeader}>
                <div style={{ fontWeight: 700 }}>Ange plats</div>
                <button style={styles.navBtn} onClick={() => setMapModalOpen(false)}>
                  Stäng
                </button>
              </div>

              <div style={styles.modalMapWrap}>
                <MapContainer center={[62.5, 15.0]} zoom={5} style={{ width: "100%", height: "100%", borderRadius: 12 }} scrollWheelZoom={true}>
                  <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <MapClicker value={mapPick} onPick={setMapPick} />
                </MapContainer>
              </div>

              <label style={{ ...styles.label, marginTop: 12 }}>
                Platsnamn (valfritt)
                <input style={styles.input} value={mapPlaceLabel} onChange={(e) => setMapPlaceLabel(e.target.value)} placeholder="t.ex. Stockholm" />
              </label>

              <div style={styles.modalFooter}>
                <button style={styles.secondary} onClick={() => setMapModalOpen(false)}>
                  Bakåt
                </button>
                <button style={styles.primary} onClick={confirmMapPick}>
                  Bekräfta
                </button>
              </div>

              <div style={styles.smallMuted}>Klicka i kartan för att sätta en markör. (Lat/Lng sparas per person.)</div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    color: "var(--text)",
    background: "var(--bg)",
    minHeight: "100vh"
  },

  topbar: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    padding: "14px 18px",
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    position: "sticky",
    top: 0,
    zIndex: 9999,
    backdropFilter: "saturate(1.1) blur(6px)"
  },
  topbarSlotLeft: { minHeight: 1 },
  topbarSlotRight: { display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center" },

  brandBtn: {
    border: "none",
    background: "transparent",
    fontWeight: 900,
    letterSpacing: 0.3,
    fontSize: 16,
    padding: "6px 10px",
    borderRadius: 12
  },

  userPill: {
    border: "1px solid var(--border)",
    background: "var(--surface)",
    padding: "8px 10px",
    borderRadius: 999,
    boxShadow: "var(--shadow-xs)",
    fontSize: 13,
    color: "var(--muted)"
  },

  navBtn: {
    border: "1px solid var(--border)",
    background: "var(--surface)",
    padding: "8px 10px",
    borderRadius: 12,
    cursor: "pointer",
    boxShadow: "var(--shadow-xs)"
  },

  main: { maxWidth: 1120, margin: "0 auto", padding: 18 },
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 16, boxShadow: "var(--shadow-md)" },
  panel: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 14, minWidth: 0, boxShadow: "var(--shadow-xs)" },

  panelHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 },

  subHeader: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },

  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 14,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    cursor: "pointer",
    fontSize: 18,
    boxShadow: "var(--shadow-xs)"
  },

  h1: { fontSize: 22, margin: "0 0 8px 0", letterSpacing: -0.2 },
  h2: { fontSize: 16, margin: "0 0 10px 0", letterSpacing: -0.1 },
  p: { margin: "0 0 10px 0", lineHeight: 1.55, color: "var(--text)" },

  row: { display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" },
  rowTight: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  row2: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginTop: 10 },
  grid2: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 },
  grid2Hub: { display: "grid", gridTemplateColumns: "1.25fr 0.9fr", gap: 12 },

  tab: { border: "1px solid var(--border)", background: "var(--surface)", padding: "8px 10px", borderRadius: 12, cursor: "pointer", boxShadow: "var(--shadow-xs)" },
  tabActive: {
    border: "1px solid var(--primary)",
    background: "var(--primary)",
    color: "#fff",
    padding: "8px 10px",
    borderRadius: 12,
    cursor: "pointer",
    boxShadow: "var(--shadow-sm)"
  },

  label: { display: "block", fontSize: 13, marginTop: 10, color: "var(--muted)" },
  input: { width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 12, border: "1px solid var(--border)", marginTop: 6, background: "var(--surface)", color: "var(--text)" },
  select: { width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 12, border: "1px solid var(--border)", marginTop: 6, background: "var(--surface)", color: "var(--text)" },

  primary: { border: "1px solid var(--primary)", background: "var(--primary)", color: "#fff", padding: "10px 12px", borderRadius: 14, cursor: "pointer", boxShadow: "var(--shadow-sm)" },
  primarySmall: { border: "1px solid var(--primary)", background: "var(--primary)", color: "#fff", padding: "8px 10px", borderRadius: 12, cursor: "pointer", boxShadow: "var(--shadow-sm)" },
  secondary: { border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", padding: "10px 12px", borderRadius: 14, cursor: "pointer", boxShadow: "var(--shadow-xs)" },
  secondarySmall: { border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", padding: "8px 10px", borderRadius: 12, cursor: "pointer", boxShadow: "var(--shadow-xs)" },

  dangerBtn: { border: "1px solid #ffd0d0", background: "#fff1f1", padding: "8px 10px", borderRadius: 12, cursor: "pointer" },

  error: { marginTop: 10, padding: 10, borderRadius: 12, background: "#fff1f1", border: "1px solid #ffd0d0" },

  smallMuted: { marginTop: 6, fontSize: 12, color: "var(--muted)" },

  list: { listStyle: "none", padding: 0, margin: "10px 0 0 0", display: "flex", flexDirection: "column", gap: 10 },
  listItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 12,
    background: "var(--surface)",
    gap: 10,
    boxShadow: "var(--shadow-xs)"
  },
  titleLine: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  titleText: { fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  badgeSoft: { fontSize: 12, border: "1px solid var(--border)", borderRadius: 999, padding: "2px 8px", color: "var(--muted)", background: "var(--surface-2)" },

  hintBox: { border: "1px dashed var(--border)", borderRadius: 14, padding: 12, background: "var(--surface-2)", color: "var(--muted)" },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.42)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 },
  modalCard: { width: "min(920px, 96vw)", background: "var(--surface)", borderRadius: 18, border: "1px solid var(--border)", padding: 14, boxShadow: "var(--shadow-lg)" },
  modalHeader: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  modalMapWrap: { marginTop: 12, width: "100%", height: "420px", borderRadius: 14, overflow: "hidden", border: "1px solid var(--border)" },
  modalFooter: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 12 }
};
