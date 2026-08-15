from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict
import os

# Ensure the hybrid search module is importable
from src.services.hybrid_search import hybrid_search

app = FastAPI(title="CloudObjectIQ Hybrid Search API", version="0.1")

class SearchRequest(BaseModel):
    query: str
    top_k: int = 10
    solr_weight: float = 0.6
    milvus_weight: float = 0.4

class SearchResult(BaseModel):
    id: str
    title: str | None = None
    content: str | None = None
    source: str
    blend_score: float

class SearchResponse(BaseModel):
    results: List[SearchResult]

@app.post("/api/hybrid-search", response_model=SearchResponse)
async def hybrid_search_endpoint(req: SearchRequest):
    if not req.query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")
    try:
        raw_results = hybrid_search(
            query=req.query,
            top_k=req.top_k,
            solr_weight=req.solr_weight,
            milvus_weight=req.milvus_weight,
        )
        results = [
            SearchResult(
                id=item.get("id"),
                title=item.get("title"),
                content=item.get("content"),
                source=item.get("source"),
                blend_score=item.get("blend_score", 0.0),
            )
            for item in raw_results
        ]
        return SearchResponse(results=results)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
