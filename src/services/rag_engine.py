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

def get_openai_key():
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise ValueError("OPENAI_API_KEY environment variable is not set. Please configure it in Render.")
    return key.strip()

def init_milvus():
    os.makedirs("./data", exist_ok=True)
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
    
    api_key = get_openai_key()
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small", api_key=api_key)
    
    data = []
    texts = [doc.page_content for doc in splits]
    vectors = embeddings.embed_documents(texts)
    
    for i, (text, vector, doc) in enumerate(zip(texts, vectors, splits)):
        data.append({
            "id": hash(text) & ((1<<63)-1),
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
    res = client.delete(collection_name=COLLECTION_NAME, filter=f'source == "{source_name}"')
    if client.has_collection(collection_name=CACHE_COLLECTION_NAME):
        client.delete(collection_name=CACHE_COLLECTION_NAME, filter="id >= 0")
    print(json.dumps({"success": True, "deleted": res.get('delete_count', 0)}))

def list_sources():
    client = init_milvus()
    res = client.query(collection_name=COLLECTION_NAME, filter="id >= 0", output_fields=["source"])
    sources = list(set([r.get("source") for r in res if "source" in r]))
    print(json.dumps({"success": True, "sources": sources}))

def query_index(query_text, mode="hybrid"):
    api_key = get_openai_key()
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small", api_key=api_key)
    query_vector = embeddings.embed_query(query_text)
    
    client = init_milvus()
    search_res = client.search(
        collection_name=COLLECTION_NAME,
        data=[query_vector],
        limit=5,
        output_fields=["text", "source", "page"]
    )
    
    hits = search_res[0] if search_res else []
    contexts = []
    sources = []
    for hit in hits:
        entity = hit.get('entity', {})
        txt = entity.get('text', '')
        src = entity.get('source', '')
        page = entity.get('page', 0)
        contexts.append(txt)
        sources.append(f"{src} (p.{page})")
    
    context_str = "\n\n---\n\n".join(contexts) if contexts else "No relevant context found in index."
    
    llm = ChatOpenAI(model="gpt-4o", temperature=0, api_key=api_key)
    prompt = f"""You are a helpful assistant analyzing unstructured documents.
Context:
{context_str}

User Question: {query_text}

Answer clearly based on the context above. If the context does not contain the answer, say so."""
    
    answer = llm.invoke(prompt).content
    print(json.dumps({"success": True, "answer": answer, "sources": list(set(sources))}))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No action specified"}))
        sys.exit(1)
        
    action = sys.argv[1]
    
    try:
        if action == "index":
            file_path = sys.argv[2]
            source_name = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "None" else None
            password = sys.argv[5] if len(sys.argv) > 5 else None
            index_file(file_path, source_name, password)
        elif action == "delete":
            source_name = sys.argv[2]
            delete_document(source_name)
        elif action == "list_sources":
            list_sources()
        elif action == "query":
            query_text = sys.argv[2]
            mode = sys.argv[3] if len(sys.argv) > 3 else "hybrid"
            query_index(query_text, mode)
        else:
            print(json.dumps({"error": f"Unknown action {action}"}))
            sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
