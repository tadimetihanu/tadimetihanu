# CloudObjectIQ Enterprise Document ML Intelligence Layer

## 1. Overview
The **CloudObjectIQ Document ML Intelligence Layer** extends the existing `ml_service/` to provide high-precision machine learning capabilities for unstructured documents while fully preserving existing SQL Predictive Cost Intelligence and Milvus/OpenSearch search pipelines.

---

## 2. Architecture & Capabilities

```
ml_service/
├── app.py                             # Unified FastAPI service (SQL Cost + Document Intelligence)
├── models.py                          # SQL Cost Models & Document Intelligence re-exports
├── trainer.py                         # SQL Cost Model Trainer (XGBoost + Scikit-Learn)
│
├── document_intelligence/             # Core Document ML Capabilities
│   ├── classification.py              # Feature 1: Multi-class & multi-label classification + feedback
│   ├── entity_extraction.py           # Feature 2: Named Entity Recognition (10+ entity types, offsets)
│   ├── reranker.py                    # Feature 3: Cross-Encoder search reranker (BGE-reranker)
│   ├── similarity.py                  # Feature 4: SHA256, MinHash near-duplicate & clustering
│   ├── anomaly_detection.py           # Feature 5: Isolation Forest, LOF & NIST MAD financial anomalies
│   ├── summarization.py               # Feature 6: Multi-granularity summarization & key findings
│   └── confidence.py                  # Calibrated confidence scoring
│
├── retrieval/                         # Search & Vector Integration
│   ├── milvus_client.py               # Milvus dense vector retrieval with tenant isolation
│   ├── opensearch_client.py           # OpenSearch BM25 keyword retrieval & entity index
│   ├── fusion.py                      # Reciprocal Rank Fusion (RRF) & linear weighting
│   └── hybrid_retrieval.py            # Multi-system retrieval orchestrator
│
├── model_registry/                    # Model Lifecycle & Governance
│   ├── registry.py                    # Model registry (versioning, lazy-loading, caching, rollback)
│   └── evaluation.py                  # Metrics (F1, Accuracy, MRR, NDCG@10, MAD anomaly scores)
│
├── schemas/                           # Pydantic Schemas
│   ├── document.py                    # DocumentInput, DocumentChunk, DocumentCitation
│   ├── entity.py                      # ExtractedEntity, EntityFilter
│   └── prediction.py                  # API Request and Response schemas
│
└── tests/                             # Automated Test Suites
    ├── test_classification.py
    ├── test_entity_extraction.py
    ├── test_reranker.py
    ├── test_similarity.py
    ├── test_anomaly_detection.py
    ├── test_summarization.py
    ├── test_model_registry.py
    └── test_document_api.py
```

---

## 3. Implemented Capabilities

### Feature 1: Intelligent Document Classification
- **Categories Supported**: `Financial Reports`, `Invoices`, `Contracts`, `Legal Documents`, `Technical Documentation`, `Bank Statements`, `Purchase Orders`, `Customer Documents`, `Other`.
- **Custom Categories**: Supports passing dynamic tenant-specific category lists.
- **Multi-Class & Multi-Label**: Predicts single primary category or multiple categories meeting confidence thresholds.
- **Human-in-the-Loop Feedback**: Corrections submitted via `POST /api/ml/document/classify/correct` are persisted into metadata DB and prioritized in subsequent predictions.

### Feature 2: Intelligent Named Entity Recognition (NER)
- **Extracted Types**: `PERSON`, `COMPANY`, `CUSTOMER`, `INVOICE_NUMBER`, `CONTRACT_ID`, `DATE`, `CURRENCY_AMOUNT`, `ADDRESS`, `EMAIL`, `TAX_IDENTIFIER`.
- **Span Attribution**: Character start/end offsets, source page number, and chunk ID preserved.
- **OpenSearch Integration**: Auto-indexes extracted entities to `cloudobjectiq_entities` for faceted filtering.

### Feature 3: ML-Based Search Reranking
- **Workflow**:
  1. Retrieves dense vector candidates from Milvus.
  2. Retrieves sparse BM25 candidates from OpenSearch.
  3. Fuses candidates using Reciprocal Rank Fusion ($RRF = \sum \frac{1}{60 + \text{rank}}$).
  4. Cross-encoder scores query-passage pairs using `BAAI/bge-reranker-v2-m3`.
  5. Selects top-$K$ with calibrated relevance and calculates baseline score improvements.

### Feature 4: Document Similarity & Duplicate Detection
- **Exact Duplicates**: Cryptographic SHA-256 fingerprinting.
- **Near Duplicates**: MinHash token shingles with Jaccard coefficient $\ge 0.75$.
- **Semantic Similarity**: Cosine similarity on Milvus embeddings.
- **Document Clustering**: Unsupervised DBSCAN / HDBSCAN topic discovery across document collections.

### Feature 5: ML Anomaly Detection
- **Detection Scope**: Duplicate invoice numbers, collision billing (same vendor + exact amount), statistical amount outliers, inverted dates (due before invoice date), missing mandatory metadata.
- **Algorithms**: Isolation Forest, Local Outlier Factor (LOF), and robust Median Absolute Deviation (MAD / NIST modified Z-score).
- **Explainability**: Returns structured indicators with severity (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), expected ranges, and confidence scores.

### Feature 6: Intelligent Document Summarization
- **Summary Types**: `executive`, `full`, `section`, `multi_doc`, and `key_findings`.
- **Pluggable Backends**: Auto-detects OpenAI (`gpt-4o-mini`), Hugging Face pipelines, or high-fidelity extractive TextRank NLP synthesizer with citations.

---

## 4. API Endpoints Reference

All endpoints enforce mandatory authentication via header: `X-API-Key: <ML_SERVICE_API_KEY>` and tenant isolation via `X-Tenant-ID`.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/ml/document/classify` | Classify document content into categories |
| `POST` | `/api/ml/document/classify/correct` | Submit user correction for misclassified document |
| `POST` | `/api/ml/document/extract-entities` | Extract named entities with offsets and page citations |
| `POST` | `/api/ml/document/rerank` | Cross-encoder search reranker on Milvus/OpenSearch candidates |
| `POST` | `/api/ml/document/similarity` | Exact duplicate, MinHash near-duplicate, and clustering |
| `POST` | `/api/ml/document/anomalies` | Isolation Forest & statistical financial anomaly detection |
| `POST` | `/api/ml/document/summarize` | Executive, section, and multi-document summarizer |
| `GET` | `/api/ml/document/models` | List active models, device, cache status, and latency stats |
| `GET` | `/api/ml/document/health` | Health probe for document intelligence subsystem |
| `POST` | `/api/ml/document/models/evaluate` | Run benchmark evaluations (F1, Accuracy, NDCG@10, MRR) |

---

## 5. Security & Authentication Fix
- **Authentication**: Closed the authentication bypass in `verify_api_key`. Any request omitting `X-API-Key` or providing an invalid key is rejected with HTTP `401 Unauthorized`.
- **Tenant Isolation**: Every database operation and vector query enforces strict tenant filtering (`tenant_id == '<tenant>'`).

---

## 6. Kubernetes & Deployment
- Deployment manifest `k8s/ml-service-deployment.yaml` updated:
  - CPU: `1000m` request, `4000m` limit.
  - Memory: `2Gi` request, `6Gi` limit.
  - Model weight caching volume mounted at `/app/cache`.
  - Readiness probe hooked to `/api/ml/document/health`.
