import sys
import os
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml_service.schemas.document import DocumentInput
from ml_service.schemas.prediction import SimilarityRequest
from ml_service.document_intelligence.similarity import DocumentSimilarityEngine

class TestSimilarityAndDuplicates(unittest.TestCase):
    def setUp(self):
        self.engine = DocumentSimilarityEngine()

    def test_exact_duplicate_detection(self):
        text = "This is a strict master agreement document containing specific clause terms."
        candidates = [
            DocumentInput(document_id="doc_ref", raw_text=text),
            DocumentInput(document_id="doc_exact", raw_text=text),
            DocumentInput(document_id="doc_diff", raw_text="Completely different content about cloud infrastructure.")
        ]
        req = SimilarityRequest(
            tenant_id="tenant_dupe",
            document_id="doc_ref",
            candidate_documents=candidates,
            check_duplicates_only=True
        )
        resp = self.engine.analyze_similarity(req)
        self.assertTrue(resp.success)
        self.assertEqual(len(resp.exact_duplicates), 1)
        self.assertEqual(resp.exact_duplicates[0].matched_document_id, "doc_exact")
        self.assertEqual(resp.exact_duplicates[0].similarity_score, 1.0)

    def test_near_duplicate_minhash(self):
        text_a = "Standard non disclosure agreement by and between Acme Corp and Beta Inc signed on 2026-01-01 with confidentiality clauses."
        # Near duplicate with minor change
        text_b = "Standard non disclosure agreement by and between Acme Corp and Beta Inc signed on 2026-01-02 with confidentiality clauses."

        candidates = [
            DocumentInput(document_id="doc_a", raw_text=text_a),
            DocumentInput(document_id="doc_b", raw_text=text_b)
        ]
        req = SimilarityRequest(
            tenant_id="tenant_dupe",
            document_id="doc_a",
            candidate_documents=candidates
        )
        resp = self.engine.analyze_similarity(req)
        self.assertTrue(resp.success)
        self.assertEqual(len(resp.near_duplicates), 1)
        self.assertEqual(resp.near_duplicates[0].matched_document_id, "doc_b")
        self.assertGreater(resp.near_duplicates[0].similarity_score, 0.75)

    def test_document_clustering(self):
        candidates = [
            DocumentInput(document_id="fin_1", raw_text="Quarterly financial statements revenue earnings balance sheet ebitda"),
            DocumentInput(document_id="fin_2", raw_text="Annual financial report balance sheet revenue margins net income"),
            DocumentInput(document_id="tech_1", raw_text="Kubernetes docker container pod deployment ingress microservice"),
            DocumentInput(document_id="tech_2", raw_text="Docker container deployment kubernetes cluster service mesh")
        ]
        req = SimilarityRequest(
            tenant_id="tenant_dupe",
            document_id="fin_1",
            candidate_documents=candidates,
            enable_clustering=True
        )
        resp = self.engine.analyze_similarity(req)
        self.assertTrue(resp.success)
        self.assertIsNotNone(resp.clusters)
        self.assertGreaterEqual(len(resp.clusters), 1)

if __name__ == "__main__":
    unittest.main()
