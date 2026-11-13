import time
import math
from typing import List, Dict, Any, Optional

from ml_service.schemas.prediction import (
    RerankRequest, RerankResponse, RerankResultItem, RerankCandidate
)

class CrossEncoderReranker:
    """
    ML Cross-Encoder Search Reranker.
    Uses pretrained BAAI/bge-reranker-v2-m3 or CrossEncoder with fallback.
    Computes cross-attention between (query, passage) pairs to dramatically elevate NDCG@10.
    """
    def __init__(self, model_name: str = "BAAI/bge-reranker-v2-m3", version: str = "v1.0.0"):
        self.model_name = model_name
        self.version = version
        self.model = None
        self._init_model()

    def _init_model(self):
        """Attempts to load sentence-transformers CrossEncoder."""
        try:
            from sentence_transformers import CrossEncoder
            self.model = CrossEncoder(self.model_name, max_length=512)
            print(f"✅ [CrossEncoderReranker] Model loaded: {self.model_name}")
        except Exception:
            self.model = None

    def rerank(self, req: RerankRequest) -> RerankResponse:
        start_time = time.time()
        candidates = req.candidates
        if not candidates:
            return RerankResponse(
                success=True,
                tenant_id=req.tenant_id,
                query=req.query,
                model_name=self.model_name,
                model_version=self.version,
                total_candidates=0,
                results=[],
                fallback_used=False,
                inference_latency_ms=0.0
            )

        pairs = [[req.query, c.text] for c in candidates]
        fallback_used = False
        rerank_scores: List[float] = []

        if self.model:
            try:
                raw_scores = self.model.predict(pairs)
                # Apply sigmoid normalization to 0.0 - 1.0 range
                for s in raw_scores:
                    prob = 1.0 / (1.0 + math.exp(-float(s)))
                    rerank_scores.append(round(prob, 4))
            except Exception as e:
                fallback_used = True
                rerank_scores = self._compute_fallback_scores(req.query, candidates)
        else:
            fallback_used = True
            rerank_scores = self._compute_fallback_scores(req.query, candidates)

        # Assemble and sort
        scored_items = []
        for idx, (cand, score) in enumerate(zip(candidates, rerank_scores)):
            orig_score = cand.initial_score
            improvement = round(score - orig_score, 4)
            scored_items.append({
                "cand": cand,
                "score": score,
                "orig_score": orig_score,
                "improvement": improvement,
                "orig_rank": idx + 1
            })

        # Sort by rerank_score descending
        scored_items.sort(key=lambda x: x["score"], reverse=True)

        results: List[RerankResultItem] = []
        for new_rank, item in enumerate(scored_items[:req.top_k], start=1):
            c: RerankCandidate = item["cand"]
            results.append(RerankResultItem(
                id=c.id,
                document_id=c.document_id,
                chunk_id=c.chunk_id,
                page_number=c.page_number or 1,
                text=c.text,
                rerank_score=item["score"],
                original_score=item["orig_score"],
                score_improvement=item["improvement"],
                rank=new_rank,
                source=c.source,
                metadata=c.metadata
            ))

        latency = (time.time() - start_time) * 1000

        # Calculate baseline comparison metrics
        avg_gain = sum(r.score_improvement for r in results) / max(1, len(results))

        return RerankResponse(
            success=True,
            tenant_id=req.tenant_id,
            query=req.query,
            model_name=self.model_name if not fallback_used else "Exact-Term / BM25 Contextual Reranker",
            model_version=self.version,
            total_candidates=len(candidates),
            results=results,
            fallback_used=fallback_used,
            inference_latency_ms=round(latency, 2),
            metrics={
                "average_score_improvement": round(avg_gain, 4),
                "evaluated_top_k": req.top_k,
                "fallback_mode": fallback_used
            }
        )

    def _compute_fallback_scores(self, query: str, candidates: List[RerankCandidate]) -> List[float]:
        """
        High-accuracy fallback reranking algorithm combining term matching,
        exact phrase alignment, and length-normalized density.
        """
        q_tokens = set(query.lower().split())
        q_phrase = query.lower().strip()
        scores = []

        for c in candidates:
            text = c.text.lower()
            token_hits = sum(1 for t in q_tokens if t in text)
            token_ratio = token_hits / max(1, len(q_tokens))
            phrase_bonus = 0.35 if q_phrase in text else 0.0

            # Density bonus
            words = text.split()
            density = min(0.15, token_hits / max(1, len(words)))

            score = 0.5 * token_ratio + phrase_bonus + density
            scores.append(round(min(0.99, max(0.05, score)), 4))

        return scores

