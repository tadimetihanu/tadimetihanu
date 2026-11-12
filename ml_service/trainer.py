import os
import math
import json
import joblib
import numpy as np
import pandas as pd
from typing import Dict, Any, Tuple, Optional
from datetime import datetime

import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

# Directory for model artifacts
ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
os.makedirs(ARTIFACTS_DIR, exist_ok=True)

CATEGORICAL_FEATURES = ["query_type", "storage_provider", "file_format", "cache_status"]
NUMERICAL_FEATURES = [
    "file_count",
    "total_file_size_bytes",
    "join_count",
    "filter_count",
    "projection_count",
    "aggregation_count",
    "has_wildcard",
    "has_group_by",
    "has_order_by",
    "has_limit",
    "limit_value",
    "cte_count",
    "query_length",
    "token_count"
]

ALL_FEATURE_COLUMNS = CATEGORICAL_FEATURES + NUMERICAL_FEATURES

def create_feature_pipeline() -> ColumnTransformer:
    return ColumnTransformer(
        transformers=[
            (
                "cat",
                OneHotEncoder(handle_unknown="ignore", sparse_output=False),
                CATEGORICAL_FEATURES
            ),
            (
                "num",
                StandardScaler(),
                NUMERICAL_FEATURES
            )
        ],
        remainder="drop"
    )

