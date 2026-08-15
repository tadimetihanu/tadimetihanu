# Legal RAG Pipeline & CloudObjectIQ - AI Prompt & Engine Upgrades

This document outlines the critical upgrades and fixes applied to the Retrieval-Augmented Generation (RAG) engines in both the **Legal RAG Pipeline (FastAPI)** and the **CloudObjectIQ (Node.js)** repositories.

## 1. Hybrid Search Retrieval (Reciprocal Rank Fusion)
**Affected Files:**
- `Legal_RAG_Pipeline/backend/services/rag.py`
- `CloudObjectIQ_Ready/src/services/rag_engine.py`

**The Problem:** Pure semantic vector search (OpenAI `text-embedding-3-small`) struggled to isolate chunks when users queried very short, exact keyword phrases (e.g., "RTA Fees", "Loan Purpose").

**The Fix:** 
- Upgraded the Milvus retrieval mechanism to use **Reciprocal Rank Fusion (RRF)**. The engine now simultaneously runs a Vector Search and a naive Keyword Search (SQL `LIKE`).
- Tripled the LLM's context window retrieval limit from 10 to 30 chunks, allowing up to 36,000 characters of context per query.

## 2. AcroForm Widget Extraction (PDF Forms)
**Affected Files:**
- `Legal_RAG_Pipeline/backend/services/ocr.py`

**The Problem:** The parser (`fitz`/PyMuPDF) ignored user-filled interactive form fields, causing the AI to miss vital numbers (like a 5.5% interest rate) if they were entered into a digital PDF widget.

**The Fix:** 
- Added logic to explicitly iterate through `page.widgets()` and extract the `field_value` of all form fields, injecting them directly into the parsed text.

## 3. Financial Mathematics & EMI Calculation Logic
**Affected Files:**
- `Legal_RAG_Pipeline/backend/services/rag.py`
- `CloudObjectIQ_Ready/src/services/rag_engine.py`

**The Problem:** The AI refused to calculate dates or perform basic math because it was not explicitly permitted to do so, nor did it know the current date to calculate EMI schedules against. Furthermore, when dealing with long tables split across chunks, it would just count visible rows (e.g., stopping at 11) rather than calculating date differences.

**The Fix:** 
- Injected `datetime.now()` into the core system prompt on every execution.
- Added explicit mathematical permission.
- **Date Difference Rule**: Instructed the AI to calculate the total EMIs paid by mathematically subtracting the `Start Date` from `Today's Date` instead of naively counting truncated table rows.

## 4. Foreclosure & Prepayment Penalty Handling
**Affected Files:**
- `CloudObjectIQ_Ready/src/services/rag_engine.py`

**The Problem:** When users asked about "closing the loan" or "full and final payment", the AI calculated a naive `EMI * Tenure` (Total Lifetime Repayment). It failed to trigger the legal mechanism for foreclosure.

**The Fix:**
- Added a strict forensic rule for loan closures. The AI is now instructed to specifically search for `Prepayment Charges` or penalties, evaluate how many EMIs have been paid, and apply the corresponding penalty percentage (e.g., 2% or 4%) to the outstanding principal.
