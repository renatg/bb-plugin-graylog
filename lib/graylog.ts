// Чистая логика плагина: окружения, разбор ответа Graylog, промт для агента.
import { z } from "zod";

/** Логические окружения → инстанс и стрим Graylog (см. skill graylog). */
export const ENVS: Record<string, { instance: string; stream: string; label: string }> = {
  dev: { instance: "dev", stream: "69455d21a51a9929da7f2fb5", label: "dev" },
  prod: { instance: "prod", stream: "6a429bb251e5285a60737acb", label: "prod" },
  hotfix: { instance: "hotfix", stream: "6a7589adf486dd3c85d5d6db", label: "hotfix" },
  stage: { instance: "hotfix", stream: "6a057e22f486dd3c859f9e0d", label: "stage (hotfix)" },
};

export type Target = { env: string; instance: string; stream?: string };

export function resolveTarget(env: string): Target {
  const known = ENVS[env];
  return known
    ? { env, instance: known.instance, stream: known.stream }
    : { env, instance: env };
}

/** Инстансы MCP в их порядке + stage, если есть hotfix. */
export function envNames(instances: string[]): string[] {
  const names = [...instances];
  if (names.includes("hotfix") && !names.includes("stage")) names.push("stage");
  return names;
}

export function cleanTraceId(raw: string): string {
  return raw.replace(/["'\s\\]/g, "");
}

/** HTTP-сведения сообщения: из атрибутов логгеров запросов и HTTP-клиентов. */
export const httpInfoSchema = z.object({
  /** request — входящий/исходящий запрос, response — ответ, other — прочее HTTP. */
  kind: z.enum(["request", "response", "other"]),
  method: z.string(),
  path: z.string(),
  status: z.string(),
  elapsedMs: z.number().nullable(),
});
export type HttpInfo = z.infer<typeof httpInfoSchema>;

export const logRowSchema = z.object({
  id: z.string(),
  index: z.string(),
  time: z.string(),
  level: z.string(),
  service: z.string(),
  /** Сообщение с подставленными значениями атрибутов. */
  message: z.string(),
  /** Исходный шаблон сообщения (`Message`), например «Body: {Body}». */
  template: z.string().default(""),
  exception: z.string(),
  category: z.string().default(""),
  spanId: z.string().default(""),
  eventId: z.string().default(""),
  /** Атрибуты сообщения (поля `Attributes_*`), кроме тела. */
  attributes: z.record(z.string(), z.string()).default({}),
  /** Тело запроса или ответа, если оно залогировано. */
  body: z.string().default(""),
  http: httpInfoSchema.nullable().default(null),
});
export type LogRow = z.infer<typeof logRowSchema>;

export const searchResultSchema = z.object({
  total: z.number(),
  rows: z.array(logRowSchema),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Исходный OTel-JSON из поля `message` (может быть обрезан — тогда `{}`). */
function original(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.message !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw.message);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const ATTRIBUTE_PREFIX = "Attributes_";
/** Атрибуты, в которых логгеры кладут тело запроса или ответа. */
const BODY_KEYS = ["Body", "RequestBody", "ResponseBody", "Content", "Payload"];

/** Атрибуты сообщения: поля Attributes_* Graylog, иначе Attributes из исходного JSON. */
function attributesOf(raw: Record<string, unknown>, orig: Record<string, unknown>): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith(ATTRIBUTE_PREFIX)) attrs[key.slice(ATTRIBUTE_PREFIX.length)] = str(value);
  }
  const fromJson = orig.Attributes;
  if (fromJson && typeof fromJson === "object") {
    for (const [key, value] of Object.entries(fromJson as Record<string, unknown>)) {
      if (!(key in attrs)) attrs[key] = str(value);
    }
  }
  return attrs;
}

/** Подставить значения атрибутов в шаблон: «{StatusCode}» → «200». */
export function renderTemplate(template: string, attrs: Record<string, string>): string {
  return template.replace(/\{([A-Za-z_][\w.]*)(?:[:,][^}]*)?\}/g, (whole, name: string) =>
    name in attrs ? (attrs[name] ?? "") : whole,
  );
}

