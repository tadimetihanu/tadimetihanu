#!/bin/bash
# 🐧 CloudObjectIQ - Ubuntu Desktop Auto-Deploy v1.0

# Colors for terminal output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Initializing CloudObjectIQ on Ubuntu...${NC}"

# 1. Verification
echo -e "🔍 Checking requirements..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js not found. Please install with: sudo apt install nodejs${NC}"
    exit 1
fi

if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Please install with: sudo apt install docker.io${NC}"
    exit 1
fi

# 2. Dependency Management
echo -e "${BLUE}📦 Installing platform dependencies...${NC}"
npm install

# 3. Directory & Permissions setup
echo -e "${BLUE}📂 Preparing Data Lake directories...${NC}"
mkdir -p data/metadata data/datalake minio_data mysql_data spark_data
chmod -R 777 data minio_data mysql_data spark_data # Ensure Docker can write

# 4. Infrastructure Launch
echo -e "${BLUE}🐘 Starting Spark & Storage Grid (Docker)...${NC}"
docker-compose up -d

# 5. Environment Check
if [ ! -f .env ]; then
    echo "Creating default .env..."
    cp .env.example .env 2>/dev/null || touch .env
fi

echo -e "${GREEN}✅ Infrastructure is LIVE.${NC}"
echo -e "${BLUE}🖥️  Launching CloudObjectIQ Gateway...${NC}"

# 6. Execution
npm start
