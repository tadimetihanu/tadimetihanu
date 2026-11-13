import sys
import os
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml_service.schemas.document import DocumentChunk, DocumentInput
from ml_service.schemas.prediction import DocumentSummarizeRequest
from ml_service.document_intelligence.summarization import DocumentSummarizer

class TestDocumentSummarization(unittest.TestCase):
    def setUp(self):
        self.summarizer = DocumentSummarizer()

    def test_executive_summary(self):
        text = (
            "CloudObjectIQ is an enterprise data federation and analytics platform designed to unify S3, Azure ADLS, and Iceberg tables. "
            "The platform leverages DuckDB for vectorized SQL query execution and out-of-core memory management. "
            "Recent performance benchmarks demonstrate a 72% reduction in cloud data egress and a 3.5x speedup in query latency. "
            "The total cost savings achieved across production workloads exceeded $45,000 in Q3 2026. "
            "Future roadmap items include deeper integration with Kubernetes autoscaling and enhanced vector similarity search."
        )
        req = DocumentSummarizeRequest(
            tenant_id="tenant_corp",
            document_id="doc_executive_report",
            text=text,
            summary_type="executive",
            max_length_words=80
        )
        resp = self.summarizer.summarize(req)
        self.assertTrue(resp.success)
        self.assertGreater(len(resp.summary), 20)
        self.assertGreater(len(resp.key_findings), 0)
        self.assertEqual(resp.summary_type, "executive")

    def test_multi_document_summary(self):
        docs = [
            DocumentInput(document_id="doc_1", raw_text="Security audit confirmed zero vulnerabilities in token validation."),
            DocumentInput(document_id="doc_2", raw_text="Performance team confirmed p99 query latency decreased to 142ms.")
        ]
        req = DocumentSummarizeRequest(
            tenant_id="tenant_audit",
            multi_documents=docs,
            summary_type="multi_doc"
        )
        resp = self.summarizer.summarize(req)
        self.assertTrue(resp.success)
        self.assertEqual(len(resp.citations), 2)

if __name__ == "__main__":
    unittest.main()

