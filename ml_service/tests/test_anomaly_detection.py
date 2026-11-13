import sys
import os
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml_service.schemas.prediction import StructuredDocumentRecord, AnomalyDetectionRequest
from ml_service.document_intelligence.anomaly_detection import DocumentAnomalyDetector

class TestAnomalyDetection(unittest.TestCase):
    def setUp(self):
        self.detector = DocumentAnomalyDetector()

    def test_duplicate_and_date_inversion_anomaly(self):
        records = [
            # Normal record
            StructuredDocumentRecord(
                document_id="doc_norm_1",
                invoice_number="INV-2026-101",
                vendor_or_company="FastFiber Ltd",
                total_amount=500.0,
                invoice_date="2026-05-01",
                due_date="2026-05-30"
            ),
            # Anomaly: Duplicate invoice number
            StructuredDocumentRecord(
                document_id="doc_dupe_inv",
                invoice_number="INV-2026-101",
                vendor_or_company="FastFiber Ltd",
                total_amount=500.0,
                invoice_date="2026-05-01",
                due_date="2026-05-30"
            ),
            # Anomaly: Due date before invoice date
            StructuredDocumentRecord(
                document_id="doc_inverted_date",
                invoice_number="INV-2026-102",
                vendor_or_company="CloudTech LLC",
                total_amount=1200.0,
                invoice_date="2026-06-15",
                due_date="2026-06-01"
            ),
            # Anomaly: Extreme outlier amount ($10,000,000 vs baseline $500 - $1,200)
            StructuredDocumentRecord(
                document_id="doc_extreme_amt",
                invoice_number="INV-2026-103",
                vendor_or_company="Global MegaCorp",
                total_amount=10000000.0,
                invoice_date="2026-06-01",
                due_date="2026-06-30"
            )
        ]
        req = AnomalyDetectionRequest(
            tenant_id="tenant_audit",
            records=records
        )
        resp = self.detector.detect_anomalies(req)
        self.assertTrue(resp.success)
        self.assertGreaterEqual(resp.anomalous_count, 3)

        res_map = {r.document_id: r for r in resp.results}

        # Check duplicate invoice flag
        self.assertTrue(res_map["doc_dupe_inv"].is_anomaly)
        codes = [i.indicator_code for i in res_map["doc_dupe_inv"].indicators]
        self.assertIn("DUPLICATE_INVOICE_NUMBER", codes)

        # Check inverted date flag
        self.assertTrue(res_map["doc_inverted_date"].is_anomaly)
        codes_date = [i.indicator_code for i in res_map["doc_inverted_date"].indicators]
        self.assertIn("INCONSISTENT_DATES", codes_date)

        # Check extreme amount flag
        self.assertTrue(res_map["doc_extreme_amt"].is_anomaly)
        codes_amt = [i.indicator_code for i in res_map["doc_extreme_amt"].indicators]
        self.assertIn("UNUSUAL_TRANSACTION_AMOUNT", codes_amt)

if __name__ == "__main__":
    unittest.main()
