import sys
import os
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml_service.schemas.prediction import DocumentClassifyRequest, ClassificationCorrectionRequest
from ml_service.document_intelligence.classification import DocumentClassifier

class TestDocumentClassification(unittest.TestCase):
    def setUp(self):
        self.classifier = DocumentClassifier()

    def test_invoice_classification(self):
        req = DocumentClassifyRequest(
            tenant_id="tenant_alpha",
            document_id="doc_inv_101",
            text="INVOICE #INV-2026-9921\nBill To: Global Logistics Inc\nSubtotal: $12,400.00\nTotal Amount Due: $13,454.00\nDue Date: 2026-12-01\nTax ID: 94-8271625"
        )
        resp = self.classifier.classify(req)
        self.assertTrue(resp.success)
        self.assertEqual(resp.primary_category, "Invoices")
        self.assertGreater(resp.confidence_score, 70.0)
        self.assertIn("Invoices", resp.multi_label_categories)

    def test_contract_classification(self):
        req = DocumentClassifyRequest(
            tenant_id="tenant_beta",
            document_id="doc_ctr_202",
            text="MASTER SERVICES AGREEMENT\nThis Non-Disclosure Agreement is entered into by and between Acme Corp and Beta LLC. In witness whereof, the parties agree to terms and conditions under governing law."
        )
        resp = self.classifier.classify(req)
        self.assertTrue(resp.success)
        self.assertEqual(resp.primary_category, "Contracts")
        self.assertGreater(resp.confidence_score, 70.0)

    def test_custom_categories(self):
        custom = ["Medical Records", "Tax Filing", "Shipping Manifest"]
        req = DocumentClassifyRequest(
            tenant_id="tenant_gamma",
            document_id="doc_cust_303",
            text="Shipping Manifest #SH-8819\nOrigin: Port of Newark\nDestination: Port of Rotterdam",
            custom_categories=custom
        )
        resp = self.classifier.classify(req)
        self.assertTrue(resp.success)
        self.assertEqual(resp.primary_category, "Shipping Manifest")

    def test_user_correction_loop(self):
        corr_req = ClassificationCorrectionRequest(
            tenant_id="tenant_feedback",
            document_id="doc_misclassified_404",
            corrected_category="Legal Documents"
        )
        self.classifier.record_user_correction(corr_req)

        # Classify again, should retrieve corrected category
        req = DocumentClassifyRequest(
            tenant_id="tenant_feedback",
            document_id="doc_misclassified_404",
            text="Some ambiguous document text"
        )
        resp = self.classifier.classify(req)
        self.assertEqual(resp.primary_category, "Legal Documents")
        self.assertEqual(resp.confidence_score, 100.0)

if __name__ == "__main__":
    unittest.main()