function pick(attrs: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = attrs[key];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

/** HTTP-сведения по атрибутам и шаблону; null — сообщение не про HTTP. */
export function httpInfo(template: string, attrs: Record<string, string>): HttpInfo | null {
  const method = pick(attrs, "Method", "HttpMethod", "RequestMethod");
  const uri = pick(attrs, "Uri", "RequestUri", "Url");
  const path = pick(attrs, "Path", "RequestPath") + pick(attrs, "QueryString") || uri;
  const status = pick(attrs, "StatusCode", "ResponseStatusCode", "Status");
  const elapsedRaw = pick(attrs, "ElapsedMilliseconds", "Elapsed", "ElapsedMs", "Duration");
  if (method === "" && path === "" && status === "") return null;
  const elapsed = Number.parseFloat(elapsedRaw);
  const t = template.toLowerCase();
  // Статус без метода — итог запроса (например «End processing HTTP request … - 200»).
  const kind =
    /response|ответ/.test(t) || (status !== "" && method === "")
      ? "response"
      : /request|запрос/.test(t)
        ? "request"
        : "other";
  return { kind, method, path, status, elapsedMs: Number.isFinite(elapsed) ? elapsed : null };
}

function toRow(raw: Record<string, unknown>): LogRow {
  const orig = original(raw);
  const resources = (orig.Resources ?? {}) as Record<string, unknown>;
  const attrs = attributesOf(raw, orig);
  const template = str(raw.Message ?? orig.Message ?? raw.message);
  const formatted = str(orig.FormattedMessage);
  const bodyKey = BODY_KEYS.find((key) => (attrs[key] ?? "") !== "");
  const body = bodyKey ? (attrs[bodyKey] ?? "") : "";
  const rest = { ...attrs };
  if (bodyKey) delete rest[bodyKey];
  return {
    id: str(raw.id),
    index: str(raw.index),
    time: str(raw.Timestamp ?? orig.Timestamp ?? raw.timestamp),
    level: str(raw.LogLevel ?? orig.LogLevel),
    service: str(
      raw.Resources_service_name ?? raw.service_name ?? resources["service.name"] ?? raw.source,
    ),
    message: formatted || renderTemplate(template, attrs),
    template,
    exception: str(raw.Exception ?? orig.Exception),
    category: str(raw.CategoryName ?? orig.CategoryName),
    spanId: str(raw.SpanId ?? orig.SpanId).replace(/^0+$/, ""),
    eventId: str(raw.EventId ?? orig.EventId).replace(/^0$/, ""),
    attributes: rest,
    body,
    http: httpInfo(template, attrs),
  };
}

export function parseSearch(text: string): SearchResult {
  const parsed = JSON.parse(text) as { total?: unknown; messages?: unknown };
  const list = Array.isArray(parsed.messages) ? parsed.messages : [];
  const rows = list
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map(toRow);
  const total = Number(parsed.total ?? rows.length);
  return { total: Number.isFinite(total) ? total : rows.length, rows };
}

/** Задание агенту, когда пользователь не написал свой вопрос. */
export const DEFAULT_QUESTION =
  "Кратко разбери этот трейс: какие сервисы участвовали, что происходило по шагам, были ли ошибки или предупреждения и в чём их вероятная причина.";

/** Предел размера логов, вставляемых в промт. */
export const PROMPT_LOG_BUDGET = 60_000;
/** Предел одного сообщения в промте (тела запросов бывают большими). */
export const PROMPT_LINE_LIMIT = 4_000;

function clip(text: string): string {
  return text.length > PROMPT_LINE_LIMIT
    ? `${text.slice(0, PROMPT_LINE_LIMIT)}… (обрезано, полностью — get_message)`
    : text;
}

/** Как были найдены логи: по TraceId или по запросу Graylog за интервал. */
export type LogSource =
  | { kind: "trace"; traceId: string }
  | { kind: "query"; query: string; rangeSeconds: number; prompt: string };

export function buildAgentPrompt(
  target: Target,
  traceId: string,
  prompt: string,
  result: SearchResult,
): string {
  return buildLogsPrompt(target, { kind: "trace", traceId }, prompt, result);
}

/** Промт агенту: найденные логи + вопрос пользователя. */
export function buildLogsPrompt(
  target: Target,
  source: LogSource,
  prompt: string,
  result: SearchResult,
): string {
  const stream = target.stream ? `, stream ${target.stream}` : "";
  const header =
    source.kind === "trace"
      ? `TraceId: ${source.traceId}. Запрос: TraceId:"${source.traceId}". Найдено: ${result.total}.`
      : `Поиск: «${source.prompt}». Запрос: ${source.query}. Интервал: последние ${formatRange(source.rangeSeconds)}. Найдено: ${result.total}.`;
  const fallback = source.kind === "trace" ? DEFAULT_QUESTION : DEFAULT_LOGS_QUESTION;
  const lines: string[] = [];
  let used = 0;
  for (const row of result.rows) {
    const exception = row.exception ? `\n    Exception: ${clip(row.exception)}` : "";
    const span = row.spanId ? `, span ${row.spanId}` : "";
    const line = `- ${row.time} ${row.level} ${row.service} [index ${row.index}, id ${row.id}${span}]: ${clip(row.message)}${exception}`;
    if (used + line.length > PROMPT_LOG_BUDGET) break;
    lines.push(line);
    used += line.length;
  }
  const cut =
    lines.length < result.total
      ? `(показано ${lines.length} из ${result.total}; остальное ищи сам через MCP graylog)`
      : "";
  return [
    `Логи Graylog. Окружение: ${target.env} (instance ${target.instance}${stream}).`,
    header,
    "",
    "Найденные сообщения (по времени):",
    lines.length > 0 ? lines.join("\n") : "(ничего не найдено)",
    cut,
    "",
    "Полные тексты сообщений — через MCP graylog: get_message с тем же instance, index и id.",
    "",
    "Вопрос:",
    prompt.trim() || fallback,
  ].join("\n");
}

export const DEFAULT_LOGS_QUESTION =
  "Кратко разбери найденные логи: какие сервисы, какие ошибки и предупреждения и в чём их вероятная причина.";

/** Интервал в секундах → «час», «15 минут», «2 дня». */
export function formatRange(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "сутки" : `${days} дн.`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "час" : `${hours} ч`;
  }
  if (seconds % 60 === 0) return `${seconds / 60} мин`;
  return `${seconds} с`;
}

