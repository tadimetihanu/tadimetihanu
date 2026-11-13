from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from datetime import datetime, timezone

from ml_service.schemas.document import DocumentChunk, DocumentInput, DocumentCitation
from ml_service.schemas.entity import ExtractedEntity

# ── Feature 1: Classification ──────────────────────────────────────
class DocumentClassifyRequest(BaseModel):
    tenant_id: str = Field(default="default", description="Tenant isolation ID")
    document_id: str = Field(..., description="Document ID")
    text: Optional[str] = Field(None, description="Raw text to classify. If omitted, chunks are joined.")
    chunks: Optional[List[DocumentChunk]] = Field(default_factory=list, description="Optional chunks")
    custom_categories: Optional[List[str]] = Field(None, description="Optional custom category list")
    multi_label: bool = Field(default=False, description="Whether to support multi-label classification")
    min_confidence: float = Field(default=50.0, description="Minimum confidence threshold (0-100)")

class CategoryScore(BaseModel):
    category: str
    confidence_score: float = Field(..., ge=0.0, le=100.0)
    is_primary: bool = False

class DocumentClassifyResponse(BaseModel):
    success: bool = True
    tenant_id: str
    document_id: str
    primary_category: str
    confidence_score: float
    categories: List[CategoryScore]
    multi_label_categories: List[str] = Field(default_factory=list)
    model_name: str
    model_version: str
    inference_latency_ms: float
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class ClassificationCorrectionRequest(BaseModel):
    tenant_id: str = "default"
    document_id: str
    corrected_category: str
    user_id: Optional[str] = "admin"
    notes: Optional[str] = None

# ── Feature 2: Named Entity Recognition ────────────────────────────
class ExtractEntitiesRequest(BaseModel):
    tenant_id: str = Field(default="default", description="Tenant ID")
    document_id: str
    text: Optional[str] = None
    chunks: Optional[List[DocumentChunk]] = Field(default_factory=list)
    custom_entity_types: Optional[List[str]] = None
    min_confidence: float = Field(default=60.0, description="Minimum confidence filter")
    index_to_opensearch: bool = Field(default=True, description="Whether to store entities in OpenSearch")

class ExtractEntitiesResponse(BaseModel):
    success: bool = True
    tenant_id: str
    document_id: str
    entity_count: int
    entities: List[ExtractedEntity]
    entity_summary: Dict[str, int] = Field(default_factory=dict)
    model_name: str
    model_version: str
    inference_latency_ms: float
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

# ── Feature 3: ML Reranking ─────────────────────────────────────────
class RerankCandidate(BaseModel):
    id: str = Field(..., description="Chunk or document identifier")
    text: str = Field(..., description="Passage or chunk text")
    initial_score: float = Field(default=0.0, description="BM25, vector or hybrid fusion score")
    source: str = Field(default="milvus", description="milvus, opensearch, or hybrid")
    document_id: Optional[str] = None
    chunk_id: Optional[str] = None
    page_number: Optional[int] = 1
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)

class RerankRequest(BaseModel):
    tenant_id: str = Field(default="default", description="Tenant ID")
    query: str = Field(..., description="User search query")
    candidates: List[RerankCandidate] = Field(..., description="Candidate passages to rerank")
    top_k: int = Field(default=5, ge=1, le=100, description="Top K reranked results")
    model_name: Optional[str] = Field("bge-reranker-v2-m3", description="Cross-encoder model")

class RerankResultItem(BaseModel):
    id: str
    document_id: Optional[str] = None
    chunk_id: Optional[str] = None
    page_number: Optional[int] = 1
    text: str
    rerank_score: float
    original_score: float
    score_improvement: float
    rank: int
    source: str
    metadata: Optional[Dict[str, Any]] = None

class RerankResponse(BaseModel):
    success: bool = True
    tenant_id: str
    query: str
    model_name: str
    model_version: str
    total_candidates: int
    results: List[RerankResultItem]
    fallback_used: bool = False
    inference_latency_ms: float
    metrics: Optional[Dict[str, Any]] = None

# ── Feature 4: Similarity & Duplicate Detection ────────────────────
class SimilarityRequest(BaseModel):
    tenant_id: str = Field(default="default", description="Tenant ID")
    document_id: Optional[str] = None
    target_text: Optional[str] = None
    candidate_documents: Optional[List[DocumentInput]] = Field(default_factory=list)
    similarity_threshold: float = Field(default=0.82, ge=0.0, le=1.0)
    top_k: int = Field(default=5, ge=1, le=50)
    check_duplicates_only: bool = Field(default=False)
    enable_clustering: bool = Field(default=False)

