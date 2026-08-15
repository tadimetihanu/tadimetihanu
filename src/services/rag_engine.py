import sys
import os
import json
from pymilvus import MilvusClient
from langchain_community.document_loaders import TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings, ChatOpenAI
from langchain_core.prompts import PromptTemplate
from langchain_core.documents import Document

# Configuration
DB_PATH = "./data/milvus.db"
COLLECTION_NAME = "unstructured_rag"
DIMENSION = 1536  # OpenAI text-embedding-3-small dimension

CACHE_COLLECTION_NAME = "rag_cache"

def init_milvus():
    client = MilvusClient(DB_PATH)
    if not client.has_collection(collection_name=COLLECTION_NAME):
        client.create_collection(
            collection_name=COLLECTION_NAME,
            dimension=DIMENSION
        )
    if not client.has_collection(collection_name=CACHE_COLLECTION_NAME):
        client.create_collection(
            collection_name=CACHE_COLLECTION_NAME,
            dimension=DIMENSION
        )
    return client

def load_pdf_with_pypdf(file_path, password=None):
    from pypdf import PdfReader
    reader = PdfReader(file_path)
    if reader.is_encrypted:
        if password:
            res = reader.decrypt(password)
            if not res:
                raise ValueError("File has not been decrypted (Invalid Password)")
        else:
            raise ValueError("File has not been decrypted (Password Required)")
            
    documents = []
    meta_str = "Document Metadata:\n"
    if reader.metadata:
        for k, v in reader.metadata.items():
            if v:
                meta_str += f"{k}: {v}\n"
                
    for i, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        if i == 0 and meta_str.strip() != "Document Metadata:":
            text = meta_str + "\n" + text
        
        # Optional: Widgets handling
        if "/Annots" in page:
            for annot in page["/Annots"]:
                try:
                    annot_obj = annot.get_object()
                    if annot_obj.get("/Subtype") == "/Widget" and annot_obj.get("/V"):
                        val = annot_obj.get("/V")
                        if isinstance(val, str):
                            text += "\n" + val
                except:
                    pass
                    
        metadata = {"source": file_path, "page": i}
        documents.append(Document(page_content=text, metadata=metadata))
    return documents

def load_cad_with_ezdxf(file_path):
    import ezdxf
    try:
        doc = ezdxf.readfile(file_path)
    except Exception as e:
        raise ValueError(f"Failed to read DXF file {file_path}: {e}")
        
    msp = doc.modelspace()
    documents = []
    
    meta_str = "CAD Document Metadata:\n"
    if doc.dxfversion:
        meta_str += f"DXF Version: {doc.dxfversion}\n"
    
    text_content = meta_str
    
    # Query all TEXT and MTEXT entities in modelspace
    for entity in msp.query('TEXT MTEXT'):
        try:
            if hasattr(entity.dxf, 'text') and entity.dxf.text:
                text_content += f"{entity.dxf.text}\n"
        except:
            pass
            
    metadata = {"source": file_path, "page": 0}
    documents.append(Document(page_content=text_content.strip(), metadata=metadata))
    
    return documents

def index_file(file_path, source_name=None, password=None):
    print(f"Indexing {file_path}...", file=sys.stderr)
    ext = os.path.splitext(file_path)[1].lower()
    
    if ext == '.pdf':
        docs = load_pdf_with_pypdf(file_path, password)
    elif ext == '.dxf':
        docs = load_cad_with_ezdxf(file_path)
    elif ext in ['.txt', '.md', '.csv']:
        loader = TextLoader(file_path, encoding='utf-8')
        docs = loader.load()
    else:
        raise ValueError(f"Unsupported file extension: {ext}")
    
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
    splits = text_splitter.split_documents(docs)
    
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
    
    # Generate embeddings and prepare data for Milvus
    data = []
    texts = [doc.page_content for doc in splits]
    vectors = embeddings.embed_documents(texts)
    
    for i, (text, vector, doc) in enumerate(zip(texts, vectors, splits)):
        data.append({
            "id": hash(text) & ((1<<63)-1), # Generate a positive 64-bit int ID
            "vector": vector,
            "text": text,
            "source": source_name if source_name else doc.metadata.get("source", file_path),
            "page": doc.metadata.get("page", 0)
        })
    
    client = init_milvus()
    res = client.insert(collection_name=COLLECTION_NAME, data=data)
    
    if client.has_collection(collection_name=CACHE_COLLECTION_NAME):
        client.delete(collection_name=CACHE_COLLECTION_NAME, filter="id >= 0")
    
    print(json.dumps({"success": True, "inserted": res.get('insert_count', len(data)), "chunks": len(splits)}))

