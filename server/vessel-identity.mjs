// Identitas kapal AIS dari database identitas kapal GFW (jenis kapal, gear, bendera), disimpan di
// tabel vessel_identity pada database riwayat AIS. Dipakai untuk mengenali kapal ikan:
// kapal ikan = jenis AIS 30 ATAU jenis menurut GFW = FISHING (view fishing_vessels).
//
// Tiap menit mengambil kapal yang belum/perlu dicek ulang, 8 MMSI per permintaan (where ssvid=.. OR ..).
// Batas aman 3.000 permintaan/hari (batas GFW 50.000/hari). Butuh GFW_TOKEN.
// Data GFW berlisensi CC BY-NC 4.0 (non-komersial) dan wajib atribusi "Powered by Global Fishing Watch".

const GFW_SEARCH_URL = "https://gateway.api.globalfishingwatch.org/v3/vessels/search";
const GFW_IDENTITY_DATASET = "public-global-vessel-identity:latest";
const RUN_INTERVAL_MS = 60_000;
const BATCH_SIZE = 8;
const BATCHES_PER_RUN = 5;
const DAILY_REQUEST_LIMIT = 3000;
const RECHECK_FOUND_S = 30 * 86400;
const RECHECK_MISSING_S = 7 * 86400;

let db = null;
let timer = null;
let running = false;
let lastError = null;
let requestDay = "";
let requestsToday = 0;

// MMSI kapal: 9 digit dengan kode negara (MID) 2xx–7xx. Stasiun pantai, AtoN, dan SART dilewati.
function isShipMmsi(mmsi) {
  return Number.isInteger(mmsi) && mmsi >= 200_000_000 && mmsi <= 799_999_999;
}

function latest(items) {
  if (!items?.length) return null;
  return items.reduce((a, b) => (Number(b.yearTo) > Number(a.yearTo) ? b : a));
}

// Ringkas satu entri hasil pencarian GFW menjadi baris identitas.
function summarize(entry) {
  const self = entry?.selfReportedInfo?.[0] || {};
  const combined = (entry?.combinedSourcesInfo || []).find((c) => c.shiptypes?.length || c.geartypes?.length) || {};
  const ship = latest(combined.shiptypes);
  const gear = latest(combined.geartypes);
  return {
    vesselId: self.id || combined.vesselId || null,
    name: self.shipname || null,
    flag: self.flag || null,
    shiptype: ship?.name || null,
    geartype: gear?.name || null,
    gearSource: gear?.source || null,
  };
}

function budgetLeft() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== requestDay) {
    requestDay = today;
    requestsToday = 0;
  }
  return DAILY_REQUEST_LIMIT - requestsToday;
}

async function lookupBatch(mmsis, token) {
  const url = new URL(GFW_SEARCH_URL);
  url.searchParams.set("datasets[0]", GFW_IDENTITY_DATASET);
  url.searchParams.set("where", mmsis.map((m) => `ssvid="${m}"`).join(" OR "));
  url.searchParams.set("limit", "50");
  requestsToday++;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GFW vessels/search ${res.status}`);
  const json = await res.json();

  // Satu MMSI bisa punya beberapa entri; pakai entri pertama yang punya jenis kapal.
  const found = new Map();
  for (const entry of json?.entries ?? []) {
    const ssvid = Number(entry?.selfReportedInfo?.[0]?.ssvid);
    if (!mmsis.includes(ssvid)) continue;
    const info = summarize(entry);
    const prev = found.get(ssvid);
    if (!prev || (!prev.shiptype && info.shiptype)) found.set(ssvid, info);
  }
  return found;
}

async function run() {
  const token = String(process.env.GFW_TOKEN || "").trim();
  if (!db || running || !token) return;
  running = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const todo = db.prepare(`
      SELECT v.mmsi FROM vessels v
      LEFT JOIN vessel_identity i ON i.mmsi = v.mmsi
      WHERE i.mmsi IS NULL
         OR (i.found = 1 AND i.checked_at < ?)
         OR (i.found = 0 AND i.checked_at < ?)
      ORDER BY v.last_seen DESC
      LIMIT ?
    `).all(now - RECHECK_FOUND_S, now - RECHECK_MISSING_S, BATCH_SIZE * BATCHES_PER_RUN * 2)
      .map((r) => Number(r.mmsi))
      .filter(isShipMmsi)
      .slice(0, BATCH_SIZE * BATCHES_PER_RUN);

    const save = db.prepare(`
      INSERT INTO vessel_identity (mmsi, checked_at, found, gfw_vessel_id, name, flag, shiptype, geartype, gear_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (mmsi) DO UPDATE SET
        checked_at = excluded.checked_at, found = excluded.found, gfw_vessel_id = excluded.gfw_vessel_id,
        name = excluded.name, flag = excluded.flag, shiptype = excluded.shiptype,
        geartype = excluded.geartype, gear_source = excluded.gear_source
    `);

    for (let i = 0; i < todo.length && budgetLeft() > 0; i += BATCH_SIZE) {
      const batch = todo.slice(i, i + BATCH_SIZE);
      const found = await lookupBatch(batch, token);
      const checkedAt = Math.floor(Date.now() / 1000);
      db.exec("BEGIN");
      try {
        for (const mmsi of batch) {
          const info = found.get(mmsi);
          save.run(mmsi, checkedAt, info ? 1 : 0, info?.vesselId ?? null, info?.name ?? null, info?.flag ?? null,
            info?.shiptype ?? null, info?.geartype ?? null, info?.gearSource ?? null);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
    lastError = null;
  } catch (err) {
    lastError = err?.message || String(err);
    console.error("[vessel-identity]", lastError);
  } finally {
    running = false;
  }
}

export function start(database) {
  if (timer) return;
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS vessel_identity (
      mmsi INTEGER PRIMARY KEY,
      checked_at INTEGER NOT NULL,
      found INTEGER NOT NULL,
      gfw_vessel_id TEXT,
      name TEXT,
      flag TEXT,
      shiptype TEXT,
      geartype TEXT,
      gear_source TEXT
    );
    CREATE VIEW IF NOT EXISTS fishing_vessels AS
      SELECT v.mmsi, COALESCE(NULLIF(v.name, ''), i.name) AS name, v.ship_type AS ais_ship_type,
             i.shiptype AS gfw_shiptype, i.geartype AS gfw_geartype, i.gear_source AS gfw_gear_source,
             i.flag, v.last_seen
      FROM vessels v LEFT JOIN vessel_identity i ON i.mmsi = v.mmsi
      WHERE v.ship_type = 30 OR i.shiptype = 'FISHING';
  `);
  timer = setInterval(run, RUN_INTERVAL_MS);
  timer.unref?.();
  setTimeout(run, 10_000).unref?.();
}

export function stop() {
  clearInterval(timer);
  timer = null;
  db = null;
}

export function stats() {
  if (!db) return { enabled: false };
  try {
    const c = db.prepare("SELECT COUNT(*) AS checked, SUM(found) AS found FROM vessel_identity").get();
    const f = db.prepare("SELECT COUNT(*) AS n FROM fishing_vessels").get();
    return {
      enabled: Boolean(process.env.GFW_TOKEN),
      error: lastError,
      checked: c.checked,
      foundInGfw: c.found ?? 0,
      fishingVessels: f.n,
      requestsToday,
    };
  } catch (err) {
    return { enabled: true, error: err?.message || String(err) };
  }
}
