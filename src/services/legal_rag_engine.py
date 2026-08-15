import sys
import os
import json
import uuid
import asyncio

# Add current directory to path so it can import from legal_rag
sys.path.append(os.path.dirname(__file__))

from legal_rag.ocr import perform_ocr
from legal_rag.extraction import extract_clauses, extract_metadata
from legal_rag.cloudobjectiq import store_in_minio, store_in_milvus
from legal_rag.rag import process_agent_query

async def index_legal_file(file_path, filename):
    try:
        with open(file_path, 'rb') as f:
            content = f.read()
            
        doc_id = str(uuid.uuid4())
        
        ocr_pages = await perform_ocr(content, filename)
        clauses = await extract_clauses(ocr_pages)
        metadata = await extract_metadata(ocr_pages)
        minio_uri = await store_in_minio(doc_id, filename, content)
        milvus_status = await store_in_milvus(doc_id, clauses)
        
        print(json.dumps({
            "success": True, 
            "document_id": doc_id, 
            "filename": filename,
            "extracted_clauses": len(clauses),
            "metadata": metadata,
            "minio_uri": minio_uri,
            "milvus_status": milvus_status
        }))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

async def query_legal_rag(question, doc_id=None):
    try:
        response = await process_agent_query(question, doc_id)
        print(json.dumps({
            "success": True,
            "answer": response
        }))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Missing arguments"}))
        sys.exit(1)
        
    action = sys.argv[1]
    payload = sys.argv[2]
    
    # Optional argument: filename for index, doc_id for query
    extra_arg = sys.argv[3] if len(sys.argv) > 3 else None
    
    if action == "index":
        filename = extra_arg if extra_arg else os.path.basename(payload)
        asyncio.run(index_legal_file(payload, filename))
    elif action == "query":
        asyncio.run(query_legal_rag(payload, extra_arg))
    else:
        print(json.dumps({"success": False, "error": "Unknown action"}))
