import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import {
  DEFAULT_LOGS_QUESTION, DEFAULT_QUESTION, MAX_RANGE_SECONDS, buildAgentPrompt, buildLogsPrompt, buildQueryTranslationPrompt,
  cleanTraceId, envNames, formatRange, httpInfo, parseQueryJson, parseSearch, renderTemplate, resolveTarget,
} from "../lib/graylog";
import { formatDuration, jaegerMcpUrls, jaegerTraceUrl, parseOperations, parseServices, parseTraces } from "../lib/jaeger";
import { startFakeJaeger } from "./fake-jaeger";
import {
  formatMs, formatSize, groupByEnv, levelKind, offsetLabel, prettyBody, serviceColor, shortService, statusKind, summarize, summaryLine, titleWithoutEnv,
} from "../lib/logview";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
});

async function setup(extraSettings: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bb-graylog-"));
  const log = join(dir, "calls.jsonl");
  const config = join(dir, "claude.json");
  const jaeger = await startFakeJaeger();
  disposers.push(jaeger.close);
  writeFileSync(config, JSON.stringify({
    mcpServers: {
      graylog: {
        type: "stdio", command: process.execPath,
        args: [resolve(__dirname, "fake-mcp.mjs")], env: { FAKE_MCP_LOG: log },
      },
    },
  }));
  const spawned: Array<Record<string, unknown>> = [];
  const listArgs: Array<Record<string, unknown>> = [];
  const archived: string[] = [];
  const deleted: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const waited: Array<Record<string, unknown>> = [];
  let helperOutput = 'Вот запрос:\n```json\n{"query": "LogLevel:Error", "range_seconds": 3600}\n```';
  const setHelperOutput = (value: string) => { helperOutput = value; };
  const thread = (id: string, title: string, status: string, updatedAt: number, archivedAt: number | null = null) =>
    ({ id, title, titleFallback: null, status, updatedAt, archivedAt, deletedAt: null });
  const threads = [
    thread("thr_a", "dev: abc", "idle", 200),
    thread("thr_b", "stage: Ошибки", "pending", 300),
    thread("thr_old", "prod: x", "idle", 400, 999),
    thread("thr_foreign", "чужой", "idle", 500),
  ];
  const metadata: Record<string, Record<string, unknown>> = {
    thr_a: { kind: "session", env: "dev", traceId: "abc", prompt: "" },
    thr_b: { kind: "session", env: "stage", traceId: null, prompt: "Ошибки" },
    thr_old: { kind: "session", env: "prod", traceId: "x", prompt: "" },
    thr_foreign: { other: true },
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "graylog",
    settings: { claudeConfigPath: config, jaegerMcpUrls: JSON.stringify({ dev: jaeger.url }), ...extraSettings },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => threads.find((t) => t.id === threadId),
        spawn: async (args: Record<string, unknown>) => { spawned.push(args); return { id: "thr_new" }; },
        list: async (args: Record<string, unknown>) => { listArgs.push(args); return threads; },
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds.filter((id) => metadata[id]).map((id) => ({ threadId: id, metadata: metadata[id] })),
        }),
        getPluginMetadata: async ({ threadId }: { threadId: string }) => ({ metadata: metadata[threadId] ?? null }),
        archive: async ({ threadId }: { threadId: string }) => { archived.push(threadId); return {}; },
        wait: async (args: Record<string, unknown>) => { waited.push(args); return { matched: true }; },
        output: async () => ({ output: helperOutput }),
        delete: async ({ threadId }: { threadId: string }) => { deleted.push(threadId); return {}; },
        send: async (args: Record<string, unknown>) => { sent.push(args); return {}; },
      },
      projects: {
        defaultExecutionOptions: async () => ({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "default" }),
      },
    } as never,
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const calls = () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> })
    : [];
  return { harness, spawned, calls, listArgs, archived, deleted, waited, sent, setHelperOutput, jaegerCalls: jaeger.calls, expireJaegerSession: jaeger.expireSession };
}

