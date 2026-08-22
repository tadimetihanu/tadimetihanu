# 🐘 CloudObjectIQ Production Gateway
FROM node:20-slim

WORKDIR /app

# Install native dependencies for DuckDB/SQLite
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001
CMD ["node", "src/server.js"]
