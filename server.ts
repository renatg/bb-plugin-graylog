// bb-plugin-graylog — серверная часть.
//
// Поднимает MCP-сервер graylog (тот же, что настроен у Claude Code в
// ~/.claude.json → mcpServers.graylog) как stdio-клиент и отдаёт UI RPC:
//   instances — окружения (инстансы MCP + stage),
//   search    — логи по TraceId,
//   runSearch — поиск логов по TraceId или по промту (промт переводит в запрос
//               Graylog короткий служебный тред агента), без анализа;
//   sessions / session / archiveSession — история поисков (bb.storage.kv);
//   askAgent  — первый вопрос агенту о найденных логах → скрытый тред сессии.
// И HTTP MCP Jaeger выбранного окружения (адреса — lib/jaeger.ts) для поиска трейсов:
//   jaegerServices / jaegerOperations / jaegerTraces.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildLogsPrompt,
  buildQueryTranslationPrompt,
  type LogSource,
  parseQueryJson,
  cleanTraceId,
  ENVS,
  envNames,
  parseSearch,
  resolveTarget,
  searchResultSchema,
  type SearchResult,
  titleFromPrompt,
  type Target,
} from "./lib/graylog";
import {
  jaegerMcpUrls,
  lookbackSchema,
  parseOperations,
  parseServices,
  parseTraces,
  traceSummarySchema,
} from "./lib/jaeger";

export type { TraceSummary } from "./lib/jaeger";
export type { LogRow, SearchResult } from "./lib/graylog";

/** Выбор из experimental_ProviderModelPicker. */
const executionSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: z.string().min(1),
  serviceTier: z.string().min(1).optional(),
});
export type Execution = z.infer<typeof executionSchema>;

/** Метка сессий плагина в pluginMetadata треда. */
const SESSION_KIND = "session";
const HELPER_KIND = "helper";

/** Сессия поиска в истории плагина (хранится в bb.storage.kv). */
const sessionSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  env: z.string(),
  mode: z.enum(["trace", "prompt"]),
  traceId: z.string().nullable(),
  prompt: z.string(),
  query: z.string(),
  rangeSeconds: z.number(),
  total: z.number(),
  title: z.string(),
  threadId: z.string().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

const sessionWithLogs = z.object({ session: sessionSchema, result: searchResultSchema });

/** Сколько трейсов Jaeger показывать по умолчанию. */
const JAEGER_LIMIT = 20;
/** Предел списков сервисов и операций Jaeger. */
const JAEGER_LIST_LIMIT = 1000;

export const rpcContract = defineRpcContract({
  instances: {
    input: z.null(),
    output: z.object({
      envs: z.array(z.object({ value: z.string(), label: z.string() })),
    }),
  },
  search: {
    input: z.object({ env: z.string().min(1), traceId: z.string().min(1).max(200) }),
    output: searchResultSchema,
  },
  /** Провайдер и модель по умолчанию: из настроек или для тредов без проекта. */
  defaults: {
    input: z.null(),
    output: z.object({ execution: executionSchema.nullable() }),
  },
  jaegerServices: {
    input: z.object({ env: z.string().min(1) }),
    output: z.object({ services: z.array(z.string()) }),
  },
  jaegerOperations: {
    input: z.object({ env: z.string().min(1), service: z.string().min(1) }),
    output: z.object({ operations: z.array(z.string()) }),
  },
  jaegerTraces: {
    input: z.object({
      env: z.string().min(1),
      service: z.string().min(1),
      operation: z.string().default(""),
      lookback: lookbackSchema,
      errorsOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(JAEGER_LIMIT),
    }),
    output: z.object({ traces: z.array(traceSummarySchema) }),
  },
  runSearch: {
    input: z
      .object({
        env: z.string().min(1),
        traceId: z.string().trim().max(200).default(""),
        prompt: z.string().trim().max(5_000).default(""),
        execution: executionSchema.optional(),
      })
      .refine((v) => v.traceId !== "" || v.prompt !== "", {
        message: "Заполните TraceId или промт",
      }),
    output: sessionWithLogs,
  },
  sessions: {
    input: z.null(),
    output: z.object({ sessions: z.array(sessionSchema) }),
  },
  session: {
    input: z.object({ id: z.string().min(1) }),
    output: sessionWithLogs,
  },
  archiveSession: {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
  askAgent: {
    input: z.object({
      id: z.string().min(1),
      question: z.string().trim().max(20_000).default(""),
      execution: executionSchema.optional(),
    }),
    output: z.object({ threadId: z.string() }),
  },
});

// ---------- MCP-клиент ----------

const stdioConfigSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
const httpConfigSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});
const mcpServerConfigSchema = z.union([httpConfigSchema, stdioConfigSchema]);
type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

