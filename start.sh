#!/bin/bash
set -e

echo "🚀 [Render Startup] Preparing CloudObjectIQ Data Directories..."
mkdir -p /app/data/.duckdb_spill /app/data/.parquet_cache /app/data/.upload_tmp

echo "🤖 [Render Startup] Launching Python ML Predictive Cost Intelligence Service on port 8000..."
python3 -m uvicorn ml_service.app:app --host 0.0.0.0 --port 8000 &
ML_PID=$!

echo "⚡ [Render Startup] Launching CloudObjectIQ Node.js Gateway on port ${PORT:-3001}..."
node src/server.js &
NODE_PID=$!

# Trap signals and propagate to children
trap 'echo "🛑 Stopping services..."; kill $ML_PID $NODE_PID 2>/dev/null; exit 0' SIGTERM SIGINT

# Wait for either process to exit
wait -n $ML_PID $NODE_PID
EXIT_CODE=$?

echo "⚠️ Service process exited with code $EXIT_CODE"
kill $ML_PID $NODE_PID 2>/dev/null || true
exit $EXIT_CODE
