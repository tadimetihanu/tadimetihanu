import asyncio
from pymilvus import MilvusClient
from openai import AsyncOpenAI
import uuid
import os

# Initialize Milvus Lite
milvus_client = MilvusClient("./milvus_demo.db")

# Initialize OpenAI
openai_client = AsyncOpenAI(api_key="YOUR_OPENAI_KEY")

from minio import Minio
import io

# Initialize MinIO Client
try:
    minio_client = Minio(
        "127.0.0.1:9000",
        access_key="minioadmin",
        secret_key="minioadmin",
        secure=False
    )
except Exception as e:
    print(f"Failed to initialize MinIO: {e}")

async def store_in_minio(doc_id: str, filename: str, content: bytes) -> str:
    """
    Real MinIO Integration.
    Stores the raw document in the MinIO bucket.
    """
    bucket_name = "datalake"
    
    def upload():
        try:
            if not minio_client.bucket_exists(bucket_name):
                minio_client.make_bucket(bucket_name)
                
            object_name = f"{doc_id}_{filename}"
            minio_client.put_object(
                bucket_name,
                object_name,
                data=io.BytesIO(content),
                length=len(content)
            )
            return f"s3://{bucket_name}/{object_name}"
        except Exception as e:
            return f"MinIO upload error: {e}"
            
    return await asyncio.to_thread(upload)

async def store_in_milvus(doc_id: str, clauses: list) -> str:
    """
    Real Milvus integration for Vector DB Storage.
    Generates embeddings and stores the chunks.
    Uses explicit schema definitions to ensure filtering works correctly.
    """
    from pymilvus import DataType
    if not clauses:
        return "No clauses to insert"
        
    if not milvus_client.has_collection("legal_clauses"):
        schema = milvus_client.create_schema(auto_id=False, enable_dynamic_field=False)
        schema.add_field(field_name="id", datatype=DataType.INT64, is_primary=True)
        schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=1536)
        schema.add_field(field_name="text", datatype=DataType.VARCHAR, max_length=65535)
        schema.add_field(field_name="doc_id", datatype=DataType.VARCHAR, max_length=65535)
        schema.add_field(field_name="page_index", datatype=DataType.INT64)
        
        index_params = milvus_client.prepare_index_params()
        index_params.add_index(field_name="vector", index_type="FLAT", metric_type="COSINE")
        
        milvus_client.create_collection(
            collection_name="legal_clauses",
            schema=schema,
            index_params=index_params
        )

    # 1. Generate embeddings for all clausesing OpenAI
    texts_to_embed = [c["text"] for c in clauses]
    response = await openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=texts_to_embed
    )

    # 2. Prepare data for Milvus
    data = []
    for i, emb in enumerate(response.data):
        data.append({
            "id": int(str(uuid.uuid4().int)[:10]), # Generate simple int ID
            "vector": emb.embedding,
            "text": clauses[i]["text"],
            "page_index": clauses[i]["page_index"],
            "doc_id": doc_id
        })

    # 3. Insert into Milvus Lite
    milvus_client.insert(
        collection_name="legal_clauses",
        data=data
    )

    return f"Successfully inserted {len(clauses)} vectors into Milvus collection 'legal_clauses'"
