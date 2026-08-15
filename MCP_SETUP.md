# CloudObjectIQ MCP Setup Guide

Model Context Protocol (MCP) allow AI agents (like Claude Desktop) to interact directly with your CloudObjectIQ data lake.

## 1. Prerequisites
- Node.js installed
- `@modelcontextprotocol/sdk` installed (already installed in this workspace)

## 2. Configuration for Claude Desktop
Add the following to your Claude Desktop configuration file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cloudobjectiq": {
      "command": "node",
      "args": [
        "C:\\Users\\user\\.gemini\\antigravity\\scratch\\CloudObjectIQ_Ready\\mcp-server.js"
      ],
      "env": {
        "AZURE_STORAGE_CONNECTION_STRING": "...",
        "MINIO_ENDPOINT": "http://localhost:9000",
        "MINIO_ACCESS_KEY": "minioadmin",
        "MINIO_SECRET_KEY": "minioadmin",
        "OPENAI_API_KEY": "..."
      }
    }
  }
}
```
*(Note: Replace `...` with your actual credentials from your `.env` file)*

## 3. Available Tools
Once connected, your AI assistant will have access to:
- `list_targets`: View all connected cloud buckets.
- `list_files`: Browse folders and objects inside targets.
- `run_sql`: Execute SQL queries against Parquet/CSV files directly.

## 4. Run Manually (Testing)
You can test the server by running:
```powershell
node mcp-server.js
```
The server communicates via JSON-RPC on standard I/O.
