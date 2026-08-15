/**
 * CloudObjectIQ MCP Server
 * Exposes CloudObjectIQ tools to MCP-compatible clients (like Claude Desktop)
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");

// Redirect console.log to stderr to avoid breaking MCP JSON-RPC protocol on stdout
console.log = console.error;

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { 
  CallToolRequestSchema, 
  ErrorCode, 
  ListToolsRequestSchema, 
  McpError 
} = require("@modelcontextprotocol/sdk/types.js");

const { runQuery } = require("./src/query/engine");
const { listFiles } = require("./src/drivers/storage");
const Database = require("better-sqlite3");
const db = new Database("./data/metadata.db");

class CloudObjectIQMcpServer {
  constructor() {
    this.server = new Server(
      {
        name: "cloudobjectiq-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error("[MCP Error]", error);
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_targets",
          description: "List all active storage targets (S3, Azure, etc.)",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "list_files",
          description: "List files within a specific storage target",
          inputSchema: {
            type: "object",
            properties: {
              targetId: { type: "string", description: "The UUID of the target" },
            },
            required: ["targetId"],
          },
        },
        {
          name: "run_sql",
          description: "Execute a DuckDB SQL query against a specific target",
          inputSchema: {
            type: "object",
            properties: {
              targetId: { type: "string", description: "The UUID of the target" },
              sql: { type: "string", description: "Standard DuckDB SQL query" },
            },
            required: ["sql", "targetId"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case "list_targets": {
            const targets = db.prepare("SELECT target_id, target_name, provider_type, bucket FROM targets WHERE is_active = 1").all();
            return {
              content: [{ type: "text", text: JSON.stringify(targets, null, 2) }],
            };
          }

          case "list_files": {
            const files = await listFiles(request.params.arguments.targetId);
            return {
              content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
            };
          }

          case "run_sql": {
            const { targetId, sql } = request.params.arguments;
            // Admin user ID (0) for MCP bypass
            const result = await runQuery("mcp-admin", sql, targetId);
            return {
              content: [
                {
                  type: "text",
                  text: `Query Executed in ${result.meta.duration}ms. Rows: ${result.rows.length}\n${JSON.stringify(result.rows, null, 2)}`,
                },
              ],
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("CloudObjectIQ MCP server running on stdio");
  }
}

const server = new CloudObjectIQMcpServer();
server.run().catch(console.error);
