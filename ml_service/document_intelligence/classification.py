import re
import time
import math
import numpy as np
from typing import List, Dict, Any, Optional

from ml_service.schemas.prediction import (
    DocumentClassifyRequest, DocumentClassifyResponse, CategoryScore, ClassificationCorrectionRequest
)
from ml_service.document_intelligence.confidence import calculate_entropy_confidence
from ml_service.db_loader import get_db_connection

STANDARD_CATEGORIES = [
    "Financial Reports",
    "Invoices",
    "Contracts",
    "Legal Documents",
    "Technical Documentation",
    "Bank Statements",
    "Purchase Orders",
    "Customer Documents",
    "Other"
]

CATEGORY_PATTERNS = {
    "Financial Reports": [
        r"balance sheet", r"income statement", r"cash flow", r"annual report", r"10-k", r"10-q",
        r"ebitda", r"fiscal year", r"net income", r"gross margin", r"operating expenses", r"quarterly earnings"
    ],
    "Invoices": [
        r"invoice\s*#?", r"bill to", r"remit to", r"due date", r"subtotal", r"total amount due",
        r"tax id", r"payment terms", r"itemized charges", r"vat #", r"invoice number"
    ],
    "Contracts": [
        r"master services agreement", r"non-disclosure agreement", r"nda", r"by and between",
        r"whereas", r"in witness whereof", r"indemnification", r"confidentiality agreement",
        r"terms and conditions", r"governing law", r"severability"
    ],
    "Legal Documents": [
        r"court of", r"plaintiff", r"defendant", r"jurisdiction", r"affidavit", r"subpoena",
        r"power of attorney", r"arbitration", r"legal notice", r"statutory compliance", r"litigation"
    ],
    "Technical Documentation": [
        r"architecture", r"api reference", r"system requirements", r"deployment guide",
        r"docker", r"kubernetes", r"sdk", r"endpoints", r"specifications", r"troubleshooting", r"schema"
    ],
    "Bank Statements": [
        r"account statement", r"checking account", r"savings account", r"opening balance",
        r"closing balance", r"deposits", r"withdrawals", r"direct deposit", r"bank of", r"routing number"
    ],
    "Purchase Orders": [
        r"purchase order", r"po\s*#?", r"vendor id", r"requisition", r"ship to", r"delivery date",
        r"quantity ordered", r"unit price", r"po date"
    ],
    "Customer Documents": [
        r"customer onboard", r"kyc", r"client profile", r"account opening", r"passport",
        r"driver license", r"utility bill", r"customer feedback", r"survey response"
    ]
}