class DuplicateDetectionItem(BaseModel):
    document_id: str
    matched_document_id: str
    duplicate_type: str = Field(..., description="EXACT, NEAR_DUPLICATE, or SEMANTIC_MATCH")
    similarity_score: float = Field(..., ge=0.0, le=1.0)
    minhash_distance: Optional[float] = None
    shared_fingerprints_count: Optional[int] = None
    explanation: str

class ClusterGroup(BaseModel):
    cluster_id: int
    cluster_label: str
    document_ids: List[str]
    cohesion_score: float

class SimilarityResponse(BaseModel):
    success: bool = True
    tenant_id: str
    reference_document_id: Optional[str] = None
    exact_duplicates: List[DuplicateDetectionItem] = Field(default_factory=list)
    near_duplicates: List[DuplicateDetectionItem] = Field(default_factory=list)
    semantic_similar: List[DuplicateDetectionItem] = Field(default_factory=list)
    clusters: Optional[List[ClusterGroup]] = None
    model_version: str
    inference_latency_ms: float

# ── Feature 5: Anomaly Detection ────────────────────────────────────
class StructuredDocumentRecord(BaseModel):
    document_id: str
    invoice_number: Optional[str] = None
    contract_id: Optional[str] = None
    vendor_or_company: Optional[str] = None
    customer_name: Optional[str] = None
    total_amount: Optional[float] = None
    currency: Optional[str] = "USD"
    invoice_date: Optional[str] = None
    due_date: Optional[str] = None
    tax_amount: Optional[float] = None
    line_item_count: Optional[int] = 1
    raw_entities: Optional[Dict[str, Any]] = None

class AnomalyDetectionRequest(BaseModel):
    tenant_id: str = Field(default="default", description="Tenant ID")
    records: List[StructuredDocumentRecord] = Field(..., description="Documents/records to evaluate for anomalies")
    sensitivity: float = Field(default=0.05, ge=0.01, le=0.5, description="Contamination factor for Isolation Forest")

class AnomalyIndicator(BaseModel):
    indicator_code: str
    severity: str = Field(..., description="LOW, MEDIUM, HIGH, CRITICAL")
    description: str
    feature_name: str
    observed_value: Any
    expected_range: Optional[str] = None
    confidence_score: float

class DocumentAnomalyItem(BaseModel):
    document_id: str
    is_anomaly: bool
    anomaly_score: float = Field(..., ge=0.0, le=1.0)
    overall_severity: str
    indicators: List[AnomalyIndicator]
    explanation: str
    model_algorithm: str = "Isolation Forest + LOF + Rule Ensemble"

class AnomalyDetectionResponse(BaseModel):
    success: bool = True
    tenant_id: str
    evaluated_count: int
    anomalous_count: int
    results: List[DocumentAnomalyItem]
    model_version: str
    inference_latency_ms: float

# ── Feature 6: Summarization ────────────────────────────────────────
class DocumentSummarizeRequest(BaseModel):
    tenant_id: str = Field(default="default", description="Tenant ID")
    document_id: Optional[str] = None
    text: Optional[str] = None
    chunks: Optional[List[DocumentChunk]] = Field(default_factory=list)
    multi_documents: Optional[List[DocumentInput]] = None
    summary_type: str = Field(default="executive", description="full, executive, section, multi_doc, key_findings")
    max_length_words: int = Field(default=250, ge=30, le=2000)
    llm_provider: Optional[str] = Field("auto", description="auto, openai, transformers, huggingface, local")

class DocumentSummarizeResponse(BaseModel):
    success: bool = True
    tenant_id: str
    document_id: Optional[str] = None
    summary_type: str
    summary: str
    key_findings: List[str] = Field(default_factory=list)
    word_count: int
    citations: List[DocumentCitation] = Field(default_factory=list)
    provider_used: str
    model_name: str
    inference_latency_ms: float

# ── Model Registry & Lifecycle ──────────────────────────────────────
class ModelLifecycleStatus(BaseModel):
    model_id: str
    model_name: str
    capability: str
    version: str
    status: str
    device: str
    is_cached: bool
    memory_mb: float
    last_loaded_at: Optional[str] = None
    inference_count: int = 0
    average_latency_ms: float = 0.0

class ModelEvaluateRequest(BaseModel):
    tenant_id: str = "default"
    capability: str = Field(..., description="classification, ner, reranker, similarity, anomaly, summarization")
    test_dataset: Optional[str] = "benchmark_default"

class ModelEvaluateResponse(BaseModel):
    success: bool = True
    tenant_id: str
    capability: str
    model_name: str
    model_version: str
    metrics: Dict[str, Any]
    baseline_comparison: Dict[str, Any]
    evaluated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
