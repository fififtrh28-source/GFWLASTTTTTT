#!/usr/bin/env python3
"""
Inference-only fusion for the FINAL_4_PIPELINE_MODELS.h5 bundle and YOLO SAR CSV.

This script reconstructs the locked PyTorch models stored in the HDF5 bundle,
builds real-data AIS features from Fifi's AIS CSVs, runs inference without
labels or synthetic events, joins YOLO SAR predictions to SAR metadata, and
writes new output CSVs. It never modifies source datasets.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import warnings
from dataclasses import dataclass
from pathlib import Path

import h5py
import joblib
import numpy as np
import pandas as pd
import torch
from torch import nn
import torch.nn.functional as F


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "KAPAL YG TERDETEKSI"
DEFAULT_H5 = MODEL_DIR / "FINAL_4_PIPELINE_MODELS.h5"
DEFAULT_AIS_DIR = ROOT / "Dataset_Test_Enriched" / "Dataset_Test_Enriched_EEZ_Indonesia"
DEFAULT_YOLO = ROOT / "hasilyolov12n" / "predictions.csv"
DEFAULT_YOLO_FALLBACK = ROOT / "RUNYOLO_FINALBISMILLAH" / "predictions_nms045" / "YOLOV12N_E150" / "predictions.csv"
DEFAULT_CANDIDATES = MODEL_DIR / "scene_candidates_godark_spoofing_transshipment.csv"
DEFAULT_METADATA = ROOT / "new" / "metadata" / "metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv"
DEFAULT_H5_OUT = MODEL_DIR / "final_h5_ai_predictions.csv"
DEFAULT_FUSION_OUT = MODEL_DIR / "final_ai_fusion_results.csv"

MODEL_SOURCE = "FINAL_4_PIPELINE_MODELS.h5"
YOLO_SOURCE = "hasilyolov12n/predictions.csv"
YOLO_FALLBACK_SOURCE = "RUNYOLO_FINALBISMILLAH/predictions_nms045/YOLOV12N_E150/predictions.csv"

GEAR_LABELS = {
    0: "drifting_longlines",
    1: "fixed_gear",
    2: "purse_seines",
    3: "trawlers",
}
GEAR_TO_ID = {label: idx for idx, label in GEAR_LABELS.items()}

SEQ_FEATURE_COLS = [
    "speed",
    "vx",
    "vy",
    "dspeed",
    "accel",
    "dcourse",
    "turn_rate",
    "abs_dcourse",
    "step_km",
    "step_km_raw",
    "dt",
    "dt_raw_seconds",
    "dt_log",
    "implied_speed_knots_raw",
    "distance_from_shore",
    "distance_from_port",
    "pos_speed_knots",
    "dpos_speed",
    "pos_bearing_sin",
    "pos_bearing_cos",
    "bearing_error",
    "curvature",
    "pos_speed_ma5",
    "pos_speed_std5",
    "abs_turn_ma5",
    "curvature_ma5",
]

GODARK_FEATURE_COLS = [c for c in SEQ_FEATURE_COLS if c not in {"distance_from_shore", "distance_from_port"}]

SPOOFING_CONTEXT_FEATURE_COLS = [
    "claimed_identity_registered",
    "claimed_history_age_log_hours",
    "claimed_prev_dt_log_hours",
    "claimed_prev_distance_log_km",
    "claimed_prev_implied_speed_log_knots",
    "claimed_concurrent_reports_log1p",
    "claimed_concurrent_spread_log_km",
    "claimed_revisit_lag_log_hours",
    "claimed_revisit_score",
]

SPOOFING_FEATURE_COLS = SEQ_FEATURE_COLS + SPOOFING_CONTEXT_FEATURE_COLS

TRANS_FEATURE_COLS = [
    "event_mode_id",
    "distance_between_km",
    "speed_a",
    "speed_b",
    "speed_pair_mean",
    "relative_speed_knots",
    "course_diff_deg",
    "same_direction_score",
    "lat_mid",
    "lon_mid",
    "shore_km_min",
    "port_km_min",
    "duration_nearby_minutes",
    "event_duration_minutes",
    "both_slow",
    "is_offshore",
    "is_port_far",
    "is_fishing_a",
    "is_fishing_b",
    "gear_a_id",
    "gear_b_id",
    "loitering_spatial_range_km",
    "loitering_start_end_km",
    "loitering_compactness",
    "loitering_turn_rate_abs",
    "loitering_duration_minutes",
    "valid_point",
]


@dataclass
class SequenceConfig:
    task: str
    seq_len: int
    stride: int
    feature_cols: list[str]
    gap_seconds: int = 10800
    apply_jump_filter: bool = True
    max_implied_knots: float = 42.0
    max_speed_knots: float = 50.0
    use_operational_filter: bool = False
    op_speed_min: float = 1.0
    op_speed_max: float = 12.0
    godark_min_distance_from_shore_nm: float = 5.0
    godark_ping_window_seconds: int = 12 * 3600
    godark_min_ping_count_prev_window: int = 3


@dataclass
class ModelMember:
    pipeline: str
    path: str
    model: nn.Module
    scaler: object
    checkpoint: dict
    seed: int | None = None
    fold: int | None = None


class AttentionPool(nn.Module):
    def __init__(self, dim: int, dropout: float = 0.2):
        super().__init__()
        self.scorer = nn.Sequential(
            nn.Linear(dim, dim),
            nn.Tanh(),
            nn.Dropout(dropout),
            nn.Linear(dim, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        a = self.scorer(x).squeeze(-1)
        w = torch.softmax(a, dim=1).unsqueeze(-1)
        return (x * w).sum(dim=1)


class TemporalSelfAttention(nn.Module):
    def __init__(self, dim: int, num_heads: int = 4, dropout: float = 0.2):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim)
        self.attn = nn.MultiheadAttention(
            embed_dim=dim,
            num_heads=max(1, int(num_heads)),
            dropout=float(dropout),
            batch_first=True,
        )
        self.drop = nn.Dropout(dropout)
        self.norm2 = nn.LayerNorm(dim)
        self.ffn = nn.Sequential(
            nn.Linear(dim, dim * 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(dim * 2, dim),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.norm1(x)
        attn_out, _ = self.attn(z, z, z, need_weights=False)
        x = x + self.drop(attn_out)
        x = x + self.ffn(self.norm2(x))
        return x


class CosineClassifier(nn.Module):
    def __init__(self, in_dim: int, num_classes: int, scale: float = 30.0):
        super().__init__()
        self.W = nn.Parameter(torch.randn(num_classes, in_dim))
        self.scale = float(scale)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.normalize(x, dim=1)
        w = F.normalize(self.W, dim=1)
        return (x @ w.t()) * self.scale


class LSTMClassifier(nn.Module):
    def __init__(
        self,
        input_size: int,
        hidden_size: int,
        num_layers: int,
        num_classes: int,
        dropout: float = 0.40,
        bidirectional: bool = True,
        input_proj_dim: int | None = None,
        embed_dim: int | None = None,
        attention_heads: int = 0,
        attention_layers: int = 0,
        predict_coords: bool = False,
        context_summary: bool = False,
    ):
        super().__init__()
        proj_dim = max(input_size, int(input_proj_dim)) if input_proj_dim is not None else max(64, min(128, input_size * 8))
        self.in_proj = nn.Sequential(
            nn.Linear(input_size, proj_dim),
            nn.GELU(),
            nn.Dropout(dropout),
        )
        self.lstm = nn.LSTM(
            input_size=proj_dim,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0.0,
            bidirectional=bidirectional,
        )
        out_dim = hidden_size * (2 if bidirectional else 1)
        heads = int(max(0, attention_heads))
        if heads > 0 and out_dim % heads != 0:
            divisors = [h for h in range(min(heads, out_dim), 0, -1) if out_dim % h == 0]
            heads = divisors[0] if divisors else 1
        self.self_attn = nn.Sequential(
            *[TemporalSelfAttention(out_dim, num_heads=heads, dropout=dropout) for _ in range(int(max(0, attention_layers if heads > 0 else 0)))]
        )
        self.attn = AttentionPool(out_dim, dropout=dropout)
        self.context_summary = bool(context_summary)
        if self.context_summary:
            context_in_dim = input_size * 5
            self.context_proj = nn.Sequential(
                nn.LayerNorm(context_in_dim),
                nn.Linear(context_in_dim, out_dim),
                nn.GELU(),
                nn.Dropout(dropout),
            )
        else:
            self.context_proj = None
        pooled_dim = out_dim * (5 if self.context_summary else 4)
        self.norm = nn.LayerNorm(pooled_dim)
        self.pooled_dropout = nn.Dropout(dropout)
        emb_dim = max(num_classes, int(embed_dim)) if embed_dim is not None else max(192, min(320, pooled_dim // 2))
        self.embed = nn.Sequential(
            nn.Linear(pooled_dim, emb_dim),
            nn.GELU(),
            nn.Dropout(dropout),
        )
        self.head = CosineClassifier(emb_dim, num_classes, scale=30.0)
        self.predict_coords = bool(predict_coords)
        self.geo_head = None
        if self.predict_coords:
            geo_hidden = max(64, min(256, emb_dim // 2))
            self.geo_head = nn.Sequential(
                nn.LayerNorm(emb_dim),
                nn.Dropout(dropout),
                nn.Linear(emb_dim, geo_hidden),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Linear(geo_hidden, 2),
            )

    def forward_features(self, x: torch.Tensor) -> torch.Tensor:
        raw_x = x
        x = self.in_proj(raw_x)
        out, _ = self.lstm(x)
        out = self.self_attn(out)
        last = out[:, -1, :]
        mean = out.mean(dim=1)
        mx = out.max(dim=1).values
        att = self.attn(out)
        pooled = [att, mean, mx, last]
        if self.context_proj is not None:
            center = max(1, int(raw_x.shape[1] // 2))
            pre = raw_x[:, :center, :]
            post = raw_x[:, center:, :]
            context = torch.cat(
                [
                    raw_x[:, center, :],
                    pre.mean(dim=1),
                    post.mean(dim=1),
                    pre.std(dim=1, unbiased=False),
                    post.std(dim=1, unbiased=False),
                ],
                dim=1,
            )
            pooled.append(self.context_proj(context))
        feat = torch.cat(pooled, dim=1)
        feat = self.norm(feat)
        feat = self.pooled_dropout(feat)
        return self.embed(feat)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.forward_features(x))


def log(msg: str) -> None:
    print(msg, flush=True)


def norm_mmsi(value: object) -> str:
    if value is None or pd.isna(value):
        return ""
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    numeric = pd.to_numeric(pd.Series([text]), errors="coerce").iloc[0]
    if pd.notna(numeric):
        return str(int(round(float(numeric))))
    return text


def first_existing(df: pd.DataFrame, names: list[str]) -> str | None:
    lower = {c.lower(): c for c in df.columns}
    for name in names:
        if name in df.columns:
            return name
        if name.lower() in lower:
            return lower[name.lower()]
    return None


def timestamp_to_epoch_seconds(series: pd.Series) -> pd.Series:
    numeric = pd.to_numeric(series, errors="coerce")
    if numeric.notna().mean() >= 0.8:
        out = numeric.astype(float)
        med = out.dropna().median() if out.notna().any() else 0
        if med > 1e12:
            out = out / 1000.0
        return out.round()
    dt = pd.to_datetime(series, errors="coerce", utc=True)
    return (dt.astype("int64") / 1_000_000_000).where(dt.notna(), np.nan).round()


def iso_from_epoch(value: object) -> str:
    n = pd.to_numeric(pd.Series([value]), errors="coerce").iloc[0]
    if pd.isna(n):
        return ""
    return pd.to_datetime(float(n), unit="s", utc=True).isoformat().replace("+00:00", "Z")


def haversine_km_np(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    r = 6371.0088
    lat1r = np.deg2rad(lat1.astype(float))
    lat2r = np.deg2rad(lat2.astype(float))
    dlat = np.deg2rad(lat2.astype(float) - lat1.astype(float))
    dlon = np.deg2rad(lon2.astype(float) - lon1.astype(float))
    a = np.sin(dlat / 2.0) ** 2 + np.cos(lat1r) * np.cos(lat2r) * np.sin(dlon / 2.0) ** 2
    return 2.0 * r * np.arctan2(np.sqrt(a), np.sqrt(np.maximum(0.0, 1.0 - a)))


def bearing_deg_np(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    lat1r = np.deg2rad(lat1.astype(float))
    lat2r = np.deg2rad(lat2.astype(float))
    dlon = np.deg2rad(lon2.astype(float) - lon1.astype(float))
    y = np.sin(dlon) * np.cos(lat2r)
    x = np.cos(lat1r) * np.sin(lat2r) - np.sin(lat1r) * np.cos(lat2r) * np.cos(dlon)
    return (np.rad2deg(np.arctan2(y, x)) + 360.0) % 360.0


def angle_diff_deg(a: object, b: object) -> np.ndarray:
    return ((np.asarray(a, dtype=float) - np.asarray(b, dtype=float) + 180.0) % 360.0) - 180.0


def distance_col_km(values: pd.Series, n: int) -> pd.Series:
    s = pd.to_numeric(values, errors="coerce")
    finite = s[np.isfinite(s)]
    if finite.empty:
        return pd.Series(np.full(n, -1.0), index=values.index)
    # GFW distance_from_shore/port in Fifi data is in meters.
    if float(finite.median()) > 1000.0:
        s = s / 1000.0
    return s.replace([np.inf, -np.inf], np.nan).fillna(-1.0)


def load_ais_data(input_dir: Path) -> pd.DataFrame:
    csvs = [
        input_dir / "drifting_longlines.csv",
        input_dir / "fixed_gear.csv",
        input_dir / "purse_seines.csv",
        input_dir / "trawlers.csv",
    ]
    parts: list[pd.DataFrame] = []
    for path in csvs:
        if not path.exists():
            raise FileNotFoundError(f"AIS source CSV not found: {path}")
        raw = pd.read_csv(path, low_memory=False)
        mmsi_col = first_existing(raw, ["mmsi", "MMSI", "ssvid"])
        time_col = first_existing(raw, ["timestamp", "timestamp_utc", "time", "time_iso"])
        lat_col = first_existing(raw, ["lat", "ais_lat", "AIS_Latitude"])
        lon_col = first_existing(raw, ["lon", "ais_lon", "AIS_Longitude"])
        speed_col = first_existing(raw, ["speed", "sog", "Sog"])
        course_col = first_existing(raw, ["course", "cog", "Cog"])
        if not all([mmsi_col, time_col, lat_col, lon_col]):
            raise ValueError(f"Required AIS columns missing in {path}")
        gear = path.stem.strip().lower()
        out = pd.DataFrame(
            {
                "mmsi": raw[mmsi_col].map(norm_mmsi),
                "timestamp": timestamp_to_epoch_seconds(raw[time_col]),
                "lat": pd.to_numeric(raw[lat_col], errors="coerce"),
                "lon": pd.to_numeric(raw[lon_col], errors="coerce"),
                "speed": pd.to_numeric(raw[speed_col], errors="coerce") if speed_col else 0.0,
                "course": pd.to_numeric(raw[course_col], errors="coerce") if course_col else 0.0,
                "source_gear_file": gear,
                "distance_from_shore": pd.to_numeric(raw[first_existing(raw, ["distance_from_shore"])], errors="coerce")
                if first_existing(raw, ["distance_from_shore"]) else np.nan,
                "distance_from_port": pd.to_numeric(raw[first_existing(raw, ["distance_from_port"])], errors="coerce")
                if first_existing(raw, ["distance_from_port"]) else np.nan,
                "is_fishing": pd.to_numeric(raw[first_existing(raw, ["is_fishing"])], errors="coerce")
                if first_existing(raw, ["is_fishing"]) else -1.0,
                "vessel_name": raw[first_existing(raw, ["vessel_name", "Name"])].astype(str)
                if first_existing(raw, ["vessel_name", "Name"]) else "",
            }
        )
        out = out[out["mmsi"] != ""].dropna(subset=["timestamp", "lat", "lon"]).copy()
        parts.append(out)
    df = pd.concat(parts, ignore_index=True, sort=False)
    df["timestamp"] = df["timestamp"].astype("int64")
    df["speed"] = pd.to_numeric(df["speed"], errors="coerce").fillna(0.0)
    df["course"] = pd.to_numeric(df["course"], errors="coerce").fillna(0.0) % 360.0
    df = df.sort_values(["mmsi", "timestamp"]).drop_duplicates(["mmsi", "timestamp"], keep="last").reset_index(drop=True)
    df["shore_km"] = distance_col_km(df["distance_from_shore"], len(df))
    df["port_km"] = distance_col_km(df["distance_from_port"], len(df))
    log(f"[AIS] rows={len(df)} mmsi={df['mmsi'].nunique()}")
    return df


def add_spoofing_observable_context(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    out = df.copy()
    stale_context = [
        column
        for column in SPOOFING_CONTEXT_FEATURE_COLS
        if column != "claimed_identity_registered" and column in out.columns
    ]
    if stale_context:
        out = out.drop(columns=stale_context)
    claimed = out["claimed_mmsi"].astype(str) if "claimed_mmsi" in out.columns else out["mmsi"].astype(str)
    out["_claimed_identity"] = claimed
    native = set(out["mmsi"].astype(str).tolist())
    out["claimed_identity_registered"] = claimed.isin(native).astype("float32")

    keys = ["_claimed_identity", "timestamp"]
    simultaneous_count = out.groupby(keys, sort=False)["mmsi"].transform("size")
    median_lat = out.groupby(keys, sort=False)["lat"].transform("median")
    median_lon = out.groupby(keys, sort=False)["lon"].transform("median")
    distance_to_center = haversine_km_np(
        out["lat"].to_numpy(dtype=float),
        out["lon"].to_numpy(dtype=float),
        median_lat.to_numpy(dtype=float),
        median_lon.to_numpy(dtype=float),
    )
    out["_simultaneous_distance_km"] = distance_to_center
    simultaneous_spread = out.groupby(keys, sort=False)["_simultaneous_distance_km"].transform("max")

    centroids = (
        out.groupby(keys, sort=False, as_index=False)
        .agg(_ctx_lat=("lat", "median"), _ctx_lon=("lon", "median"))
        .sort_values(["_claimed_identity", "timestamp"])
    )
    by_claim = centroids.groupby("_claimed_identity", sort=False)
    centroids["_prev_timestamp"] = by_claim["timestamp"].shift(1)
    centroids["_prev_lat"] = by_claim["_ctx_lat"].shift(1)
    centroids["_prev_lon"] = by_claim["_ctx_lon"].shift(1)
    centroids["_first_timestamp"] = by_claim["timestamp"].transform("min")

    prev_valid = centroids["_prev_timestamp"].notna()
    prev_distance = np.zeros(len(centroids), dtype=np.float64)
    if bool(prev_valid.any()):
        prev_distance[prev_valid.to_numpy()] = haversine_km_np(
            centroids.loc[prev_valid, "_prev_lat"].to_numpy(dtype=float),
            centroids.loc[prev_valid, "_prev_lon"].to_numpy(dtype=float),
            centroids.loc[prev_valid, "_ctx_lat"].to_numpy(dtype=float),
            centroids.loc[prev_valid, "_ctx_lon"].to_numpy(dtype=float),
        )
    prev_dt = (centroids["timestamp"] - centroids["_prev_timestamp"]).fillna(0.0).clip(lower=0.0).to_numpy(dtype=float)
    prev_speed_knots = np.divide(prev_distance * (3600.0 / 1.852), np.maximum(prev_dt, 1.0))

    revisit_lag = np.zeros(len(centroids), dtype=np.float64)
    for _, idx in centroids.groupby("_claimed_identity", sort=False).groups.items():
        last_seen: dict[tuple[int, int], float] = {}
        local = centroids.loc[list(idx)].sort_values("timestamp")
        for timestamp, rows in local.groupby("timestamp", sort=True):
            pending: list[tuple[int, int]] = []
            for row_idx, row in rows.iterrows():
                cell = (int(np.round(float(row["_ctx_lat"]) * 100.0)), int(np.round(float(row["_ctx_lon"]) * 100.0)))
                if cell in last_seen:
                    revisit_lag[int(row_idx)] = max(0.0, float(timestamp) - float(last_seen[cell]))
                pending.append(cell)
            for cell in pending:
                last_seen[cell] = float(timestamp)

    centroids["claimed_history_age_log_hours"] = np.log1p(((centroids["timestamp"] - centroids["_first_timestamp"]) / 3600.0).clip(lower=0.0))
    centroids["claimed_prev_dt_log_hours"] = np.log1p(prev_dt / 3600.0)
    centroids["claimed_prev_distance_log_km"] = np.log1p(np.clip(prev_distance, 0.0, 20000.0))
    centroids["claimed_prev_implied_speed_log_knots"] = np.log1p(np.clip(prev_speed_knots, 0.0, 10000.0))
    centroids["claimed_revisit_lag_log_hours"] = np.log1p(revisit_lag / 3600.0)
    centroids["claimed_revisit_score"] = (revisit_lag >= 3600.0).astype(np.float32)

    context_cols = [
        "claimed_history_age_log_hours",
        "claimed_prev_dt_log_hours",
        "claimed_prev_distance_log_km",
        "claimed_prev_implied_speed_log_knots",
        "claimed_revisit_lag_log_hours",
        "claimed_revisit_score",
    ]
    out = out.merge(centroids[keys + context_cols], on=keys, how="left", validate="many_to_one")
    out["claimed_concurrent_reports_log1p"] = np.log1p(simultaneous_count.to_numpy(dtype=float).clip(min=1.0) - 1.0).astype(np.float32)
    out["claimed_concurrent_spread_log_km"] = np.log1p(np.clip(simultaneous_spread.to_numpy(dtype=float), 0.0, 20000.0)).astype(np.float32)
    for column in SPOOFING_CONTEXT_FEATURE_COLS:
        out[column] = pd.to_numeric(out[column], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0).astype("float32")
    return out.drop(columns=["_claimed_identity", "_simultaneous_distance_km"])


def clean_and_derive(df: pd.DataFrame, cfg: SequenceConfig) -> pd.DataFrame:
    out = df.dropna(subset=["mmsi", "timestamp", "lat", "lon"]).copy()
    out["timestamp"] = timestamp_to_epoch_seconds(out["timestamp"]).astype("int64")
    out["mmsi"] = out["mmsi"].map(norm_mmsi)
    out["lat"] = pd.to_numeric(out["lat"], errors="coerce")
    out["lon"] = pd.to_numeric(out["lon"], errors="coerce")
    out = out.dropna(subset=["lat", "lon"]).copy()
    out = out[(out["lat"].between(-90, 90)) & (out["lon"].between(-180, 180))].copy()
    if cfg.task == "spoofing":
        out = add_spoofing_observable_context(out)
    out["speed"] = pd.to_numeric(out.get("speed", 0.0), errors="coerce").fillna(0.0)
    out["course"] = pd.to_numeric(out.get("course", 0.0), errors="coerce").fillna(0.0)
    out["distance_from_shore"] = pd.to_numeric(out.get("distance_from_shore", np.nan), errors="coerce").fillna(-1.0)
    out["distance_from_port"] = pd.to_numeric(out.get("distance_from_port", np.nan), errors="coerce").fillna(-1.0)
    out = out[(out["speed"] >= 0) & (out["speed"] <= cfg.max_speed_knots)].copy()
    if cfg.use_operational_filter:
        out = out[(out["speed"] >= cfg.op_speed_min) & (out["speed"] <= cfg.op_speed_max)].copy()
    out = out.sort_values(["mmsi", "timestamp"]).drop_duplicates(["mmsi", "timestamp"], keep="last")

    if cfg.task == "godark":
        out["_motion_segment"] = 0
        motion_group_cols = ["mmsi"]
    else:
        gap_break = out.groupby("mmsi", sort=False)["timestamp"].diff().gt(float(cfg.gap_seconds))
        out["_motion_segment"] = gap_break.groupby(out["mmsi"], sort=False).cumsum().fillna(0).astype("int64")
        motion_group_cols = ["mmsi", "_motion_segment"]

    motion_groups = out.groupby(motion_group_cols, sort=False)
    rolling_levels = list(range(len(motion_group_cols)))
    raw_dt = motion_groups["timestamp"].diff().fillna(1.0).astype("float32")
    out["dt_raw_seconds"] = raw_dt.clip(lower=1.0, upper=float(30 * 24 * 3600)).astype("float32")
    dt_clip_upper = float(cfg.gap_seconds)
    if cfg.task == "godark":
        dt_clip_upper = max(dt_clip_upper, float(7 * 24 * 3600))
    out["dt"] = raw_dt.clip(lower=1.0, upper=dt_clip_upper).astype("float32")
    course_deg = out["course"].astype("float32") % 360.0
    cr = np.deg2rad(course_deg)
    out["course_sin"] = np.sin(cr).astype("float32")
    out["course_cos"] = np.cos(cr).astype("float32")
    out["dspeed"] = motion_groups["speed"].diff().fillna(0).astype("float32")
    prev_course = motion_groups["course"].shift(1).astype("float32")
    dc = (course_deg - prev_course) % 360.0
    dc = ((dc + 180.0) % 360.0) - 180.0
    out["dcourse"] = dc.fillna(0).astype("float32")
    out["abs_dcourse"] = np.abs(out["dcourse"]).astype("float32")

    prev_lat = motion_groups["lat"].shift(1)
    prev_lon = motion_groups["lon"].shift(1)
    mask = prev_lat.notna() & prev_lon.notna()
    step_km = np.zeros(len(out), dtype=np.float32)
    if mask.any():
        step_km[mask.to_numpy()] = haversine_km_np(
            prev_lat[mask].to_numpy(),
            prev_lon[mask].to_numpy(),
            out.loc[mask, "lat"].to_numpy(),
            out.loc[mask, "lon"].to_numpy(),
        ).astype(np.float32)
    out["step_km_raw"] = np.clip(step_km, 0.0, 500.0).astype(np.float32)
    out["step_km"] = np.clip(step_km, 0.0, 25.0).astype(np.float32)
    out["dt_log"] = np.log1p(out["dt"].astype("float32")).astype("float32")
    implied_raw = (out["step_km_raw"] / out["dt"].clip(lower=1.0)) * (3600.0 / 1.852)
    out["implied_speed_knots_raw"] = implied_raw.clip(0.0, 500.0).astype("float32")
    spd = out["speed"].astype("float32")
    out["vx"] = (spd * out["course_cos"]).astype("float32")
    out["vy"] = (spd * out["course_sin"]).astype("float32")
    dt = out["dt"].astype("float32")
    out["accel"] = (out["dspeed"] / dt * 60.0).astype("float32").clip(-30.0, 30.0)
    out["turn_rate"] = (out["dcourse"] / dt * 60.0).astype("float32").clip(-180.0, 180.0)
    pos_speed = (out["step_km"] / out["dt"].clip(lower=1.0)) * (3600.0 / 1.852)
    out["pos_speed_knots"] = pos_speed.clip(0.0, cfg.max_speed_knots).astype("float32")
    out["dpos_speed"] = out.groupby(motion_group_cols, sort=False)["pos_speed_knots"].diff().fillna(0).astype("float32")

    pos_bearing = np.zeros(len(out), dtype=np.float32)
    if mask.any():
        pos_bearing[mask.to_numpy()] = bearing_deg_np(
            prev_lat[mask].to_numpy(),
            prev_lon[mask].to_numpy(),
            out.loc[mask, "lat"].to_numpy(),
            out.loc[mask, "lon"].to_numpy(),
        ).astype(np.float32)
    pos_bearing = (pos_bearing % 360.0).astype(np.float32)
    br = np.deg2rad(pos_bearing.astype(np.float32))
    out["pos_bearing_sin"] = np.sin(br).astype("float32")
    out["pos_bearing_cos"] = np.cos(br).astype("float32")
    out.loc[~mask, ["pos_bearing_sin", "pos_bearing_cos"]] = 0.0
    berr = np.zeros(len(out), dtype=np.float32)
    if mask.any():
        berr_valid = (course_deg.loc[mask].to_numpy(dtype=np.float32) - pos_bearing[mask.to_numpy()]) % 360.0
        berr[mask.to_numpy()] = ((berr_valid + 180.0) % 360.0) - 180.0
    out["bearing_error"] = berr.astype("float32")
    out["curvature"] = (out["abs_dcourse"] / (out["step_km"] + 1e-3)).clip(0.0, 500.0).astype("float32")

    g = out.groupby(motion_group_cols, sort=False)
    out["pos_speed_ma5"] = g["pos_speed_knots"].rolling(5, min_periods=1).mean().reset_index(level=rolling_levels, drop=True).astype("float32")
    out["pos_speed_std5"] = g["pos_speed_knots"].rolling(5, min_periods=1).std().reset_index(level=rolling_levels, drop=True).fillna(0.0).astype("float32")
    abs_turn = out["turn_rate"].abs().astype("float32")
    out["abs_turn_ma5"] = abs_turn.groupby([out[c] for c in motion_group_cols], sort=False).rolling(5, min_periods=1).mean().reset_index(level=rolling_levels, drop=True).astype("float32")
    out["curvature_ma5"] = g["curvature"].rolling(5, min_periods=1).mean().reset_index(level=rolling_levels, drop=True).astype("float32")
    out["pos_speed_std5"] = out["pos_speed_std5"].clip(0.0, 20.0)
    out["abs_turn_ma5"] = out["abs_turn_ma5"].clip(0.0, 180.0)
    out["curvature_ma5"] = out["curvature_ma5"].clip(0.0, 500.0)
    for col in cfg.feature_cols:
        out[col] = pd.to_numeric(out[col], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0).astype("float32")
    return out


def filter_jumps(df: pd.DataFrame, cfg: SequenceConfig) -> pd.DataFrame:
    if len(df) < 2:
        return df
    keep = np.ones(len(df), dtype=bool)
    for _, g in df.groupby("mmsi", sort=False):
        idx = g.index.to_numpy()
        if len(idx) < 2:
            continue
        ts = g["timestamp"].to_numpy(dtype=float)
        dt = ts[1:] - ts[:-1]
        valid = (dt > 0) & (dt <= cfg.gap_seconds)
        if not valid.any():
            continue
        d_km = haversine_km_np(
            g["lat"].to_numpy(dtype=float)[:-1][valid],
            g["lon"].to_numpy(dtype=float)[:-1][valid],
            g["lat"].to_numpy(dtype=float)[1:][valid],
            g["lon"].to_numpy(dtype=float)[1:][valid],
        )
        implied_knots = (d_km / dt[valid]) * 3600.0 / 1.852
        bad_pos = np.where(valid)[0][implied_knots > cfg.max_implied_knots]
        keep[idx[bad_pos + 1]] = False
    return df.loc[keep].copy()


def build_sliding_sequences(df: pd.DataFrame, cfg: SequenceConfig) -> tuple[np.ndarray, pd.DataFrame]:
    features = clean_and_derive(df, cfg)
    if cfg.apply_jump_filter:
        filtered = filter_jumps(features, cfg)
        if len(filtered) != len(features):
            features = clean_and_derive(filtered, cfg)
    rows: list[dict] = []
    seqs: list[np.ndarray] = []
    for (mmsi, seg), g in features.groupby(["mmsi", "_motion_segment"], sort=False):
        g = g.sort_values("timestamp").reset_index(drop=True)
        if len(g) < cfg.seq_len:
            continue
        feat = g[cfg.feature_cols].to_numpy(dtype=np.float32)
        for start in range(0, len(g) - cfg.seq_len + 1, max(1, cfg.stride)):
            end = start + cfg.seq_len
            seqs.append(feat[start:end])
            rows.append(
                {
                    "mmsi": str(mmsi),
                    "timestamp_start": int(g.loc[start, "timestamp"]),
                    "timestamp_end": int(g.loc[end - 1, "timestamp"]),
                    "lat": float(g.loc[end - 1, "lat"]),
                    "lon": float(g.loc[end - 1, "lon"]),
                    "window_index": len(rows),
                }
            )
    X = np.stack(seqs).astype(np.float32) if seqs else np.zeros((0, cfg.seq_len, len(cfg.feature_cols)), dtype=np.float32)
    return X, pd.DataFrame(rows)


def build_godark_gap_sequences(df: pd.DataFrame, cfg: SequenceConfig) -> tuple[np.ndarray, pd.DataFrame]:
    features = clean_and_derive(df, cfg)
    features["distance_from_shore_km_normalized"] = distance_col_km(features["distance_from_shore"], len(features))
    rows: list[dict] = []
    seqs: list[np.ndarray] = []
    pre_len = cfg.seq_len // 2
    post_len = cfg.seq_len - pre_len
    min_shore_km = float(cfg.godark_min_distance_from_shore_nm) * 1.852
    for mmsi, g in features.groupby("mmsi", sort=False):
        g = g.sort_values("timestamp").reset_index(drop=True)
        if len(g) < cfg.seq_len:
            continue
        ts = g["timestamp"].to_numpy(dtype=np.int64)
        gap_idx = np.where(np.diff(ts) >= int(cfg.gap_seconds))[0]
        shore_km = g["distance_from_shore_km_normalized"].to_numpy(dtype=float)
        feat = g[cfg.feature_cols].to_numpy(dtype=np.float32)
        for order, x_raw in enumerate(gap_idx.tolist()):
            x = int(x_raw)
            pre_start = x - pre_len + 1
            post_end = x + 1 + post_len
            if pre_start < 0 or post_end > len(g):
                continue
            if min_shore_km > 0.0:
                boundary_shore = shore_km[[x, x + 1]]
                if (not np.all(np.isfinite(boundary_shore))) or float(np.min(boundary_shore)) < min_shore_km:
                    continue
            left_t = int(ts[x])
            ping_lo = int(np.searchsorted(ts, left_t - cfg.godark_ping_window_seconds, side="left"))
            ping_count = max(0, x - ping_lo)
            if ping_count < int(cfg.godark_min_ping_count_prev_window):
                continue
            seqs.append(np.concatenate([feat[pre_start : x + 1], feat[x + 1 : post_end]], axis=0))
            rows.append(
                {
                    "mmsi": str(mmsi),
                    "timestamp_start": int(ts[pre_start]),
                    "timestamp_end": int(ts[post_end - 1]),
                    "gap_start": int(ts[x]),
                    "gap_end": int(ts[x + 1]),
                    "gap_hours": float((ts[x + 1] - ts[x]) / 3600.0),
                    "lat": float(g.loc[x + 1, "lat"]),
                    "lon": float(g.loc[x + 1, "lon"]),
                    "event_id": f"gap::real::{mmsi}::{int(ts[x])}::{int(ts[x + 1])}",
                    "ping_count_prev_window": int(ping_count),
                    "window_index": len(rows),
                }
            )
    X = np.stack(seqs).astype(np.float32) if seqs else np.zeros((0, cfg.seq_len, len(cfg.feature_cols)), dtype=np.float32)
    return X, pd.DataFrame(rows)


def scaler_feature_count(scaler: object) -> int | None:
    for attr in ("n_features_in_",):
        if hasattr(scaler, attr):
            return int(getattr(scaler, attr))
    for attr in ("center_", "scale_", "mean_"):
        if hasattr(scaler, attr):
            return int(len(getattr(scaler, attr)))
    return None


def state_dict_from_checkpoint(checkpoint: object) -> dict:
    if isinstance(checkpoint, dict):
        for key in ("model_state", "model_state_dict", "state_dict"):
            if key in checkpoint:
                return checkpoint[key]
    if isinstance(checkpoint, dict):
        return checkpoint
    raise TypeError(f"Unsupported checkpoint object: {type(checkpoint)}")


def instantiate_from_checkpoint(ck: dict, state: dict) -> nn.Module:
    context_summary = bool(ck.get("context_summary", any(str(k).startswith("context_proj") for k in state.keys())))
    model = LSTMClassifier(
        input_size=int(ck["input_size"]),
        hidden_size=int(ck["hidden_size"]),
        num_layers=int(ck["num_layers"]),
        num_classes=int(ck["num_classes"]),
        dropout=float(ck.get("dropout", 0.4)),
        bidirectional=bool(ck.get("bidirectional", True)),
        input_proj_dim=int(ck["input_proj_dim"]) if ck.get("input_proj_dim") is not None else None,
        embed_dim=int(ck["embed_dim"]) if ck.get("embed_dim") is not None else None,
        attention_heads=int(ck.get("attention_heads", 0)),
        attention_layers=int(ck.get("attention_layers", 0)),
        predict_coords=bool(ck.get("predict_coords", False)),
        context_summary=context_summary,
    )
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


class H5ModelBundle:
    def __init__(self, path: Path):
        if not path.exists():
            raise FileNotFoundError(path)
        self.path = path

    def _read_bytes(self, files: h5py.Group, path: str) -> bytes:
        if path not in files:
            raise KeyError(f"H5 dataset not found: {path}")
        return bytes(files[path][()])

    def _read_json(self, files: h5py.Group, path: str) -> dict:
        raw = self._read_bytes(files, path).decode("utf-8-sig")
        return json.loads(raw)

    def _load_member(self, files: h5py.Group, pipeline: str, model_path: str, scaler_path: str, expected_features: int) -> ModelMember:
        ck = torch.load(io.BytesIO(self._read_bytes(files, model_path)), map_location="cpu", weights_only=False)
        if not isinstance(ck, dict):
            raise TypeError(f"Checkpoint is not a dict: {model_path}")
        state = state_dict_from_checkpoint(ck)
        model = instantiate_from_checkpoint(ck, state)
        scaler = joblib.load(io.BytesIO(self._read_bytes(files, scaler_path)))
        scaler_n = scaler_feature_count(scaler)
        input_size = int(ck["input_size"])
        if input_size != expected_features:
            raise ValueError(f"{pipeline} feature mismatch: checkpoint input_size={input_size}, expected={expected_features}")
        if scaler_n is not None and scaler_n != expected_features:
            raise ValueError(f"{pipeline} scaler mismatch: scaler_n={scaler_n}, expected={expected_features}")
        seed = None
        fold = None
        seed_match = re.search(r"seed_(\d+)", model_path)
        fold_match = re.search(r"fold_(\d+)", model_path)
        if seed_match:
            seed = int(seed_match.group(1))
        if fold_match:
            fold = int(fold_match.group(1))
        return ModelMember(pipeline, model_path, model, scaler, ck, seed=seed, fold=fold)

    def load(self) -> dict:
        with h5py.File(self.path, "r") as h5:
            pipelines = h5["pipelines"]
            gear_files = pipelines["gear"]["files"]
            godark_files = pipelines["godark"]["files"]
            spoof_files = pipelines["spoofing"]["files"]
            trans_files = pipelines["transshipment"]["files"]

            gear_members = [
                self._load_member(
                    gear_files,
                    "gear",
                    f"gear/model/ensemble/seed_{seed}/model.pt",
                    f"gear/model/ensemble/seed_{seed}/scaler.joblib",
                    len(SEQ_FEATURE_COLS),
                )
                for seed in [42, 43, 44, 45, 46]
            ]
            godark_members = [
                self._load_member(
                    godark_files,
                    "godark",
                    f"godark/model/ensemble/seed_{seed}/model.pt",
                    f"godark/model/ensemble/seed_{seed}/scaler.joblib",
                    len(GODARK_FEATURE_COLS),
                )
                for seed in [42, 43, 44]
            ]
            spoof_members = [
                self._load_member(
                    spoof_files,
                    "spoofing",
                    f"spoofing/source_model_files/seed_{seed}/model_spoofing/model.pt",
                    f"spoofing/source_model_files/seed_{seed}/model_spoofing/scaler.joblib",
                    len(SPOOFING_FEATURE_COLS),
                )
                for seed in [42, 43, 44]
            ]
            trans_members = [
                self._load_member(
                    trans_files,
                    "transshipment",
                    f"transshipment/model/ensemble/seed_{seed}/fold_{fold}/model.pt",
                    f"transshipment/model/ensemble/seed_{seed}/fold_{fold}/scaler.joblib",
                    len(TRANS_FEATURE_COLS),
                )
                for seed in [42, 43, 44]
                for fold in [0, 1, 2]
            ]
            godark_lock = self._read_json(godark_files, "godark/GODARK_MODEL_LOCK.json")
            godark_cal = joblib.load(io.BytesIO(self._read_bytes(godark_files, "godark/model/compact_h128_platt.joblib")))
            spoof_policy = self._read_json(spoof_files, "spoofing/validation/platt_scenario_policy.json")
            trans_lock = self._read_json(trans_files, "transshipment/validation/winner_internal_only.json")
            trans_cals = {
                seed: joblib.load(io.BytesIO(self._read_bytes(trans_files, f"transshipment/model/calibrators/syn125_seed_{seed}_platt.joblib")))
                for seed in [42, 43, 44]
            }
        log(
            "[H5] loaded strict state_dicts: "
            f"gear={len(gear_members)} godark={len(godark_members)} "
            f"spoofing={len(spoof_members)} transshipment={len(trans_members)}"
        )
        return {
            "gear": gear_members,
            "godark": godark_members,
            "godark_threshold": float(godark_lock["decision_threshold"]),
            "godark_calibrator": godark_cal["estimator"],
            "spoofing": spoof_members,
            "spoofing_policy": spoof_policy,
            "transshipment": trans_members,
            "transshipment_threshold": float(trans_lock["winner"]["threshold"]),
            "transshipment_calibrators": trans_cals,
        }


def transform_for_member(member: ModelMember, X: np.ndarray) -> np.ndarray:
    if X.ndim != 3:
        raise ValueError(f"{member.pipeline} X must be 3D, got {X.shape}")
    expected = int(member.checkpoint["input_size"])
    if X.shape[-1] != expected:
        raise ValueError(f"{member.pipeline} feature shape mismatch for {member.path}: {X.shape[-1]} != {expected}")
    flat = X.reshape(-1, X.shape[-1])
    flat_scaled = member.scaler.transform(flat)
    return flat_scaled.reshape(X.shape).astype(np.float32)


def predict_member(member: ModelMember, X: np.ndarray, batch_size: int = 256) -> np.ndarray:
    if len(X) == 0:
        return np.zeros((0, int(member.checkpoint["num_classes"])), dtype=np.float32)
    X_scaled = transform_for_member(member, X)
    probs: list[np.ndarray] = []
    with torch.no_grad():
        for start in range(0, len(X_scaled), batch_size):
            xb = torch.from_numpy(X_scaled[start : start + batch_size]).float()
            logits = member.model(xb)
            probs.append(torch.softmax(logits, dim=1).cpu().numpy())
    return np.vstack(probs).astype(np.float32)


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1.0 - 1e-6)
    return np.log(p / (1.0 - p))


def calibrate_sklearn(prob: np.ndarray, estimator: object) -> np.ndarray:
    z = logit(prob).reshape(-1, 1)
    return estimator.predict_proba(z)[:, 1].astype(float)


def calibrate_spoofing(prob: np.ndarray, policy: dict) -> np.ndarray:
    z = float(policy["platt_coefficient"]) * logit(prob) + float(policy["platt_intercept"])
    return (1.0 / (1.0 + np.exp(-z))).astype(float)


def aggregate_mmsi_probability(rows: pd.DataFrame, prob: np.ndarray, prob_col: str) -> dict[str, dict]:
    if rows.empty or len(prob) == 0:
        return {}
    tmp = rows.copy()
    tmp[prob_col] = prob
    out: dict[str, dict] = {}
    for mmsi, g in tmp.groupby("mmsi", sort=False):
        vals = g[prob_col].to_numpy(dtype=float)
        if len(vals) == 0:
            continue
        k = max(1, int(math.ceil(len(vals) * 0.10)))
        top_mean = float(np.sort(vals)[-k:].mean())
        best = g.iloc[int(np.argmax(vals))]
        out[str(mmsi)] = {
            prob_col: top_mean,
            "timestamp_start": int(g["timestamp_start"].min()),
            "timestamp_end": int(g["timestamp_end"].max()),
            "best_timestamp_end": int(best["timestamp_end"]),
            "lat": float(best.get("lat", np.nan)),
            "lon": float(best.get("lon", np.nan)),
            "windows": int(len(g)),
        }
    return out


def run_gear(models: dict, ais: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, dict]]:
    cfg = SequenceConfig("gear", 120, 6, SEQ_FEATURE_COLS, gap_seconds=43200, use_operational_filter=True)
    X, rows = build_sliding_sequences(ais, cfg)
    if len(X) == 0:
        log("[gear] no valid sequence")
        return rows, {}
    member_probs = [predict_member(member, X) for member in models["gear"]]
    probs = np.mean(member_probs, axis=0)
    labels = np.argmax(probs, axis=1)
    rows = rows.copy()
    for class_id, label in GEAR_LABELS.items():
        rows[f"gear_prob_{label}"] = probs[:, class_id]
    rows["gear_label"] = [GEAR_LABELS[int(x)] for x in labels]
    rows["gear_probability"] = probs[np.arange(len(probs)), labels]

    summary: dict[str, dict] = {}
    for mmsi, g in rows.groupby("mmsi", sort=False):
        class_scores = {label: float(g[f"gear_prob_{label}"].mean()) for label in GEAR_LABELS.values()}
        label = max(class_scores, key=class_scores.get)
        best = g.iloc[int(g["gear_probability"].to_numpy(dtype=float).argmax())]
        summary[str(mmsi)] = {
            "gear_label": label,
            "gear_probability": float(class_scores[label]),
            "gear_class_probabilities": class_scores,
            "timestamp_start": int(g["timestamp_start"].min()),
            "timestamp_end": int(g["timestamp_end"].max()),
            "lat": float(best.get("lat", np.nan)),
            "lon": float(best.get("lon", np.nan)),
            "windows": int(len(g)),
        }
    log(f"[gear] windows={len(rows)} mmsi={len(summary)}")
    return rows, summary


def run_godark(models: dict, ais: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, dict]]:
    cfg = SequenceConfig(
        "godark",
        120,
        3,
        GODARK_FEATURE_COLS,
        gap_seconds=10800,
        apply_jump_filter=False,
        godark_min_distance_from_shore_nm=5.0,
        godark_min_ping_count_prev_window=3,
    )
    X, rows = build_godark_gap_sequences(ais, cfg)
    if len(X) == 0:
        log("[godark] no observable gap sequence")
        return rows, {}
    raw = np.mean([predict_member(member, X)[:, 1] for member in models["godark"]], axis=0)
    calibrated = calibrate_sklearn(raw, models["godark_calibrator"])
    rows = rows.copy()
    rows["godark_probability_raw"] = raw
    rows["godark_probability"] = calibrated
    rows["godark_label"] = np.where(calibrated >= models["godark_threshold"], "go_dark", "normal")
    summary = aggregate_mmsi_probability(rows, calibrated, "godark_probability")
    for item in summary.values():
        item["godark_label"] = "go_dark" if item["godark_probability"] >= models["godark_threshold"] else "normal"
    log(f"[godark] windows={len(rows)} mmsi={len(summary)} threshold={models['godark_threshold']}")
    return rows, summary


def run_spoofing(models: dict, ais: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, dict]]:
    cfg = SequenceConfig("spoofing", 120, 6, SPOOFING_FEATURE_COLS, gap_seconds=10800)
    X, rows = build_sliding_sequences(ais, cfg)
    if len(X) == 0:
        log("[spoofing] no valid sequence")
        return rows, {}
    raw = np.mean([predict_member(member, X)[:, 1] for member in models["spoofing"]], axis=0)
    rows = rows.copy()
    rows["spoofing_probability_raw"] = raw
    grouped_raw = aggregate_mmsi_probability(rows, raw, "spoofing_probability_raw")
    summary: dict[str, dict] = {}
    for mmsi, item in grouped_raw.items():
        calibrated = float(calibrate_spoofing(np.array([item["spoofing_probability_raw"]]), models["spoofing_policy"])[0])
        summary[mmsi] = {
            **item,
            "spoofing_probability": calibrated,
            "spoofing_label": "spoofing" if calibrated >= float(models["spoofing_policy"]["threshold"]) else "normal",
        }
    rows["spoofing_probability"] = calibrate_spoofing(rows["spoofing_probability_raw"].to_numpy(dtype=float), models["spoofing_policy"])
    rows["spoofing_label"] = np.where(rows["spoofing_probability"] >= float(models["spoofing_policy"]["threshold"]), "spoofing", "normal")
    log(f"[spoofing] windows={len(rows)} mmsi={len(summary)} threshold={models['spoofing_policy']['threshold']}")
    return rows, summary


def vx(speed: float, course: float) -> float:
    return float(speed) * float(np.cos(np.deg2rad(course)))


def vy(speed: float, course: float) -> float:
    return float(speed) * float(np.sin(np.deg2rad(course)))


def min_valid(a: float, b: float) -> float:
    vals = [float(x) for x in [a, b] if np.isfinite(float(x)) and float(x) >= 0.0]
    return float(min(vals)) if vals else -1.0


def base_event_row(
    timestamp: int,
    event_mode_id: int,
    mmsi_a: str,
    mmsi_b: str,
    pair_id: str,
    lat_a: float,
    lon_a: float,
    lat_b: float,
    lon_b: float,
    speed_a: float,
    speed_b: float,
    course_a: float,
    course_b: float,
    shore_a: float,
    shore_b: float,
    port_a: float,
    port_b: float,
    is_fishing_a: float,
    is_fishing_b: float,
    gear_a_id: int,
    gear_b_id: int,
    gear_a_label: str,
    gear_b_label: str,
    distance_between_km: float,
) -> dict:
    course_diff = float(abs(angle_diff_deg(course_a, course_b)))
    rel_speed = float(np.hypot(vx(speed_a, course_a) - vx(speed_b, course_b), vy(speed_a, course_a) - vy(speed_b, course_b)))
    speed_pair = float((float(speed_a) + float(speed_b)) / 2.0)
    same_dir = float((np.cos(np.deg2rad(course_diff)) + 1.0) / 2.0)
    return {
        "event_id": "",
        "event_kind": "candidate",
        "timestamp": int(timestamp),
        "mmsi_a": norm_mmsi(mmsi_a),
        "mmsi_b": norm_mmsi(mmsi_b),
        "pair_id": str(pair_id),
        "lat_a": float(lat_a),
        "lon_a": float(lon_a),
        "lat_b": float(lat_b) if np.isfinite(float(lat_b)) else np.nan,
        "lon_b": float(lon_b) if np.isfinite(float(lon_b)) else np.nan,
        "gear_a_label": str(gear_a_label),
        "gear_b_label": str(gear_b_label),
        "event_mode_id": int(event_mode_id),
        "distance_between_km": float(distance_between_km),
        "speed_a": float(speed_a),
        "speed_b": float(speed_b),
        "speed_pair_mean": speed_pair,
        "relative_speed_knots": rel_speed,
        "course_diff_deg": course_diff,
        "same_direction_score": same_dir,
        "lat_mid": float((float(lat_a) + float(lat_b)) / 2.0) if np.isfinite(float(lat_b)) else float(lat_a),
        "lon_mid": float(((float(lon_a) + float(lon_b)) / 2.0 + 180.0) % 360.0 - 180.0) if np.isfinite(float(lon_b)) else float(lon_a),
        "shore_km_min": min_valid(shore_a, shore_b),
        "port_km_min": min_valid(port_a, port_b),
        "duration_nearby_minutes": 0.0,
        "event_duration_minutes": 0.0,
        "both_slow": 0,
        "is_offshore": 0,
        "is_port_far": 0,
        "is_fishing_a": float(is_fishing_a),
        "is_fishing_b": float(is_fishing_b),
        "gear_a_id": int(gear_a_id),
        "gear_b_id": int(gear_b_id),
        "loitering_spatial_range_km": 0.0,
        "loitering_start_end_km": 0.0,
        "loitering_compactness": 0.0,
        "loitering_turn_rate_abs": 0.0,
        "loitering_duration_minutes": 0.0,
        "valid_point": 1.0,
    }


def duration_minutes(seg: pd.DataFrame, grid_minutes: int) -> float:
    if seg.empty:
        return 0.0
    if len(seg) == 1:
        return float(grid_minutes)
    return float((int(seg["timestamp"].iloc[-1]) - int(seg["timestamp"].iloc[0])) / 60.0 + float(grid_minutes))


def regularize_vessels(ais: pd.DataFrame, gear_by_mmsi: dict[str, dict]) -> pd.DataFrame:
    parts: list[pd.DataFrame] = []
    grid_sec = 10 * 60
    max_gap = 90 * 60
    for mmsi, g in ais.groupby("mmsi", sort=False):
        if len(g) < 40:
            continue
        g = g.sort_values("timestamp").drop_duplicates("timestamp", keep="last").reset_index(drop=True)
        ts = g["timestamp"].to_numpy(dtype=np.int64)
        if len(ts) < 2:
            continue
        start = int(np.ceil(ts[0] / grid_sec) * grid_sec)
        end = int(np.floor(ts[-1] / grid_sec) * grid_sec)
        if end < start:
            continue
        grid = np.arange(start, end + grid_sec, grid_sec, dtype=np.int64)
        idx = np.searchsorted(ts, grid, side="left")
        exact = (idx < len(ts)) & (ts[np.clip(idx, 0, len(ts) - 1)] == grid)
        lo = np.where(exact, idx, idx - 1)
        hi = np.where(exact, idx, idx)
        valid = (lo >= 0) & (hi < len(ts))
        lo, hi, grid = lo[valid], hi[valid], grid[valid]
        if len(grid) == 0:
            continue
        dt = (ts[hi] - ts[lo]).astype(float)
        valid_gap = (dt <= max_gap) | (dt == 0.0)
        lo, hi, grid, dt = lo[valid_gap], hi[valid_gap], grid[valid_gap], dt[valid_gap]
        if len(grid) == 0:
            continue
        frac = np.zeros_like(dt, dtype=float)
        nz = dt > 0.0
        frac[nz] = (grid[nz] - ts[lo[nz]]) / dt[nz]
        frac = np.clip(frac, 0.0, 1.0)

        def interp(col: str) -> np.ndarray:
            vals = g[col].to_numpy(dtype=float)
            return vals[lo] * (1.0 - frac) + vals[hi] * frac

        course = g["course"].to_numpy(dtype=float)
        rad = np.deg2rad(course % 360.0)
        s = np.sin(rad)
        c = np.cos(rad)
        si = s[lo] * (1.0 - frac) + s[hi] * frac
        ci = c[lo] * (1.0 - frac) + c[hi] * frac
        gear_label = gear_by_mmsi.get(str(mmsi), {}).get("gear_label", "")
        gear_id = GEAR_TO_ID.get(str(gear_label), -1)
        out = pd.DataFrame(
            {
                "timestamp": grid.astype(np.int64),
                "mmsi": str(mmsi),
                "lat": interp("lat"),
                "lon": ((interp("lon") + 180.0) % 360.0) - 180.0,
                "speed": interp("speed"),
                "course": (np.rad2deg(np.arctan2(si, ci)) + 360.0) % 360.0,
                "shore_km": interp("shore_km"),
                "port_km": interp("port_km"),
                "is_fishing": interp("is_fishing"),
                "gear_id": int(gear_id),
                "gear_label": str(gear_label or "unknown"),
            }
        )
        parts.append(out.replace([np.inf, -np.inf], np.nan).dropna(subset=["lat", "lon", "speed", "course"]))
    return pd.concat(parts, ignore_index=True, sort=False).sort_values(["timestamp", "mmsi"]).reset_index(drop=True) if parts else pd.DataFrame()


def build_transshipment_event_rows(ais: pd.DataFrame, gear_by_mmsi: dict[str, dict]) -> pd.DataFrame:
    reg = regularize_vessels(ais, gear_by_mmsi)
    if reg.empty:
        return pd.DataFrame()
    parts: list[pd.DataFrame] = []
    event_no = 0
    # Real encounter candidates from AIS time alignment.
    for ts, tg in reg.groupby("timestamp", sort=True):
        if len(tg) < 2:
            continue
        rows = tg.reset_index(drop=True)
        for i in range(len(rows) - 1):
            a = rows.iloc[i]
            for j in range(i + 1, len(rows)):
                b = rows.iloc[j]
                d = float(haversine_km_np(np.array([a["lat"]]), np.array([a["lon"]]), np.array([b["lat"]]), np.array([b["lon"]]))[0])
                if d > 2.0:
                    continue
                pair_id = "__".join(sorted([str(a["mmsi"]), str(b["mmsi"])]))
                parts.append(
                    pd.DataFrame(
                        [
                            base_event_row(
                                timestamp=int(ts),
                                event_mode_id=1,
                                mmsi_a=str(a["mmsi"]),
                                mmsi_b=str(b["mmsi"]),
                                pair_id=pair_id,
                                lat_a=float(a["lat"]),
                                lon_a=float(a["lon"]),
                                lat_b=float(b["lat"]),
                                lon_b=float(b["lon"]),
                                speed_a=float(a["speed"]),
                                speed_b=float(b["speed"]),
                                course_a=float(a["course"]),
                                course_b=float(b["course"]),
                                shore_a=float(a["shore_km"]),
                                shore_b=float(b["shore_km"]),
                                port_a=float(a["port_km"]),
                                port_b=float(b["port_km"]),
                                is_fishing_a=float(a["is_fishing"]),
                                is_fishing_b=float(b["is_fishing"]),
                                gear_a_id=int(a["gear_id"]),
                                gear_b_id=int(b["gear_id"]),
                                gear_a_label=str(a["gear_label"]),
                                gear_b_label=str(b["gear_label"]),
                                distance_between_km=d,
                            )
                        ]
                    )
                )
    encounter_df = pd.concat(parts, ignore_index=True, sort=False) if parts else pd.DataFrame()
    event_parts: list[pd.DataFrame] = []
    if not encounter_df.empty:
        for pair_id, g in encounter_df.sort_values("timestamp").groupby("pair_id", sort=False):
            gaps = g["timestamp"].diff().fillna(0).to_numpy(dtype=float) > 30 * 60
            seg_ids = np.cumsum(gaps.astype(int))
            for _, seg in g.groupby(seg_ids, sort=False):
                seg = seg.sort_values("timestamp").reset_index(drop=True)
                dur = duration_minutes(seg, 10)
                if dur < 30.0:
                    continue
                event_no += 1
                seg["event_id"] = f"real_encounter_{event_no:06d}"
                seg["event_kind"] = "encounter"
                seg["duration_nearby_minutes"] = float(dur)
                seg["event_duration_minutes"] = float(dur)
                seg["both_slow"] = (seg[["speed_a", "speed_b"]].max(axis=1).to_numpy(dtype=float) <= 2.0).astype(int)
                seg["is_port_far"] = (seg["port_km_min"].to_numpy(dtype=float) >= 10.0).astype(int)
                seg["is_offshore"] = (seg["shore_km_min"].to_numpy(dtype=float) >= 20.0 * 1.852).astype(int)
                event_parts.append(seg)

    # Real loitering candidates from AIS.
    for mmsi, vg in reg.groupby("mmsi", sort=False):
        vg = vg.sort_values("timestamp").reset_index(drop=True)
        offshore = (vg["shore_km"].to_numpy(dtype=float) >= 20.0 * 1.852) | (vg["shore_km"].to_numpy(dtype=float) < 0.0)
        candidate = (vg["speed"].to_numpy(dtype=float) <= 4.0) & offshore
        if not candidate.any():
            continue
        cand = vg.iloc[np.where(candidate)[0]].copy().reset_index(drop=True)
        gaps = cand["timestamp"].diff().fillna(0).to_numpy(dtype=float) > 30 * 60
        seg_ids = np.cumsum(gaps.astype(int))
        for _, raw_seg in cand.groupby(seg_ids, sort=False):
            raw_seg = raw_seg.sort_values("timestamp").reset_index(drop=True)
            dur = duration_minutes(raw_seg, 10)
            if dur < 30.0:
                continue
            lat = raw_seg["lat"].to_numpy(dtype=float)
            lon = raw_seg["lon"].to_numpy(dtype=float)
            track_km = float(np.nansum(haversine_km_np(lat[:-1], lon[:-1], lat[1:], lon[1:]))) if len(lat) >= 2 else 0.0
            start_end = float(haversine_km_np(np.array([lat[0]]), np.array([lon[0]]), np.array([lat[-1]]), np.array([lon[-1]]))[0]) if len(lat) >= 2 else 0.0
            compactness = float(start_end / max(track_km, 1e-6))
            center_d = haversine_km_np(np.full(len(lat), np.nanmean(lat)), np.full(len(lon), np.nanmean(lon)), lat, lon)
            spatial_range = float(np.nanmax(center_d) * 2.0) if len(center_d) else 0.0
            course = raw_seg["course"].to_numpy(dtype=float)
            turn_rate = float(np.nanmean(np.abs(angle_diff_deg(course[1:], course[:-1]))) / 10.0) if len(course) >= 2 else 0.0
            event_no += 1
            event_id = f"real_loitering_{event_no:06d}"
            rows = []
            for _, r in raw_seg.iterrows():
                rows.append(
                    base_event_row(
                        timestamp=int(r["timestamp"]),
                        event_mode_id=2,
                        mmsi_a=str(mmsi),
                        mmsi_b="",
                        pair_id=f"{mmsi}__loitering",
                        lat_a=float(r["lat"]),
                        lon_a=float(r["lon"]),
                        lat_b=np.nan,
                        lon_b=np.nan,
                        speed_a=float(r["speed"]),
                        speed_b=0.0,
                        course_a=float(r["course"]),
                        course_b=float(r["course"]),
                        shore_a=float(r["shore_km"]),
                        shore_b=np.nan,
                        port_a=float(r["port_km"]),
                        port_b=np.nan,
                        is_fishing_a=float(r["is_fishing"]),
                        is_fishing_b=-1.0,
                        gear_a_id=int(r["gear_id"]),
                        gear_b_id=-1,
                        gear_a_label=str(r["gear_label"]),
                        gear_b_label="none",
                        distance_between_km=0.0,
                    )
                )
            seg = pd.DataFrame(rows)
            seg["event_id"] = event_id
            seg["event_kind"] = "loitering"
            seg["event_duration_minutes"] = float(dur)
            seg["loitering_duration_minutes"] = float(dur)
            seg["loitering_spatial_range_km"] = float(spatial_range)
            seg["loitering_start_end_km"] = float(start_end)
            seg["loitering_compactness"] = float(np.clip(compactness, 0.0, 1.0))
            seg["loitering_turn_rate_abs"] = float(turn_rate)
            seg["is_offshore"] = (seg["shore_km_min"].to_numpy(dtype=float) >= 20.0 * 1.852).astype(int)
            event_parts.append(seg)

    if not event_parts:
        return pd.DataFrame()
    events = pd.concat(event_parts, ignore_index=True, sort=False)
    for col in TRANS_FEATURE_COLS:
        if col not in events.columns:
            events[col] = 0.0
        events[col] = pd.to_numeric(events[col], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    events["valid_point"] = 1.0
    return events.sort_values(["event_id", "timestamp"]).reset_index(drop=True)


def build_transshipment_sequences(events: pd.DataFrame, seq_len: int = 24, stride: int = 3) -> tuple[np.ndarray, pd.DataFrame]:
    if events.empty:
        return np.zeros((0, seq_len, len(TRANS_FEATURE_COLS)), dtype=np.float32), pd.DataFrame()
    rows: list[dict] = []
    seqs: list[np.ndarray] = []
    for event_id, g in events.groupby("event_id", sort=False):
        g = g.sort_values("timestamp").reset_index(drop=True)
        feat = g[TRANS_FEATURE_COLS].to_numpy(dtype=np.float32)
        if len(g) < seq_len:
            pad = seq_len - len(g)
            feat_pad = np.zeros((pad, len(TRANS_FEATURE_COLS)), dtype=np.float32)
            feat_pad[:, TRANS_FEATURE_COLS.index("valid_point")] = 0.0
            window = np.concatenate([feat, feat_pad], axis=0)
            seqs.append(window)
            rows.append(
                {
                    "event_id": event_id,
                    "mmsi": norm_mmsi(g["mmsi_a"].iloc[0]),
                    "neighbor_mmsi": norm_mmsi(g["mmsi_b"].iloc[0]),
                    "timestamp_start": int(g["timestamp"].min()),
                    "timestamp_end": int(g["timestamp"].max()),
                    "lat": float(g["lat_mid"].iloc[-1]),
                    "lon": float(g["lon_mid"].iloc[-1]),
                    "event_kind": str(g["event_kind"].iloc[0]),
                    "window_index": len(rows),
                }
            )
            continue
        for start in range(0, len(g) - seq_len + 1, stride):
            end = start + seq_len
            seqs.append(feat[start:end])
            rows.append(
                {
                    "event_id": event_id,
                    "mmsi": norm_mmsi(g["mmsi_a"].iloc[0]),
                    "neighbor_mmsi": norm_mmsi(g["mmsi_b"].iloc[0]),
                    "timestamp_start": int(g.loc[start, "timestamp"]),
                    "timestamp_end": int(g.loc[end - 1, "timestamp"]),
                    "lat": float(g.loc[end - 1, "lat_mid"]),
                    "lon": float(g.loc[end - 1, "lon_mid"]),
                    "event_kind": str(g["event_kind"].iloc[0]),
                    "window_index": len(rows),
                }
            )
    return np.stack(seqs).astype(np.float32), pd.DataFrame(rows)


def run_transshipment(models: dict, ais: pd.DataFrame, gear_summary: dict[str, dict]) -> tuple[pd.DataFrame, dict[str, dict]]:
    events = build_transshipment_event_rows(ais, gear_summary)
    X, rows = build_transshipment_sequences(events, seq_len=24, stride=3)
    if len(X) == 0:
        log("[transshipment] no real encounter/loitering sequence")
        return rows, {}
    by_seed: dict[int, list[np.ndarray]] = {}
    for member in models["transshipment"]:
        by_seed.setdefault(int(member.seed), []).append(predict_member(member, X)[:, 1])
    calibrated_seed_probs = []
    for seed, probs in sorted(by_seed.items()):
        raw_seed = np.mean(probs, axis=0)
        calibrator = models["transshipment_calibrators"][seed]["estimator"]
        calibrated_seed_probs.append(calibrate_sklearn(raw_seed, calibrator))
    calibrated = np.mean(calibrated_seed_probs, axis=0)
    rows = rows.copy()
    rows["transshipment_probability"] = calibrated
    rows["transshipment_label"] = np.where(calibrated >= models["transshipment_threshold"], "potential_transshipment", "normal")
    summary: dict[str, dict] = {}
    for event_id, g in rows.groupby("event_id", sort=False):
        vals = g["transshipment_probability"].to_numpy(dtype=float)
        best = g.iloc[int(np.argmax(vals))]
        key = f"{norm_mmsi(best['mmsi'])}|{norm_mmsi(best.get('neighbor_mmsi', ''))}|{event_id}"
        prob = float(vals.max())
        summary[key] = {
            "event_id": event_id,
            "mmsi": norm_mmsi(best["mmsi"]),
            "neighbor_mmsi": norm_mmsi(best.get("neighbor_mmsi", "")),
            "transshipment_probability": prob,
            "transshipment_label": "potential_transshipment" if prob >= models["transshipment_threshold"] else "normal",
            "timestamp_start": int(g["timestamp_start"].min()),
            "timestamp_end": int(g["timestamp_end"].max()),
            "lat": float(best.get("lat", np.nan)),
            "lon": float(best.get("lon", np.nan)),
            "event_kind": str(best.get("event_kind", "")),
            "windows": int(len(g)),
        }
    log(f"[transshipment] windows={len(rows)} events={len(summary)} threshold={models['transshipment_threshold']}")
    return rows, summary


def basename_key(value: object) -> str:
    text = str(value or "").strip().replace("\\", "/").split("/")[-1]
    text = re.sub(r"\.(png|jpg|jpeg|tif|tiff)$", "", text, flags=re.I)
    text = re.sub(r"(_vv_vh_rgb|_rgb|_vv|_vh)$", "", text, flags=re.I)
    return text.lower()


YOLO_PATCH_FIELDS = [
    "patch_rgb_vv_actual_file",
    "patch_rgb_vh_actual_file",
    "patch_uint8_vv_actual_file",
    "patch_uint8_vh_actual_file",
    "patch_vv_actual_file",
    "patch_vh_actual_file",
]


def yolo_source_label(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def candidate_patch_keys(row: pd.Series | dict) -> list[str]:
    keys: list[str] = []
    for field in YOLO_PATCH_FIELDS:
        value = row.get(field, "") if hasattr(row, "get") else ""
        if str(value or "").strip():
            key = basename_key(value)
            if key and key not in keys:
                keys.append(key)
    image_name = row.get("yolo_image_name", "") if hasattr(row, "get") else ""
    if str(image_name or "").strip():
        key = basename_key(image_name)
        if key and key not in keys:
            keys.append(key)
    return keys


def load_metadata(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(path)
    df = pd.read_csv(path, low_memory=False)
    if "MMSI" in df.columns:
        df["MMSI"] = df["MMSI"].map(norm_mmsi)
    return df


def load_candidates(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(path)
    df = pd.read_csv(path, low_memory=False)
    if "MMSI" in df.columns:
        df["MMSI"] = df["MMSI"].map(norm_mmsi)
    if "neighbor_mmsi" in df.columns:
        df["neighbor_mmsi"] = df["neighbor_mmsi"].map(norm_mmsi)
    return df


def metadata_patch_maps(metadata: pd.DataFrame) -> tuple[dict[str, str], dict[str, str], dict[str, pd.Series]]:
    meta_key_to_scene: dict[str, str] = {}
    meta_key_to_mmsi: dict[str, str] = {}
    meta_by_patch: dict[str, pd.Series] = {}
    for _, row in metadata.iterrows():
        for field in YOLO_PATCH_FIELDS:
            if field in metadata.columns and str(row.get(field, "")).strip():
                key = basename_key(row.get(field, ""))
                if key:
                    meta_key_to_scene[key] = str(row.get("scene", ""))
                    meta_key_to_mmsi[key] = norm_mmsi(row.get("MMSI", ""))
                    meta_by_patch[key] = row
    return meta_key_to_scene, meta_key_to_mmsi, meta_by_patch


def yolo_entry_from_row(row: pd.Series) -> dict:
    confidence = float(pd.to_numeric(pd.Series([row.get("confidence")]), errors="coerce").iloc[0])
    return {
        "yolo_class": str(row.get("pred_class_name", "")),
        "yolo_confidence": confidence,
        "yolo_bbox": f"{row.get('x1')},{row.get('y1')},{row.get('x2')},{row.get('y2')}",
        "yolo_image_name": str(row.get("image_name", "")),
        "yolo_patch_key": str(row.get("_patch_key", "")),
        "yolo_source": str(row.get("_source_label", "")),
        "_source_priority": int(row.get("_source_priority", 0)),
        "MMSI": str(row.get("_MMSI", "")),
    }


def load_yolo_predictions(yolo_paths: list[Path], metadata: pd.DataFrame) -> tuple[dict[str, dict], pd.DataFrame, dict[str, pd.Series]]:
    required = ["image_name", "pred_class_name", "confidence", "x1", "y1", "x2", "y2"]
    meta_key_to_scene, meta_key_to_mmsi, meta_by_patch = metadata_patch_maps(metadata)
    frames: list[pd.DataFrame] = []
    by_patch: dict[str, dict] = {}

    for priority, yolo_path in enumerate(yolo_paths):
        if not yolo_path.exists():
            log(f"[yolo] skip missing source: {yolo_path}")
            continue
        yolo = pd.read_csv(yolo_path, low_memory=False)
        missing = [c for c in required if c not in yolo.columns]
        if missing:
            raise ValueError(f"YOLO predictions missing required columns in {yolo_path}: {missing}")
        yolo["_source_priority"] = priority
        yolo["_source_label"] = yolo_source_label(yolo_path)
        yolo["_patch_key"] = yolo["image_name"].map(basename_key)
        yolo["_scene"] = yolo["_patch_key"].map(meta_key_to_scene).fillna("")
        yolo["_MMSI"] = yolo["_patch_key"].map(meta_key_to_mmsi).fillna("")
        frames.append(yolo)

        for _, row in yolo.iterrows():
            patch_key = str(row.get("_patch_key", ""))
            if not patch_key or not str(row.get("_scene", "")).strip():
                continue
            confidence = pd.to_numeric(pd.Series([row.get("confidence")]), errors="coerce").iloc[0]
            if pd.isna(confidence):
                continue
            entry = yolo_entry_from_row(row)
            current = by_patch.get(patch_key)
            if current is None:
                by_patch[patch_key] = entry
                continue
            current_priority = int(current.get("_source_priority", priority))
            if priority < current_priority or (
                priority == current_priority and float(entry.get("yolo_confidence", -1)) > float(current.get("yolo_confidence", -1))
            ):
                by_patch[patch_key] = entry

    if not frames:
        raise FileNotFoundError("No YOLO prediction CSV source exists")

    yolo_df = pd.concat(frames, ignore_index=True)
    if not by_patch:
        raise ValueError("YOLO join key mismatch: no YOLO image_name matched SAR metadata patch basenames")
    log(f"[yolo] sources={len(frames)} matched_patch_keys={len(by_patch)}")
    return by_patch, yolo_df, meta_by_patch


def yolo_for_row(row: pd.Series | dict, yolo_by_patch: dict[str, dict]) -> dict:
    for key in candidate_patch_keys(row):
        yolo = yolo_by_patch.get(key)
        if yolo:
            return yolo
    return {}


def score_for_rule_type(candidate_type: str, h5: dict) -> tuple[bool | None, float | None]:
    t = str(candidate_type or "").lower()
    if "dark" in t:
        p = h5.get("godark_probability")
        return (bool(h5.get("godark_label") == "go_dark"), p) if p != "" else (None, None)
    if "spoof" in t:
        p = h5.get("spoofing_probability")
        return (bool(h5.get("spoofing_label") == "spoofing"), p) if p != "" else (None, None)
    if "transship" in t:
        p = h5.get("transshipment_probability")
        return (bool(h5.get("transshipment_label") == "potential_transshipment"), p) if p != "" else (None, None)
    return (None, None)


def best_transshipment_for_pair(summary: dict[str, dict], mmsi: str, neighbor: str) -> dict | None:
    mmsi = norm_mmsi(mmsi)
    neighbor = norm_mmsi(neighbor)
    candidates = []
    for item in summary.values():
        a = norm_mmsi(item.get("mmsi"))
        b = norm_mmsi(item.get("neighbor_mmsi"))
        if neighbor:
            if {a, b} == {mmsi, neighbor}:
                candidates.append(item)
        elif a == mmsi:
            candidates.append(item)
    if not candidates:
        return None
    return max(candidates, key=lambda x: float(x.get("transshipment_probability", -1)))


def h5_values_for_row(row: pd.Series, gear_summary: dict, godark_summary: dict, spoofing_summary: dict, trans_summary: dict) -> dict:
    mmsi = norm_mmsi(row.get("MMSI", row.get("mmsi", "")))
    neighbor = norm_mmsi(row.get("neighbor_mmsi", ""))
    gear = gear_summary.get(mmsi, {})
    godark = godark_summary.get(mmsi, {})
    spoof = spoofing_summary.get(mmsi, {})
    trans = best_transshipment_for_pair(trans_summary, mmsi, neighbor) or {}
    return {
        "gear_label": gear.get("gear_label", ""),
        "gear_probability": gear.get("gear_probability", ""),
        "godark_probability": godark.get("godark_probability", ""),
        "godark_label": godark.get("godark_label", ""),
        "spoofing_probability": spoof.get("spoofing_probability", ""),
        "spoofing_label": spoof.get("spoofing_label", ""),
        "transshipment_probability": trans.get("transshipment_probability", ""),
        "transshipment_label": trans.get("transshipment_label", ""),
        "transshipment_event_id": trans.get("event_id", ""),
    }


def h5_inference_status(values: dict) -> str:
    status = []
    status.append("gear=available" if values.get("gear_label") else "gear=not_available")
    status.append("godark=available" if values.get("godark_probability") != "" else "godark=not_available")
    status.append("spoofing=available" if values.get("spoofing_probability") != "" else "spoofing=not_available")
    status.append("transshipment=available" if values.get("transshipment_probability") != "" else "transshipment=not_available")
    return ";".join(status)


def build_outputs(
    candidates: pd.DataFrame,
    metadata: pd.DataFrame,
    yolo_by_patch: dict[str, dict],
    yolo_df: pd.DataFrame,
    yolo_meta_by_patch: dict[str, pd.Series],
    gear_summary: dict,
    godark_summary: dict,
    spoofing_summary: dict,
    trans_summary: dict,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    h5_rows: list[dict] = []
    fusion_rows: list[dict] = []
    candidate_keys = set()
    meta_by_scene = {str(row.get("scene", "")): row for _, row in metadata.iterrows()}

    for _, row in candidates.iterrows():
        scene = str(row.get("scene", ""))
        mmsi = norm_mmsi(row.get("MMSI", row.get("mmsi", "")))
        neighbor = norm_mmsi(row.get("neighbor_mmsi", ""))
        key = (scene, mmsi, neighbor, str(row.get("candidate_type", "")))
        candidate_keys.add(key)
        h5 = h5_values_for_row(row, gear_summary, godark_summary, spoofing_summary, trans_summary)
        ts_start = row.get("timestamp_start", row.get("scene_time_utc", ""))
        ts_end = row.get("timestamp_end", row.get("scene_time_utc", ""))
        h5_row = {
            "scene": scene,
            "MMSI": mmsi,
            "neighbor_mmsi": neighbor,
            "timestamp_start": ts_start,
            "timestamp_end": ts_end,
            **h5,
            "model_source": MODEL_SOURCE,
            "inference_status": h5_inference_status(h5),
        }
        h5_rows.append(h5_row)

        yolo = yolo_for_row(row, yolo_by_patch)
        supports, ai_score = score_for_rule_type(str(row.get("candidate_type", "")), h5)
        any_ai_available = any(h5.get(k) != "" for k in ["godark_probability", "spoofing_probability", "transshipment_probability"])
        if supports is True:
            hybrid_status = "confirmed_by_ai"
        elif supports is False or any_ai_available:
            hybrid_status = "rule_only"
        else:
            hybrid_status = "not_available"
        score = ai_score if ai_score is not None else row.get("score", "")
        fusion_rows.append(
            {
                **row.to_dict(),
                **h5_row,
                "candidate_type": row.get("candidate_type", ""),
                "score": score,
                "yolo_class": yolo.get("yolo_class", ""),
                "yolo_confidence": yolo.get("yolo_confidence", ""),
                "yolo_bbox": yolo.get("yolo_bbox", ""),
                "yolo_image_name": yolo.get("yolo_image_name", ""),
                "yolo_source": yolo.get("yolo_source", ""),
                "yolo_patch_key": yolo.get("yolo_patch_key", ""),
                "ai_gear_label": h5.get("gear_label", ""),
                "ai_gear_probability": h5.get("gear_probability", ""),
                "ai_godark_probability": h5.get("godark_probability", ""),
                "ai_spoofing_probability": h5.get("spoofing_probability", ""),
                "ai_transshipment_probability": h5.get("transshipment_probability", ""),
                "hybrid_status": hybrid_status,
                "ai_source": f"{MODEL_SOURCE} + {yolo.get('yolo_source', YOLO_SOURCE)}",
            }
        )

    # Add H5-positive rows that can be connected to SAR metadata but are not rule candidates.
    ai_mmsi: set[str] = set()
    ai_mmsi.update(k for k, v in godark_summary.items() if v.get("godark_label") == "go_dark")
    ai_mmsi.update(k for k, v in spoofing_summary.items() if v.get("spoofing_label") == "spoofing")
    ai_mmsi.update(v.get("mmsi", "") for v in trans_summary.values() if v.get("transshipment_label") == "potential_transshipment")
    for _, meta in metadata.iterrows():
        scene = str(meta.get("scene", ""))
        mmsi = norm_mmsi(meta.get("MMSI", ""))
        if not mmsi or mmsi not in ai_mmsi:
            continue
        row = meta.to_dict()
        h5 = h5_values_for_row(pd.Series({"MMSI": mmsi, "neighbor_mmsi": ""}), gear_summary, godark_summary, spoofing_summary, trans_summary)
        if (scene, mmsi, "", str(row.get("candidate_type", ""))) in candidate_keys:
            continue
        if h5.get("godark_label") == "go_dark":
            ctype, score = "godark", h5.get("godark_probability", "")
        elif h5.get("spoofing_label") == "spoofing":
            ctype, score = "spoofing", h5.get("spoofing_probability", "")
        elif h5.get("transshipment_label") == "potential_transshipment":
            ctype, score = "transshipment", h5.get("transshipment_probability", "")
        else:
            continue
        yolo = yolo_for_row(row, yolo_by_patch)
        h5_row = {
            "scene": scene,
            "MMSI": mmsi,
            "neighbor_mmsi": "",
            "timestamp_start": row.get("scene_time_utc", ""),
            "timestamp_end": row.get("scene_time_utc", ""),
            **h5,
            "model_source": MODEL_SOURCE,
            "inference_status": h5_inference_status(h5),
        }
        h5_rows.append(h5_row)
        fusion_rows.append(
            {
                **row,
                **h5_row,
                "candidate_type": ctype,
                "score": score,
                "rule": "AI-only inference from final H5 bundle",
                "evidence": f"{ctype} supported by FINAL_4_PIPELINE_MODELS.h5 without matching rule candidate.",
                "yolo_class": yolo.get("yolo_class", ""),
                "yolo_confidence": yolo.get("yolo_confidence", ""),
                "yolo_bbox": yolo.get("yolo_bbox", ""),
                "yolo_image_name": yolo.get("yolo_image_name", ""),
                "yolo_source": yolo.get("yolo_source", ""),
                "yolo_patch_key": yolo.get("yolo_patch_key", ""),
                "ai_gear_label": h5.get("gear_label", ""),
                "ai_gear_probability": h5.get("gear_probability", ""),
                "ai_godark_probability": h5.get("godark_probability", ""),
                "ai_spoofing_probability": h5.get("spoofing_probability", ""),
                "ai_transshipment_probability": h5.get("transshipment_probability", ""),
                "hybrid_status": "ai_only",
                "ai_source": f"{MODEL_SOURCE} + {yolo.get('yolo_source', YOLO_SOURCE)}",
            }
        )

    # Add YOLO-only evidence rows so every YOLO detection remains visible in the fusion CSV.
    existing_scene_mmsi = {(str(r.get("scene", "")), norm_mmsi(r.get("MMSI", ""))) for r in fusion_rows}
    for _, yrow in yolo_df.iterrows():
        scene = str(yrow.get("_scene", ""))
        mmsi = norm_mmsi(yrow.get("_MMSI", ""))
        if not scene or (scene, mmsi) in existing_scene_mmsi:
            continue
        meta = yolo_meta_by_patch.get(str(yrow.get("_patch_key", "")), meta_by_scene.get(scene, pd.Series(dtype=object)))
        base = meta.to_dict() if hasattr(meta, "to_dict") else {}
        source_label = str(yrow.get("_source_label", YOLO_SOURCE))
        fusion_rows.append(
            {
                **base,
                "scene": scene,
                "MMSI": mmsi,
                "neighbor_mmsi": "",
                "timestamp_start": base.get("scene_time_utc", ""),
                "timestamp_end": base.get("scene_time_utc", ""),
                "candidate_type": "yolo_sar",
                "score": yrow.get("confidence", ""),
                "rule": "YOLO SAR AI detection without legacy rule candidate",
                "evidence": f"YOLO {yrow.get('pred_class_name', '')} confidence {yrow.get('confidence', '')}",
                "gear_label": "",
                "gear_probability": "",
                "godark_probability": "",
                "godark_label": "",
                "spoofing_probability": "",
                "spoofing_label": "",
                "transshipment_probability": "",
                "transshipment_label": "",
                "model_source": MODEL_SOURCE,
                "inference_status": "h5=not_available;yolo=available",
                "yolo_class": yrow.get("pred_class_name", ""),
                "yolo_confidence": yrow.get("confidence", ""),
                "yolo_bbox": f"{yrow.get('x1')},{yrow.get('y1')},{yrow.get('x2')},{yrow.get('y2')}",
                "yolo_image_name": yrow.get("image_name", ""),
                "yolo_source": source_label,
                "yolo_patch_key": yrow.get("_patch_key", ""),
                "ai_gear_label": "",
                "ai_gear_probability": "",
                "ai_godark_probability": "",
                "ai_spoofing_probability": "",
                "ai_transshipment_probability": "",
                "hybrid_status": "ai_only",
                "ai_source": f"{MODEL_SOURCE} + {source_label}",
            }
        )

    h5_df = pd.DataFrame(h5_rows)
    fusion_df = pd.DataFrame(fusion_rows)
    return h5_df, fusion_df


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--h5", type=Path, default=DEFAULT_H5)
    parser.add_argument("--ais-dir", type=Path, default=DEFAULT_AIS_DIR)
    parser.add_argument("--yolo", type=Path, default=DEFAULT_YOLO)
    parser.add_argument("--yolo-fallback", type=Path, default=DEFAULT_YOLO_FALLBACK)
    parser.add_argument("--candidates", type=Path, default=DEFAULT_CANDIDATES)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--h5-output", type=Path, default=DEFAULT_H5_OUT)
    parser.add_argument("--fusion-output", type=Path, default=DEFAULT_FUSION_OUT)
    return parser.parse_args()


def main() -> int:
    warnings.filterwarnings("ignore", category=UserWarning)
    args = parse_args()
    bundle = H5ModelBundle(args.h5)
    models = bundle.load()
    ais = load_ais_data(args.ais_dir)
    candidates = load_candidates(args.candidates)
    metadata = load_metadata(args.metadata)
    yolo_paths = [args.yolo]
    if args.yolo_fallback and args.yolo_fallback != args.yolo:
        yolo_paths.append(args.yolo_fallback)
    yolo_by_patch, yolo_df, yolo_meta_by_patch = load_yolo_predictions(yolo_paths, metadata)

    gear_rows, gear_summary = run_gear(models, ais)
    godark_rows, godark_summary = run_godark(models, ais)
    spoofing_rows, spoofing_summary = run_spoofing(models, ais)
    trans_rows, trans_summary = run_transshipment(models, ais, gear_summary)

    h5_df, fusion_df = build_outputs(
        candidates,
        metadata,
        yolo_by_patch,
        yolo_df,
        yolo_meta_by_patch,
        gear_summary,
        godark_summary,
        spoofing_summary,
        trans_summary,
    )
    args.h5_output.parent.mkdir(parents=True, exist_ok=True)
    args.fusion_output.parent.mkdir(parents=True, exist_ok=True)
    h5_df.to_csv(args.h5_output, index=False)
    fusion_df.to_csv(args.fusion_output, index=False)

    hybrid_counts = fusion_df["hybrid_status"].value_counts(dropna=False).to_dict() if "hybrid_status" in fusion_df.columns else {}
    yolo_joined = int((yolo_df["_scene"].astype(str).str.len() > 0).sum())
    summary = {
        "gear_windows": int(len(gear_rows)),
        "gear_mmsi": int(len(gear_summary)),
        "godark_windows": int(len(godark_rows)),
        "godark_mmsi": int(len(godark_summary)),
        "spoofing_windows": int(len(spoofing_rows)),
        "spoofing_mmsi": int(len(spoofing_summary)),
        "transshipment_windows": int(len(trans_rows)),
        "transshipment_events": int(len(trans_summary)),
        "final_h5_ai_predictions_rows": int(len(h5_df)),
        "final_ai_fusion_results_rows": int(len(fusion_df)),
        "yolo_rows": int(len(yolo_df)),
        "yolo_rows_joined_to_metadata": yolo_joined,
        "hybrid_counts": hybrid_counts,
        "h5_output": str(args.h5_output.relative_to(ROOT)),
        "fusion_output": str(args.fusion_output.relative_to(ROOT)),
    }
    log("[summary] " + json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