describe("lib/graylog query translation", () => {
  it("parses the helper answer", () => {
    expect(parseQueryJson('{"query":"LogLevel:Error","range_seconds":3600}')).toEqual({ query: "LogLevel:Error", rangeSeconds: 3600 });
    expect(parseQueryJson('ok\n```json\n{"query": "*", "range_seconds": "900"}\n```')).toEqual({ query: "*", rangeSeconds: 900 });
    expect(parseQueryJson('{"query":"*","range_seconds":99999999}').rangeSeconds).toBe(MAX_RANGE_SECONDS);
    expect(() => parseQueryJson("нет")).toThrow(/не вернул запрос/);
    expect(() => parseQueryJson('{"query":""}')).toThrow();
  });
  it("formats ranges and builds the logs prompt for a query search", () => {
    expect(formatRange(3600)).toBe("час");
    expect(formatRange(900)).toBe("15 мин");
    expect(formatRange(172800)).toBe("2 дн.");
    const text = buildLogsPrompt(resolveTarget("dev"), { kind: "query", query: "LogLevel:Error", rangeSeconds: 3600, prompt: "ошибки" }, "",
      parseSearch(JSON.stringify({ total: 0, messages: [] })));
    expect(text).toContain("Запрос: LogLevel:Error. Интервал: последние час");
    expect(text.endsWith(DEFAULT_LOGS_QUESTION)).toBe(true);
    expect(buildQueryTranslationPrompt(resolveTarget("dev"), "ошибки за час")).toContain('{"query": "...", "range_seconds": N}');
  });
});

