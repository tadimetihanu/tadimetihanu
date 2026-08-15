import asyncio
from langchain_text_splitters import RecursiveCharacterTextSplitter

async def extract_clauses(pages: list) -> list:
    """
    Real Document Chunking.
    Uses LangChain to split each page's text into chunks for the Vector DB.
    Returns a list of dicts: [{"text": str, "page_index": int}]
    """
    clauses = []
    if not pages:
        return clauses
        
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=600,
        chunk_overlap=100,
        length_function=len,
    )
    
    for page in pages:
        text = page.get("text", "")
        if not text or text.startswith("Error extracting text"):
            continue
        chunks = text_splitter.split_text(text)
        for chunk in chunks:
            clauses.append({
                "text": chunk,
                "page_index": page.get("page_index", 1)
            })
            
    return clauses

async def extract_metadata(pages: list) -> dict:
    """
    Mock Metadata Extraction.
    Extracts key entities from the contract.
    """
    await asyncio.sleep(0.5)
    return {
        "contract_type": "Non-Disclosure Agreement (Mock)",
        "parties": ["Party A", "Party B"],
        "effective_date": "2026-05-30"
    }
