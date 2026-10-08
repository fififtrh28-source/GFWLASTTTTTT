// Riwayat posisi AIS di SQLite (modul node:sqlite bawaan Node.js 22.13+), untuk playback dan model H5.
// File: AIS_HISTORY_DB (default .local-dev/ais-history.sqlite), disimpan AIS_HISTORY_DAYS hari (default 7).
//
// Kepadatan: satu titik per kapal paling cepat tiap 2 menit saat bergerak, tiap 10 menit saat diam (< 0,5 kn).
// Model H5 nanti mengambil ulang per ~10 menit supaya sama dengan data latihannya (GFW AIS track).
// Waktu (ts) = detik UTC saat pesan diterima server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as identity from "./vessel-identity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOVING_INTERVAL_S = 120;
const STOPPED_INTERVAL_S = 600;
const STOPPED_KN = 0.5;
const FLUSH_INTERVAL_MS = 5000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const STATS_TTL_MS = 30_000;

let db = null;
let insertPosition = null;
let upsertVessel = null;
let timers = [];
let lastError = null;
let dbFile = null;
let statsCache = null;
const pendingPositions = [];
const pendingVessels = new Map();
const lastStoredTs = new Map();

function retentionDays() {
  const n = Number(process.env.AIS_HISTORY_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export async function open() {
  if (db) return;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    dbFile = path.resolve(ROOT, process.env.AIS_HISTORY_DB || path.join(".local-dev", "ais-history.sqlite"));
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    db = new DatabaseSync(dbFile);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS positions (
        mmsi INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        speed REAL,
        course REAL,
        heading REAL,
        nav_status INTEGER,
        PRIMARY KEY (mmsi, ts)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS positions_ts ON positions (ts);
      CREATE TABLE IF NOT EXISTS vessels (
        mmsi INTEGER PRIMARY KEY,
        name TEXT,
        ship_type INTEGER,
        class_b INTEGER NOT NULL DEFAULT 0,
        destination TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
    insertPosition = db.prepare(
      "INSERT OR IGNORE INTO positions (mmsi, ts, lat, lon, speed, course, heading, nav_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    upsertVessel = db.prepare(`
      INSERT INTO vessels (mmsi, name, ship_type, class_b, destination, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (mmsi) DO UPDATE SET
        name = COALESCE(NULLIF(excluded.name, ''), vessels.name),
        ship_type = COALESCE(excluded.ship_type, vessels.ship_type),
        class_b = MAX(vessels.class_b, excluded.class_b),
        destination = COALESCE(excluded.destination, vessels.destination),
        last_seen = MAX(vessels.last_seen, excluded.last_seen)
    `);
    timers = [setInterval(flush, FLUSH_INTERVAL_MS), setInterval(prune, PRUNE_INTERVAL_MS)];
    for (const timer of timers) timer.unref?.();
    prune();
    identity.start(db);
    lastError = null;
    console.log(`[ais-history] menyimpan riwayat AIS ke ${dbFile} (${retentionDays()} hari)`);
  } catch (err) {
    db = null;
    lastError = err?.message || String(err);
    console.error("[ais-history] riwayat AIS tidak aktif:", lastError);
  }
}

// Dipanggil relay setiap ada posisi baru; disimpan hanya jika jeda dari titik terakhir sudah cukup.
export function recordPosition(ship, receivedAt) {
  if (!db) return;
  const ts = Math.floor(receivedAt / 1000);
  const prev = lastStoredTs.get(ship.mmsi);
  const minGap = ship.speed != null && ship.speed < STOPPED_KN ? STOPPED_INTERVAL_S : MOVING_INTERVAL_S;
  if (prev != null && ts - prev < minGap) return;
  lastStoredTs.set(ship.mmsi, ts);
  pendingPositions.push([ship.mmsi, ts, ship.lat, ship.lon, ship.speed, ship.course, ship.heading, ship.navStatus]);
  pendingVessels.set(ship.mmsi, ship);
}

// Dipanggil relay saat data statis (nama, jenis kapal, tujuan) diterima.
export function recordVessel(ship) {
  if (db) pendingVessels.set(ship.mmsi, ship);
}

function flush() {
  if (!db || (!pendingPositions.length && !pendingVessels.size)) return;
  const positions = pendingPositions.splice(0);
  const vessels = [...pendingVessels.values()];
  pendingVessels.clear();
  const now = Math.floor(Date.now() / 1000);
  try {
    db.exec("BEGIN");
    for (const row of positions) insertPosition.run(...row);
    for (const ship of vessels) {
      const seen = ship.lastSeenAt ? Math.floor(ship.lastSeenAt / 1000) : now;
      upsertVessel.run(ship.mmsi, ship.name || "", ship.shipType ?? null, ship.classB ? 1 : 0, ship.destination ?? null, seen, seen);
    }
    db.exec("COMMIT");
    lastError = null;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    lastError = err?.message || String(err);
    console.error("[ais-history] gagal menyimpan:", lastError);
  }
}

function prune() {
  if (!db) return;
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays() * 86400;
  try {
    db.prepare("DELETE FROM positions WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM vessels WHERE last_seen < ?").run(cutoff);
    for (const [mmsi, ts] of lastStoredTs) if (ts < cutoff) lastStoredTs.delete(mmsi);
  } catch (err) {
    lastError = err?.message || String(err);
    console.error("[ais-history] gagal menghapus data lama:", lastError);
  }
}

// Ringkasan untuk /api/ais/status (di-cache 30 detik supaya tidak menghitung ulang tiap permintaan).
export function stats() {
  if (!db) return { enabled: false, error: lastError };
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.value;
  try {
    const p = db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM positions").get();
    const vessels = db.prepare("SELECT COUNT(DISTINCT mmsi) AS n FROM positions").get();
    const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
    const value = {
      enabled: true,
      error: lastError,
      positions: p.n,
      vessels: vessels.n,
      oldest: iso(p.oldest),
      newest: iso(p.newest),
      retentionDays: retentionDays(),
      fileMB: Math.round((fs.statSync(dbFile).size / 1048576) * 10) / 10,
      identity: identity.stats(),
    };
    statsCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    return { enabled: true, error: err?.message || String(err) };
  }
}

export function close() {
  flush();
  identity.stop();
  for (const timer of timers) clearInterval(timer);
  timers = [];
  try { db?.close(); } catch {}
  db = null;
}