def delete_document(source_name):
    print(f"Deleting document {source_name} from index...", file=sys.stderr)
    client = init_milvus()
    
    if not client.has_collection(collection_name=COLLECTION_NAME):
        print(json.dumps({"success": False, "error": "No documents indexed yet."}))
        return

    # Delete vectors where source == source_name
    res = client.delete(
        collection_name=COLLECTION_NAME,
        filter=f"source == '{source_name}'"
    )
    
    if client.has_collection(collection_name=CACHE_COLLECTION_NAME):
        client.delete(collection_name=CACHE_COLLECTION_NAME, filter="id >= 0")
        
    print(json.dumps({"success": True, "deleted": True, "message": f"Deleted vectors for {source_name}"}))

def list_sources():
    client = init_milvus()
    
    if not client.has_collection(collection_name=COLLECTION_NAME):
        print(json.dumps({"success": True, "sources": []}))
        return

    client.load_collection(collection_name=COLLECTION_NAME)

    # Query all vectors and get the source field
    res = client.query(
        collection_name=COLLECTION_NAME,
        filter="id >= 0",
        output_fields=["source"],
        limit=100000
    )
    
    # Extract unique sources
    sources = set()
    for hit in res:
        if 'source' in hit and hit['source']:
            sources.add(hit['source'])
            
    print(json.dumps({"success": True, "sources": list(sources)}))

