from typing import List, Dict, Any

def reciprocal_rank_fusion(
    ranked_lists: List[List[Dict[str, Any]]],
    k: int = 60
) -> List[Dict[str, Any]]:
    """
    Standard Reciprocal Rank Fusion (RRF) algorithm for fusing candidate rankings
    from multiple distinct retrieval systems (e.g. Milvus Dense Vector + OpenSearch BM25).
    
    Formula: RRF_Score(d) = sum_{system in systems} ( 1.0 / (k + rank_{system}(d)) )
    """
    scores: Dict[str, float] = {}
    doc_map: Dict[str, Dict[str, Any]] = {}
    provenance: Dict[str, List[str]] = {}

    for system_list in ranked_lists:
        for rank, item in enumerate(system_list):
            doc_id = str(item.get("id") or item.get("chunk_id") or item.get("document_id"))
            if not doc_id:
                continue

            doc_map[doc_id] = item
            src = item.get("source", "unknown")
            provenance.setdefault(doc_id, []).append(f"{src}#rank_{rank+1}")

            # RRF calculation (rank is 0-indexed, so rank + 1)
            rrf_val = 1.0 / (k + (rank + 1))
            scores[doc_id] = scores.get(doc_id, 0.0) + rrf_val

    # Construct unified sorted results
    fused_results = []
    for doc_id, rrf_score in sorted(scores.items(), key=lambda x: x[1], reverse=True):
        doc = dict(doc_map[doc_id])
        doc["rrf_score"] = round(rrf_score, 6)
        doc["fusion_sources"] = provenance.get(doc_id, [])
        fused_results.append(doc)

    return fused_results

def linear_weighted_fusion(
    dense_results: List[Dict[str, Any]],
    sparse_results: List[Dict[str, Any]],
    dense_weight: float = 0.5,
    sparse_weight: float = 0.5
) -> List[Dict[str, Any]]:
    """Alternative linear weighted fusion with min-max normalization."""
    # Normalize dense scores
    dense_scores = [d.get("score", 0.0) for d in dense_results]
    min_d, max_d = (min(dense_scores), max(dense_scores)) if dense_scores else (0.0, 1.0)
    denom_d = max_d - min_d or 1.0

    # Normalize sparse scores
    sparse_scores = [s.get("score", 0.0) for s in sparse_results]
    min_s, max_s = (min(sparse_scores), max(sparse_scores)) if sparse_scores else (0.0, 1.0)
    denom_s = max_s - min_s or 1.0

    combined: Dict[str, Dict[str, Any]] = {}

    for d in dense_results:
        did = str(d.get("id"))
        norm_score = (d.get("score", 0.0) - min_d) / denom_d
        combined[did] = {**d, "score": norm_score * dense_weight, "source": "milvus_dense"}

    for s in sparse_results:
        did = str(s.get("id"))
        norm_score = (s.get("score", 0.0) - min_s) / denom_s
        if did in combined:
            combined[did]["score"] += norm_score * sparse_weight
            combined[did]["source"] = "hybrid"
        else:
            combined[did] = {**s, "score": norm_score * sparse_weight, "source": "opensearch_sparse"}

    results = list(combined.values())
    results.sort(key=lambda x: x["score"], reverse=True)
    return results

