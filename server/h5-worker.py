"""Server H5: menjalankan model FINAL_4_PIPELINE_MODELS.h5 secara berkala pada kapal ikan dari riwayat AIS.

Tahap 3 (hasil BELUM ditampilkan ke pengguna; dipakai untuk uji kelayakan Tahap 4):
- Hanya model gear dan spoofing yang dijalankan. Go dark & transshipment ditunda sampai cara hitung
  jarak pantai/pelabuhan pada data latihan diketahui (uji kepekaan: kedua model itu peka terhadap sumber jarak).
- Data: .local-dev/ais-history.sqlite (ditulis server/ais-history.mjs), hanya kapal ikan (view fishing_vessels),
  AIS_LOOKBACK_DAYS hari terakhir. Titik dijarangkan >= 10 menit seperti data latihan (GFW AIS track, median ~10,7 menit).
- Jarak pantai/pelabuhan: raster GFW public-distance-from-shore-v1 / public-distance-from-port-v1 (km -> meter).
- Pengolahan fitur & model memakai fungsi dari scripts/run-final-h5-yolo-fusion.py, dengan empat bagian yang
  disamakan dengan kode pelatihan pembuat model (newcodinggfw_fixbuanget): saringan lompatan, fitur konteks
  spoofing, pemotongan fitur setelah penskalaan, dan urutan agregasi spoofing (lihat load_fusion dan
  spoofing_predictions). Kesamaan hasilnya dengan catatan pembuat model diuji oleh server/h5-check.py:
  gear 21/21 kapal, spoofing 522/522 skenario.
- Gear per kapal disimpan dua versi:
    gear_*     rata-rata probabilitas semua window (cara skrip fusion, hanya pembanding);
    gear_h5_*  aturan agregasi resmi yang tersimpan di tiap model gear H5 (lihat gear_member_predictions).
- Hasil: .local-dev/ai-results.sqlite (tabel runs + vessel_results), disimpan 14 hari.

Jalankan dari folder project:
    py server/h5-worker.py           berulang tiap H5_INTERVAL_MIN menit (default 30)
    py server/h5-worker.py --once    sekali jalan
    py server/h5-worker.py --report  ringkasan uji kelayakan: gear H5 vs gear menurut GFW
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sqlite3
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parents[1]


def env_path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    if not value:
        return default
    p = Path(value)
    return p if p.is_absolute() else ROOT / p


LOCAL = ROOT / ".local-dev"
HISTORY_DB = env_path("AIS_HISTORY_DB", LOCAL / "ais-history.sqlite")
RESULTS_DB = env_path("AI_RESULTS_DB", LOCAL / "ai-results.sqlite")
H5_PATH = env_path("H5_PATH", ROOT / "FINAL_4_PIPELINE_MODELS.h5")
SHORE_TIF = env_path("GFW_SHORE_TIF", LOCAL / "gfw-distance" / "distance-from-shore.tif")
PORT_TIF = env_path("GFW_PORT_TIF", LOCAL / "gfw-distance" / "distance-from-port-v1.tiff")
FUSION_SCRIPT = ROOT / "scripts" / "run-final-h5-yolo-fusion.py"

LOOKBACK_DAYS = float(os.environ.get("AIS_LOOKBACK_DAYS", "7"))
INTERVAL_MIN = float(os.environ.get("H5_INTERVAL_MIN", "30"))
MIN_GAP_S = 600
KEEP_RUNS_DAYS = 14

# Gear menurut GFW -> kelas model gear di H5 (untuk uji kelayakan, bukan untuk tampilan).
GFW_GEAR_TO_H5 = {
    "drifting_longlines": "drifting_longlines",
    "fixed_gear": "fixed_gear", "set_longlines": "fixed_gear", "set_gillnets": "fixed_gear", "pots_and_traps": "fixed_gear",
    "purse_seines": "purse_seines", "tuna_purse_seines": "purse_seines", "other_purse_seines": "purse_seines",
    "trawlers": "trawlers",
}


def log(msg: str) -> None:
    print(f"[h5-worker {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def filter_jumps(df: pd.DataFrame, cfg) -> pd.DataFrame:
    """Buang titik yang "melompat" (kecepatan tersirat > cfg.max_implied_knots dari titik sebelumnya).
    Sama dengan filter_jumps di kode pelatihan (newcodinggfw_fixbuanget/data_preparation.py): berdasarkan
    posisi baris, df harus terurut per mmsi lalu waktu. Versi di skrip fusion memakai label indeks sebagai
    posisi, sehingga salah (atau gagal) begitu indeksnya tidak lagi 0..n-1, misalnya setelah saringan kecepatan."""
    if len(df) < 2:
        return df
    m = df["mmsi"].to_numpy()
    ts = df["timestamp"].to_numpy(dtype=float)
    lat = df["lat"].to_numpy(dtype=float)
    lon = df["lon"].to_numpy(dtype=float)
    keep = np.ones(len(df), dtype=bool)
    start = 0
    for i in range(1, len(df) + 1):
        if i == len(df) or m[i] != m[start]:
            if i - start >= 2:
                idx = np.arange(start, i)
                dt = ts[idx[1:]] - ts[idx[:-1]]
                valid = (dt > 0) & (dt <= cfg.gap_seconds)
                if valid.any():
                    d_km = sys.modules["fusion"].haversine_km_np(
                        lat[idx[:-1]][valid], lon[idx[:-1]][valid], lat[idx[1:]][valid], lon[idx[1:]][valid])
                    bad = (d_km / dt[valid]) * 3600.0 / 1.852 > cfg.max_implied_knots
                    keep[idx[np.where(valid)[0][bad] + 1]] = False
            start = i
    return df[keep].copy()


def add_spoofing_context(df: pd.DataFrame) -> pd.DataFrame:
    """Fitur konteks identitas untuk spoofing: fungsi skrip fusion, disamakan dengan kode pelatihan
    (_add_spoofing_observable_context di newcodinggfw_fixbuanget/data_preparation.py) pada satu hal yang berbeda:
    kalau kolom claimed_identity_registered sudah ada di data (data uji buatan), nilainya dipakai apa adanya.
    Skrip fusion selalu menghitungnya ulang. Untuk AIS live kolom itu tidak ada, jadi tidak ada bedanya.
    Urutan baris keluaran sama dengan masukan."""
    out = sys.modules["fusion"]._add_spoofing_context_fusion(df)
    if "claimed_identity_registered" in df.columns and len(out) == len(df):
        out["claimed_identity_registered"] = (
            pd.to_numeric(df["claimed_identity_registered"], errors="coerce").fillna(0.0).clip(0.0, 1.0).to_numpy(dtype="float32"))
    return out


def transform_for_member(member, X: np.ndarray) -> np.ndarray:
    """Penskalaan fitur seperti kode pelatihan (standardize.apply_scaler): RobustScaler, lalu dipotong ke ±50.
    Skrip fusion tidak memotong. Untuk gear hasilnya sama, tetapi fitur konteks spoofing yang sebarannya sempit
    menjadi sangat besar tanpa pemotongan, sehingga probabilitas spoofing jauh berbeda dari kode pelatihan."""
    scaled = sys.modules["fusion"]._transform_for_member_fusion(member, X)
    return np.clip(scaled, -50.0, 50.0).astype(np.float32)


def load_fusion():
    """Muat skrip fusion, lalu ganti tiga bagiannya yang tidak sama dengan kode pelatihan pembuat model
    (newcodinggfw_fixbuanget). Kesamaannya diuji oleh server/h5-check.py."""
    spec = importlib.util.spec_from_file_location("fusion", FUSION_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["fusion"] = module
    spec.loader.exec_module(module)
    module.filter_jumps = filter_jumps  # saringan lompatan skrip fusion salah indeks (lihat di atas)
    module._add_spoofing_context_fusion = module.add_spoofing_observable_context
    module.add_spoofing_observable_context = add_spoofing_context
    module._transform_for_member_fusion = module.transform_for_member
    module.transform_for_member = transform_for_member
    return module


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(16 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def thin_track(group: pd.DataFrame) -> pd.DataFrame:
    """Ambil satu titik per >= MIN_GAP_S detik (titik pertama selalu diambil)."""
    keep = []
    last = None
    for idx, ts in zip(group.index, group["ts"].to_numpy()):
        if last is None or ts - last >= MIN_GAP_S:
            keep.append(idx)
            last = ts
    return group.loc[keep]


def read_fishing_tracks(since: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    con = sqlite3.connect(HISTORY_DB.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    try:
        vessels = pd.read_sql_query(
            "SELECT mmsi, name, ais_ship_type, gfw_shiptype, gfw_geartype FROM fishing_vessels", con)
        positions = pd.read_sql_query(
            """SELECT p.mmsi, p.ts, p.lat, p.lon, p.speed, p.course
               FROM positions p JOIN fishing_vessels f ON f.mmsi = p.mmsi
               WHERE p.ts >= ? ORDER BY p.mmsi, p.ts""", con, params=(since,))
    finally:
        con.close()
    if not positions.empty:
        positions = positions.groupby("mmsi", group_keys=False).apply(thin_track).reset_index(drop=True)
    return vessels, positions


class DistanceRasters:
    """Jarak dari raster GFW (nilai raster dalam km, dikembalikan dalam meter seperti data latihan)."""

    def __init__(self):
        self.shore = rasterio.open(SHORE_TIF)
        self.port = rasterio.open(PORT_TIF)

    @staticmethod
    def _sample_m(src, lon, lat) -> np.ndarray:
        values = np.array([v[0] for v in src.sample(list(zip(lon, lat)))], dtype=float)
        if src.nodata is not None:
            values[values == src.nodata] = np.nan
        return values * 1000.0

    def add(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["distance_from_shore"] = self._sample_m(self.shore, out["lon"], out["lat"])
        out["distance_from_port"] = self._sample_m(self.port, out["lon"], out["lat"])
        return out


def to_model_frame(fusion, positions: pd.DataFrame, names: dict) -> pd.DataFrame:
    """Bentuk tabel sama dengan load_ais_data() di skrip fusion."""
    df = pd.DataFrame({
        "mmsi": positions["mmsi"].map(fusion.norm_mmsi),
        "timestamp": positions["ts"].astype("int64"),
        "lat": positions["lat"].astype(float),
        "lon": positions["lon"].astype(float),
        "speed": pd.to_numeric(positions["speed"], errors="coerce").fillna(0.0),
        "course": pd.to_numeric(positions["course"], errors="coerce").fillna(0.0) % 360.0,
        "source_gear_file": "",
        "distance_from_shore": positions["distance_from_shore"],
        "distance_from_port": positions["distance_from_port"],
        "is_fishing": -1.0,
        "vessel_name": positions["mmsi"].map(lambda m: names.get(int(m)) or ""),
    })
    df = df.sort_values(["mmsi", "timestamp"]).drop_duplicates(["mmsi", "timestamp"], keep="last").reset_index(drop=True)
    df["shore_km"] = fusion.distance_col_km(df["distance_from_shore"], len(df))
    df["port_km"] = fusion.distance_col_km(df["distance_from_port"], len(df))
    return df


def softmax(z: np.ndarray) -> np.ndarray:
    e = np.exp(z - z.max(axis=1, keepdims=True))
    return e / e.sum(axis=1, keepdims=True)


def gear_member_predictions(fusion, models, frame: pd.DataFrame, apply_jump_filter: bool = True) -> dict[str, dict]:
    """Probabilitas gear per kapal dari TIAP model gear di H5 (5 seed), dengan aturan agregasi kode pelatihan
    (newcodinggfw_fixbuanget/agg_utils.py, aggregate_vessel, metode mean_logit):
      logit - logit_adjust (= tau * log prior) -> softmax -> keyakinan = maxprob * margin^2
      -> ambil K window paling yakin, K = max(agg_min_keep, round(jumlah window * agg_keep_frac))
      -> rata-rata logit berbobot keyakinan^agg_weight_power -> softmax.
    Tiap model memakai pengaturan agg_* miliknya sendiri (tersimpan di checkpoint).
    Window: 120 titik, langkah 6, jeda maksimum 12 jam, hanya titik 1-12 knot (konfigurasi final gear).
    apply_jump_filter=True seperti saat pelatihan; evaluasi luar pembuat model memakai False (data GFW sudah bersih).
    Hasil: { mmsi: { "probs": [array per model], "used": [K per model], "windows": jumlah window } }.
    Sudah diuji sama dengan hasil kode pelatihan pada data uji pembuat model (server/h5-check.py)."""
    cfg = fusion.SequenceConfig("gear", 120, 6, fusion.SEQ_FEATURE_COLS, gap_seconds=43200,
                                apply_jump_filter=apply_jump_filter, use_operational_filter=True)
    X, rows = fusion.build_sliding_sequences(frame, cfg)
    if len(X) == 0:
        return {}
    mmsis = rows["mmsi"].astype(str).to_numpy()
    out: dict[str, dict] = {}
    for member in models["gear"]:
        ck = member.checkpoint
        if ck.get("agg_method") != "mean_logit" or ck.get("agg_conf_mode") != "maxprob_margin2":
            raise ValueError(f"aturan agregasi gear tidak dikenal: {ck.get('agg_method')} / {ck.get('agg_conf_mode')}")
        # log(softmax) sama dengan logit dikurangi konstanta per baris, jadi hasil softmax akhirnya identik.
        logits = np.log(np.clip(fusion.predict_member(member, X), 1e-12, 1.0)) - np.asarray(ck.get("logit_adjust", 0.0), float)
        probs = softmax(logits)
        top = np.sort(probs, axis=1)
        conf = top[:, -1] * (top[:, -1] - top[:, -2]) ** 2
        for mmsi in np.unique(mmsis):
            idx = np.flatnonzero(mmsis == mmsi)
            k = min(len(idx), max(int(ck["agg_min_keep"]), int(round(len(idx) * float(ck["agg_keep_frac"])))))
            keep = idx[np.argsort(conf[idx])[::-1][:k]]
            w = np.power(np.clip(conf[keep], 1e-6, 1.0), float(ck["agg_weight_power"]))
            w = w / max(w.sum(), 1e-12)
            vessel_logit = (logits[keep] * w[:, None]).sum(axis=0)
            item = out.setdefault(mmsi, {"probs": [], "used": [], "windows": int(len(idx))})
            item["probs"].append(softmax(vessel_logit[None, :])[0])
            item["used"].append(k)
    return out


def gear_h5_aggregation(fusion, models, frame: pd.DataFrame, apply_jump_filter: bool = True) -> dict[str, dict]:
    """Gear per kapal: probabilitas kelima model gear (gear_member_predictions) dirata-rata."""
    labels = [fusion.GEAR_LABELS[i] for i in sorted(fusion.GEAR_LABELS)]
    out = {}
    for mmsi, item in gear_member_predictions(fusion, models, frame, apply_jump_filter).items():
        p = np.mean(item["probs"], axis=0)
        j = int(np.argmax(p))
        out[mmsi] = {"gear_label": labels[j], "gear_probability": float(p[j]), "used_windows": int(np.median(item["used"]))}
    return out


def spoofing_predictions(fusion, models, frame: pd.DataFrame) -> dict[str, dict]:
    """Dugaan spoofing per identitas (mmsi) dengan aturan resmi model (platt_scenario_policy.json di H5):
      untuk TIAP model: rata-rata 10% window dengan probabilitas spoofing tertinggi (minimal 1 window)
      -> rata-rata ketiga model -> kalibrasi Platt -> dibandingkan dengan ambang.
    fusion.run_spoofing merata-ratakan ketiga model dulu baru mengambil 10% teratas; hasilnya tidak sama.
    Window: 120 titik, langkah 6, jeda maksimum 3 jam, tanpa saringan lompatan (lompatan justru yang dicari),
    35 fitur termasuk jarak pantai/pelabuhan dan 9 fitur konteks identitas.
    Sudah diuji sama dengan catatan pembuat model pada data uji buatannya (server/h5-check.py).
    Catatan: aturan ini disetel pada skenario buatan sepanjang ±21 window; untuk AIS nyata belum ada uji."""
    cfg = fusion.SequenceConfig("spoofing", 120, 6, fusion.SPOOFING_FEATURE_COLS, gap_seconds=10800, apply_jump_filter=False)
    X, rows = fusion.build_sliding_sequences(frame, cfg)
    if len(X) == 0:
        return {}
    policy = models["spoofing_policy"]
    threshold = float(policy["threshold"])
    mmsis = rows["mmsi"].astype(str).to_numpy()
    groups = {mmsi: np.flatnonzero(mmsis == mmsi) for mmsi in np.unique(mmsis)}
    top_means: dict[str, list[float]] = {mmsi: [] for mmsi in groups}
    for member in models["spoofing"]:
        prob = fusion.predict_member(member, X)[:, 1]
        for mmsi, idx in groups.items():
            k = max(1, int(np.ceil(len(idx) * 0.10)))
            top_means[mmsi].append(float(np.sort(prob[idx])[-k:].mean()))
    out = {}
    for mmsi, idx in groups.items():
        raw = float(np.mean(top_means[mmsi]))
        calibrated = float(fusion.calibrate_spoofing(np.array([raw]), policy)[0])
        out[mmsi] = {
            "spoofing_probability_raw": raw,
            "spoofing_probability": calibrated,
            "spoofing_label": "spoofing" if calibrated >= threshold else "normal",
            "windows": int(len(idx)),
        }
    return out


RESULT_COLUMNS = [
    "run_id", "mmsi", "name", "points", "data_start", "data_end", "status",
    "gear_label", "gear_probability", "gear_class_probs", "gear_windows",
    "gear_h5_label", "gear_h5_probability", "gear_h5_used_windows",
    "spoofing_label", "spoofing_probability", "spoofing_windows",
    "gfw_geartype", "gfw_gear_class",
]


def open_results_db() -> sqlite3.Connection:
    RESULTS_DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(RESULTS_DB, timeout=30)
    con.executescript("""
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS runs (
            run_id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            model_sha256 TEXT,
            data_since INTEGER,
            fishing_vessels INTEGER,
            vessels_gear INTEGER,
            vessels_spoofing INTEGER,
            settings TEXT,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS vessel_results (
            run_id INTEGER NOT NULL,
            mmsi INTEGER NOT NULL,
            name TEXT,
            points INTEGER,
            data_start INTEGER,
            data_end INTEGER,
            status TEXT,
            gear_label TEXT,
            gear_probability REAL,
            gear_class_probs TEXT,
            gear_windows INTEGER,
            spoofing_label TEXT,
            spoofing_probability REAL,
            spoofing_windows INTEGER,
            gfw_geartype TEXT,
            gfw_gear_class TEXT,
            PRIMARY KEY (run_id, mmsi)
        );
    """)
    # Kolom yang ditambahkan setelah tabel pertama kali dibuat.
    existing = {row[1] for row in con.execute("PRAGMA table_info(vessel_results)")}
    for column, kind in [("gear_h5_label", "TEXT"), ("gear_h5_probability", "REAL"), ("gear_h5_used_windows", "INTEGER")]:
        if column not in existing:
            con.execute(f"ALTER TABLE vessel_results ADD COLUMN {column} {kind}")
    return con


def run_once(fusion, models, rasters: DistanceRasters, model_sha: str) -> None:
    started = int(time.time())
    since = started - int(LOOKBACK_DAYS * 86400)
    con = open_results_db()
    run_id = con.execute("INSERT INTO runs (started_at, model_sha256, data_since, settings) VALUES (?, ?, ?, ?)", (
        started, model_sha, since, json.dumps({
            "pipelines": ["gear", "spoofing"],
            "min_gap_s": MIN_GAP_S,
            "lookback_days": LOOKBACK_DAYS,
            "distance_source": [SHORE_TIF.name, PORT_TIF.name],
            "vessel_aggregation": {"gear": "mean window probability (skrip fusion)",
                                   "gear_h5": "agg_* per model H5 (agg_utils.aggregate_vessel), rata-rata 5 model",
                                   "spoofing": "rata-rata 10% window teratas per model -> rata-rata 3 model -> Platt -> ambang"},
        }))).lastrowid
    con.commit()
    try:
        vessels, positions = read_fishing_tracks(since)
        names = {int(r.mmsi): r.name for r in vessels.itertuples()}
        gfw_gear = {int(r.mmsi): r.gfw_geartype for r in vessels.itertuples()}

        gear, gear_h5, spoof = {}, {}, {}
        if not positions.empty:
            positions = rasters.add(positions)
            frame = to_model_frame(fusion, positions, names)
            _, gear = fusion.run_gear(models, frame)
            gear_h5 = gear_h5_aggregation(fusion, models, frame)
            spoof = spoofing_predictions(fusion, models, frame)

        counts = positions.groupby("mmsi")["ts"].agg(["count", "min", "max"]) if not positions.empty else pd.DataFrame()
        rows = []
        for mmsi in vessels["mmsi"].astype(int):
            key = str(mmsi)
            g, gh, s = gear.get(key), gear_h5.get(key), spoof.get(key)
            c = counts.loc[mmsi] if mmsi in counts.index else None
            raw_gfw = (gfw_gear.get(mmsi) or "").lower() or None
            rows.append((
                run_id, mmsi, names.get(mmsi) or None,
                int(c["count"]) if c is not None else 0,
                int(c["min"]) if c is not None else None,
                int(c["max"]) if c is not None else None,
                "ok" if (g or s) else "data_belum_cukup",
                g["gear_label"] if g else None,
                float(g["gear_probability"]) if g else None,
                json.dumps(g["gear_class_probabilities"]) if g else None,
                int(g["windows"]) if g else None,
                gh["gear_label"] if gh else None,
                gh["gear_probability"] if gh else None,
                gh["used_windows"] if gh else None,
                s["spoofing_label"] if s else None,
                float(s["spoofing_probability"]) if s else None,
                int(s["windows"]) if s else None,
                raw_gfw,
                GFW_GEAR_TO_H5.get(raw_gfw) if raw_gfw else None,
            ))
        con.executemany(
            f"INSERT INTO vessel_results ({', '.join(RESULT_COLUMNS)}) VALUES ({', '.join('?' * len(RESULT_COLUMNS))})", rows)
        con.execute("UPDATE runs SET finished_at = ?, fishing_vessels = ?, vessels_gear = ?, vessels_spoofing = ? WHERE run_id = ?",
                    (int(time.time()), len(rows), len(gear), len(spoof), run_id))
        cutoff = started - KEEP_RUNS_DAYS * 86400
        con.execute("DELETE FROM vessel_results WHERE run_id IN (SELECT run_id FROM runs WHERE started_at < ?)", (cutoff,))
        con.execute("DELETE FROM runs WHERE started_at < ?", (cutoff,))
        con.commit()
        log(f"run {run_id}: {len(rows)} kapal ikan, {len(positions)} titik; hasil gear {len(gear)}, spoofing {len(spoof)}")
    except Exception as exc:
        con.execute("UPDATE runs SET finished_at = ?, error = ? WHERE run_id = ?", (int(time.time()), str(exc)[:500], run_id))
        con.commit()
        raise
    finally:
        con.close()


def report() -> int:
    """Uji kelayakan (Tahap 4): hasil gear terbaru tiap kapal dibandingkan dengan gear menurut GFW."""
    if not RESULTS_DB.exists():
        log(f"belum ada hasil: {RESULTS_DB}")
        return 1
    con = sqlite3.connect(RESULTS_DB.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    try:
        runs = con.execute("SELECT COUNT(*), MIN(started_at), MAX(started_at) FROM runs").fetchone()
        analysed = con.execute("SELECT COUNT(DISTINCT mmsi) FROM vessel_results").fetchone()[0]
        latest = pd.read_sql_query("""
            SELECT r.* FROM vessel_results r
            JOIN (SELECT mmsi, MAX(run_id) AS run_id FROM vessel_results
                  WHERE gear_label IS NOT NULL OR gear_h5_label IS NOT NULL GROUP BY mmsi) last
              ON last.mmsi = r.mmsi AND last.run_id = r.run_id""", con)
    finally:
        con.close()
    span = (f"{time.strftime('%d-%m-%Y %H:%M', time.localtime(runs[1]))} s.d. {time.strftime('%d-%m-%Y %H:%M', time.localtime(runs[2]))}"
            if runs[0] else "-")
    print(f"\nUJI KELAYAKAN GEAR H5  |  {runs[0]} kali jalan ({span})")
    print(f"Kapal ikan pernah dianalisis : {analysed}")
    print(f"Kapal dengan prediksi gear   : {len(latest)}")
    comparable = latest[latest["gfw_gear_class"].notna()]
    print(f"...yang punya pembanding GFW : {len(comparable)}  (gear GFW di luar 4 kelas H5 tidak dihitung)")
    print("Target tayang: kecocokan >= 80% (hasil uji resmi model: 83%)\n")
    for prefix, title in [("gear", "rata-rata window (skrip fusion)"), ("gear_h5", "aturan agregasi H5")]:
        sub = comparable[comparable[f"{prefix}_label"].notna()]
        if sub.empty:
            print(f"- {title}: belum ada data")
            continue
        match = sub[f"{prefix}_label"] == sub["gfw_gear_class"]
        confident = sub[sub[f"{prefix}_probability"] >= 0.8]
        cmatch = confident[f"{prefix}_label"] == confident["gfw_gear_class"]
        print(f"- {title}: cocok {match.sum()}/{len(sub)} ({match.mean():.0%})"
              f" | keyakinan >= 80%: cocok {cmatch.sum()}/{len(confident)}" + (f" ({cmatch.mean():.0%})" if len(confident) else ""))
    if not comparable.empty:
        print("\nPer kapal (versi aturan H5):")
        for r in comparable.sort_values("mmsi").itertuples():
            label = r.gear_h5_label or "-"
            prob = f"{r.gear_h5_probability:.0%}" if r.gear_h5_probability is not None and not pd.isna(r.gear_h5_probability) else ""
            mark = "cocok" if label == r.gfw_gear_class else "BEDA"
            print(f"  {r.mmsi} {r.name or ''}: H5 {label} {prob} | GFW {r.gfw_geartype} -> {mark}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--once", action="store_true", help="jalankan sekali lalu keluar")
    parser.add_argument("--report", action="store_true", help="ringkasan uji kelayakan gear H5 vs GFW")
    args = parser.parse_args()
    if args.report:
        return report()

    for path, label in [(H5_PATH, "file H5"), (HISTORY_DB, "riwayat AIS"), (SHORE_TIF, "raster jarak pantai"), (PORT_TIF, "raster jarak pelabuhan")]:
        if not path.exists():
            log(f"{label} tidak ditemukan: {path}")
            return 1

    fusion = load_fusion()
    fusion.log = lambda msg: log(msg)
    t0 = time.time()
    models = fusion.H5ModelBundle(H5_PATH).load()
    model_sha = sha256(H5_PATH)
    rasters = DistanceRasters()
    log(f"H5 dimuat dalam {time.time() - t0:.1f} dtk (sha256 {model_sha[:12]}…); gear + spoofing aktif")

    while True:
        try:
            run_once(fusion, models, rasters, model_sha)
        except Exception as exc:
            log(f"gagal: {exc}")
        if args.once:
            return 0
        time.sleep(INTERVAL_MIN * 60)


if __name__ == "__main__":
    sys.exit(main())
