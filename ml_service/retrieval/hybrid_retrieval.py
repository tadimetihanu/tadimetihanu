from typing import List, Dict, Any, Optional

from ml_service.retrieval.milvus_client import get_milvus_client
from ml_service.retrieval.opensearch_client import get_opensearch_client
from ml_service.retrieval.fusion import reciprocal_rank_fusion

class HybridRetrievalCoordinator:
    """
    Coordinates multi-engine candidate retrieval across Milvus and OpenSearch,
    executing Reciprocal Rank Fusion prior to Cross-Encoder reranking.
    """
    def __init__(self):
        self.milvus = get_milvus_client()
        self.opensearch = get_opensearch_client()

    def retrieve_candidates(
        self,
        query: str,
        query_vector: Optional[List[float]] = None,
        tenant_id: str = "default",
        top_k: int = 25
    ) -> List[Dict[str, Any]]:
        # 1. Retrieve dense vector candidates from Milvus
        milvus_candidates = self.milvus.search_candidates(
            query=query,
            query_vector=query_vector,
            tenant_id=tenant_id,
            top_k=top_k
        )

        # 2. Retrieve sparse keyword candidates from OpenSearch
        opensearch_candidates = self.opensearch.search_keyword_candidates(
            query=query,
            tenant_id=tenant_id,
            top_k=top_k
        )

        # 3. Fuse candidate rankings using Reciprocal Rank Fusion (RRF)
        fused = reciprocal_rank_fusion(
            ranked_lists=[milvus_candidates, opensearch_candidates],
            k=60
        )

        return fused[:top_k]

_coordinator = None
def get_hybrid_coordinator() -> HybridRetrievalCoordinator:
    global _coordinator
    if _coordinator is None:
        _coordinator = HybridRetrievalCoordinator()
    return _coordinator

