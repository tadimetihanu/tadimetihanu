# 🐘 CloudObjectIQ Production Gateway
FROM node:20-slim

WORKDIR /app

# Install native dependencies, CA certificates, Python3, and pip
RUN apt-get update && apt-get install -y python3 python3-pip python-is-python3 make g++ ca-certificates curl && update-ca-certificates && rm -rf /var/lib/apt/lists/*

# Symlink python to python3 if missing
RUN ln -sf /usr/bin/python3 /usr/bin/python || true

COPY package*.json ./
RUN npm install

# Install Python requirements for RAG / Analytics Engine (with break-system-packages for Debian 12+)
RUN pip3 install --no-cache-dir --break-system-packages pymilvus langchain-community langchain-text-splitters langchain-openai langchain-core pypdf || pip3 install --no-cache-dir pymilvus langchain-community langchain-text-splitters langchain-openai langchain-core pypdf || true

COPY . .

ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs

EXPOSE 3001
CMD ["node", "src/server.js"]
