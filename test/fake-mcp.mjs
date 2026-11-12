// Фейковый MCP-сервер graylog для тестов: те же имена инструментов и форма ответов.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync } from "node:fs";
import { z } from "zod";

const log = process.env.FAKE_MCP_LOG;
const record = (tool, args) => log && appendFileSync(log, JSON.stringify({ tool, args }) + "\n");
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const server = new McpServer({ name: "fake-graylog", version: "0.0.0" });
server.tool("list_instances", {}, async () => {
  record("list_instances", {});
  return text([{ name: "prod" }, { name: "dev" }, { name: "hotfix" }]);
});
server.tool(
  "search_messages",
  { instance: z.string().optional(), query: z.string().optional(), streams: z.array(z.string()).optional(),
    range_seconds: z.number().optional(), limit: z.number().optional(), sort: z.string().optional(),
    fields: z.array(z.string()).optional() },
  async (args) => {
    record("search_messages", args);
    return text({
      instance: args.instance, total: 1, returned: 1, offset: 0,
      messages: [{
        index: "graylog_1", id: "m1", Timestamp: "2026-11-11T22:30:32.6317538Z", LogLevel: "Error",
        Message: "Boom happened", message: JSON.stringify({ Resources: { "service.name": "Svc.Api" } }),
        Exception: "System.Exception: bad\n   at X", TraceId: "abc",
      }],
    });
  },
);
await server.connect(new StdioServerTransport());
