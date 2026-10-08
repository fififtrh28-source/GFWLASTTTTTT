(function () {
  // Sumber data halaman Anomaly Alert Center dan Data & Reports.
  // Isinya SAMA dengan temuan di tab AI Inference pada dashboard peta: file kandidat yang dibaca dashboard.html
  // (INTEGRATION_DATA_FILES.candidates), ditambah bendera dan IMO kapal dari file metadata penelitian.
  // Tidak ada data contoh di sini. Yang disimpan di browser hanya status tiap temuan (New / Reviewed / Sent)
  // dan riwayat alert; data kapalnya selalu dibaca ulang dari file.
  const CANDIDATES_URL = "KAPAL YG TERDETEKSI/scene_candidates_godark_spoofing_transshipment.csv";
  const METADATA_URL = "new/metadata/metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv";
  const STATUS_KEY = "ocean-nexus-anomaly-status-v2";
  const HISTORY_KEY = "ocean-nexus-alert-history-v2";
  // Kunci lama berisi data contoh; dibuang supaya tidak pernah tampil lagi.
  const OLD_KEYS = ["ocean-nexus-anomalies-v1", "ocean-nexus-alert-history-v1"];

  const TYPE_LABEL = { spoofing: "Spoofing", godark: "Go Dark", transshipment: "Transshipment" };
  const REMARKS = "Rule-based candidate; requires verification.";

  let baseline = [];
  let sourceNote = "";
  let loadError = "";

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function read(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : clone(fallback);
    } catch (error) {
      return clone(fallback);
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // localStorage can be unavailable in strict browser modes; the UI still works in memory.
    }
  }

  // CSV dengan tanda kutip (RFC 4180) → daftar objek, kunci dari baris judul.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i += 1;
        row.push(cell); cell = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    const header = (rows.shift() || []).map((name) => name.replace(/^﻿/, "").trim());
    return rows.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
  }

  const normId = (value) => String(value ?? "").trim().replace(/\.0$/, "");
  const hasValue = (value) => value !== "" && value !== null && value !== undefined && String(value).toLowerCase() !== "nan";

  // Waktu citra satelit (UTC) → bagian tanggal dalam WIB.
  function wibParts(utc) {
    const date = new Date(utc);
    if (Number.isNaN(date.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date).map((part) => [part.type, part.value]));
    const month = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", month: "short" }).format(date);
    const hour = parts.hour === "24" ? "00" : parts.hour;
    return {
      iso: `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:00+07:00`,
      day: `${parts.day} ${month} ${parts.year}`,
      time: `${hour}:${parts.minute}`,
    };
  }

  function formatLocation(lat, lon) {
    return `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? "W" : "E"}`;
  }

  // Ringkasan singkat dasar temuan untuk kolom tabel, diambil dari angka yang ada di datanya (bukan skor).
  function shortBasis(row, type) {
    const num = (value, digits) => (hasValue(value) && Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : null);
    if (type === "godark") {
      const gap = num(row.AIS_update_time_gap_hours, 0);
      return gap ? `AIS gap ${Number(gap).toLocaleString("en-US")} h` : "AIS gap";
    }
    if (type === "transshipment") {
      const dist = num(row.neighbor_distance_km, 2);
      return dist ? `${dist} km to MMSI ${normId(row.neighbor_mmsi)}` : "Nearby vessel";
    }
    const dist = num(row.sar_ais_distance_km, 1);
    if (/SAR-AIS distance/.test(row.evidence || "") && dist) return `SAR-AIS ${dist} km`;
    const residual = num(row.kalman_pred_residual_m, 0);
    if (residual) return `Kalman miss ${(Number(residual) / 1000).toFixed(1)} km`;
    return dist ? `SAR-AIS ${dist} km` : "Position mismatch";
  }

  async function fetchText(url) {
    const response = await fetch(encodeURI(url));
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const text = await response.text();
    // Situs yang tayang mengembalikan halaman depan untuk alamat yang tidak ada; itu bukan CSV.
    if (/^\s*<!doctype html|^\s*<html/i.test(text)) throw new Error(`${url}: file not found`);
    return text;
  }

  async function load() {
    OLD_KEYS.forEach((key) => { try { localStorage.removeItem(key); } catch (error) { /* abaikan */ } });
    try {
      const [candidateText, metadataText] = await Promise.all([
        fetchText(CANDIDATES_URL),
        fetchText(METADATA_URL).catch(() => ""), // bendera/IMO hanya pelengkap; tanpa file ini tetap jalan
      ]);

      const identity = new Map();
      for (const row of metadataText ? parseCsv(metadataText) : []) {
        const mmsi = normId(row.MMSI);
        if (!mmsi) continue;
        const known = identity.get(mmsi) || {};
        identity.set(mmsi, {
          flag: known.flag || (hasValue(row.gfw_flag) ? row.gfw_flag : ""),
          imo: known.imo || (hasValue(row.gfw_imo) ? normId(row.gfw_imo) : ""),
        });
      }

      const seen = new Set();
      const records = [];
      for (const row of parseCsv(candidateText)) {
        const lat = Number(row.Center_latitude);
        const lon = Number(row.Center_longitude);
        const type = String(row.candidate_type || "").toLowerCase();
        const when = wibParts(row.scene_time_utc);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !when) continue;
        // Kunci yang sama dengan dashboard peta, supaya jumlah temuannya persis sama.
        const mmsi = normId(row.MMSI);
        const id = `${row.scene}|${row.MMSI}|${row.candidate_type}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const who = identity.get(mmsi) || {};
        const aisLat = Number(row.AIS_Latitude);
        const aisLon = Number(row.AIS_Longitude);
        records.push({
          id,
          vesselName: hasValue(row.Name) ? row.Name : `MMSI ${mmsi}`,
          mmsi,
          imo: who.imo || "-",
          flag: who.flag || "-",
          shipType: hasValue(row.Ship_Type) ? row.Ship_Type : (hasValue(row.gfw_shiptype) ? row.gfw_shiptype : "-"),
          anomalyType: TYPE_LABEL[type] || row.candidate_type,
          dateISO: when.iso,
          dateLabel: `${when.day} ${when.time}`,
          detectionTime: `${when.day}, ${when.time} WIB`,
          location: formatLocation(lat, lon),
          lat,
          lon,
          aisLocation: Number.isFinite(aisLat) && Number.isFinite(aisLon) ? formatLocation(aisLat, aisLon) : "-",
          basis: shortBasis(row, type),
          rule: row.rule || "-",
          evidence: row.evidence || "-",
          scene: row.scene || "-",
          status: "New",
          remarks: REMARKS,
        });
      }

      records.sort((a, b) => b.dateISO.localeCompare(a.dateISO) || a.vesselName.localeCompare(b.vesselName));
      baseline = records;
      if (records.length) {
        const first = records[records.length - 1].dateLabel.replace(/\s\d{2}:\d{2}$/, "");
        const last = records[0].dateLabel.replace(/\s\d{2}:\d{2}$/, "");
        sourceNote = `Source: ${records.length} findings from the AI Inference tab of the map dashboard (${first} - ${last}). `
          + "Rule-based candidates from satellite and AIS data; each one requires verification.";
      } else {
        sourceNote = "No findings were found in the dashboard data.";
      }
    } catch (error) {
      baseline = [];
      loadError = error?.message || "data could not be loaded";
      sourceNote = `Data could not be loaded (${loadError}).`;
    }
  }

  function readStatuses() {
    const saved = read(STATUS_KEY, {});
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }

  function getAnomalies() {
    const statuses = readStatuses();
    return clone(baseline.map((record) => ({ ...record, ...(statuses[record.id] || {}) })));
  }

  // Hanya status dan catatan yang disimpan; data kapalnya tetap dari file.
  function saveAnomalies(records) {
    const statuses = {};
    (Array.isArray(records) ? records : []).forEach((record) => {
      if (record.status && record.status !== "New") statuses[record.id] = { status: record.status, remarks: record.remarks };
    });
    write(STATUS_KEY, statuses);
  }

  function updateAnomaly(id, patch) {
    const record = baseline.find((item) => item.id === id);
    if (!record) return null;
    const statuses = readStatuses();
    statuses[id] = { ...(statuses[id] || {}), ...patch };
    write(STATUS_KEY, statuses);
    return clone({ ...record, ...statuses[id] });
  }

  function getAlertHistory() {
    const history = read(HISTORY_KEY, []);
    return clone(Array.isArray(history) ? history : []);
  }

  function addAlertHistory(entry) {
    const history = [entry, ...getAlertHistory()].slice(0, 20);
    write(HISTORY_KEY, history);
    return clone(history);
  }

  function formatNowWib() {
    const date = new Date();
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Jakarta",
    }).format(date).replace(",", "") + " WIB";
  }

  function getSummary(records) {
    const source = Array.isArray(records) ? records : getAnomalies();
    const total = source.length;
    const newCount = source.filter((record) => record.status === "New").length;
    const reviewed = source.filter((record) => record.status === "Reviewed").length;
    const sent = source.filter((record) => record.status === "Sent").length;
    return { total, newCount, reviewed, sent };
  }

  window.OceanNexusData = {
    ready: load(),          // selesai saat data dashboard sudah terbaca
    getAnomalies,
    saveAnomalies,
    updateAnomaly,
    getAlertHistory,
    addAlertHistory,
    formatNowWib,
    getSummary,
    getSourceNote: () => sourceNote,
    getLoadError: () => loadError,
  };
})();
