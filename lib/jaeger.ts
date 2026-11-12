// Чистая логика Jaeger: окружения, интервалы поиска и разбор ответов MCP jaeger.
import { z } from "zod";

/**
 * Jaeger по окружениям: mcp — MCP-эндпоинт jaeger-query (без авторизации),
 * ui — веб-интерфейс для ссылок на трейс.
 */
export const JAEGER_ENVS: Record<string, { mcp: string; ui: string }> = {
  dev: {
    mcp: "https://jaeger-query-india-2-dev.htz-k8s.2pp.dev/api/ai/mcp/",
    ui: "https://jaeger-ui-india-2-dev.htz-k8s.2pp.dev/",
  },
  hotfix: {
    mcp: "https://jaeger-query.hotfix-tech.finru.co/api/ai/mcp/",
    ui: "https://jaeger-ui.hotfix-tech.finru.co/",
  },
  stage: {
    mcp: "https://jaeger-query.stage-tech.finru.co/api/ai/mcp/",
    ui: "https://jaeger-ui.stage-tech.finru.co/",
  },
  prod: {
    mcp: "https://jaeger-query.tech.finru.co/api/ai/mcp/",
    ui: "https://jaeger-ui.tech.finru.co/",
  },
};

/**
 * MCP-адреса Jaeger: встроенные + переопределения из настройки
 * (JSON-объект {"env": "url"}; пусто — без переопределений).
 */
export function jaegerMcpUrls(overrides: string): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const [env, item] of Object.entries(JAEGER_ENVS)) urls[env] = item.mcp;
  if (overrides.trim() === "") return urls;
  const parsed = z.record(z.string(), z.string().url()).parse(JSON.parse(overrides));
  return { ...urls, ...parsed };
}

/** Ссылка на трейс в веб-интерфейсе Jaeger; null — окружение без Jaeger. */
export function jaegerTraceUrl(env: string, traceId: string): string | null {
  const ui = JAEGER_ENVS[env]?.ui;
  return ui ? `${ui}trace/${encodeURIComponent(traceId)}` : null;
}

/** Интервалы «последние N» → start_time_min для search_traces. */
export const LOOKBACKS = [
  { value: "5m", label: "Последние 5 минут" },
  { value: "15m", label: "Последние 15 минут" },
  { value: "30m", label: "Последние 30 минут" },
  { value: "1h", label: "Последний час" },
  { value: "2h", label: "Последние 2 часа" },
  { value: "6h", label: "Последние 6 часов" },
  { value: "12h", label: "Последние 12 часов" },
  { value: "24h", label: "Последние 24 часа" },
  { value: "48h", label: "Последние 2 дня" },
  { value: "168h", label: "Последние 7 дней" },
] as const;

export type Lookback = (typeof LOOKBACKS)[number]["value"];
export const lookbackSchema = z.enum(
  LOOKBACKS.map((item) => item.value) as [Lookback, ...Lookback[]],
);
export const DEFAULT_LOOKBACK: Lookback = "15m";

export const traceSummarySchema = z.object({
  traceId: z.string(),
  startTime: z.string(),
  durationUs: z.number(),
  hasErrors: z.boolean(),
  rootService: z.string(),
  rootSpanName: z.string(),
  spanCount: z.number(),
  serviceCount: z.number(),
});
export type TraceSummary = z.infer<typeof traceSummarySchema>;

function obj(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** get_services → отсортированные имена сервисов. */
export function parseServices(text: string): string[] {
  return list(obj(text).services)
    .filter((name): name is string => typeof name === "string")
    .sort((a, b) => a.localeCompare(b));
}

/** get_span_names → уникальные отсортированные имена операций. */
export function parseOperations(text: string): string[] {
  const names = list(obj(text).span_names)
    .map((item) => (item && typeof item === "object" ? (item as { name?: unknown }).name : item))
    .filter((name): name is string => typeof name === "string" && name !== "");
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** search_traces → трейсы, новые сверху. */
export function parseTraces(text: string): TraceSummary[] {
  return list(obj(text).traces)
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => {
      const services = list(t.services);
      return {
        traceId: str(t.trace_id),
        startTime: str(t.start_time),
        durationUs: num(t.duration_us),
        hasErrors: t.has_errors === true,
        rootService: str(t.root_service),
        rootSpanName: str(t.root_span_name),
        spanCount: num(t.span_count),
        serviceCount: num(t.service_count ?? services.length),
      };
    })
    .filter((t) => t.traceId !== "")
    .sort((a, b) => b.startTime.localeCompare(a.startTime));
}

export function formatDuration(us: number): string {
  if (us < 1000) return `${Math.round(us)} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}