def query_rag(question, mode="hybrid"):
    print(f"Querying: {question}", file=sys.stderr)
    client = init_milvus()
    
    if not client.has_collection(collection_name=COLLECTION_NAME):
        print(json.dumps({"success": False, "error": "No documents indexed yet."}))
        return

    # --- Semantic Cache Lookup ---
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
    query_vector = embeddings.embed_query(question)
    # ── SEMANTIC CACHE CHECK ──
    if mode != "exhaustive" and client.has_collection(collection_name=CACHE_COLLECTION_NAME):
        client.load_collection(collection_name=CACHE_COLLECTION_NAME)
        cache_res = client.search(
            collection_name=CACHE_COLLECTION_NAME,
            data=[query_vector],
            limit=1,
            output_fields=["question", "answer"]
        )
        
        if cache_res and len(cache_res[0]) > 0:
            best_match = cache_res[0][0]
            # Threshold check: Milvus default is usually COSINE (higher is better similarity, or lower distance)
            # We'll use a conservative threshold check since metric might be COSINE or L2.
            # If exact match or highly similar:
            is_match = False
            dist = best_match.get('distance', 0)
            # If L2: distance < 0.2 is very close. If COSINE: distance > 0.9 or distance < 0.1 depending on if it returns similarity or distance.
            # A safe way is to check if it's very close to 0 or 1.
            if dist < 0.1 or dist > 0.9: 
                is_match = True
            
            # Or just check string equality to be absolutely safe on first launch:
            if best_match['entity']['question'].strip().lower() == question.strip().lower():
                is_match = True

            if is_match:
                print(json.dumps({
                    "success": True,
                    "answer": best_match['entity']['answer'],
                    "context_snippets": 0,
                    "cached": True
                }))
                return
    # --- End Cache Lookup ---

    client.load_collection(collection_name=COLLECTION_NAME)
    
    contexts = []
    sources = set()
    
    if mode == "keyword":
        # Full-text Keyword Search using LIKE filter
        safe_question = question.replace('"', '').replace("'", "")
        tokens = [t.replace('mg', '').replace('MG', '') if t.lower().endswith('mg') else t for t in safe_question.split() if len(t) > 1 and t.lower() not in {"list", "show", "what", "how", "the", "for", "and", "all", "me", "of"}]
        kw_filter = " OR ".join([f'text LIKE "%{t}%"' for t in tokens]) if tokens else f'text LIKE "%{safe_question}%"'
        search_res = client.query(
            collection_name=COLLECTION_NAME,
            filter=kw_filter,
            output_fields=["text", "source", "page"],
            limit=5
        )
        for hit in search_res:
            text = hit['text']
            source = hit.get('source', 'Unknown')
            page = hit.get('page', 'Unknown')
            contexts.append(f"[Source: {source}, Page: {page}]\n{text}")
            sources.add(source)
    elif mode == "hybrid":
        # Application-level Reciprocal Rank Fusion (RRF) Hybrid Search
        embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
        query_vector = embeddings.embed_query(question)
        
        # 1. Semantic Search
        sem_res = client.search(
            collection_name=COLLECTION_NAME,
            data=[query_vector],
            limit=30,
            output_fields=["text", "source", "page"]
        )
        
        # 2. Keyword Search
        safe_question = question.replace('"', '').replace("'", "")
        tokens = [t.replace('mg', '').replace('MG', '') if t.lower().endswith('mg') else t for t in safe_question.split() if len(t) > 1 and t.lower() not in {"list", "show", "what", "how", "the", "for", "and", "all", "me", "of"}]
        kw_filter = " OR ".join([f'text LIKE "%{t}%"' for t in tokens]) if tokens else f'text LIKE "%{safe_question}%"'
        kw_res = client.query(
            collection_name=COLLECTION_NAME,
            filter=kw_filter,
            output_fields=["text", "source", "page"],
            limit=30
        )
        
        # 3. RRF Scoring
        rrf_scores = {}
        snippets_data = {}
        
        for rank, hit in enumerate(sem_res[0]):
            text = hit['entity']['text']
            snippets_data[text] = hit['entity']
            rrf_scores[text] = rrf_scores.get(text, 0) + 1.0 / (60 + rank)
            
        for rank, hit in enumerate(kw_res):
            text = hit['text']
            snippets_data[text] = hit
            rrf_scores[text] = rrf_scores.get(text, 0) + 1.0 / (60 + rank)
            
        sorted_snippets = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)
        
        for text, score in sorted_snippets[:30]:
            hit = snippets_data[text]
            source = hit.get('source', 'Unknown')
            page = hit.get('page', 'Unknown')
            contexts.append(f"[Source: {source}, Page: {page}]\n{text}")
            sources.add(source)
    elif mode == "exhaustive":
        safe_question = question.replace('"', '').replace("'", "")
        tokens = [t.replace('mg', '').replace('MG', '') if t.lower().endswith('mg') else t for t in safe_question.split() if len(t) > 1 and t.lower() not in {"list", "show", "what", "how", "the", "for", "and", "all", "me", "of", "count", "many"}]
        kw_filter = " OR ".join([f'text LIKE "%{t}%"' for t in tokens]) if tokens else f'text LIKE "%{safe_question}%"'
        search_res = client.query(
            collection_name=COLLECTION_NAME,
            filter=kw_filter,
            output_fields=["text", "source", "page"],
            limit=400
        )
        for hit in search_res:
            source = hit.get('source', 'Unknown')
            page = hit.get('page', 'Unknown')
            text = hit['text']
            if tokens:
                lines = [line.strip() for line in text.split('\n') if any(t.lower() in line.lower() for t in tokens)]
                if lines:
                    contexts.append(f"[Source: {source}, Page: {page}]\n" + "\n".join(lines))
            else:
                contexts.append(f"[Source: {source}, Page: {page}]\n{text}")
            sources.add(source)
    else:
        # Semantic Search using Vector Embeddings
        embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
        query_vector = embeddings.embed_query(question)
        
        search_res = client.search(
            collection_name=COLLECTION_NAME,
            data=[query_vector],
            limit=30,
            output_fields=["text", "source", "page"]
        )
        for hits in search_res:
            for hit in hits:
                text = hit['entity']['text']
                source = hit['entity'].get('source', 'Unknown')
                page = hit['entity'].get('page', 'Unknown')
                contexts.append(f"[Source: {source}, Page: {page}]\n{text}")
                sources.add(source)
            
    context_str = "\n\n".join(contexts)
    
    import datetime
    current_date = datetime.datetime.now().strftime("%B %d, %Y")
    
    prompt = f"""You are a helpful AI assistant analyzing documents. Today's date is {current_date}.
Use the following context to answer the user's question. 
If the context contains a partial answer or relevant information, provide it. Even if the context only mentions the topic briefly without deep detail, summarize what IS available instead of refusing to answer.
Only if the topic is completely missing from the context should you say that you cannot answer.
When you provide any information from the context, you MUST explicitly mention the [Source: ..., Page: ...] file path(s) and page number(s) you used in your response.

You are explicitly permitted to perform mathematical calculations using numbers found in the context.
IMPORTANT RULE 1: If the user asks 'how many EMIs I have paid', ASSUME they have paid all EMIs strictly according to the schedule up to today's date. DO NOT just count the rows visible in the context. Instead, find the START DATE (first installment) and mathematically calculate the number of months between that Start Date and Today's Date.
IMPORTANT RULE 2: If the user asks about 'closing the loan', 'full and final', 'prepayment', or 'foreclosure', DO NOT just calculate EMI * Tenure. You MUST look for 'Prepayment Charges' in the context. Calculate how many EMIs they have paid to date (using Rule 1), find the applicable penalty percentage from the Prepayment Charges table, and explain that the final amount is the Outstanding Principal plus the applicable Prepayment Penalty %.
IMPORTANT RULE 3: If the user asks for a specific category, filter, or value (like "100mg"), STRICTLY filter the context and ONLY list the items that exactly match the requested criteria. DO NOT include items that don't match (e.g. 200mg) with a warning note; completely exclude them from your answer.
IMPORTANT RULE 4: If the user asks 'how many' or for a 'count', you MUST be absolutely EXHAUSTIVE. Search the entire context carefully and extract EVERY SINGLE matching item. Do not stop early. If there are 30 matches, you must list all 30. First, explicitly state the total count of matches found in the context. Then, provide a clean list of examples formatted as "Name 100mg (Page X)".

Context:
{context_str}

Question:
{question}

Answer:"""

    llm = ChatOpenAI(model="gpt-4o", temperature=0)
    response = llm.invoke(prompt)
    answer_text = response.content
    
    # --- Semantic Cache Insertion ---
    try:
        cache_data = [{
            "id": hash(question) & ((1<<63)-1),
            "vector": query_vector,
            "question": question,
            "answer": answer_text
        }]
        client.insert(collection_name=CACHE_COLLECTION_NAME, data=cache_data)
    except Exception as e:
        print(f"Warning: Failed to cache response: {e}", file=sys.stderr)
    # --- End Cache Insertion ---
    
    print(json.dumps({
        "success": True,
        "answer": answer_text,
        "context_snippets": len(contexts),
        "cached": False
    }))

if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    
    if len(sys.argv) < 3:
        print("Usage: python rag_engine.py [index|query] [filepath|question]")
        sys.exit(1)
        
    action = sys.argv[1]
    payload = sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else "hybrid"
    
    with open("debug.log", "a") as f:
        f.write(f"ARGS: {sys.argv}\n")
    
    try:
        if action == "index":
            source_name = sys.argv[4] if len(sys.argv) > 4 else None
            if source_name in ["None", "null", '""']:
                source_name = None
            password = sys.argv[5] if len(sys.argv) > 5 else None
            index_file(payload, source_name, password)
        elif action == "query":
            query_rag(payload, mode)
        elif action == "delete":
            delete_document(payload)
        elif action == "list_sources":
            list_sources()
        else:
            print(json.dumps({"success": False, "error": "Unknown action"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
