import { cacheGet, cacheSet } from "../_redis.js";
import { applyRateLimit } from "../_rate-limit.js";

// Pencocokan AIS-SAR di ZEE Indonesia: kapal yang terlihat di citra radar satelit (Sentinel-1), dipisah antara
// yang COCOK dengan AIS (punya identitas) dan yang TIDAK cocok (tidak terlacak AIS, "dark vessel").
// Sumber: dataset "SAR Vessel Detections" Global Fishing Watch (4Wings report, filter matched).
// Metode deteksi dan pencocokan dengan AIS: Paolo dkk. (2024), "Satellite mapping reveals extensive industrial
// activity at sea", Nature 625:85-91, doi:10.1038/s41586-023-06825-8.
// Catatan: data GFW tersedia sampai kira-kira 5 hari yang lalu, posisinya per kotak 0,01 derajat (±1 km), dan
// deteksi yang tidak cocok dengan AIS tidak punya identitas kapal.

const GFW_REPORT = "https://gateway.api.globalfishingwatch.org/v3/4wings/report";
const DATASET = "public-global-sar-presence:latest";
const REGION = { dataset: "public-eez-areas", id: 8492 }; // ZEE Indonesia
const DATA_DELAY_DAYS = 5;   // hari terakhir yang tersedia = hari ini - 5
const DEFAULT_DAYS = 30;
const MAX_DAYS = 62;
const CACHE_TTL_SECONDS = 6 * 60 * 60;
const CDN_CACHE = "public, max-age=600, s-maxage=3600, stale-while-revalidate=43200";
const CDN_CACHE_STALE = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && isoDay(ms) === value ? ms : null;
}

// Rentang tanggal [start, end): "end" tidak ikut dihitung, sama seperti date-range di API GFW.
function resolveRange(query) {
  const today = Date.parse(`${isoDay(Date.now())}T00:00:00Z`);
  const maxEnd = today - (DATA_DELAY_DAYS - 1) * DAY_MS;
  let end = query.end ? parseDay(query.end) : maxEnd;
  let start = query.start ? parseDay(query.start) : null;
  if (end === null || (query.start && start === null)) return { error: "start/end harus berformat YYYY-MM-DD" };
  if (end > maxEnd) end = maxEnd;
  if (start === null) start = end - DEFAULT_DAYS * DAY_MS;
  if (start >= end) return { error: "start harus sebelum end" };
  if ((end - start) / DAY_MS > MAX_DAYS) return { error: `rentang paling lama ${MAX_DAYS} hari` };
  return { start: isoDay(start), end: isoDay(end), lastDay: isoDay(end - DAY_MS) };
}

async function fetchReport(token, { range, matched }) {
  const url = new URL(GFW_REPORT);
  url.searchParams.set("spatial-resolution", "HIGH");
  url.searchParams.set("temporal-resolution", "DAILY");
  if (matched) url.searchParams.set("group-by", "VESSEL_ID"); // satu baris per kapal, lengkap dengan identitasnya
  url.searchParams.set("datasets[0]", DATASET);
  url.searchParams.set("date-range", range);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("filters[0]", `matched='${matched}'`);

  // GFW hanya mengizinkan satu laporan berjalan per token; kalau masih sibuk (429), tunggu sebentar lalu coba lagi.
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ region: REGION }),
    });
    if (res.status !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, 2500 * (attempt + 1)));
  }
  if (!res.ok) throw new Error(`GFW SAR report gagal: ${res.status}`);
  const json = await res.json();
  const rows = (json?.entries ?? []).flatMap((entry) => Object.values(entry).flat())
    .filter((row) => row && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon)));
  return { rows, truncated: json?.nextOffset != null };
}

const count = (row) => Number(row.detections) || 1;
const sumDetections = (rows) => rows.reduce((sum, row) => sum + count(row), 0);
const round2 = (value) => Math.round(Number(value) * 100) / 100;

async function buildPayload(token, range) {
  const dateRange = `${range.start},${range.end}`;
  // Berurutan, bukan bersamaan (lihat batas satu laporan per token di fetchReport).
  const unmatched = await fetchReport(token, { range: dateRange, matched: false });
  const matched = await fetchReport(token, { range: dateRange, matched: true });

  const days = [...new Set([...unmatched.rows, ...matched.rows].map((row) => row.date))].sort();
  const dayIndex = new Map(days.map((day, index) => [day, index]));

  // Identitas kapal disimpan sekali per kapal; tiap titik hanya menunjuk nomor urutnya.
  const vessels = [];
  const vesselIndex = new Map();
  const vesselOf = (row) => {
    const key = row.vesselId || `${row.mmsi}|${row.shipName}`;
    if (!vesselIndex.has(key)) {
      vesselIndex.set(key, vessels.length);
      vessels.push([row.shipName || "", row.mmsi || "", row.flag || "", row.vesselType || ""]);
    }
    return vesselIndex.get(key);
  };

  return {
    region: "ZEE Indonesia",
    ...range,
    source: {
      provider: "Global Fishing Watch",
      dataset: DATASET,
      satellite: "Sentinel-1 (radar)",
      method: "Paolo dkk. (2024), Nature 625:85-91, doi:10.1038/s41586-023-06825-8",
    },
    days,
    // titik = [lintang, bujur, indeks hari di "days", jumlah deteksi di kotak ±1 km itu pada hari tersebut]
    unmatched: {
      total: sumDetections(unmatched.rows),
      points: unmatched.rows.map((row) => [round2(row.lat), round2(row.lon), dayIndex.get(row.date), count(row)]),
    },
    // kapal = [nama, MMSI, bendera, jenis]; titik = [..., nomor urut kapal di "vessels"]
    matched: {
      total: sumDetections(matched.rows),
      vessels,
      points: matched.rows.map((row) => [round2(row.lat), round2(row.lon), dayIndex.get(row.date), count(row), vesselOf(row)]),
    },
    truncated: unmatched.truncated || matched.truncated,
  };
}

export default async function handler(req, res) {
  const range = resolveRange(req.query || {});
  if (range.error) return res.status(400).json({ error: range.error });

  const allowed = await applyRateLimit(req, res, { name: "gfw-sar-ais", limit: 30, windowSeconds: 10 * 60 });
  if (!allowed) return;

  const key = `gfw:sar-ais:v1:${range.start}:${range.end}`;
  const cached = await cacheGet(key);
  if (cached?.payload) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", CDN_CACHE);
    return res.json({ ...cached.payload, fetchedAt: new Date(cached.fetchedAt).toISOString() });
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ error: "GFW_TOKEN not configured" });

  try {
    const payload = await buildPayload(token, range);
    const fetchedAt = Date.now();
    await cacheSet(key, { payload, fetchedAt }, CACHE_TTL_SECONDS);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", CDN_CACHE);
    res.json({ ...payload, fetchedAt: new Date(fetchedAt).toISOString() });
  } catch (error) {
    res.setHeader("cache-control", CDN_CACHE_STALE);
    res.status(502).json({ error: error?.message || "GFW SAR gagal" });
  }
}