class TenantModelBundle:
    def __init__(self, tenant_id: str, version: str = "v1.0.0"):
        self.tenant_id = tenant_id
        self.version = version
        self.scan_pipeline: Optional[Pipeline] = None
        self.time_pipeline: Optional[Pipeline] = None
        self.cost_pipeline: Optional[Pipeline] = None
        self.metrics: Dict[str, Any] = {}
        self.residual_std: Dict[str, float] = {
            "scan": 1024 * 1024 * 5,   # 5 MB baseline
            "time": 80.0,              # 80 ms baseline
            "cost": 0.00002            # $0.00002 baseline
        }
        self.is_trained = False
        self.trained_at = None

    def train(self, df: pd.DataFrame) -> Dict[str, Any]:
        if df.empty or len(df) < 5:
            raise ValueError(f"Insufficient telemetry samples for training (found {len(df)}, minimum 5 required)")

        # Prepare X and y
        X = df[ALL_FEATURE_COLUMNS].copy()
        y_scan = df["actual_scan_bytes"].astype(float)
        y_time = df["duration_ms"].astype(float)
        y_cost = df["actual_cost_usd"].astype(float)

        test_size = 0.2 if len(df) >= 20 else 0.1
        X_train, X_test, y_scan_train, y_scan_test = train_test_split(X, y_scan, test_size=test_size, random_state=42)
        _, _, y_time_train, y_time_test = train_test_split(X, y_time, test_size=test_size, random_state=42)
        _, _, y_cost_train, y_cost_test = train_test_split(X, y_cost, test_size=test_size, random_state=42)

        # 1. Scan Regressor
        scan_model = xgb.XGBRegressor(
            n_estimators=80,
            max_depth=4,
            learning_rate=0.08,
            objective="reg:squarederror",
            random_state=42,
            n_jobs=1
        )
        self.scan_pipeline = Pipeline([
            ("preprocessor", create_feature_pipeline()),
            ("regressor", scan_model)
        ])
        self.scan_pipeline.fit(X_train, y_scan_train)

        # 2. Execution Time Regressor
        time_model = xgb.XGBRegressor(
            n_estimators=80,
            max_depth=4,
            learning_rate=0.08,
            objective="reg:squarederror",
            random_state=42,
            n_jobs=1
        )
        self.time_pipeline = Pipeline([
            ("preprocessor", create_feature_pipeline()),
            ("regressor", time_model)
        ])
        self.time_pipeline.fit(X_train, y_time_train)

        # 3. Cost Regressor
        cost_model = xgb.XGBRegressor(
            n_estimators=80,
            max_depth=4,
            learning_rate=0.08,
            objective="reg:squarederror",
            random_state=42,
            n_jobs=1
        )
        self.cost_pipeline = Pipeline([
            ("preprocessor", create_feature_pipeline()),
            ("regressor", cost_model)
        ])
        self.cost_pipeline.fit(X_train, y_cost_train)

        # Evaluate test sets
        pred_scan_test = self.scan_pipeline.predict(X_test)
        pred_time_test = self.time_pipeline.predict(X_test)
        pred_cost_test = self.cost_pipeline.predict(X_test)

        self.residual_std["scan"] = float(np.std(y_scan_test - pred_scan_test)) if len(y_scan_test) > 1 else 1024*1024*2
        self.residual_std["time"] = float(np.std(y_time_test - pred_time_test)) if len(y_time_test) > 1 else 50.0
        self.residual_std["cost"] = float(np.std(y_cost_test - pred_cost_test)) if len(y_cost_test) > 1 else 0.00001

        self.metrics = {
            "sample_count": len(df),
            "train_samples": len(X_train),
            "test_samples": len(X_test),
            "scan_r2": float(max(0.0, r2_score(y_scan_test, pred_scan_test))),
            "scan_mae_bytes": float(mean_absolute_error(y_scan_test, pred_scan_test)),
            "time_r2": float(max(0.0, r2_score(y_time_test, pred_time_test))),
            "time_mae_ms": float(mean_absolute_error(y_time_test, pred_time_test)),
            "cost_r2": float(max(0.0, r2_score(y_cost_test, pred_cost_test))),
            "cost_mae_usd": float(mean_absolute_error(y_cost_test, pred_cost_test)),
            "algorithm": "XGBoost Regressor (Trained via Scikit-Learn Pipeline)"
        }

        self.is_trained = True
        self.trained_at = datetime.utcnow().isoformat()
        self.save()
        return self.metrics

    def predict(self, feature_row: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_trained or not self.scan_pipeline:
            raise RuntimeError(f"Model for tenant {self.tenant_id} is not trained yet.")

        # Build single row dataframe
        df_row = pd.DataFrame([feature_row])
        # Ensure all columns exist
        for col in ALL_FEATURE_COLUMNS:
            if col not in df_row.columns:
                df_row[col] = 0 if col in NUMERICAL_FEATURES else "unknown"

        # Predictions
        raw_scan = float(self.scan_pipeline.predict(df_row)[0])
        raw_time = float(self.time_pipeline.predict(df_row)[0])
        raw_cost = float(self.cost_pipeline.predict(df_row)[0])

        # Clamping
        pred_scan = max(1024, int(round(raw_scan)))
        pred_time = max(10, int(round(raw_time)))
        pred_cost = max(0.0, round(raw_cost, 7))

        # Cloud standard pricing sanity check: $5.00 per TiB (1 TiB = 1024^4 bytes)
        tib = 1024.0 ** 4
        expected_ondemand = (pred_scan / tib) * 5.0
        if df_row.get("cache_status", ["MISS"])[0] == "HIT":
            pred_cost = 0.0
        elif pred_cost <= 0.0 or abs(pred_cost - expected_ondemand) > expected_ondemand * 2.0:
            pred_cost = round(expected_ondemand, 7)

        # 95% Confidence Intervals (1.96 * Residual Standard Error)
        scan_se = max(1024 * 1024, self.residual_std.get("scan", 1024*1024*5))
        time_se = max(15.0, self.residual_std.get("time", 60.0))
        cost_se = max(0.000005, self.residual_std.get("cost", 0.00002))

        ci_scan = [max(1024, int(pred_scan - 1.96 * scan_se)), int(pred_scan + 1.96 * scan_se)]
        ci_time = [max(5, int(pred_time - 1.96 * time_se)), int(pred_time + 1.96 * time_se)]
        ci_cost = [max(0.0, round(pred_cost - 1.96 * cost_se, 7)), round(pred_cost + 1.96 * cost_se, 7)]

        # Confidence Score calculation
        base_r2 = max(0.5, (self.metrics.get("scan_r2", 0.8) + self.metrics.get("time_r2", 0.8)) / 2.0)
        confidence_pct = min(98.5, max(75.0, round(base_r2 * 100.0 - 5.0 + (len(self.metrics) > 0) * 8.0, 1)))

        return {
            "predicted_scan_volume_bytes": pred_scan,
            "predicted_execution_duration_ms": pred_time,
            "predicted_cost_usd": pred_cost,
            "confidence_score": confidence_pct,
            "confidence_level": "High" if confidence_pct >= 85.0 else ("Moderate" if confidence_pct >= 70.0 else "Low"),
            "confidence_interval": {
                "scan_bytes": {"lower": ci_scan[0], "upper": ci_scan[1]},
                "duration_ms": {"lower": ci_time[0], "upper": ci_time[1]},
                "cost_usd": {"lower": ci_cost[0], "upper": ci_cost[1]}
            },
            "model_version": self.version,
            "algorithm": self.metrics.get("algorithm", "XGBoost Regressor")
        }

    def save(self):
        tenant_dir = os.path.join(ARTIFACTS_DIR, self.tenant_id, self.version)
        os.makedirs(tenant_dir, exist_ok=True)
        joblib.dump(self.scan_pipeline, os.path.join(tenant_dir, "scan_pipeline.pkl"))
        joblib.dump(self.time_pipeline, os.path.join(tenant_dir, "time_pipeline.pkl"))
        joblib.dump(self.cost_pipeline, os.path.join(tenant_dir, "cost_pipeline.pkl"))
        meta = {
            "tenant_id": self.tenant_id,
            "version": self.version,
            "trained_at": self.trained_at,
            "metrics": self.metrics,
            "residual_std": self.residual_std
        }
        with open(os.path.join(tenant_dir, "metadata.json"), "w") as f:
            json.dump(meta, f, indent=2)

    def load(self, version: Optional[str] = None) -> bool:
        v = version or self.version
        tenant_dir = os.path.join(ARTIFACTS_DIR, self.tenant_id, v)
        meta_file = os.path.join(tenant_dir, "metadata.json")
        if not os.path.exists(meta_file):
            return False
        try:
            with open(meta_file, "r") as f:
                meta = json.load(f)
            self.version = meta.get("version", v)
            self.metrics = meta.get("metrics", {})
            self.residual_std = meta.get("residual_std", self.residual_std)
            self.trained_at = meta.get("trained_at")
            self.scan_pipeline = joblib.load(os.path.join(tenant_dir, "scan_pipeline.pkl"))
            self.time_pipeline = joblib.load(os.path.join(tenant_dir, "time_pipeline.pkl"))
            self.cost_pipeline = joblib.load(os.path.join(tenant_dir, "cost_pipeline.pkl"))
            self.is_trained = True
            return True
        except Exception as e:
            print(f"Failed to load model for {self.tenant_id}: {e}")
            return False

# Model Registry manager
_REGISTRY: Dict[str, TenantModelBundle] = {}

def get_tenant_model(tenant_id: str = "default") -> TenantModelBundle:
    tid = tenant_id or "default"
    if tid not in _REGISTRY:
        bundle = TenantModelBundle(tenant_id=tid)
        if not bundle.load():
            print(f"ℹ️ [ML Registry] No pre-existing model artifact found for tenant '{tid}'. Initializing baseline...")
            bundle.is_trained = False
        _REGISTRY[tid] = bundle
    return _REGISTRY[tid]