async function readMcpConfig(path: string, name: string): Promise<McpServerConfig> {
  const json = JSON.parse(await readFile(path, "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  const server = json.mcpServers?.[name];
  if (!server) throw new Error(`В ${path} нет mcpServers.${name}`);
  return mcpServerConfigSchema.parse(server);
}

type McpResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

function textOf(result: McpResult): string {
  return (result.content ?? [])
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

function transportFor(config: McpServerConfig): Transport {
  if ("url" in config) {
    const url = new URL(config.url);
    const requestInit = { headers: config.headers };
    return config.type === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  Object.assign(env, config.env);
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    stderr: "ignore",
  });
}

/** Ленивое переподключаемое соединение с MCP-сервером. */
function mcpConnection(
  serverName: string,
  loadConfig: () => Promise<McpServerConfig>,
  log: (msg: string) => void,
) {
  let client: Promise<Client> | null = null;

  async function connect(): Promise<Client> {
    const transport = transportFor(await loadConfig());
    const next = new Client({ name: "bb-plugin-graylog", version: "0.1.0" });
    transport.onclose = () => {
      client = null;
    };
    await next.connect(transport);
    log(`mcp ${serverName} connected`);
    return next;
  }

  function getClient(): Promise<Client> {
    if (!client) {
      client = connect().catch((err: unknown) => {
        client = null;
        throw err;
      });
    }
    return client;
  }

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const mcp = await getClient();
      const result = (await mcp.callTool({ name, arguments: args })) as McpResult;
      const text = textOf(result);
      if (result.isError) throw new Error(text || `MCP ${serverName}: ошибка ${name}`);
      return text;
    },
    async close(): Promise<void> {
      const current = client;
      client = null;
      if (!current) return;
      try {
        await (await current).close();
      } catch {
        // уже закрыт или не подключился
      }
    },
  };
}

const SEARCH_RANGE_SECONDS = 7 * 24 * 3600;
const SEARCH_LIMIT = 200;
/** Сколько ждать служебного агента, переводящего промт в запрос. */
const TRANSLATE_TIMEOUT_MS = 180_000;
/** Повторная просьба, если служебный агент ответил не JSON. */
const QUERY_RETRY_TEXT =
  'Ответь только одной строкой JSON вида {"query": "...", "range_seconds": N} — без пояснений.';
