import sys
import os
import unittest
from fastapi import HTTPException

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml_service.app import (
    verify_api_key,
    document_health,
    list_document_models,
    classify_document,
    correct_classification,
    extract_document_entities,
    rerank_search_results,
    compute_document_similarity,
    detect_document_anomalies,
    summarize_document,
    evaluate_document_model,
    predict_query_cost,
    ML_SERVICE_API_KEY
)
from ml_service.schemas.prediction import (
    DocumentClassifyRequest, ClassificationCorrectionRequest,
    ExtractEntitiesRequest, RerankRequest, RerankCandidate,
    SimilarityRequest, StructuredDocumentRecord, AnomalyDetectionRequest,
    DocumentSummarizeRequest, ModelEvaluateRequest
)
from ml_service.models import (
    PredictQueryCostRequest, ExecutionPlanFeatures, FileMetadata
)

class TestDocumentAPIEndpoints(unittest.TestCase):
    def test_security_authentication_enforcement(self):
        """Verifies that omitted, None, or invalid API key raises 401 Unauthorized."""
        # 1. Omitted / None
        with self.assertRaises(HTTPException) as ctx:
            verify_api_key(None)
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("Unauthorized", ctx.exception.detail)

        # 2. Empty string
        with self.assertRaises(HTTPException) as ctx:
            verify_api_key("")
        self.assertEqual(ctx.exception.status_code, 401)

        # 3. Invalid token
        with self.assertRaises(HTTPException) as ctx:
            verify_api_key("unauthorized_random_token")
        self.assertEqual(ctx.exception.status_code, 401)

        # 4. Valid token succeeds
        self.assertTrue(verify_api_key(ML_SERVICE_API_KEY))

    def test_document_health_endpoint(self):
        resp = document_health()
        self.assertEqual(resp["status"], "healthy")
        self.assertIn("classification", resp["registered_capabilities"])
        self.assertIn("anomaly_detection", resp["registered_capabilities"])

    def test_classify_document_endpoint(self):
        req = DocumentClassifyRequest(
            tenant_id="tenant_api_1",
            document_id="doc_api_inv",
            text="INVOICE #INV-9901 Due Date: 2026-11-20 Subtotal: $4,500.00 Total: $4,850.00"
        )
        resp = classify_document(req, True)
        self.assertTrue(resp.success)
        self.assertEqual(resp.primary_category, "Invoices")
        self.assertGreaterEqual(resp.confidence_score, 70.0)

    def test_extract_entities_endpoint(self):
        req = ExtractEntitiesRequest(
            tenant_id="tenant_api_1",
            document_id="doc_api_ent",
            text="Invoice #INV-4410 issued by Global Tech Inc on 2026-05-12 for $15,000.00. Contact: info@globaltech.com",
            index_to_opensearch=False
        )
        resp = extract_document_entities(req, True)
        self.assertTrue(resp.success)
        self.assertGreater(resp.entity_count, 0)
        found_types = {e.entity_type for e in resp.entities}
        self.assertIn("INVOICE_NUMBER", found_types)

    def test_rerank_endpoint(self):
        candidates = [
            RerankCandidate(id="c1", text="Parquet file format enables dictionary encoding and column pruning.", initial_score=0.5),
            RerankCandidate(id="c2", text="Baking sourdough bread in a Dutch oven.", initial_score=0.6)
        ]
        req = RerankRequest(
            tenant_id="tenant_api_1",
            query="cloud object storage parquet pruning",
            candidates=candidates,
            top_k=2
        )
        resp = rerank_search_results(req, True)
        self.assertTrue(resp.success)
        self.assertEqual(resp.results[0].id, "c1")

    def test_similarity_endpoint(self):
        from ml_service.schemas.document import DocumentInput
        candidates = [
            DocumentInput(document_id="d2", raw_text="Executive agreement between parties Alpha and Beta.")
        ]
        req = SimilarityRequest(
            tenant_id="tenant_api_1",
            document_id="d1",
            target_text="Executive agreement between parties Alpha and Beta.",
            candidate_documents=candidates
        )
        resp = compute_document_similarity(req, True)
        self.assertTrue(resp.success)
        self.assertEqual(len(resp.exact_duplicates), 1)

    def test_anomalies_endpoint(self):
        records = [
            StructuredDocumentRecord(
                document_id="r1",
                invoice_number="INV-11",
                total_amount=100.0,
                invoice_date="2026-05-10",
                due_date="2026-05-01"
            )
        ]
        req = AnomalyDetectionRequest(tenant_id="tenant_api_1", records=records)
        resp = detect_document_anomalies(req, True)
        self.assertTrue(resp.success)
        self.assertEqual(resp.anomalous_count, 1)

    def test_summarize_endpoint(self):
        req = DocumentSummarizeRequest(
            tenant_id="tenant_api_1",
            document_id="s1",
            text="Quarterly financial results show a 40% growth in active user engagement. Cloud costs were reduced by 25% following optimization.",
            summary_type="executive"
        )
        resp = summarize_document(req, True)
        self.assertTrue(resp.success)
        self.assertGreater(len(resp.summary), 10)

    def test_model_evaluation_endpoint(self):
        req = ModelEvaluateRequest(tenant_id="tenant_api_1", capability="classification")
        resp = evaluate_document_model(req, True)
        self.assertTrue(resp.success)
        self.assertIn("accuracy", resp.metrics)
        self.assertIn("macro_f1", resp.metrics)

    def test_sql_cost_intelligence_regression(self):
        """Regression test ensuring SQL cost forecasting endpoint is fully preserved."""
        req = PredictQueryCostRequest(
            sql_query="SELECT customer_id, SUM(order_total) FROM orders GROUP BY customer_id",
            storage_provider="s3",
            file_metadata=FileMetadata(file_format="parquet", file_count=2, total_file_size_bytes=10000000),
            execution_plan_features=ExecutionPlanFeatures(
                query_type="AGGREGATE",
                join_count=0,
                filter_count=0,
                projection_count=2,
                has_group_by=1
            ),
            tenant_id="default"
        )
        resp = predict_query_cost(req, True)
        self.assertTrue(resp.success)
        self.assertGreater(resp.predicted_scan_volume_bytes, 0)
        self.assertGreater(resp.predicted_execution_duration_ms, 0)
        self.assertGreater(resp.predicted_cost_usd, 0.0)

if __name__ == "__main__":
    unittest.main()
