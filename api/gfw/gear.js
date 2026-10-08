import { cacheGet, cacheSet } from "../_redis.js";
import { applyRateLimit } from "../_rate-limit.js";

// Alat tangkap per kapal dari database identitas kapal GFW (combinedSourcesInfo.geartypes).
// Ini perkiraan GFW (gabungan registrasi + model dari pola gerak AIS), bukan data izin resmi.
// POST { ids: [vesselId, ...] }  →  { gear: { [vesselId]: { name, source, yearFrom, yearTo } | null } }

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_IDENTITY_DATASET = "public-global-vessel-identity:latest";
const MAX_IDS = 1000;
const GFW_BATCH = 100;
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const VESSEL_ID_RE = /^[0-9a-f-]{20,64}$/i;

function cacheKey(id) {
  return `gfw:gear:v1:${id}`;
}

function readIds(req) {
  let raw = req.body?.ids ?? req.query?.ids ?? [];
  if (typeof raw === "string") raw = raw.split(",");
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((id) => String(id).trim()).filter((id) => VESSEL_ID_RE.test(id)))].slice(0, MAX_IDS);
}

// Pilih info sumber yang memuat vesselId ini, lalu alat tangkap dengan tahun berlaku paling akhir.
function pickGear(entry, id) {
  const sources = entry?.combinedSourcesInfo || [];
  const info = sources.find((s) => s.vesselId === id) || sources[0];
  const gears = info?.geartypes || [];
  if (!gears.length) return null;
  const latest = gears.reduce((a, b) => (Number(b.yearTo) > Number(a.yearTo) ? b : a));
  return { name: latest.name, source: latest.source, yearFrom: latest.yearFrom, yearTo: latest.yearTo };
}

function entryIds(entry) {
  return [
    ...(entry?.combinedSourcesInfo || []).map((s) => s.vesselId),
    ...(entry?.selfReportedInfo || []).map((s) => s.id),
  ].filter(Boolean);
}

async function fetchGearBatch(ids, token) {
  const url = new URL(`${GFW_BASE}/vessels`);
  url.searchParams.set("datasets[0]", GFW_IDENTITY_DATASET);
  ids.forEach((id, i) => url.searchParams.set(`ids[${i}]`, id));

  const gfwRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!gfwRes.ok) throw new Error(`GFW vessels ${gfwRes.status}`);
  const json = await gfwRes.json();

  const wanted = new Set(ids);
  const found = {};
  for (const entry of json?.entries ?? []) {
    for (const id of entryIds(entry)) {
      if (wanted.has(id) && !(id in found)) found[id] = pickGear(entry, id);
    }
  }
  return found;
}

export default async function handler(req, res) {
  const ids = readIds(req);
  if (!ids.length) return res.json({ gear: {} });

  const allowed = await applyRateLimit(req, res, {
    name: "gfw-gear",
    limit: 30,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const gear = {};
  const cached = await Promise.all(ids.map((id) => cacheGet(cacheKey(id))));
  const missing = [];
  ids.forEach((id, i) => {
    if (cached[i]) gear[id] = cached[i].gear;
    else missing.push(id);
  });

  if (missing.length) {
    const token = process.env.GFW_TOKEN;
    if (!token) return res.status(500).json({ gear, error: "GFW_TOKEN not configured" });

    try {
      for (let i = 0; i < missing.length; i += GFW_BATCH) {
        const batch = missing.slice(i, i + GFW_BATCH);
        const found = await fetchGearBatch(batch, token);
        await Promise.all(batch.map((id) => {
          gear[id] = found[id] ?? null;
          return cacheSet(cacheKey(id), { gear: gear[id] }, CACHE_TTL_SECONDS);
        }));
      }
    } catch (e) {
      console.error("[gfw gear]", e?.message);
      return res.json({ gear, warning: e?.message || "gear lookup failed" });
    }
  }

  res.setHeader("cache-control", "private, max-age=600");
  res.json({ gear });
}
