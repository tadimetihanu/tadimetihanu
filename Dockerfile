# 🐘 CloudObjectIQ Production Gateway
FROM node:20-slim

WORKDIR /app

# Install native dependencies and CA certificates for SSL/TLS
RUN apt-get update && apt-get install -y python3 make g++ ca-certificates curl && update-ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001
CMD ["node", "src/server.js"]
