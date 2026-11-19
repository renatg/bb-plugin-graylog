// Чистая логика превью логов: уровни, короткие имена сервисов, сводка, смещения,
// HTTP-сведения и тела запросов.
import { type LogRow, renderTemplate } from "./graylog";

/** Краткая строка сообщения: шаблон с атрибутами, тело заменено на «…». */
export function summaryLine(row: LogRow): string {
  const text = row.template
    ? renderTemplate(row.template, row.attributes).replace(/\{(Body|RequestBody|ResponseBody|Content|Payload)\}/g, "…")
    : row.message;
  return (text.split(/\r?\n/, 1)[0] ?? "").trim();
}

/** Тело: JSON красиво с отступами, остальное как есть. */
export function prettyBody(body: string): { text: string; json: boolean } {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true };
    } catch {
      // не JSON — показываем как есть
    }
  }
  return { text: body, json: false };
}

/** Порядок окружений в истории: от боевого к разработке, прочие — по алфавиту. */
export const ENV_ORDER = ["prod", "stage", "hotfix", "dev"];

/**
 * Сгруппировать элементы по окружению; порядок внутри группы сохраняется.
 * Группы идут по свежести: сверху окружение с самым недавним поиском,
 * при равенстве — по ENV_ORDER, затем по алфавиту.
 */
export function groupByEnv<T extends { env: string; updatedAt: number }>(
  items: T[],
): Array<{ env: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.env);
    if (list) list.push(item);
    else groups.set(item.env, [item]);
  }
  const rank = (env: string) => {
    const i = ENV_ORDER.indexOf(env);
    return i < 0 ? ENV_ORDER.length : i;
  };
  const latest = (list: T[]) => Math.max(...list.map((item) => item.updatedAt));
  return [...groups.entries()]
    .map(([env, list]) => ({ env, items: list }))
    .sort(
      (a, b) =>
        latest(b.items) - latest(a.items) || rank(a.env) - rank(b.env) || a.env.localeCompare(b.env),
    );
}

/** Заголовок сессии без префикса окружения («dev: abc» → «abc»). */
export function titleWithoutEnv(title: string, env: string): string {
  const prefix = `${env}: `;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

export type StatusKind = "ok" | "redirect" | "client" | "server" | "unknown";

export function statusKind(status: string): StatusKind {
  const code = Number.parseInt(status, 10);
  if (!Number.isFinite(code)) return "unknown";
  if (code >= 500) return "server";
  if (code >= 400) return "client";
  if (code >= 300) return "redirect";
  return code >= 100 ? "ok" : "unknown";
}

/** Размер тела для подписи: «512 Б», «3.4 КБ». */
export function formatSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1)} КБ`;
}

export type LevelKind = "error" | "warn" | "info" | "debug";

export function levelKind(level: string): LevelKind {
  const l = level.trim().toLowerCase();
  if (/^(err|error|critical|crit|fatal|emerg|alert)/.test(l)) return "error";
  if (/^warn/.test(l)) return "warn";
  if (/^(debug|dbg|trace|verbose)/.test(l)) return "debug";
  return "info";
}

const SERVICE_PREFIXES = [
  "LMS.Platform.Services.",
  "LMS.India2.Services.",
  "LMS.India2.BFF.",
  "LMS.Platform.",
  "LMS.India2.",
];

/** Короткое имя сервиса для тега: без общего префикса и суффикса .RestApi. */
export function shortService(name: string): string {
  let short = name;
  const prefix = SERVICE_PREFIXES.find((p) => short.startsWith(p));
  if (prefix && short.length > prefix.length) short = short.slice(prefix.length);
  return short.replace(/\.RestApi$/, "") || name;
}

/** Стабильный номер цвета сервиса 0..count-1. */
export function serviceColor(name: string, count = 8): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash) % count;
}

function ms(time: string): number | null {
  const value = Date.parse(time);
  return Number.isNaN(value) ? null : value;
}

export type LogSummary = {
  total: number;
  shown: number;
  errors: number;
  warnings: number;
  services: string[];
  startMs: number | null;
  durationMs: number | null;
};

export function summarize(rows: LogRow[], total: number): LogSummary {
  const times = rows.map((row) => ms(row.time)).filter((t): t is number => t !== null);
  const startMs = times.length > 0 ? Math.min(...times) : null;
  const endMs = times.length > 0 ? Math.max(...times) : null;
  const services: string[] = [];
  for (const row of rows) {
    if (row.service !== "" && !services.includes(row.service)) services.push(row.service);
  }
  return {
    total,
    shown: rows.length,
    errors: rows.filter((row) => levelKind(row.level) === "error").length,
    warnings: rows.filter((row) => levelKind(row.level) === "warn").length,
    services,
    startMs,
    durationMs: startMs !== null && endMs !== null ? endMs - startMs : null,
  };
}

/** Длительность в мс → «850 ms», «1.234 s», «2m 03s». */
export function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(3)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Смещение сообщения от начала трейса: «+0.000s», «+1.234s», «+2m 03s». */
export function offsetLabel(time: string, startMs: number | null): string {
  const value = ms(time);
  if (value === null || startMs === null) return "";
  const delta = Math.max(0, value - startMs);
  if (delta < 60_000) return `+${(delta / 1000).toFixed(3)}s`;
  return `+${formatMs(delta)}`;
}
