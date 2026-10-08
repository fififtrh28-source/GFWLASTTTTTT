import { cacheGet, cacheSet } from "./_redis.js";
import { applyRateLimit } from "./_rate-limit.js";
import { decodeGrib2 } from "./_grib2.js";

// Angin permukaan (10 m) seluruh dunia untuk animasi angin di tab AIS Live.
// GET  →  { source, run, fetchedAt, grid: { la1, lo1, dx, dy, nx, ny }, hours: [{ time, u: [...], v: [...] }] }
// u/v dalam m/s, urut baris utara→selatan dan tiap baris barat→timur (susunan yang dipakai leaflet-velocity).
//
// Sumber: model cuaca GFS dari NOAA/NCEP, grid 1° (360 × 181 titik). Data pemerintah AS, bebas dipakai.
// GFS dijalankan tiap 6 jam (00/06/12/18 UTC) dan baru terbit ±4–5 jam kemudian, dengan prakiraan tiap 3 jam.
// Yang diambil: run terbaru yang sudah terbit, pada jam prakiraan yang paling dekat dengan waktu sekarang.

const HOUR = 3600 * 1000;
const CACHE_KEY = "wind:gfs:1p00:v1";
const CACHE_TTL_SECONDS = 12 * 60 * 60;   // disimpan lama supaya masih ada cadangan kalau NOAA sedang bermasalah
const FRESH_MS = 60 * 60 * 1000;          // tapi dicoba diperbarui tiap jam
const CDN_CACHE = "public, max-age=600, s-maxage=1800, stale-while-revalidate=10800";

const pad = (n, w = 2) => String(n).padStart(w, "0");

function runParts(runMs) {
  const d = new Date(runMs);
  return { ymd: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`, hh: pad(d.getUTCHours()) };
}

// Jalur 1: NOMADS (NOAA) — server memotongkan file-nya, cukup satu permintaan.
async function fromNomads(runMs, fh) {
  const { ymd, hh } = runParts(runMs);
  const url =
    "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl" +
    `?file=gfs.t${hh}z.pgrb2.1p00.f${pad(fh, 3)}&lev_10_m_above_ground=on&var_UGRD=on&var_VGRD=on` +
    `&dir=%2Fgfs.${ymd}%2F${hh}%2Fatmos`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`NOMADS ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Jalur 2 (cadangan): salinan resmi GFS di AWS — baca indeksnya, lalu ambil hanya bagian angin 10 m.
async function fromAws(runMs, fh) {
  const { ymd, hh } = runParts(runMs);
  const base = `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.${ymd}/${hh}/atmos/gfs.t${hh}z.pgrb2.1p00.f${pad(fh, 3)}`;
  const idxRes = await fetch(`${base}.idx`, { signal: AbortSignal.timeout(20000) });
  if (!idxRes.ok) throw new Error(`AWS idx ${idxRes.status}`);
  const lines = (await idxRes.text()).split("\n");
  const u = lines.findIndex((l) => l.includes(":UGRD:10 m above ground:"));
  const v = lines.findIndex((l) => l.includes(":VGRD:10 m above ground:"));
  if (u < 0 || v < 0) throw new Error("AWS idx: angin 10 m tidak ditemukan");
  const offset = (i) => Number(lines[i]?.split(":")[1]);
  const start = offset(Math.min(u, v));
  const end = offset(Math.max(u, v) + 1); // awal pesan berikutnya
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("AWS idx: posisi tidak terbaca");
  const r = await fetch(base, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`AWS ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function toPayload(bytes, runMs, fh) {
  const msgs = decodeGrib2(bytes);
  const U = msgs.find((m) => m.category === 2 && m.number === 2);
  const V = msgs.find((m) => m.category === 2 && m.number === 3);
  if (!U || !V) throw new Error("GFS: komponen angin U/V tidak lengkap");
  // leaflet-velocity menganggap baris pertama paling utara dan bujur bertambah ke timur (scan mode 0).
  if (U.scanMode !== 0 || U.la1 < U.la2 || U.nx !== V.nx || U.ny !== V.ny) throw new Error("GFS: susunan grid tidak sesuai");
  const round = (a) => Array.from(a, (x) => Math.round(x * 10) / 10);
  return {
    source: "NOAA GFS",
    run: new Date(runMs).toISOString(),
    fetchedAt: Date.now(),
    grid: { la1: U.la1, lo1: U.lo1, dx: U.dx, dy: U.dy, nx: U.nx, ny: U.ny },
    hours: [{ time: new Date(runMs + fh * HOUR).toISOString(), u: round(U.values), v: round(V.values) }],
  };
}

async function fetchWind() {
  const now = Date.now();
  const latestRun = Math.floor(now / (6 * HOUR)) * 6 * HOUR;
  let lastError = null;
  for (let back = 0; back < 5; back++) {
    const runMs = latestRun - back * 6 * HOUR;
    const fh = Math.max(0, Math.round((now - runMs) / (3 * HOUR)) * 3);
    for (const source of [fromNomads, fromAws]) {
      try {
        return toPayload(await source(runMs, fh), runMs, fh);
      } catch (e) {
        lastError = e; // run ini belum terbit (404) atau sumbernya bermasalah → coba jalur/run berikutnya
      }
    }
  }
  throw lastError || new Error("GFS tidak tersedia");
}

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, { name: "wind", limit: 60, windowSeconds: 10 * 60 });
  if (!allowed) return;

  const cached = await cacheGet(CACHE_KEY);
  if (cached?.hours?.length && Date.now() - cached.fetchedAt < FRESH_MS) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", CDN_CACHE);
    return res.json(cached);
  }

  try {
    const payload = await fetchWind();
    await cacheSet(CACHE_KEY, payload, CACHE_TTL_SECONDS);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", CDN_CACHE);
    res.json(payload);
  } catch (e) {
    console.error("[wind]", e?.message);
    if (cached?.hours?.length) {
      res.setHeader("x-cache", "STALE");
      res.setHeader("cache-control", "public, max-age=300, s-maxage=300");
      return res.json(cached);
    }
    res.setHeader("cache-control", "no-store");
    res.status(502).json({ hours: [], error: e?.message || "wind failed" });
  }
}
