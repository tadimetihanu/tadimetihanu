# 🐘 CloudObjectIQ Production Gateway
FROM node:20-slim

WORKDIR /app

# Install native dependencies, CA certificates, Python3, pip, OpenJDK 17 headless, and procps for Apache Spark
RUN apt-get update && apt-get install -y \
    python3 python3-pip python-is-python3 make g++ ca-certificates curl \
    default-jre-headless openjdk-17-jre-headless procps \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Symlink python to python3 if missing
RUN ln -sf /usr/bin/python3 /usr/bin/python || true

# Set Java & Spark environment variables
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"
ENV SPARK_LOCAL_IP="127.0.0.1"
ENV PYSPARK_PYTHON=/usr/bin/python3
ENV PYSPARK_DRIVER_PYTHON=/usr/bin/python3
ENV PYSPARK_SUBMIT_ARGS="--driver-memory 256m --executor-memory 256m pyspark-shell"

COPY package*.json ./
RUN npm install

# Install Python requirements for RAG / Analytics Engine and Apache Spark (PySpark)
RUN pip3 install --no-cache-dir --break-system-packages \
    pyspark==3.5.1 \
    pymilvus langchain-community langchain-text-splitters langchain-openai langchain-core pypdf \
    || pip3 install --no-cache-dir \
    pyspark==3.5.1 \
    pymilvus langchain-community langchain-text-splitters langchain-openai langchain-core pypdf \
    || true

COPY . .

ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs
ENV AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
ENV AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
ENV MALLOC_ARENA_MAX=2
ENV NODE_OPTIONS="--max-semi-space-size=4 --expose-gc"

RUN mkdir -p /app/data/.duckdb_spill /app/data/.parquet_cache /app/data/.upload_tmp

EXPOSE 3001
CMD ["node", "src/server.js"]