const SESSION_KEY_PREFIX = "session:";
/** Проект BB для тредов без проекта. */
const PERSONAL_PROJECT_ID = "proj_personal";
/** Модель нового треда по умолчанию: opencode — On-Prem (private). */
export const DEFAULT_EXECUTION = {
  providerId: "acp-opencode",
  model: "finbeat/qwen3.8-27b-fp8",
  reasoningLevel: "default",
} as const;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    claudeConfigPath: {
      type: "string",
      label: "Путь к конфигу Claude Code",
      description: "Файл, где описан MCP-сервер graylog (mcpServers). Пусто — ~/.claude.json.",
      default: "",
    },
    mcpServerName: {
      type: "string",
      label: "Имя MCP-сервера Graylog",
      default: "graylog",
    },
    jaegerMcpUrls: {
      type: "string",
      label: "MCP-адреса Jaeger",
      description:
        'Переопределение адресов по окружениям, JSON: {"dev": "https://…/api/ai/mcp/"}. Пусто — встроенные.',
      default: "",
    },
    defaultProviderId: {
      type: "string",
      label: "Провайдер нового треда",
      description: "Выбирается по умолчанию. Пусто — провайдер и модель текущего треда.",
      default: DEFAULT_EXECUTION.providerId,
    },
    defaultModel: {
      type: "string",
      label: "Модель нового треда",
      default: DEFAULT_EXECUTION.model,
    },
    defaultReasoningLevel: {
      type: "string",
      label: "Уровень рассуждений нового треда",
      default: DEFAULT_EXECUTION.reasoningLevel,
    },
  });
  const {
    claudeConfigPath,
    mcpServerName,
    jaegerMcpUrls: jaegerOverrides,
    defaultProviderId,
    defaultModel,
    defaultReasoningLevel,
  } = await settings.get();
  /** Модель по умолчанию из настроек; null — брать из треда, как BB. */
  const configuredExecution: Execution | null =
    defaultProviderId.trim() !== "" && defaultModel.trim() !== ""
      ? {
          providerId: defaultProviderId.trim(),
          model: defaultModel.trim(),
          reasoningLevel: defaultReasoningLevel.trim() || "default",
        }
      : null;
  const configPath = claudeConfigPath.trim() || join(homedir(), ".claude.json");
  const serverName = mcpServerName.trim() || "graylog";
  const jaegerUrls = jaegerMcpUrls(jaegerOverrides);

  const log = (msg: string) => bb.log.info(msg);
  const graylog = mcpConnection(serverName, () => readMcpConfig(configPath, serverName), log);

  /** Соединения с Jaeger по окружениям, создаются при первом обращении. */
  const jaegers = new Map<string, ReturnType<typeof mcpConnection>>();
  function jaeger(env: string) {
    const url = jaegerUrls[env];
    if (!url) throw new Error(`Jaeger для окружения «${env}» не настроен`);
    let connection = jaegers.get(env);
    if (!connection) {
      connection = mcpConnection(`jaeger ${env}`, async () => ({ type: "http", url, headers: {} }), log);
      jaegers.set(env, connection);
    }
    return connection;
  }
  const callTool = graylog.callTool;

  async function listEnvs(): Promise<string[]> {
    const parsed: unknown = JSON.parse(await callTool("list_instances", {}));
    if (!Array.isArray(parsed)) throw new Error("list_instances вернул не массив");
    const names = parsed
      .map((item) => (item as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");
    return envNames(names);
  }

  /** Логи окружения по запросу Graylog за интервал; строки по времени. */
  async function searchQuery(
    target: Target,
    query: string,
    rangeSeconds: number,
    newestFirst = false,
  ): Promise<SearchResult> {
    const args: Record<string, unknown> = {
      instance: target.instance,
      query,
      range_seconds: rangeSeconds,
      limit: SEARCH_LIMIT,
      sort: newestFirst ? "desc" : "asc",
    };
    if (target.stream) args.streams = [target.stream];
    const result = parseSearch(await callTool("search_messages", args));
    // По промту берём самые свежие сообщения, но показываем их по времени.
    return newestFirst ? { ...result, rows: [...result.rows].reverse() } : result;
  }

  async function search(
    env: string,
    rawTraceId: string,
  ): Promise<{ target: Target; traceId: string; result: SearchResult }> {
    const traceId = cleanTraceId(rawTraceId);
    if (!traceId) throw new Error("Пустой TraceId");
    const target = resolveTarget(env);
    const result = await searchQuery(target, `TraceId:"${traceId}"`, SEARCH_RANGE_SECONDS);
    return { target, traceId, result };
  }

  /** Логи сессии по её сохранённому запросу. */
  function sessionLogs(session: Session): Promise<SearchResult> {
    return searchQuery(
      resolveTarget(session.env),
      session.query,
      session.rangeSeconds,
      session.mode === "prompt",
    );
  }

  /**
   * Перевод фразы в запрос Graylog коротким служебным скрытым тредом агента:
   * ждём ответа, читаем JSON и удаляем тред.
   */
  async function translatePrompt(target: Target, prompt: string, execution: Execution | undefined) {
    const helper = await bb.sdk.threads.spawn({
      ...personalThread(),
      ...(execution ?? {}),
      title: `Graylog: запрос для «${titleFromPrompt(prompt, 40)}»`,
      prompt: buildQueryTranslationPrompt(target, prompt),
      visibility: "hidden",
      pluginMetadata: { kind: HELPER_KIND },
    });
    const answer = async () => {
      await bb.sdk.threads.wait({ threadId: helper.id, status: "idle", timeoutMs: TRANSLATE_TIMEOUT_MS });
      return (await bb.sdk.threads.output({ threadId: helper.id })).output ?? "";
    };
    try {
      const first = await answer();
      try {
        return parseQueryJson(first);
      } catch {
        // Модель ответила не по формату — одна повторная просьба.
        await bb.sdk.threads.send({
          threadId: helper.id,
          mode: "start",
          input: [{ type: "text", text: QUERY_RETRY_TEXT, mentions: [] }],
        });
        return parseQueryJson(await answer());
      }
    } finally {
      try {
        await bb.sdk.threads.delete({ threadId: helper.id, childThreadsConfirmed: true });
      } catch (err) {
        bb.log.warn(`не удалось удалить служебный тред ${helper.id}: ${String(err)}`);
      }
    }
  }

  const kv = bb.storage.kv;
  const sessionKey = (id: string) => `${SESSION_KEY_PREFIX}${id}`;

  async function loadSession(id: string): Promise<Session> {
    const parsed = sessionSchema.safeParse(await kv.get(sessionKey(id)));
    if (!parsed.success) throw new Error("Сессия не найдена");
    return parsed.data;
  }

  async function listSessions(): Promise<Session[]> {
    const keys = await kv.list(SESSION_KEY_PREFIX);
    const sessions: Session[] = [];
    for (const key of keys) {
      const parsed = sessionSchema.safeParse(await kv.get(key));
      if (parsed.success) sessions.push(parsed.data);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Тред без проекта — как New thread с «No project». */
  function personalThread() {
    return {
      projectId: PERSONAL_PROJECT_ID,
      environment: { type: "host" as const, workspace: { type: "personal" as const } },
    };
  }

  bb.rpc.register(rpcContract, {
    instances: async () => {
      const names = await listEnvs();
      return {
        envs: names.map((value) => ({ value, label: ENVS[value]?.label ?? value })),
      };
    },
    search: async ({ env, traceId }) => (await search(env, traceId)).result,
    defaults: async () => {
      if (configuredExecution) return { execution: configuredExecution };
      const resolved = await bb.sdk.projects.defaultExecutionOptions({
        projectId: PERSONAL_PROJECT_ID,
      });
      if (!resolved) return { execution: null };
      return {
        execution: {
          providerId: resolved.providerId,
          model: resolved.model,
          reasoningLevel: resolved.reasoningLevel,
          serviceTier: resolved.serviceTier,
        },
      };
    },
    jaegerServices: async ({ env }) => ({
      services: parseServices(await jaeger(env).callTool("get_services", { limit: JAEGER_LIST_LIMIT })),
    }),
    jaegerOperations: async ({ env, service }) => ({
      operations: parseOperations(
        await jaeger(env).callTool("get_span_names", {
          service_name: service,
          limit: JAEGER_LIST_LIMIT,
        }),
      ),
    }),
    jaegerTraces: async ({ env, service, operation, lookback, errorsOnly, limit }) => {
      const args: Record<string, unknown> = {
        service_name: service,
        start_time_min: `-${lookback}`,
        search_depth: limit,
      };
      if (operation.trim() !== "") args.span_name = operation;
      if (errorsOnly) args.with_errors = true;
      return { traces: parseTraces(await jaeger(env).callTool("search_traces", args)) };
    },
    runSearch: async ({ env, traceId, prompt, execution }) => {
      const now = Date.now();
      const base = { id: randomUUID(), createdAt: now, updatedAt: now, threadId: null, prompt };
      let session: Session;
      let result: SearchResult;
      if (cleanTraceId(traceId) !== "") {
        const found = await search(env, traceId);
        result = found.result;
        session = {
          ...base,
          env: found.target.env,
          mode: "trace",
          traceId: found.traceId,
          query: `TraceId:"${found.traceId}"`,
          rangeSeconds: SEARCH_RANGE_SECONDS,
          total: result.total,
          title: `${found.target.env}: ${found.traceId}`,
        };
      } else {
        const target = resolveTarget(env);
        const { query, rangeSeconds } = await translatePrompt(target, prompt, execution);
        result = await searchQuery(target, query, rangeSeconds, true);
        session = {
          ...base,
          env: target.env,
          mode: "prompt",
          traceId: null,
          query,
          rangeSeconds,
          total: result.total,
          title: `${target.env}: ${titleFromPrompt(prompt)}`,
        };
      }
      await kv.set(sessionKey(session.id), session);
      return { session, result };
    },
    sessions: async () => ({ sessions: await listSessions() }),
    session: async ({ id }) => {
      const session = await loadSession(id);
      return { session, result: await sessionLogs(session) };
    },
    archiveSession: async ({ id }) => {
      const session = await loadSession(id);
      await kv.delete(sessionKey(id));
      if (session.threadId) {
        try {
          await bb.sdk.threads.archive({ threadId: session.threadId });
        } catch (err) {
          bb.log.warn(`не удалось архивировать тред ${session.threadId}: ${String(err)}`);
        }
      }
      return { ok: true };
    },
    askAgent: async ({ id, question, execution }) => {
      const session = await loadSession(id);
      if (session.threadId) return { threadId: session.threadId };
      const target = resolveTarget(session.env);
      const result = await sessionLogs(session);
      const source: LogSource =
        session.mode === "trace" && session.traceId
          ? { kind: "trace", traceId: session.traceId }
          : { kind: "query", query: session.query, rangeSeconds: session.rangeSeconds, prompt: session.prompt };
      const spawned = await bb.sdk.threads.spawn({
        ...personalThread(),
        ...(execution ?? {}),
        title: `Graylog ${session.title}`,
        prompt: buildLogsPrompt(target, source, question, result),
        visibility: "hidden",
        pluginMetadata: { kind: SESSION_KIND, sessionId: session.id },
      });
      await kv.set(sessionKey(id), { ...session, threadId: spawned.id, updatedAt: Date.now() });
      return { threadId: spawned.id };
    },
  });

  bb.onDispose(async () => {
    await Promise.all([graylog.close(), ...[...jaegers.values()].map((c) => c.close())]);
  });
}
