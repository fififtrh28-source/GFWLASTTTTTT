"""Uji cocok model H5: program di server/h5-worker.py dibandingkan dengan catatan pembuat model.

Dua uji, dua-duanya pada data uji pembuat model (folder newcodinggfw_fixbuanget) dan tanpa pelatihan:

1. GEAR. Jalur gear worker dijalankan pada Dataset_Test_Enriched, lalu untuk tiap kapal tebakan kelima model
   dibandingkan dengan catatan pembuatnya:
       Outputs/gear_tuning06_internal_hparam_gap12h_opfilter/final_analysis/external_prediction_stability.csv
   Lulus kalau 21 dari 21 kapal cocok (suara 5 model sama dan jumlah window sama).

2. SPOOFING. Data uji buatan dibangkitkan ulang dengan perintah pembuatnya (main.py make_spoofing, seed 1042,
   pengaturan run "spoofing_fix02_location_real_drift100_mirrorfar") ke folder sementara, lalu jalur spoofing
   worker dijalankan dan tebakan tiap skenario dibandingkan dengan catatan pembuatnya:
       Outputs/spoofing_fix02_location_real_drift100_mirrorfar/final_external_ensemble/spoofing_scenario_predictions.csv
   Lulus kalau 522 dari 522 skenario cocok.

Tidak ada file proyek atau file pembuat model yang diubah; folder sementara dihapus lagi.

Jalankan dari folder project (beberapa menit di CPU):
    py server/h5-check.py                  kedua uji
    py server/h5-check.py --only gear      hanya gear
    py server/h5-check.py --only spoofing  hanya spoofing
Kode keluar 0 = semua uji yang dijalankan lulus.
Ulangi setiap kali cara mengolah data atau cara memakai model di h5-worker.py diubah.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
AUTHOR = ROOT / "newcodinggfw_fixbuanget"
TEST_DIR = AUTHOR / "Dataset_Test_Enriched"
GEAR_REFERENCE = AUTHOR / "Outputs" / "gear_tuning06_internal_hparam_gap12h_opfilter" / "final_analysis" / "external_prediction_stability.csv"
SPOOF_RUN = AUTHOR / "Outputs" / "spoofing_fix02_location_real_drift100_mirrorfar"
SPOOF_REFERENCE = SPOOF_RUN / "final_external_ensemble" / "spoofing_scenario_predictions.csv"

# Perintah pembuat model untuk data uji spoofing (run_spoofing_multiseed.py, prepare_external_after_internal_policy).
# Jarak cermin 4-12 derajat tidak tercatat di foldernya; nilainya dihitung balik dari file
# _generated_external/spoofed_fixed_gear.csv, dan dengan nilai itu file hasil bangkit ulang sama byte demi byte.
SPOOF_GENERATE_ARGS = [
    "--attacks", "gradual_drift", "location_jump", "replay", "meaconing", "ghost", "mirroring",
    "--seed", "1042", "--limit_rows", "0", "--normal_keep_frac", "0.50",
    "--include_labels", "drifting_longlines", "fixed_gear", "purse_seines", "trawlers",
    "--exclude_labels", "pole_and_line", "trollers",
    "--max_vessels_per_file", "0", "--min_points_per_vessel", "300", "--points_per_attack", "240",
    "--scenarios_per_attack", "3", "--drift_lat_deg", "0.01", "--drift_lon_deg", "0.01",
    "--drift_rate_kmh", "0.1", "--drift_rate_jitter_frac", "0.5", "--jump_lat_deg", "0.5", "--jump_lon_deg", "0.5",
    "--mirror_offset_min_deg", "4.0", "--mirror_offset_max_deg", "12.0",
    "--reported_motion_mode", "preserve", "--mixed_recompute_probability", "0.0",
    "--include_matched_normal_controls", "--combine_outputs",
]


def load_worker():
    spec = importlib.util.spec_from_file_location("h5worker", ROOT / "server" / "h5-worker.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_gear(worker, fusion, models) -> bool:
    for path, label in [(TEST_DIR, "data uji pembuat model"), (GEAR_REFERENCE, "catatan gear pembuat model")]:
        if not path.exists():
            print(f"{label} tidak ditemukan: {path}")
            return False

    # Data uji dibentuk seperti yang diterima worker dari riwayat AIS (jarak pantai/pelabuhan sudah ada di filenya).
    raw = pd.concat([pd.read_csv(f) for f in sorted(TEST_DIR.glob("*.csv"))], ignore_index=True)
    positions = pd.DataFrame({
        "mmsi": raw["mmsi"].astype("int64"),
        "ts": pd.to_datetime(raw["timestamp"], utc=True, format="mixed").dt.as_unit("s").astype("int64"),
        "lat": raw["lat"], "lon": raw["lon"], "speed": raw["speed"], "course": raw["course"],
        "distance_from_shore": raw["distance_from_shore"], "distance_from_port": raw["distance_from_port"],
    })
    frame = worker.to_model_frame(fusion, positions, {})

    # Evaluasi luar pembuat model memakai --no_jump_filter, jadi di sini saringan lompatan dimatikan.
    members = worker.gear_member_predictions(fusion, models, frame, apply_jump_filter=False)
    labels = [fusion.GEAR_LABELS[i] for i in sorted(fusion.GEAR_LABELS)]
    reference = pd.read_csv(GEAR_REFERENCE, dtype={"mmsi": str})

    print(f"UJI GEAR: {len(models['gear'])} model, {len(members)} kapal menghasilkan tebakan, {len(reference)} kapal di catatan\n")
    print(f"{'MMSI':<11}{'label asli':<20}{'suara 5 model (program ini)':<44}{'window':<10}{'gabungan':<20}hasil")
    matched = correct = 0
    for r in reference.itertuples():
        item = members.get(r.mmsi)
        if item is None:
            print(f"{r.mmsi:<11}{r.true_label:<20}{'(tidak ada tebakan)':<44}{'':<10}{'':<20}BEDA")
            continue
        votes = Counter(labels[int(np.argmax(p))] for p in item["probs"])
        ensemble = labels[int(np.argmax(np.mean(item["probs"], axis=0)))]
        same = (dict(votes) == json.loads(r.prediction_votes)
                and votes.get(r.true_label, 0) == int(r.correct_seeds)
                and item["windows"] == int(r.n_sequences))
        matched += same
        correct += ensemble == r.true_label
        print(f"{r.mmsi:<11}{r.true_label:<20}{str(dict(sorted(votes.items()))):<44}{item['windows']:>4}/{int(r.n_sequences):<5}{ensemble:<20}{'cocok' if same else 'BEDA'}")

    extra = sorted(set(members) - set(reference["mmsi"]))
    print(f"\nGEAR: KAPAL COCOK DENGAN CATATAN PEMBUAT MODEL: {matched} dari {len(reference)}")
    if extra:
        print(f"kapal yang hanya ada di program ini: {extra}")
    print(f"tebakan gabungan 5 model benar terhadap label asli: {correct} dari {len(reference)} ({correct / len(reference):.0%})")
    return matched == len(reference) and not extra


def check_spoofing(worker, fusion, models) -> bool:
    for path, label in [(TEST_DIR, "data uji pembuat model"), (SPOOF_REFERENCE, "catatan spoofing pembuat model"), (AUTHOR / "main.py", "kode pembuat model")]:
        if not path.exists():
            print(f"{label} tidak ditemukan: {path}")
            return False

    tmp = Path(tempfile.mkdtemp(prefix="h5-check-spoofing-"))
    try:
        # Hanya membangkitkan data uji buatan (bukan pelatihan); tidak menulis apa pun ke folder pembuat model.
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        cmd = [sys.executable, "main.py", "make_spoofing", "--input_path", "Dataset_Test_Enriched", "--out_dir", str(tmp), *SPOOF_GENERATE_ARGS]
        done = subprocess.run(cmd, cwd=AUTHOR, env=env, capture_output=True, text=True)
        if done.returncode != 0:
            print("gagal membangkitkan data uji spoofing:\n" + (done.stderr or done.stdout)[-800:])
            return False
        author_file = SPOOF_RUN / "_generated_external" / "spoofed_fixed_gear.csv"
        if author_file.exists():
            identical = author_file.read_bytes() == (tmp / "spoofed_fixed_gear.csv").read_bytes()
            print(f"UJI SPOOFING: data uji buatan sama dengan file pembuat model (fixed_gear): {'ya, byte demi byte' if identical else 'TIDAK'}")
            if not identical:
                return False
        raw = pd.read_csv(tmp / "spoofed_all.csv", low_memory=False)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # Urutan baris dibiarkan seperti di file: kode pelatihan menghitung fitur konteks sebelum mengurutkan data,
    # dan dua fitur "revisit" hasilnya bergantung pada urutan itu.
    scenario_of = dict(zip(raw["mmsi"].map(fusion.norm_mmsi), raw["scenario_id"].astype(str)))
    frame = pd.DataFrame({
        "mmsi": raw["mmsi"].map(fusion.norm_mmsi),
        "timestamp": pd.to_numeric(raw["timestamp"], errors="raise").astype("int64"),  # sudah detik epoch
        "lat": pd.to_numeric(raw["lat"], errors="coerce"),
        "lon": pd.to_numeric(raw["lon"], errors="coerce"),
        "speed": pd.to_numeric(raw["speed"], errors="coerce").fillna(0.0),
        "course": pd.to_numeric(raw["course"], errors="coerce").fillna(0.0),
        "distance_from_shore": pd.to_numeric(raw["distance_from_shore"], errors="coerce"),
        "distance_from_port": pd.to_numeric(raw["distance_from_port"], errors="coerce"),
        "is_fishing": pd.to_numeric(raw["is_fishing"], errors="coerce"),
        "claimed_mmsi": raw["claimed_mmsi"].map(fusion.norm_mmsi),
        "claimed_identity_registered": pd.to_numeric(raw["claimed_identity_registered"], errors="coerce"),
    })
    results = {scenario_of[mmsi]: item for mmsi, item in worker.spoofing_predictions(fusion, models, frame).items()}
    reference = pd.read_csv(SPOOF_REFERENCE)

    matched = 0
    worst = 0.0
    counts = Counter()
    by_attack: dict[str, list[int]] = {}
    different = []
    for r in reference.itertuples():
        item = results.get(r.scenario_id)
        if item is None:
            different.append(f"{r.scenario_id}: tidak ada tebakan")
            continue
        pred = int(item["spoofing_label"] == "spoofing")
        worst = max(worst, abs(item["spoofing_probability"] - float(r.calibrated_probability)))
        same = pred == int(r.pred_id) and item["windows"] == int(r.n_windows)
        matched += same
        if not same:
            different.append(f"{r.scenario_id}: program ini {item['spoofing_probability']:.4f} | catatan {float(r.calibrated_probability):.4f}")
        truth = int(r.true_id)
        counts[("tn", "fp", "fn", "tp")[truth * 2 + pred]] += 1
        ok = by_attack.setdefault(r.attack_type, [0, 0])
        ok[0] += pred == truth
        ok[1] += 1

    print(f"{len(models['spoofing'])} model, {len(results)} skenario menghasilkan tebakan, {len(reference)} skenario di catatan")
    print(f"SPOOFING: SKENARIO COCOK DENGAN CATATAN PEMBUAT MODEL: {matched} dari {len(reference)} (selisih probabilitas terbesar {worst:.5f})")
    for line in different[:10]:
        print("   beda:", line)
    print(f"hitungan: normal benar {counts['tn']}, salah tanda {counts['fp']}, spoofing lolos {counts['fn']}, spoofing tertangkap {counts['tp']}"
          f"  (catatan pembuat model: 248, 22, 87, 165)")
    print("benar per jenis:", ", ".join(f"{k} {v[0]}/{v[1]}" for k, v in sorted(by_attack.items())))
    return matched == len(reference) and len(results) == len(reference)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", choices=["gear", "spoofing"], help="jalankan satu uji saja")
    args = parser.parse_args()

    worker = load_worker()
    fusion = worker.load_fusion()
    fusion.log = lambda msg: None
    models = fusion.H5ModelBundle(worker.H5_PATH).load()

    passed = {}
    if args.only in (None, "gear"):
        passed["gear"] = check_gear(worker, fusion, models)
        print()
    if args.only in (None, "spoofing"):
        passed["spoofing"] = check_spoofing(worker, fusion, models)
        print()
    print("RINGKASAN:", ", ".join(f"{name} {'LULUS' if ok else 'GAGAL'}" for name, ok in passed.items()))
    return 0 if all(passed.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