describe("parsing request/response logs", () => {
  const otel = (message: string, attrs: Record<string, string>) => JSON.stringify({
    Timestamp: "2026-11-12T13:23:33.58Z", TraceId: "t", SpanId: "0eed6c3eac4cf45c", EventId: "0",
    CategoryName: "Svc.Middlewares.RequestResponseLoggingMiddleware", LogLevel: "Information", FormattedMessage: null,
    Message: message, Attributes: attrs, Resources: { "service.name": "Svc.Api" }, Exception: null,
  });
  it("extracts the body, HTTP info, attributes and renders the template", () => {
    const body = '{"personId":"p1","provider":"DIGITAP"}';
    const r = parseSearch(JSON.stringify({ total: 2, messages: [
      { id: "1", index: "i", Message: "Incoming request: {Method} {Path}{QueryString}. Body: {Body}",
        Resources_service_name: "Svc.Api", Attributes_Method: "POST", Attributes_Path: "/v1/links:resolve", Attributes_Body: body,
        message: otel("Incoming request: {Method} {Path}{QueryString}. Body: {Body}", { Method: "POST", Path: "/v1/links:resolve", QueryString: "?a=1", Body: body }) },
      { id: "2", index: "i", Message: "End processing HTTP request after {ElapsedMilliseconds}ms - {StatusCode}",
        Attributes_StatusCode: "503", Attributes_ElapsedMilliseconds: "19.0003", message: "обрезано{" },
    ] }));
    const [req, end] = r.rows;
    expect(req).toMatchObject({
      service: "Svc.Api", body, spanId: "0eed6c3eac4cf45c", eventId: "",
      category: "Svc.Middlewares.RequestResponseLoggingMiddleware",
      message: `Incoming request: POST /v1/links:resolve?a=1. Body: ${body}`,
      http: { kind: "request", method: "POST", path: "/v1/links:resolve?a=1", status: "", elapsedMs: null },
    });
    expect(req?.attributes).toEqual({ Method: "POST", Path: "/v1/links:resolve", QueryString: "?a=1" });
    expect(summaryLine(req!)).toBe("Incoming request: POST /v1/links:resolve?a=1. Body: …");
    expect(end).toMatchObject({
      message: "End processing HTTP request after 19.0003ms - 503",
      http: { kind: "response", status: "503", elapsedMs: 19.0003 }, body: "",
    });
    expect(httpInfo("Outgoing response: {StatusCode}", { StatusCode: "200" })?.kind).toBe("response");
    expect(httpInfo("Worker running at: {Time}", { Time: "now" })).toBeNull();
  });
  it("renders templates with format specifiers and keeps unknown placeholders", () => {
    expect(renderTemplate("took {Elapsed:0.00} ms for {Id}", { Elapsed: "1.5" })).toBe("took 1.5 ms for {Id}");
  });
  it("pretty-prints JSON bodies and classifies statuses", () => {
    expect(prettyBody('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true });
    expect(prettyBody("plain")).toEqual({ text: "plain", json: false });
    expect(["200", "302", "404", "500", "x"].map(statusKind)).toEqual(["ok", "redirect", "client", "server", "unknown"]);
    expect(formatSize("abc")).toBe("3 Б");
    expect(formatSize("x".repeat(2048))).toBe("2.0 КБ");
  });
});

describe("lib/logview", () => {
  const row = (time: string, level: string, service: string) =>
    ({ id: "1", index: "i", time, level, service, message: "m", template: "m", exception: "", category: "",
      spanId: "", eventId: "", attributes: {}, body: "", http: null });
  it("groups sessions by environment, freshest group first, keeping order inside", () => {
    const items = [
      { env: "dev", id: 1, updatedAt: 50 }, { env: "qa", id: 2, updatedAt: 10 }, { env: "prod", id: 3, updatedAt: 30 },
      { env: "dev", id: 4, updatedAt: 20 }, { env: "stage", id: 5, updatedAt: 10 },
    ];
    expect(groupByEnv(items).map((g) => [g.env, g.items.map((i) => i.id)])).toEqual([
      ["dev", [1, 4]], ["prod", [3]], ["stage", [5]], ["qa", [2]],
    ]);
    expect(titleWithoutEnv("dev: abc", "dev")).toBe("abc");
    expect(titleWithoutEnv("abc", "dev")).toBe("abc");
  });
  it("classifies levels", () => {
    expect(["Error", "Critical", "Fatal", "err"].map(levelKind)).toEqual(["error", "error", "error", "error"]);
    expect(levelKind("Warning")).toBe("warn");
    expect(levelKind("Debug")).toBe("debug");
    expect(levelKind("Trace")).toBe("debug");
    expect(levelKind("Information")).toBe("info");
    expect(levelKind("")).toBe("info");
  });
  it("shortens service names and colors them stably", () => {
    expect(shortService("LMS.Platform.Services.FilesManager.RestApi")).toBe("FilesManager");
    expect(shortService("LMS.India2.BFF.BOB.Client.RestApi")).toBe("BOB.Client");
    expect(shortService("bpm-platform-dcs")).toBe("bpm-platform-dcs");
    expect(serviceColor("a")).toBe(serviceColor("a"));
    expect(serviceColor("anything", 8)).toBeLessThan(8);
  });
  it("summarizes rows", () => {
    const summary = summarize([
      row("2026-11-12T10:00:00.000Z", "Information", "A"),
      row("2026-11-12T10:00:01.500Z", "Error", "B"),
      row("2026-11-12T10:00:00.200Z", "Warning", "A"),
    ], 5);
    expect(summary).toMatchObject({ total: 5, shown: 3, errors: 1, warnings: 1, services: ["A", "B"], durationMs: 1500 });
  });
  it("formats offsets and durations", () => {
    const start = Date.parse("2026-11-12T10:00:00.000Z");
    expect(offsetLabel("2026-11-12T10:00:00.000Z", start)).toBe("+0.000s");
    expect(offsetLabel("2026-11-12T10:00:01.234Z", start)).toBe("+1.234s");
    expect(offsetLabel("2026-11-12T10:02:03.000Z", start)).toBe("+2m 03s");
    expect(offsetLabel("bad", start)).toBe("");
    expect(formatMs(850)).toBe("850 ms");
    expect(formatMs(1234)).toBe("1.234 s");
  });
});

describe("lib/jaeger", () => {
  it("parses services, unique operations and traces (newest first)", () => {
    expect(parseServices(JSON.stringify({ services: ["b", "a", 1] }))).toEqual(["a", "b"]);
    expect(parseOperations(JSON.stringify({ span_names: [{ name: "x" }, { name: "x" }, { name: "a" }] })))
      .toEqual(["a", "x"]);
    const traces = parseTraces(JSON.stringify({ traces: [
      { trace_id: "1", start_time: "2026-01-01T00:00:00Z", duration_us: 5, services: ["s", "t"] },
      { trace_id: "2", start_time: "2026-01-02T00:00:00Z", has_errors: true },
      { start_time: "2026-01-03T00:00:00Z" },
    ] }));
    expect(traces.map((t) => t.traceId)).toEqual(["2", "1"]);
    expect(traces[1]?.serviceCount).toBe(2);
    expect(traces[0]?.hasErrors).toBe(true);
  });
  it("maps environments to MCP urls and trace links", () => {
    const urls = jaegerMcpUrls("");
    expect(Object.keys(urls).sort()).toEqual(["dev", "hotfix", "prod", "stage"]);
    expect(urls.prod).toBe("https://jaeger-query.tech.finru.co/api/ai/mcp/");
    expect(jaegerMcpUrls('{"dev":"http://x/mcp"}').dev).toBe("http://x/mcp");
    expect(() => jaegerMcpUrls('{"dev":"nope"}')).toThrow();
    expect(jaegerTraceUrl("stage", "abc")).toBe("https://jaeger-ui.stage-tech.finru.co/trace/abc");
    expect(jaegerTraceUrl("qa", "abc")).toBeNull();
  });
  it("formats durations", () => {
    expect(formatDuration(850)).toBe("850 µs");
    expect(formatDuration(16_459)).toBe("16.5 ms");
    expect(formatDuration(2_500_000)).toBe("2.50 s");
  });
});

describe("jaeger rpc via HTTP MCP", () => {
  it("переподключается и повторяет вызов, если сессия MCP устарела", async () => {
    const { harness, expireJaegerSession } = await setup();
    await harness.behavior.callRpc("jaegerServices", { env: "dev" });
    expireJaegerSession();
    expect(await harness.behavior.callRpc("jaegerServices", { env: "dev" })).toEqual({ services: ["Svc.A", "Svc.B"] });
  });

  it("lists services and operations", async () => {
    const { harness, jaegerCalls } = await setup();
    expect(await harness.behavior.callRpc("jaegerServices", { env: "dev" })).toEqual({ services: ["Svc.A", "Svc.B"] });
    expect(await harness.behavior.callRpc("jaegerOperations", { env: "dev", service: "Svc.A" }))
      .toEqual({ operations: ["GET /a", "GET /b"] });
    expect(jaegerCalls.find((c) => c.tool === "get_span_names")?.args.service_name).toBe("Svc.A");
  }, 30_000);

  it("searches traces with operation, lookback and errors filter", async () => {
    const { harness, jaegerCalls } = await setup();
    const out = await harness.behavior.callRpc("jaegerTraces", {
      env: "dev", service: "Svc.A", operation: "GET /a", lookback: "30m", errorsOnly: true,
    }) as { traces: Array<{ traceId: string }> };
    expect(out.traces.map((t) => t.traceId)).toEqual(["new", "old"]);
    expect(jaegerCalls.at(-1)).toEqual({ tool: "search_traces", args: {
      service_name: "Svc.A", span_name: "GET /a", start_time_min: "-30m", search_depth: 20, with_errors: true,
    } });
  }, 30_000);

  it("omits operation and errors filter when not set", async () => {
    const { harness, jaegerCalls } = await setup();
    await harness.behavior.callRpc("jaegerTraces", { env: "dev", service: "Svc.A", lookback: "5m" });
    expect(jaegerCalls.at(-1)?.args).toEqual({ service_name: "Svc.A", start_time_min: "-5m", search_depth: 20 });
  }, 30_000);

  it("rejects an environment without Jaeger", async () => {
    const { harness } = await setup();
    await expect(harness.behavior.callRpc("jaegerServices", { env: "qa" })).rejects.toThrow(/не настроен/);
  }, 30_000);

  it("rejects an unknown lookback", async () => {
    const { harness } = await setup();
    await expect(harness.behavior.callRpc("jaegerTraces", { env: "dev", service: "Svc.A", lookback: "3m" })).rejects.toThrow();
  }, 30_000);
});

describe("lib/graylog", () => {
  it("adds stage when hotfix is present and maps it to the hotfix instance", () => {
    expect(envNames(["prod", "dev", "hotfix"])).toEqual(["prod", "dev", "hotfix", "stage"]);
    expect(envNames(["prod"])).toEqual(["prod"]);
    expect(resolveTarget("stage")).toEqual({ env: "stage", instance: "hotfix", stream: "6a057e22f486dd3c859f9e0d" });
    expect(resolveTarget("qa")).toEqual({ env: "qa", instance: "qa" });
  });
  it("cleans the trace id", () => {
    expect(cleanTraceId(' "ab c\\" ')).toBe("abc");
  });
  it("parses messages and reads the service from Resources", () => {
    const r = parseSearch(JSON.stringify({ total: 3, messages: [{ id: "1", index: "i", Message: "m",
      message: JSON.stringify({ Resources: { "service.name": "S" } }) }] }));
    expect(r.total).toBe(3);
    expect(r.rows[0]?.service).toBe("S");
  });
  it("builds the agent prompt with logs and the question", () => {
    const text = buildAgentPrompt(resolveTarget("dev"), "abc", "Почему?", parseSearch(JSON.stringify({
      total: 1, messages: [{ id: "1", index: "i", LogLevel: "Error", Message: "Boom", Exception: "Ex" }] })));
    expect(text).toContain("instance dev, stream 69455d21a51a9929da7f2fb5");
    expect(text).toContain("Boom");
    expect(text).toContain("Exception: Ex");
    expect(text.endsWith("Почему?")).toBe(true);
  });
});

describe("server rpc via MCP", () => {
  it("lists environments from MCP plus stage", async () => {
    const { harness } = await setup();
    const out = await harness.behavior.callRpc("instances", null);
    expect(out).toEqual({ envs: [
      { value: "prod", label: "prod" }, { value: "dev", label: "dev" },
      { value: "hotfix", label: "hotfix" }, { value: "stage", label: "stage (hotfix)" },
    ] });
  }, 30_000);

  it("searches by TraceId in the stage stream", async () => {
    const { harness, calls, spawned } = await setup();
    const out = (await harness.behavior.callRpc("search", { env: "stage", traceId: " abc " })) as {
      total: number; rows: Array<{ service: string; message: string }> };
    expect(out.total).toBe(1);
    expect(out.rows[0]).toMatchObject({ service: "Svc.Api", message: "Boom happened" });
    const search = calls().find((c) => c.tool === "search_messages");
    expect(search?.args).toMatchObject({ instance: "hotfix", query: 'TraceId:"abc"', streams: ["6a057e22f486dd3c859f9e0d"] });
    expect(spawned).toHaveLength(0);
  }, 30_000);

  it("defaults to opencode On-Prem", async () => {
    const { harness } = await setup();
    expect(await harness.behavior.callRpc("defaults", null)).toEqual({
      execution: { providerId: "acp-opencode", model: "finbeat/qwen3.8-27b-fp8", reasoningLevel: "default" },
    });
  }, 30_000);

  it("defaults come from BB when the setting is cleared", async () => {
    const { harness } = await setup({ defaultProviderId: "" });
    expect(await harness.behavior.callRpc("defaults", null)).toEqual({
      execution: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "default" },
    });
  }, 30_000);

  it("runSearch by TraceId shows logs without creating threads and saves the session", async () => {
    const { harness, spawned } = await setup();
    const out = await harness.behavior.callRpc("runSearch", { env: "dev", traceId: "abc", prompt: "игнорируется" }) as {
      session: Record<string, unknown>; result: { total: number; rows: unknown[] };
    };
    expect(spawned).toHaveLength(0);
    expect(out.result.total).toBe(1);
    expect(out.session).toMatchObject({
      env: "dev", mode: "trace", traceId: "abc", query: 'TraceId:"abc"', rangeSeconds: 604800,
      total: 1, title: "dev: abc", threadId: null,
    });
    const list = await harness.behavior.callRpc("sessions", null) as { sessions: Array<{ id: string }> };
    expect(list.sessions.map((s) => s.id)).toEqual([out.session.id]);
  }, 30_000);

  it("runSearch by prompt lets a hidden helper agent build the query, then deletes it", async () => {
    const { harness, spawned, calls, deleted, waited } = await setup();
    const out = await harness.behavior.callRpc("runSearch", { env: "stage", prompt: "ошибки за последний час",
      execution: { providerId: "acp-opencode", model: "m", reasoningLevel: "default" } }) as {
      session: Record<string, unknown>;
    };
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ visibility: "hidden", pluginMetadata: { kind: "helper" }, providerId: "acp-opencode" });
    expect(String(spawned[0]?.prompt)).toContain("ошибки за последний час");
    expect(waited[0]).toMatchObject({ threadId: "thr_new", status: "idle" });
    expect(deleted).toEqual(["thr_new"]);
    const search = calls().find((c) => c.tool === "search_messages");
    expect(search?.args).toMatchObject({
      instance: "hotfix", query: "LogLevel:Error", range_seconds: 3600, sort: "desc", streams: ["6a057e22f486dd3c859f9e0d"],
    });
    expect(out.session).toMatchObject({
      env: "stage", mode: "prompt", traceId: null, query: "LogLevel:Error", rangeSeconds: 3600,
      title: "stage: ошибки за последний час",
    });
  }, 30_000);

  it("runSearch by prompt asks once more, then deletes the helper when the answer is still not JSON", async () => {
    const { harness, deleted, sent, setHelperOutput } = await setup();
    setHelperOutput("не знаю");
    await expect(harness.behavior.callRpc("runSearch", { env: "dev", prompt: "что-то" })).rejects.toThrow(/не вернул запрос/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: "thr_new", mode: "start" });
    expect(deleted).toEqual(["thr_new"]);
    expect((await harness.behavior.callRpc("sessions", null) as { sessions: unknown[] }).sessions).toEqual([]);
  }, 30_000);

  it("runSearch rejects when neither TraceId nor prompt is given", async () => {
    const { harness, spawned } = await setup();
    await expect(harness.behavior.callRpc("runSearch", { env: "dev", traceId: " ", prompt: "" })).rejects.toThrow();
    expect(spawned).toHaveLength(0);
  }, 30_000);

  it("session reloads logs; askAgent starts a hidden thread with logs once; archive removes it", async () => {
    const { harness, spawned, archived } = await setup();
    const { session } = await harness.behavior.callRpc("runSearch", { env: "dev", traceId: "abc" }) as { session: { id: string } };
    const reopened = await harness.behavior.callRpc("session", { id: session.id }) as { result: { total: number } };
    expect(reopened.result.total).toBe(1);

    const asked = await harness.behavior.callRpc("askAgent", { id: session.id, question: "Почему упало?" });
    expect(asked).toEqual({ threadId: "thr_new" });
    expect(spawned[0]).toMatchObject({
      projectId: "proj_personal", visibility: "hidden", pluginMetadata: { kind: "session", sessionId: session.id },
    });
    expect(String(spawned[0]?.prompt)).toContain("Boom happened");
    expect(String(spawned[0]?.prompt).endsWith("Почему упало?")).toBe(true);
    expect(await harness.behavior.callRpc("askAgent", { id: session.id, question: "ещё" })).toEqual({ threadId: "thr_new" });
    expect(spawned).toHaveLength(1);
    const list = await harness.behavior.callRpc("sessions", null) as { sessions: Array<{ threadId: string | null }> };
    expect(list.sessions[0]?.threadId).toBe("thr_new");

    expect(await harness.behavior.callRpc("archiveSession", { id: session.id })).toEqual({ ok: true });
    expect(archived).toEqual(["thr_new"]);
    expect((await harness.behavior.callRpc("sessions", null) as { sessions: unknown[] }).sessions).toEqual([]);
    await expect(harness.behavior.callRpc("session", { id: session.id })).rejects.toThrow(/не найдена/);
  }, 30_000);

  it("askAgent with an empty question uses the default task", async () => {
    const { harness, spawned } = await setup();
    const { session } = await harness.behavior.callRpc("runSearch", { env: "dev", traceId: "abc" }) as { session: { id: string } };
    await harness.behavior.callRpc("askAgent", { id: session.id });
    expect(String(spawned[0]?.prompt).endsWith(DEFAULT_QUESTION)).toBe(true);
  }, 30_000);
});
