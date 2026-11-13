import sys
import os
import unittest
import time

sys.path.insert(0, os.path.dirname(__file__))

def main():
    print("=" * 80)
    print("🧠 CLOUDOBJECTIQ UNSTRUCTURED DOCUMENT ML INTELLIGENCE - FULL VERIFICATION SUITE")
    print("=" * 80)

    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    test_modules = [
        "ml_service.tests.test_classification",
        "ml_service.tests.test_entity_extraction",
        "ml_service.tests.test_reranker",
        "ml_service.tests.test_similarity",
        "ml_service.tests.test_anomaly_detection",
        "ml_service.tests.test_summarization",
        "ml_service.tests.test_model_registry",
        "ml_service.tests.test_document_api"
    ]

    for mod_name in test_modules:
        try:
            mod = __import__(mod_name, fromlist=["*"])
            suite.addTests(loader.loadTestsFromModule(mod))
            print(f" Loaded test suite: {mod_name}")
        except Exception as e:
            print(f"❌ Failed loading {mod_name}: {e}")

    print("-" * 80)
    start_time = time.time()
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    elapsed = round(time.time() - start_time, 2)
    print("-" * 80)

    print(f"\n📊 Summary: Run {result.testsRun} tests in {elapsed}s.")
    if result.wasSuccessful():
        print("✅ ALL DOCUMENT ML INTELLIGENCE AND SECURITY TESTS PASSED SUCCESSFULLY!")
        return 0
    else:
        print(f"❌ FAILURES: {len(result.failures)}, ERRORS: {len(result.errors)}")
        return 1

if __name__ == "__main__":
    sys.exit(main())

