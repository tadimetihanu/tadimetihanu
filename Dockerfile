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

# Set Java & Spark environment variables tuned for 512MB RAM containers
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"
ENV SPARK_LOCAL_IP="127.0.0.1"
ENV SPARK_SUBMIT_OPTS="-Dspark.testing.memory=471859200"
ENV PYSPARK_PYTHON=/usr/bin/python3
ENV PYSPARK_DRIVER_PYTHON=/usr/bin/python3
ENV PYSPARK_SUBMIT_ARGS="--conf spark.testing.memory=471859200 --driver-memory 200m --executor-memory 512m pyspark-shell"

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

# Add Hadoop-AWS and AWS SDK jars to PySpark for Cloudflare R2 / S3 / MinIO support
RUN PYSPARK_JARS=$(python3 -c "import pyspark, os; print(os.path.join(os.path.dirname(pyspark.__file__), 'jars'))") && \
    curl -fsSL --retry 3 -o "${PYSPARK_JARS}/hadoop-aws-3.3.4.jar" \
    https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-aws/3.3.4/hadoop-aws-3.3.4.jar && \
    curl -fsSL --retry 3 -o "${PYSPARK_JARS}/aws-java-sdk-bundle-1.12.262.jar" \
    https://repo1.maven.org/maven2/com/amazonaws/aws-java-sdk-bundle/1.12.262/aws-java-sdk-bundle-1.12.262.jar || true

COPY . .

ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs
ENV AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
ENV AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
ENV MALLOC_ARENA_MAX=2
ENV NODE_OPTIONS="--max-old-space-size=160 --max-semi-space-size=4 --expose-gc"

RUN mkdir -p /app/data/.duckdb_spill /app/data/.parquet_cache /app/data/.upload_tmp

EXPOSE 3001
CMD ["node", "src/server.js"]
