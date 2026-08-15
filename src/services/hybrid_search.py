import os
import json
from typing import List, Dict

import pysolr
from pymilvus import connections, Collection

# Initialize Solr client (SOLR_URL env var or default)
solr_url = os.getenv('SOLR_URL', 'http://localhost:8983/solr/cloudobjectiq')
solr = pysolr.Solr(solr_url, always_commit=True, timeout=10)

# Initialize Milvus connection (default settings)
connections.connect(alias='default', host='localhost', port='19530')

# Assume a Milvus collection named "legal_embeddings" exists with fields:
#   - id (string primary key)
#   - embedding (float vector)
#   - title (string) optional for display
#   - content (string) optional

def milvus_search(query_embedding: List[float], top_k: int = 10) -> List[Dict]:
    """Simple wrapper around Milvus vector search.
    Returns a list of dicts with at least 'id' and 'score'.
    """
    collection = Collection('legal_embeddings')
    # Note: this assumes the collection has a vector field named "embedding"
    search_params = {"metric_type": "L2", "params": {"nlist": 128}}
    results = collection.search(
        data=[query_embedding],
        anns_field='embedding',
        param=search_params,
        limit=top_k,
        expr=None,
        output_fields=['id', 'title', 'content']
    )
    matches = []
    for hits in results:
        for hit in hits:
            matches.append({
                'id': hit.id,
                'score': hit.distance,
                'title': hit.entity.get('title'),
                'content': hit.entity.get('content')
            })
    return matches

def get_query_embedding(query: str) -> List[float]:
    """Placeholder: generate a dummy embedding. In production replace with actual model.
    For now we return a list of zeros of dimension 768.
    """
    dim = int(os.getenv('EMBEDDING_DIM', '768'))
    return [0.0] * dim

def hybrid_search(query: str, top_k: int = 10, solr_weight: float = 0.6, milvus_weight: float = 0.4) -> List[Dict]:
    """Perform a hybrid search using Solr BM25 (plus optional kNN) and Milvus vector search.
    Returns a merged, re‑ranked list of result dicts.
    """
    # 1️⃣ Solr BM25 search
    solr_params = {
        'defType': 'edismax',
        'q': query,
        'rows': top_k,
        'fl': 'id,title,content,score'
    }
    solr_response = solr.search(**solr_params)
    solr_hits = []
    for doc in solr_response:
        solr_hits.append({
            'id': doc.get('id'),
            'title': doc.get('title'),
            'content': doc.get('content'),
            'solr_score': doc.get('score', 0.0),
            'source': 'solr'
        })

    # 2️⃣ Milvus vector search (if we can generate an embedding)
    query_vec = get_query_embedding(query)
    milvus_hits_raw = milvus_search(query_vec, top_k)
    milvus_hits = []
    for hit in milvus_hits_raw:
        milvus_hits.append({
            'id': hit['id'],
            'title': hit.get('title'),
            'content': hit.get('content'),
            'milvus_score': hit['score'],
            'source': 'milvus'
        })

    # 3️⃣ Merge & re‑rank using linear weighting
    combined = []
    for d in solr_hits:
        d['blend_score'] = solr_weight * d.get('solr_score', 0.0)
        combined.append(d)
    for d in milvus_hits:
        d['blend_score'] = milvus_weight * d.get('milvus_score', 0.0)
        combined.append(d)

    combined.sort(key=lambda x: x['blend_score'], reverse=True)
    return combined[:top_k]
