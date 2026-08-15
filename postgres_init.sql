CREATE TABLE IF NOT EXISTS ingestion_metadata (
    id SERIAL PRIMARY KEY,
    source_path VARCHAR(500),
    file_type VARCHAR(50),
    minio_path VARCHAR(500),
    record_count INT,
    status VARCHAR(50),
    ingestion_time TIMESTAMP
);
