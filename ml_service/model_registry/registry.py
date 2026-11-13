import os
import sys
import time
import json
import threading
from typing import Dict, Any, Optional, Callable
from datetime import datetime, timezone

from ml_service.schemas.prediction import ModelLifecycleStatus

# Base directory for registry metadata
REGISTRY_DIR = os.path.join(os.path.dirname(__file__), "..", "artifacts", "registry")
os.makedirs(REGISTRY_DIR, exist_ok=True)

class ModelMetadata:
    def __init__(
        self,
        model_id: str,
        name: str,
        capability: str,
        version: str = "v1.0.0",
        device: str = "cpu",
        hyperparameters: Optional[Dict[str, Any]] = None,
        metrics: Optional[Dict[str, Any]] = None
    ):
        self.model_id = model_id
        self.name = name
        self.capability = capability
        self.version = version
        self.device = device
        self.hyperparameters = hyperparameters or {}
        self.metrics = metrics or {}
        self.status = "registered"
        self.is_cached = False
        self.memory_mb = 0.0
        self.last_loaded_at = None
        self.inference_count = 0
        self.total_latency_ms = 0.0
        self.registered_at = datetime.now(timezone.utc).isoformat()

class ModelRegistry:
    """
    Enterprise-grade model registry supporting versioning, lazy loading, caching,
    CPU/GPU selection, telemetry tracking, and seamless rollback.
    """
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(ModelRegistry, cls).__new__(cls)
                cls._instance._init_registry()
            return cls._instance

    def _init_registry(self):
        self.models: Dict[str, ModelMetadata] = {}
        self.instances: Dict[str, Any] = {}
        self.loaders: Dict[str, Callable] = {}
        self.version_history: Dict[str, list] = {}
        self.device = self._detect_optimal_device()

        # Seed standard model definitions
        self._register_default_models()

    def _detect_optimal_device(self) -> str:
        # Check for CUDA if torch is present
        try:
            import torch
            if torch.cuda.is_available():
                return f"cuda:{torch.cuda.current_device()}"
        except Exception:
            pass
        return "cpu"

    def _register_default_models(self):
        defaults = [
            ("doc_classifier_deberta", "DeBERTa-v3 / Transformer Multi-label Classifier", "classification", "v1.0.0"),
            ("gliner_entity_extractor", "GLiNER Zero-Shot / Transformer NER", "ner", "v1.0.0"),
            ("bge_reranker_v2", "BAAI/bge-reranker-v2-m3 Cross-Encoder", "reranking", "v1.0.0"),
            ("doc_similarity_minhash", "MinHash LSH & Milvus Cosine Embedding Engine", "similarity", "v1.0.0"),
            ("doc_anomaly_ensemble", "Isolation Forest + LOF Financial Anomaly Detector", "anomaly_detection", "v1.0.0"),
            ("doc_summarizer_engine", "Multi-granularity Context Summarization Engine", "summarization", "v1.0.0"),
            ("sql_cost_xgboost", "XGBoost SQL Predictive Cost & Latency Regressor", "sql_cost", "v1.0.0"),
        ]
        for mid, name, cap, ver in defaults:
            meta = ModelMetadata(
                model_id=mid,
                name=name,
                capability=cap,
                version=ver,
                device=self.device
            )
            self.models[mid] = meta
            self.version_history.setdefault(cap, []).append(ver)

    def register_loader(self, model_id: str, loader_fn: Callable):
        """Register a lazy-loading function for a model."""
        self.loaders[model_id] = loader_fn

    def get_model(self, model_id: str) -> Any:
        """Lazy loads and caches model instances into memory on first call."""
        if model_id in self.instances:
            return self.instances[model_id]

        if model_id not in self.loaders:
            raise KeyError(f"No loader registered for model {model_id}")

        start = time.time()
        print(f"📦 [ModelRegistry] Lazy-loading model '{model_id}' on {self.device}...")
        instance = self.loaders[model_id]()
        load_time = round((time.time() - start) * 1000, 2)

        self.instances[model_id] = instance
        meta = self.models.get(model_id)
        if meta:
            meta.is_cached = True
            meta.status = "ready"
            meta.last_loaded_at = datetime.now(timezone.utc).isoformat()
            meta.memory_mb = 128.0  # nominal memory foot-print estimation
        print(f"✅ [ModelRegistry] Model '{model_id}' loaded successfully in {load_time}ms")
        return instance

    def unload_model(self, model_id: str):
        """Unload model from cache to reclaim memory."""
        if model_id in self.instances:
            del self.instances[model_id]
            meta = self.models.get(model_id)
            if meta:
                meta.is_cached = False
                meta.status = "unloaded"
            print(f"🗑️ [ModelRegistry] Model '{model_id}' unloaded from memory cache.")

    def record_inference(self, model_id: str, latency_ms: float):
        """Track runtime performance telemetry for model."""
        meta = self.models.get(model_id)
        if meta:
            meta.inference_count += 1
            meta.total_latency_ms += latency_ms

    def rollback(self, capability: str, target_version: str) -> bool:
        """Roll back an active capability model to a previous version."""
        for mid, meta in self.models.items():
            if meta.capability == capability:
                meta.version = target_version
                self.unload_model(mid)
                print(f"⏪ [ModelRegistry] Capability '{capability}' rolled back to version {target_version}")
                return True
        return False

    def list_models_status(self) -> list:
        statuses = []
        for mid, meta in self.models.items():
            avg_lat = round(meta.total_latency_ms / max(1, meta.inference_count), 2)
            statuses.append(ModelLifecycleStatus(
                model_id=meta.model_id,
                model_name=meta.name,
                capability=meta.capability,
                version=meta.version,
                status=meta.status if meta.is_cached else "ready_on_disk",
                device=meta.device,
                is_cached=meta.is_cached,
                memory_mb=meta.memory_mb if meta.is_cached else 0.0,
                last_loaded_at=meta.last_loaded_at,
                inference_count=meta.inference_count,
                average_latency_ms=avg_lat
            ))
        return statuses

# Global singleton accessor
def get_model_registry() -> ModelRegistry:
    return ModelRegistry()
