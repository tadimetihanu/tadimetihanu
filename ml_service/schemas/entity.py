from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from datetime import datetime, timezone

class ExtractedEntity(BaseModel):
    entity_id: Optional[str] = Field(None, description="Unique ID for entity occurrence")
    tenant_id: str = Field(default="default", description="Tenant ID")
    document_id: str = Field(..., description="Source document ID")
    chunk_id: Optional[str] = Field(None, description="Source chunk ID")
    page_number: Optional[int] = Field(1, description="Source page number")
    entity_type: str = Field(..., description="Entity type, e.g. PERSON, COMPANY, INVOICE_NUMBER, etc.")
    entity_value: str = Field(..., description="Extracted entity text")
    normalized_value: Optional[str] = Field(None, description="Standardized or parsed representation")
    confidence_score: float = Field(..., ge=0.0, le=100.0, description="Confidence score 0.0 - 100.0")
    start_char: Optional[int] = Field(None, description="Character start offset in source text")
    end_char: Optional[int] = Field(None, description="Character end offset in source text")
    model_name: str = Field(default="gliner-transformer-ner", description="Model used for extraction")
    model_version: str = Field(default="v1.0.0", description="Model version")
    created_at: Optional[str] = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class EntityFilter(BaseModel):
    tenant_id: str = "default"
    entity_types: Optional[List[str]] = None
    entity_value_contains: Optional[str] = None
    min_confidence: Optional[float] = 70.0
    document_id: Optional[str] = None
    limit: Optional[int] = 50
