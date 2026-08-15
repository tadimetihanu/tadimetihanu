#!/bin/bash
echo "Waiting for HDFS to be healthy..."
until hdfs dfsadmin -safemode wait; do
  sleep 2
done

echo "HDFS is ready. Creating directories..."
hdfs dfs -mkdir -p /data/parquet
hdfs dfs -mkdir -p /user/admin

echo "Ingesting Parquet files..."
if [ -d "/tmp/ingest" ]; then
  hdfs dfs -put /tmp/ingest/*.parquet /data/parquet/
  echo "✅ Ingestion Complete."
else
  echo "❌ No ingest directory found."
fi

hdfs dfs -ls -R /data
