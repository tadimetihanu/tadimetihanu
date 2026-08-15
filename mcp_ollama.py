import httpx
import mcp.server.fastmcp as fastmcp
import asyncio
import sys
import os

print("Starting Ollama MCP Server...", file=sys.stderr, flush=True)

# Initialize FastMCP
mcp = fastmcp.FastMCP("Ollama Remote")

# Use environment variable for Ollama host, default to localhost
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")

@mcp.tool()
async def query_ollama(model: str, prompt: str):
    """
    Query a local model running on Ollama.
    """
    url = f"{OLLAMA_HOST}/api/generate"
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(url, json={
            "model": model,
            "prompt": prompt,
            "stream": False
        })
        response.raise_for_status()
        return response.json().get("response", "No response received.")

@mcp.tool()
async def list_local_models():
    """
    List models currently available in the Ollama instance.
    """
    url = f"{OLLAMA_HOST}/api/tags"
    async with httpx.AsyncClient() as client:
        response = await client.get(url)
        response.raise_for_status()
        tags = response.json().get("models", [])
        return [t["name"] for t in tags]

if __name__ == "__main__":
    mcp.run()
