// Фейковый HTTP MCP-сервер jaeger для тестов (stateless Streamable HTTP).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export type JaegerCall = { tool: string; args: Record<string, unknown> };

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function buildServer(calls: JaegerCall[]): McpServer {
  const server = new McpServer({ name: "fake-jaeger", version: "0.0.0" });
  server.registerTool(
    "get_services",
    { inputSchema: { limit: z.number().optional(), pattern: z.string().optional() } },
    async (args) => {
      calls.push({ tool: "get_services", args });
      return text({ services: ["Svc.B", "Svc.A"], total_count: 2, truncated: false });
    },
  );
  server.registerTool(
    "get_span_names",
    { inputSchema: { service_name: z.string(), limit: z.number().optional() } },
    async (args) => {
      calls.push({ tool: "get_span_names", args });
      return text({
        span_names: [
          { name: "GET /b", span_kind: "SERVER" },
          { name: "GET /a", span_kind: "SERVER" },
          { name: "GET /a", span_kind: "CLIENT" },
        ],
      });
    },
  );
  server.registerTool(
    "search_traces",
    {
      inputSchema: {
        service_name: z.string(),
        span_name: z.string().optional(),
        start_time_min: z.string().optional(),
        search_depth: z.number().optional(),
        with_errors: z.boolean().optional(),
      },
    },
    async (args) => {
      calls.push({ tool: "search_traces", args });
      return text({
        traces: [
          { trace_id: "old", start_time: "2026-11-12T10:00:00Z", duration_us: 1500, has_errors: false,
            root_service: "Svc.A", root_span_name: "GET /a", span_count: 3, service_count: 1, services: ["Svc.A"] },
          { trace_id: "new", start_time: "2026-11-12T11:00:00Z", duration_us: 2_500_000, has_errors: true,
            root_service: "Svc.A", root_span_name: "GET /a", span_count: 9, service_count: 2, services: ["Svc.A", "Svc.B"] },
        ],
      });
    },
  );
  return server;
}

export async function startFakeJaeger(): Promise<{ url: string; calls: JaegerCall[]; close: () => Promise<void> }> {
  const calls: JaegerCall[] = [];
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const server = buildServer(calls);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise<void>((done) => http.close(() => done())),
  };
}
