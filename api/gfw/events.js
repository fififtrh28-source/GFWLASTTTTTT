import { cacheGet, cacheSet } from "../_redis.js";
import { applyRateLimit } from "../_rate-limit.js";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_EVENT_DATASETS = [
  "public-global-fishing-events:latest",
  "public-global-encounters-events:latest",
  "public-global-loitering-events:latest",
];
// Hanya event di ZEE Indonesia (id 8492 di dataset public-eez-areas GFW), bukan kotak lintang/bujur
// yang ikut mencakup perairan Malaysia/Singapura.
// PENTING: GFW hanya menerapkan batas wilayah ini kalau satu permintaan berisi SATU dataset. Kalau beberapa dataset
// dikirim sekaligus, batas wilayahnya diabaikan dan yang datang adalah event seluruh dunia. Karena itu tiap
// dataset diminta sendiri-sendiri (fetchDataset) lalu hasilnya digabung.
const INDONESIA_EEZ = { dataset: "public-eez-areas", id: 8492 };
const INDONESIA_EEZ_ID = String(INDONESIA_EEZ.id);

const FRESH_TTL_SECONDS = 10 * 60;
const STALE_TTL_SECONDS = 6 * 60 * 60;
// Cache CDN Vercel: segar 1 jam, lalu tetap disajikan langsung (maks. 1 hari) sambil diperbarui di belakang.
// Data GFW sendiri baru berubah kira-kira sekali sehari (jeda ~72 jam), jadi pengunjung tidak perlu menunggu.
const CDN_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
const CDN_CACHE_STALE = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";
// 700 event terbaru di ZEE Indonesia dari ketiga jenis (sekitar 1,5–2 hari data GFW).
const MAX_EVENTS = 700;

function toIsoDate(date) {
  return date.includes("T") ? date : `${date}T00:00:00Z`;
}

function cacheKey(start, end) {
  return `gfw:events:idn-eez:v5:${MAX_EVENTS}:${start}:${end}:fishing-encounter-loitering`;
}

// Event terbaru satu dataset di ZEE Indonesia.
async function fetchDataset(token, dataset, start, end) {
  const url = new URL(`${GFW_BASE}/events`);
  url.searchParams.set("limit", String(MAX_EVENTS));
  url.searchParams.set("offset", "0");
  url.searchParams.set("sort", "-start");

  const gfwRes = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      datasets: [dataset],
      startDate: toIsoDate(start),
      endDate: toIsoDate(end),
      region: INDONESIA_EEZ,
      vesselTypes: ["FISHING"],
    }),
  });

  if (!gfwRes.ok) {
    const text = await gfwRes.text().catch(() => "");
    console.error(`[gfw] error ${gfwRes.status} (${dataset}): ${text.slice(0, 200)}`);
    throw new Error(`GFW ${gfwRes.status}: ${text.slice(0, 200)}`);
  }
  const json = await gfwRes.json();
  return json?.entries ?? [];
}

function cacheEnvelope(payload) {
  return {
    payload,
    fetchedAt: Date.now(),
  };
}

function isFresh(entry) {
  return entry?.payload && Date.now() - Number(entry.fetchedAt || 0) < FRESH_TTL_SECONDS * 1000;
}

export default async function handler(req, res) {
  const start = req.query.start_date || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const end = req.query.end_date || new Date().toISOString().slice(0, 10);

  const allowed = await applyRateLimit(req, res, {
    name: "gfw-events",
    limit: 20,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const key = cacheKey(start, end);
  const cached = await cacheGet(key);
  if (isFresh(cached)) {
    const payload = {
      ...cached.payload,
      events: (cached.payload.events || []).slice(0, MAX_EVENTS),
    };
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", CDN_CACHE);
    res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
    return res.json(payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ events: [], error: "GFW_TOKEN not configured" });

  try {
    console.log(`[gfw] fetching ${start} -> ${end} ...`);
    const t0 = Date.now();

    const lists = await Promise.all(GFW_EVENT_DATASETS.map((dataset) => fetchDataset(token, dataset, start, end)));
    // Pengaman: apa pun jawaban GFW, yang diteruskan hanya event yang memang tercatat di ZEE Indonesia.
    const data = lists.flat()
      .filter((event) => (event?.regions?.eez ?? []).map(String).includes(INDONESIA_EEZ_ID))
      .sort((x, y) => String(y.start).localeCompare(String(x.start)))
      .slice(0, MAX_EVENTS);
    console.log(`[gfw] OK - ${data.length} events (${Date.now() - t0}ms)`);

    const payload = { events: data };
    await cacheSet(key, cacheEnvelope(payload), STALE_TTL_SECONDS);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", CDN_CACHE);
    res.json(payload);
  } catch (e) {
    console.error("[gfw] catch:", e?.message);
    if (cached?.payload) {
      res.setHeader("x-cache", "STALE");
      res.setHeader("cache-control", CDN_CACHE_STALE);
      res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
      return res.json({
        ...cached.payload,
        events: (cached.payload.events || []).slice(0, MAX_EVENTS),
        warning: "Serving stale GFW data because live fetch failed",
      });
    }
    res.setHeader("cache-control", "no-store");
    res.status(500).json({ events: [], error: e?.message || "events failed" });
  }
}
