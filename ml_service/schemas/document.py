from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from datetime import datetime

class DocumentChunk(BaseModel):
    chunk_id: str = Field(..., description="Unique chunk identifier")
    text: str = Field(..., description="Extracted chunk text content")
    page_number: Optional[int] = Field(1, description="Page number where chunk appears")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Custom chunk metadata")

class DocumentInput(BaseModel):
    document_id: str = Field(..., description="Unique document identifier")
    tenant_id: str = Field(default="default", description="Tenant isolation ID")
    file_name: Optional[str] = Field(None, description="Original filename")
    raw_text: Optional[str] = Field(None, description="Full raw document text")
    chunks: Optional[List[DocumentChunk]] = Field(default_factory=list, description="Existing document chunks")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Associated document metadata")

class DocumentCitation(BaseModel):
    document_id: str
    tenant_id: str = "default"
    chunk_id: Optional[str] = None
    page_number: Optional[int] = 1
    snippet: Optional[str] = None
    similarity_score: Optional[float] = None

