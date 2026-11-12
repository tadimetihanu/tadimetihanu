from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional

class FileMetadata(BaseModel):
    file_format: Optional[str] = "parquet"
    file_count: Optional[int] = 1
    total_file_size_bytes: Optional[int] = 25000000

class ExecutionPlanFeatures(BaseModel):
    query_type: Optional[str] = "SELECT"
    join_count: Optional[int] = 0
    filter_count: Optional[int] = 0
    projection_count: Optional[int] = 1
    selected_column_count: Optional[int] = 1
    column_count: Optional[int] = 10
    has_partition_filter: Optional[int] = 0
    aggregation_count: Optional[int] = 0
    has_wildcard: Optional[int] = 0
    has_group_by: Optional[int] = 0
    has_order_by: Optional[int] = 0
    has_limit: Optional[int] = 0
    limit_value: Optional[int] = -1
    cte_count: Optional[int] = 0
    query_length: Optional[int] = 0
    token_count: Optional[int] = 0

class PredictQueryCostRequest(BaseModel):
    sql_query: str
    storage_provider: Optional[str] = "s3"
    file_metadata: Optional[FileMetadata] = None
    execution_plan_features: Optional[ExecutionPlanFeatures] = None
    tenant_id: Optional[str] = "default"
    cache_status: Optional[str] = "MISS"

class Recommendation(BaseModel):
    id: str
    type: str
    severity: str  # "warning", "tip", "critical"
    message: str
    potential_savings: Optional[str] = None

class ConfidenceIntervalRange(BaseModel):
    lower: float
    upper: float

class ConfidenceIntervals(BaseModel):
    scan_bytes: ConfidenceIntervalRange
    duration_ms: ConfidenceIntervalRange
    cost_usd: ConfidenceIntervalRange

class PredictQueryCostResponse(BaseModel):
    success: bool = True
    sql_query: str
    tenant_id: str
    predicted_scan_volume_bytes: int
    predicted_scan_volume_formatted: str
    predicted_execution_duration_ms: int
    predicted_execution_duration_formatted: str
    predicted_cost_usd: float
    predicted_cost_formatted: str
    confidence_score: float
    confidence_level: str
    confidence_interval: ConfidenceIntervals
    optimization_recommendations: List[Recommendation]
    model_version: str
    algorithm: str

class FeedbackRequest(BaseModel):
    execution_id: str
    tenant_id: Optional[str] = "default"
    user_id: Optional[str] = None
    query_text: str
    predicted_scan_bytes: Optional[int] = 0
    predicted_duration_ms: Optional[int] = 0
    predicted_cost_usd: Optional[float] = 0.0
    actual_scan_bytes: int
    actual_duration_ms: int
    actual_cost_usd: float
    model_version: Optional[str] = "v1.0.0"

class FeedbackResponse(BaseModel):
    success: bool
    execution_id: str
    scan_error_pct: float
    duration_error_pct: float
    cost_error_pct: float
    message: str

class TrainRequest(BaseModel):
    tenant_id: Optional[str] = "default"
    retrain_all: Optional[bool] = False

class TrainResponse(BaseModel):
    success: bool
    tenant_id: str
    version: str
    sample_count: int
    metrics: Dict[str, Any]
    message: str

