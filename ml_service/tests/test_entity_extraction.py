import sys
import os
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml_service.schemas.document import DocumentChunk
from ml_service.schemas.prediction import ExtractEntitiesRequest
from ml_service.document_intelligence.entity_extraction import EntityExtractionEngine

class TestEntityExtraction(unittest.TestCase):
    def setUp(self):
        self.engine = EntityExtractionEngine()

    def test_structured_entity_extraction(self):
        text = (
            "INVOICE #INV-88392\n"
            "Contract No: CTR-55102\n"
            "Date: October 14, 2026\n"
            "Prepared by: Johnathan Davis\n"
            "Company: Apex Technologies Inc\n"
            "Bill To: Quantum Solutions LLC\n"
            "Total Amount: $78,500.00\n"
            "Remit to: 742 Evergreen Terrace, Springfield\n"
            "Email: accounts@apextech.com\n"
            "Tax ID: 12-3456789\n"
        )
        req = ExtractEntitiesRequest(
            tenant_id="tenant_finance",
            document_id="doc_financial_stmt",
            text=text,
            index_to_opensearch=False
        )
        resp = self.engine.extract_entities(req)
        self.assertTrue(resp.success)
        self.assertGreater(resp.entity_count, 5)

        found_types = {e.entity_type for e in resp.entities}
        self.assertIn("INVOICE_NUMBER", found_types)
        self.assertIn("CONTRACT_ID", found_types)
        self.assertIn("DATE", found_types)
        self.assertIn("CURRENCY_AMOUNT", found_types)
        self.assertIn("EMAIL", found_types)
        self.assertIn("TAX_IDENTIFIER", found_types)

        # Check provenance details
        for ent in resp.entities:
            self.assertEqual(ent.document_id, "doc_financial_stmt")
            self.assertEqual(ent.tenant_id, "tenant_finance")
            self.assertIsNotNone(ent.start_char)
            self.assertIsNotNone(ent.end_char)
            self.assertGreaterEqual(ent.confidence_score, 60.0)

    def test_chunk_level_extraction(self):
        chunks = [
            DocumentChunk(chunk_id="chk_1", text="Contract ID: CTR-9901 Signed by: Robert Miller", page_number=1),
            DocumentChunk(chunk_id="chk_2", text="Payment of $25,000.00 due to contact@robert.com", page_number=2)
        ]
        req = ExtractEntitiesRequest(
            tenant_id="tenant_legal",
            document_id="doc_chunked_nda",
            chunks=chunks,
            index_to_opensearch=False
        )
        resp = self.engine.extract_entities(req)
        self.assertTrue(resp.success)
        chunk_ids = {e.chunk_id for e in resp.entities}
        self.assertIn("chk_1", chunk_ids)
        self.assertIn("chk_2", chunk_ids)

if __name__ == "__main__":
    unittest.main()

