FROM python:3.12-slim

WORKDIR /app

# Install system build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY ml_service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy ML service code
COPY ml_service/ /app/ml_service/

EXPOSE 8000

ENV PYTHONUNBUFFERED=1
ENV ML_SERVICE_API_KEY="cloudobjectiq_ml_internal_key_2026"

CMD ["uvicorn", "ml_service.app:app", "--host", "0.0.0.0", "--port", "8000"]

