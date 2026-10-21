"""N-1: salin angka scaler dan kalibrator dari FINAL_4_PIPELINE_MODELS.h5 ke file JSON biasa.

Di dalam file H5 ada 24 berkas joblib: 20 RobustScaler (satu per model) dan 4 kalibrator Platt (LogisticRegression).
joblib membukanya lewat pickle, yang bisa ikut menjalankan kode saat dibuka (peringatan dokumentasi scikit-learn,
"Model persistence: security & maintainability limitations"), masalah sejenis temuan audit K-2. Skrip ini membuka
ke-24 berkas itu SEKALI, menyalin angkanya ke <nama H5>.preprocessing.json, dan mencatat sidik jari SHA-256 tiap
berkas. Setelah itu run-final-h5-yolo-fusion.py (dan server/h5-worker.py) membaca JSON tersebut tanpa joblib.

File H5 tidak diubah, model tidak dilatih. Jalankan ulang skrip ini hanya bila menerima file H5 baru dari pembuat
model; run-final akan menolak JSON yang sidik jarinya tidak cocok dengan H5.

Pakai: python scripts/export-h5-preprocessing.py [--h5 FINAL_4_PIPELINE_MODELS.h5]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
from pathlib import Path

import h5py
import joblib
import numpy as np
import sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import RobustScaler

ROOT = Path(__file__).resolve().parents[1]
JSON_SUFFIX = ".preprocessing.json"


def preprocessing_path(h5_path: Path) -> Path:
    return h5_path.with_name(h5_path.stem + JSON_SUFFIX)


def numbers(array: np.ndarray) -> list:
    # Nilai float32/float64 disimpan dengan repr Python (17 digit), sehingga terbaca kembali bit demi bit sama.
    return np.asarray(array).tolist()


def export_scaler(obj: object) -> dict:
    if type(obj) is not RobustScaler:
        raise TypeError(f"diharapkan RobustScaler, ditemukan {type(obj).__name__}")
    if getattr(obj, "unit_variance", False):
        raise ValueError("unit_variance=True belum didukung")
    return {
        "kind": "RobustScaler",
        "with_centering": bool(obj.with_centering),
        "with_scaling": bool(obj.with_scaling),
        "n_features_in": int(obj.n_features_in_),
        "center": numbers(obj.center_) if obj.with_centering else None,
        "center_dtype": str(obj.center_.dtype) if obj.with_centering else None,
        "scale": numbers(obj.scale_) if obj.with_scaling else None,
        "scale_dtype": str(obj.scale_.dtype) if obj.with_scaling else None,
    }


def export_calibrator(obj: object) -> dict:
    if not isinstance(obj, dict) or type(obj.get("estimator")) is not LogisticRegression:
        raise TypeError("diharapkan dict dengan estimator LogisticRegression")
    est = obj["estimator"]
    if len(est.classes_) != 2 or est.coef_.shape != (1, int(est.n_features_in_)):
        raise ValueError("hanya kalibrator Platt dua kelas yang didukung")
    metadata = {k: v for k, v in obj.items() if k != "estimator"}
    json.dumps(metadata)  # pastikan isinya hanya teks/angka/boolean
    return {
        "kind": "PlattLogisticRegression",
        "n_features_in": int(est.n_features_in_),
        "classes": numbers(est.classes_),
        "coef": numbers(est.coef_),
        "coef_dtype": str(est.coef_.dtype),
        "intercept": numbers(est.intercept_),
        "intercept_dtype": str(est.intercept_.dtype),
        "metadata": metadata,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--h5", type=Path, default=ROOT / "FINAL_4_PIPELINE_MODELS.h5")
    args = parser.parse_args()
    h5_path = args.h5.resolve()

    entries: dict[str, dict] = {}
    with h5py.File(h5_path, "r") as h5:
        names: list[str] = []
        h5.visit(lambda name: names.append(name) if name.endswith(".joblib") else None)
        for name in sorted(names):
            raw = bytes(h5[name][()])
            obj = joblib.load(io.BytesIO(raw))  # satu-satunya pembukaan joblib, sekali saja
            entry = export_calibrator(obj) if name.endswith("_platt.joblib") else export_scaler(obj)
            entry["sha256"] = hashlib.sha256(raw).hexdigest()
            entries[name] = entry

    out = preprocessing_path(h5_path)
    payload = {
        "format": "ocean-nexus-h5-preprocessing/1",
        "source_h5": h5_path.name,
        "exported_utc": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "sklearn_version": sklearn.__version__,
        "note": "Disalin dari berkas joblib di dalam file H5 oleh scripts/export-h5-preprocessing.py (temuan N-1). File H5 tidak diubah.",
        "entries": entries,
    }
    out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    kinds = {}
    for entry in entries.values():
        kinds[entry["kind"]] = kinds.get(entry["kind"], 0) + 1
    print(f"[N-1] {len(entries)} berkas joblib disalin ke {out.name}: {kinds}")


if __name__ == "__main__":
    main()
