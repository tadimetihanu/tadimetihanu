# 🐘 CloudObjectIQ Production Gateway
FROM node:18-slim

WORKDIR /app

# Install native dependencies, Python3 and pip
RUN apt-get update && apt-get install -y python3 python3-pip make g++ && \
    ln -s /usr/bin/python3 /usr/bin/python || true && \
    rm -rf /var/lib/apt/lists/*

# Install Python RAG packages with --break-system-packages flag
RUN pip3 install --no-cache-dir --break-system-packages pymilvus langchain langchain-community langchain-openai langchain-text-splitters pypdf minio openai

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3001
CMD ["node", "src/server.js"]