/** Предел интервала поиска по промту — 30 дней. */
export const MAX_RANGE_SECONDS = 30 * 86_400;

/** Задание служебному агенту: перевести фразу в запрос Graylog, ничего не анализируя. */
export function buildQueryTranslationPrompt(target: Target, prompt: string): string {
  return [
    "Переведи просьбу пользователя в запрос поиска Graylog. Ничего не ищи, инструменты не вызывай, логи не анализируй.",
    `Окружение: ${target.env}. Стрим окружения плагин подставит сам — в запрос его не включай.`,
    "",
    "Поля сообщений: LogLevel (Information, Warning, Error, Critical, Debug), service_name (например LMS.Platform.Services.Clients.RestApi), Message, Exception, TraceId.",
    "Синтаксис — Lucene, как в Graylog: LogLevel:Error, service_name:*Clients*, Message:\"timeout\", AND / OR / NOT, скобки. Все сообщения — *.",
    "range_seconds — интервал от текущего момента в секундах (час — 3600, сутки — 86400). Если интервал не указан, бери 3600. Не больше 2592000.",
    "",
    'Ответь ровно одной строкой JSON без пояснений: {"query": "...", "range_seconds": N}',
    "",
    "Просьба пользователя:",
    prompt.trim(),
  ].join("\n");
}

/** Ответ служебного агента → запрос и интервал. JSON может быть в ``` или с текстом вокруг. */
export function parseQueryJson(text: string): { query: string; rangeSeconds: number } {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error(`Агент не вернул запрос Graylog: ${text.slice(0, 200)}`);
  const parsed = z
    .object({ query: z.string().trim().min(1), range_seconds: z.coerce.number().int().positive() })
    .parse(JSON.parse(match[0]));
  return {
    query: parsed.query,
    rangeSeconds: Math.min(parsed.range_seconds, MAX_RANGE_SECONDS),
  };
}

/** Короткий заголовок треда из промта. */
export function titleFromPrompt(prompt: string, max = 60): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
