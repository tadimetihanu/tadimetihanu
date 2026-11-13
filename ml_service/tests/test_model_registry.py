import sys
import os
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml_service.model_registry.registry import get_model_registry
from ml_service.model_registry.evaluation import evaluate_classification, evaluate_ner, evaluate_reranking

class TestModelRegistryAndEvaluation(unittest.TestCase):
    def setUp(self):
        self.registry = get_model_registry()
        # Ensure default loader is preserved
        from ml_service.document_intelligence.classification import DocumentClassifier
        self.registry.register_loader("doc_classifier_deberta", lambda: DocumentClassifier())

    def test_registry_lifecycle_and_caching(self):
        statuses = self.registry.list_models_status()
        self.assertGreater(len(statuses), 4)

        # Lazy load doc_classifier_deberta
        model = self.registry.get_model("doc_classifier_deberta")
        self.assertIsNotNone(model)

        # Confirm cached status
        cached_status = next(s for s in self.registry.list_models_status() if s.model_id == "doc_classifier_deberta")
        self.assertTrue(cached_status.is_cached)

    def test_model_rollback(self):
        self.registry.rollback("classification", "v0.9.0")
        meta = self.registry.models.get("doc_classifier_deberta")
        self.assertEqual(meta.version, "v0.9.0")
        # Rollback back to v1.0.0
        self.registry.rollback("classification", "v1.0.0")

    def test_evaluation_metrics(self):
        # Classification evaluation
        y_true = ["Invoices", "Contracts", "Invoices"]
        y_pred = ["Invoices", "Contracts", "Invoices"]
        cls_eval = evaluate_classification(y_true, y_pred, ["Invoices", "Contracts"])
        self.assertEqual(cls_eval["accuracy"], 100.0)
        self.assertEqual(cls_eval["macro_f1"], 100.0)

        # NER evaluation
        gold = [{"entity_type": "DATE", "entity_value": "2026-01-01"}]
        pred = [{"entity_type": "DATE", "entity_value": "2026-01-01"}]
        ner_eval = evaluate_ner(pred, gold)
        self.assertEqual(ner_eval["entity_f1"], 100.0)

        # Reranker evaluation
        ranked = ["A", "B", "C"]
        relevant = ["A"]
        rerank_eval = evaluate_reranking(ranked, relevant, k=3)
        self.assertEqual(rerank_eval["recall_at_k"], 100.0)
        self.assertEqual(rerank_eval["mrr"], 1.0)

if __name__ == "__main__":
    unittest.main()