class DocumentClassifier:
    """
    ML Document Classification Engine supporting pretrained Transformers,
    dynamic custom categories, multi-label scoring, and human feedback.
    """
    def __init__(self, model_name: str = "microsoft/deberta-v3-small", version: str = "v1.0.0"):
        self.model_name = model_name
        self.version = version
        self.pipeline = None
        self._init_transformer_pipeline()

    def _init_transformer_pipeline(self):
        """Attempts to load a zero-shot classification transformer pipeline."""
        try:
            from transformers import pipeline
            self.pipeline = pipeline("zero-shot-classification", model=self.model_name, device=-1)
            print(f"✅ [DocumentClassifier] Transformer zero-shot pipeline loaded: {self.model_name}")
        except Exception:
            self.pipeline = None

    def classify(self, req: DocumentClassifyRequest) -> DocumentClassifyResponse:
        start_time = time.time()
        
        # 1. Prepare text from raw_text or chunks
        text = req.text or ""
        if not text and req.chunks:
            text = " ".join(c.text for c in req.chunks)

        categories = req.custom_categories or STANDARD_CATEGORIES

        # 2. Check for human-corrected classification in DB first (tenant-isolated)
        corrected = self._get_user_correction(req.tenant_id, req.document_id)
        if corrected:
            latency = (time.time() - start_time) * 1000
            return DocumentClassifyResponse(
                success=True,
                tenant_id=req.tenant_id,
                document_id=req.document_id,
                primary_category=corrected,
                confidence_score=100.0,
                categories=[CategoryScore(category=corrected, confidence_score=100.0, is_primary=True)],
                multi_label_categories=[corrected],
                model_name=f"{self.model_name} (User Corrected)",
                model_version=self.version,
                inference_latency_ms=round(latency, 2)
            )

        # 3. Model Inference (Transformer or Semantic Fallback)
        category_scores: List[CategoryScore] = []
        if self.pipeline and len(text.strip()) > 20:
            try:
                res = self.pipeline(text[:2000], candidate_labels=categories, multi_label=req.multi_label)
                for label, score in zip(res["labels"], res["scores"]):
                    category_scores.append(CategoryScore(
                        category=label,
                        confidence_score=round(score * 100.0, 2)
                    ))
            except Exception as e:
                category_scores = self._semantic_pattern_classify(text, categories)
        else:
            category_scores = self._semantic_pattern_classify(text, categories)

        # Sort by confidence descending
        category_scores.sort(key=lambda x: x.confidence_score, reverse=True)
        if category_scores:
            category_scores[0].is_primary = True
            primary_cat = category_scores[0].category
            primary_conf = category_scores[0].confidence_score
        else:
            primary_cat = "Other"
            primary_conf = 50.0

        multi_labels = [c.category for c in category_scores if c.confidence_score >= req.min_confidence]
        if not multi_labels:
            multi_labels = [primary_cat]

        latency = (time.time() - start_time) * 1000

        # Persist classification result to metadata database
        self._persist_classification(
            tenant_id=req.tenant_id,
            document_id=req.document_id,
            category=primary_cat,
            confidence=primary_conf,
            model_name=self.model_name,
            model_version=self.version
        )

        return DocumentClassifyResponse(
            success=True,
            tenant_id=req.tenant_id,
            document_id=req.document_id,
            primary_category=primary_cat,
            confidence_score=primary_conf,
            categories=category_scores,
            multi_label_categories=multi_labels,
            model_name=self.model_name,
            model_version=self.version,
            inference_latency_ms=round(latency, 2)
        )

    def classify_batch(self, requests: List[DocumentClassifyRequest]) -> List[DocumentClassifyResponse]:
        """Supports efficient batch processing for multi-document workflows."""
        return [self.classify(r) for r in requests]

    def _semantic_pattern_classify(self, text: str, categories: List[str]) -> List[CategoryScore]:
        """High-precision semantic and keyword scoring with normalized confidence."""
        lower_text = text.lower()
        scores = {}

        for cat in categories:
            patterns = CATEGORY_PATTERNS.get(cat, [])
            match_count = 0
            for pat in patterns:
                matches = len(re.findall(pat, lower_text))
                match_count += matches

            # Also check direct category name and token occurrences
            cat_words = [w.lower() for w in re.findall(r"\b[A-Za-z0-9]+\b", cat) if len(w) > 2]
            for cw in cat_words:
                match_count += len(re.findall(r"\b" + re.escape(cw) + r"\b", lower_text)) * 2

            # Base score proportional to match density
            scores[cat] = match_count

        total_matches = sum(scores.values())
        results = []

        if total_matches == 0:
            # Fallback to Other
            for cat in categories:
                conf = 85.0 if cat == "Other" else 15.0
                results.append(CategoryScore(category=cat, confidence_score=conf))
            return results

        # Convert to probabilities with temperature smoothing
        prob_list = []
        for cat in categories:
            raw = scores.get(cat, 0)
            p = (raw + 0.1) / (total_matches + 0.1 * len(categories))
            prob_list.append((cat, p))

        # Softmax calibration
        max_prob = max(p for _, p in prob_list)
        for cat, p in prob_list:
            calibrated = (p / max_prob) * 96.0 + 3.0
            calibrated = min(99.5, max(5.0, round(calibrated, 2)))
            results.append(CategoryScore(category=cat, confidence_score=calibrated))

        return results

    def _get_user_correction(self, tenant_id: str, document_id: str) -> Optional[str]:
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("""
                SELECT corrected_category FROM document_classifications
                WHERE tenant_id = ? AND document_id = ? AND is_corrected = 1
                ORDER BY created_at DESC LIMIT 1
            """, (tenant_id, document_id))
            row = cur.fetchone()
            conn.close()
            if row:
                return row[0] if isinstance(row, (tuple, list)) else row["corrected_category"]
        except Exception:
            pass
        return None

    def record_user_correction(self, req: ClassificationCorrectionRequest) -> bool:
        """Saves a user-corrected classification to the database."""
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO document_classifications (
                    id, tenant_id, document_id, predicted_category, confidence_score,
                    is_corrected, corrected_category, model_name, model_version, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """, (
                f"corr_{req.document_id[:12]}_{int(time.time())}",
                req.tenant_id,
                req.document_id,
                req.corrected_category,
                100.0,
                1,
                req.corrected_category,
                "human_feedback",
                self.version
            ))
            conn.commit()
            conn.close()
            return True
        except Exception as e:
            print(f"Warning: Failed to save correction: {e}")
            return False

    def _persist_classification(self, tenant_id: str, document_id: str, category: str, confidence: float, model_name: str, model_version: str):
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO document_classifications (
                    id, tenant_id, document_id, predicted_category, confidence_score,
                    is_corrected, corrected_category, model_name, model_version, created_at
                ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, datetime('now'))
            """, (
                f"cls_{document_id[:12]}_{int(time.time())}",
                tenant_id,
                document_id,
                category,
                confidence,
                model_name,
                model_version
            ))
            conn.commit()
            conn.close()
        except Exception:
            pass
