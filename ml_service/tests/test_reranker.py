import sys
import os
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml_service.schemas.prediction import RerankRequest, RerankCandidate
from ml_service.document_intelligence.reranker import CrossEncoderReranker
from ml_service.retrieval.fusion import reciprocal_rank_fusion

class TestSearchReranking(unittest.TestCase):
    def setUp(self):
        self.reranker = CrossEncoderReranker()

    def test_cross_encoder_rerank(self):
        candidates = [
            RerankCandidate(
                id="cand_1",
                text="The weather in California is sunny and pleasant throughout the spring.",
                initial_score=0.72,
                source="milvus"
            ),
            RerankCandidate(
                id="cand_2",
                text="DuckDB execution engine executes out-of-core vectorized SQL queries with predicate pushdown.",
                initial_score=0.55,
                source="opensearch"
            ),
            RerankCandidate(
                id="cand_3",
                text="Database storage formats like Parquet and ORC enable columnar projection pruning.",
                initial_score=0.40,
                source="milvus"
            )
        ]
        req = RerankRequest(
            tenant_id="tenant_ops",
            query="vectorized SQL predicate pushdown in DuckDB",
            candidates=candidates,
            top_k=2
        )
        resp = self.reranker.rerank(req)
        self.assertTrue(resp.success)
        self.assertEqual(len(resp.results), 2)
        # Most relevant candidate should be reranked to rank 1
        self.assertEqual(resp.results[0].id, "cand_2")
        self.assertGreater(resp.results[0].rerank_score, resp.results[1].rerank_score)

    def test_reciprocal_rank_fusion(self):
        milvus_list = [
            {"id": "doc_A", "score": 0.95, "source": "milvus"},
            {"id": "doc_B", "score": 0.88, "source": "milvus"},
            {"id": "doc_C", "score": 0.70, "source": "milvus"}
        ]
        opensearch_list = [
            {"id": "doc_B", "score": 12.4, "source": "opensearch"},
            {"id": "doc_D", "score": 8.1, "source": "opensearch"},
            {"id": "doc_A", "score": 5.2, "source": "opensearch"}
        ]
        fused = reciprocal_rank_fusion([milvus_list, opensearch_list], k=60)
        self.assertGreater(len(fused), 0)
        # doc_B is rank 2 in milvus and rank 1 in opensearch, so it should rank at or near top
        top_ids = [d["id"] for d in fused[:2]]
        self.assertIn("doc_B", top_ids)

if __name__ == "__main__":
    unittest.main()
