// bb-plugin-graylog — интерфейс: страница Graylog в левой навигации.
// Слева история поисков, справа — новый поиск или найденные логи. Поиск не
// анализирует логи; диалог с агентом начинается по кнопке под результатами.
// Блок Jaeger ищет трейсы по сервису/операции/интервалу и подставляет TraceId.
import { Fragment, useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  type PluginNavPanelProps,
  ThreadChat,
  experimental_ProviderModelPicker as ProviderModelPicker,
  type ExperimentalProviderModelPickerValue,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { LogRow, rpcContract, SearchResult, Session } from "./server";
import { formatRange, type HttpInfo } from "./lib/graylog";
import {
  formatMs,
  formatSize,
  groupByEnv,
  type LevelKind,
  levelKind,
  offsetLabel,
  prettyBody,
  serviceColor,
  shortService,
  type StatusKind,
  statusKind,
  summarize,
  summaryLine,
  titleWithoutEnv,
} from "./lib/logview";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  DEFAULT_LOOKBACK,
  formatDuration,
  JAEGER_ENVS,
  jaegerTraceUrl,
  LOOKBACKS,
  type Lookback,
  type TraceSummary,
} from "./lib/jaeger";

type Env = { value: string; label: string };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useEnvs() {
  const rpc = useRpc<typeof rpcContract>();
  const [envs, setEnvs] = useState<Env[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    rpc.call("instances").then(
      (result) => setEnvs(result.envs),
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(load, [load]);
  return { envs, error, reload: load };
}

/** Провайдер и модель по умолчанию; null — пока не загружены или BB их не знает. */
function useDefaultExecution() {
  const rpc = useRpc<typeof rpcContract>();
  const [execution, setExecution] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    rpc.call("defaults").then(
      (result) => {
        if (cancelled) return;
        setExecution(result.execution);
        setLoaded(true);
      },
      () => !cancelled && setLoaded(true),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  return { execution, setExecution, loaded };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

const controlClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Поиск трейсов в Jaeger окружения env; onPick получает выбранный trace_id. */
function JaegerPicker({
  env,
  onPick,
  picked,
}: {
  env: string;
  onPick: (traceId: string) => void;
  picked: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const supported = env !== "" && JAEGER_ENVS[env] !== undefined;
  const [open, setOpen] = useState(false);
  const [services, setServices] = useState<string[] | null>(null);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [service, setService] = useState("");
  const [operations, setOperations] = useState<string[] | null>(null);
  const [operation, setOperation] = useState("");
  const [lookback, setLookback] = useState<Lookback>(DEFAULT_LOOKBACK);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [traces, setTraces] = useState<TraceSummary[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Смена окружения сбрасывает выбор и результаты.
  useEffect(() => {
    setServices(null);
    setServicesError(null);
    setService("");
    setTraces(null);
    setError(null);
  }, [env]);

  // Сервисы загружаются при первом раскрытии блока для текущего окружения.
  useEffect(() => {
    if (!open || !supported || services !== null || servicesError !== null) return;
    let cancelled = false;
    rpc.call("jaegerServices", { env }).then(
      (result) => {
        if (!cancelled) setServices(result.services);
      },
      (cause) => {
        if (!cancelled) setServicesError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, env, open, supported, services, servicesError]);

  useEffect(() => {
    setOperation("");
    setOperations(null);
    setTraces(null);
    if (service === "") return;
    let cancelled = false;
    rpc.call("jaegerOperations", { env, service }).then(
      (result) => {
        if (!cancelled) setOperations(result.operations);
      },
      (cause) => {
        if (cancelled) return;
        setOperations([]);
        setError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
    // env не в зависимостях: при его смене service сбрасывается в "".
  }, [rpc, service]);

  const find = async () => {
    if (service === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await rpc.call("jaegerTraces", {
        env,
        service,
        operation,
        lookback,
        errorsOnly,
      });
      setTraces(result.traces);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <details
      className="rounded-md border border-border"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        Найти TraceId в Jaeger
      </summary>
      <div className="flex flex-col gap-3 border-t border-border p-3">
        {supported ? null : (
          <p className="text-xs text-muted-foreground">
            {env === ""
              ? "Выберите окружение выше."
              : `Для окружения «${env}» Jaeger не настроен.`}
          </p>
        )}
        <Field label="Service">
          <select
            className={controlClass}
            value={service}
            disabled={services === null}
            onChange={(event) => setService(event.target.value)}
          >
            <option value="">
              {!supported ? "—" : services === null ? "Загрузка…" : "— выберите сервис —"}
            </option>
            {(services ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        {servicesError === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            Не удалось получить сервисы из MCP jaeger: {servicesError}{" "}
            <button type="button" className="underline" onClick={() => setServicesError(null)}>
              Повторить
            </button>
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Operation">
            <select
              className={controlClass}
              value={operation}
              disabled={service === "" || operations === null}
              onChange={(event) => setOperation(event.target.value)}
            >
              <option value="">
                {service !== "" && operations === null ? "Загрузка…" : "— все операции —"}
              </option>
              {(operations ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lookback">
            <select
              className={controlClass}
              value={lookback}
              onChange={(event) => setLookback(event.target.value as Lookback)}
            >
              {LOOKBACKS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(event) => setErrorsOnly(event.target.checked)}
          />
          Только с ошибками
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={service === "" || pending}
          onClick={() => void find()}
        >
          <Icon name="Search" className="size-4" />
          {pending ? "Ищу трейсы…" : "Найти трейсы"}
        </Button>
        {error === null ? null : (
          <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
            {error}
          </p>
        )}
        {traces === null ? null : traces.length === 0 ? (
          <p className="text-xs text-muted-foreground">Трейсов не найдено.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {traces.map((trace) => {
              const link = jaegerTraceUrl(env, trace.traceId);
              return (
              <li
                key={trace.traceId}
                className={cn("flex items-start", picked === trace.traceId && "bg-accent")}
              >
                <button
                  type="button"
                  title="Подставить TraceId"
                  onClick={() => onPick(trace.traceId)}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-accent"
                >
                  <span className="flex flex-wrap items-center gap-x-2 text-sm">
                    {trace.hasErrors ? (
                      <span className="font-medium text-destructive">ошибка</span>
                    ) : null}
                    <span className="font-medium">{trace.rootSpanName || "(без имени)"}</span>
                    <span className="text-muted-foreground">{formatDuration(trace.durationUs)}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {formatTime(trace.startTime)} · {trace.rootService} · спанов {trace.spanCount} ·
                    сервисов {trace.serviceCount}
                  </span>
                  <span className="break-all font-mono text-muted-foreground">{trace.traceId}</span>
                </button>
                {link === null ? null : (
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    title="Открыть в Jaeger"
                    className="shrink-0 px-3 py-2 text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    Jaeger
                  </a>
                )}
              </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Клик по трейсу подставит TraceId в поиск логов.
        </p>
      </div>
    </details>
  );
}

/** Цвета тегов сервисов (индекс — serviceColor). */
const SERVICE_COLORS = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-pink-500/15 text-pink-700 dark:text-pink-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  "bg-lime-500/15 text-lime-700 dark:text-lime-300",
];

const LEVEL_BADGE: Record<LevelKind, string> = {
  error: "bg-destructive text-white",
  warn: "bg-amber-500 text-black",
  info: "bg-muted text-foreground",
  debug: "bg-transparent text-muted-foreground border border-border",
};

const LEVEL_ROW: Record<LevelKind, string> = {
  error: "bg-destructive/10",
  warn: "bg-amber-500/10",
  info: "",
  debug: "opacity-70",
};

function ServiceTag({ name }: { name: string }) {
  if (name === "") return null;
  return (
    <span
      title={name}
      className={cn(
        "max-w-48 shrink-0 truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
        SERVICE_COLORS[serviceColor(name, SERVICE_COLORS.length)],
      )}
    >
      {shortService(name)}
    </span>
  );
}

const STATUS_BADGE: Record<StatusKind, string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  redirect: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  client: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  server: "bg-destructive/15 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

function copyText(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success("Скопировано."),
    () => toast.error("Не удалось скопировать."),
  );
}

/** Компактная метка HTTP: «→ POST /v1/links 200 · 19 ms». */
function HttpBadge({ http }: { http: HttpInfo }) {
  const arrow = http.kind === "request" ? "→" : http.kind === "response" ? "←" : "";
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
      {arrow ? <span className="text-muted-foreground">{arrow}</span> : null}
      {http.method ? <span className="font-semibold">{http.method}</span> : null}
      {http.path ? (
        <span className="max-w-64 truncate text-muted-foreground" title={http.path}>
          {http.path}
        </span>
      ) : null}
      {http.status ? (
        <span className={cn("rounded px-1", STATUS_BADGE[statusKind(http.status)])}>{http.status}</span>
      ) : null}
      {http.elapsedMs !== null ? (
        <span className="text-muted-foreground">{formatMs(http.elapsedMs)}</span>
      ) : null}
    </span>
  );
}

/** Блок кода с подписью и кнопкой копирования. */
function CodeBlock({
  title,
  text,
  tone = "default",
}: {
  title: string;
  text: string;
  tone?: "default" | "error";
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <span>{title}</span>
        <button type="button" onClick={() => copyText(text)} className="ml-auto underline hover:text-foreground">
          Копировать
        </button>
      </div>
      <pre
        className={cn(
          "max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed",
          tone === "error" && "text-destructive",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function bodyTitle(row: LogRow, size: string): string {
  const kind = row.http?.kind;
  const what = kind === "request" ? "Тело запроса" : kind === "response" ? "Тело ответа" : "Тело";
  return `${what} · ${size}`;
}

function LogLine({ row, startMs }: { row: LogRow; startMs: number | null }) {
  const [open, setOpen] = useState(false);
  const kind = levelKind(row.level);
  const summary = summaryLine(row);
  const body = row.body !== "" ? prettyBody(row.body) : null;
  const attributes = Object.entries(row.attributes).filter(([, value]) => value !== "");
  return (
    <li className={cn("text-xs", LEVEL_ROW[kind])}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/60"
      >
        <span className="w-16 shrink-0 font-mono text-muted-foreground">
          {offsetLabel(row.time, startMs)}
        </span>
        <span
          className={cn(
            "w-12 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-semibold uppercase",
            LEVEL_BADGE[kind],
          )}
        >
          {kind}
        </span>
        <ServiceTag name={row.service} />
        {row.http ? <HttpBadge http={row.http} /> : null}
        <span className="min-w-0 flex-1 truncate">{summary || "(пусто)"}</span>
        {body ? (
          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
            {body.json ? "JSON" : "тело"} {formatSize(row.body)}
          </span>
        ) : null}
        {row.exception !== "" ? (
          <span className="shrink-0 text-[10px] font-medium text-destructive">exception</span>
        ) : null}
        <span aria-hidden className="w-3 shrink-0 text-center text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>{formatTime(row.time)}</span>
            <span>{row.level || "—"}</span>
            <span className="break-all">{row.service || "—"}</span>
            <button
              type="button"
              onClick={() => copyText([row.message, row.body, row.exception].filter((p) => p !== "").join("\n\n"))}
              className="ml-auto underline hover:text-foreground"
            >
              Копировать всё
            </button>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">{summary || row.message}</p>
          {row.http ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
              {row.http.method ? (
                <>
                  <dt className="text-muted-foreground">Метод</dt>
                  <dd>{row.http.method}</dd>
                </>
              ) : null}
              {row.http.path ? (
                <>
                  <dt className="text-muted-foreground">Путь</dt>
                  <dd className="break-all">{row.http.path}</dd>
                </>
              ) : null}
              {row.http.status ? (
                <>
                  <dt className="text-muted-foreground">Статус</dt>
                  <dd>
                    <span className={cn("rounded px-1", STATUS_BADGE[statusKind(row.http.status)])}>
                      {row.http.status}
                    </span>
                  </dd>
                </>
              ) : null}
              {row.http.elapsedMs !== null ? (
                <>
                  <dt className="text-muted-foreground">Время</dt>
                  <dd>{formatMs(row.http.elapsedMs)}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {body ? <CodeBlock title={bodyTitle(row, formatSize(row.body))} text={body.text} /> : null}
          {row.exception !== "" ? <CodeBlock title="Exception" text={row.exception} tone="error" /> : null}
          {attributes.length > 0 ? (
            <details>
              <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground">
                Атрибуты ({attributes.length})
              </summary>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
                {attributes.map(([key, value]) => (
                  <Fragment key={key}>
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="break-all">{value}</dd>
                  </Fragment>
                ))}
              </dl>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
            {row.category ? <span className="break-all">{row.category}</span> : null}
            {row.eventId ? <span>event {row.eventId}</span> : null}
            {row.spanId ? <span>span {row.spanId}</span> : null}
            <span>
              index {row.index} · id {row.id}
            </span>
          </div>
          {row.template && row.template !== summary ? (
            <p className="font-mono text-[11px] text-muted-foreground">Шаблон: {row.template}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Логи трейса: сводка и список сообщений. */
function LogPreview({ result }: { result: SearchResult }) {
  const { rows, total } = result;
  const summary = summarize(rows, total);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-md bg-muted px-2 py-1">
          Найдено <b>{summary.total}</b>
          {summary.shown < summary.total ? ` (показано ${summary.shown})` : ""}
        </span>
        <span
          className={cn(
            "rounded-md px-2 py-1",
            summary.errors > 0 ? "bg-destructive/15 text-destructive" : "bg-muted",
          )}
        >
          Ошибок <b>{summary.errors}</b>
        </span>
        <span
          className={cn(
            "rounded-md px-2 py-1",
            summary.warnings > 0 ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted",
          )}
        >
          Предупреждений <b>{summary.warnings}</b>
        </span>
        <span className="rounded-md bg-muted px-2 py-1" title={summary.services.join("\n")}>
          Сервисов <b>{summary.services.length}</b>
        </span>
        {summary.durationMs === null ? null : (
          <span className="rounded-md bg-muted px-2 py-1">
            Длительность <b>{formatMs(summary.durationMs)}</b>
          </span>
        )}
      </div>
      {summary.services.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {summary.services.map((name) => (
            <ServiceTag key={name} name={name} />
          ))}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">По TraceId ничего не найдено за 7 дней.</p>
      ) : (
        <ul className="flex max-h-[28rem] flex-col divide-y divide-border/60 overflow-y-auto rounded-md border border-border">
          {rows.map((row, i) => (
            <LogLine key={`${row.index}/${row.id}/${i}`} row={row} startMs={summary.startMs} />
          ))}
        </ul>
      )}
    </div>
  );
}

const PANEL_PATH = "graylog";

/** Сессия, только что найденная формой: логи уже есть, перезапрашивать не нужно. */
type Found = { session: Session; result: SearchResult };

/** Форма нового поиска. */
function SearchForm({ onFound }: { onFound: (found: Found) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const { envs, error: envError, reload } = useEnvs();
  const [env, setEnv] = useState("");
  const [traceId, setTraceId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { execution, setExecution, loaded } = useDefaultExecution();

  const hasTrace = traceId.trim() !== "";
  const hasPrompt = prompt.trim() !== "";
  const canRun = env !== "" && (hasTrace || hasPrompt) && !pending;

  const run = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canRun) return;
    setPending(true);
    setError(null);
    try {
      const found = await rpc.call("runSearch", {
        env,
        traceId: traceId.trim(),
        prompt: hasTrace ? "" : prompt.trim(),
        ...(execution ? { execution } : {}),
      });
      onFound(found);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  const pickTrace = (picked: string) => {
    setTraceId(picked);
    toast.success("TraceId подставлен.");
  };

  return (
    <form onSubmit={run} className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
      <h2 className="text-base font-semibold">Новый поиск</h2>
      <Field label="Окружение (Jaeger и Graylog)">
        <select
          className={controlClass}
          value={env}
          disabled={envs === null}
          onChange={(event) => setEnv(event.target.value)}
        >
          <option value="">{envs === null ? "Загрузка…" : "— выберите окружение —"}</option>
          {(envs ?? []).map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      {envError === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          Не удалось получить окружения из MCP graylog: {envError}{" "}
          <button type="button" className="underline" onClick={reload}>
            Повторить
          </button>
        </p>
      )}
      <JaegerPicker env={env} onPick={pickTrace} picked={traceId.trim()} />
      <Field label="TraceId">
        <Input
          value={traceId}
          onChange={(event) => setTraceId(event.target.value)}
          placeholder="4bf92f3577b34da6a3ce929d0e0e4736"
          className="font-mono"
        />
      </Field>
      <Field label="…или опишите, что найти">
        <textarea
          className={cn(controlClass, "min-h-16 resize-y")}
          value={prompt}
          rows={3}
          disabled={hasTrace}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void run();
            }
          }}
          placeholder={
            hasTrace
              ? "Поиск идёт по TraceId."
              : "Например: логи с ошибками за последний час"
          }
        />
      </Field>
      <Field label="Модель агента (запрос по описанию и вопросы о логах)">
        {execution ? (
          <ProviderModelPicker value={execution} onChange={setExecution} className="self-start" />
        ) : (
          <span className="text-sm font-normal text-muted-foreground">
            {loaded ? "По умолчанию BB" : "Загрузка…"}
          </span>
        )}
      </Field>
      <Button type="submit" disabled={!canRun}>
        <Icon name="Search" className="size-4" />
        {pending ? (hasTrace ? "Ищу…" : "Подбираю запрос и ищу…") : "Поиск"}
      </Button>
      <p className="text-xs text-muted-foreground">
        {hasTrace
          ? "Логи по TraceId за 7 дней (до 200)."
          : hasPrompt
            ? "Агент только переведёт описание в запрос Graylog, логи найдёт и покажет плагин (до 200, свежие)."
            : "Укажите TraceId или опишите, что найти."}{" "}
        Анализа нет — вопрос агенту можно задать под результатами.
      </p>
      {error === null ? null : (
        <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "только что";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return new Date(ms).toLocaleDateString();
}

const COLLAPSED_KEY = "bb-graylog:collapsedEnvs";

/** Свёрнутые разделы истории переживают перезагрузку; недоступное хранилище не ломает панель. */
function loadCollapsed(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function saveCollapsed(state: Record<string, boolean>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state));
  } catch {
    // хранилище недоступно — состояние живёт только до перезагрузки
  }
}

/** История поисков: новые сверху, «×» удаляет. */
function SessionList({
  sessions,
  error,
  activeId,
  onOpen,
  onNew,
  onArchive,
}: {
  sessions: Session[] | null;
  error: string | null;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onArchive: (session: Session) => void;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const groups = groupByEnv(sessions ?? []);
  const activeEnv = sessions?.find((session) => session.id === activeId)?.env ?? null;
  const visible = filter === null ? groups : groups.filter((group) => group.env === filter);
  const toggle = (env: string) =>
    setCollapsed((state) => {
      const next = { ...state, [env]: !state[env] };
      saveCollapsed(next);
      return next;
    });

  const row = (session: Session) => (
    <li
      key={session.id}
      className={cn(
        "group flex items-start rounded-md hover:bg-accent/60",
        activeId === session.id && "bg-accent",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left"
      >
        <span className="truncate text-sm">{titleWithoutEnv(session.title, session.env)}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          <span>{session.mode === "trace" ? "TraceId" : "описание"}</span>
          <span>· {session.total} сообщ.</span>
          <span>· {timeAgo(session.updatedAt)}</span>
          {session.threadId ? <span title="Есть диалог с агентом">· 💬</span> : null}
        </span>
      </button>
      <button
        type="button"
        title="Удалить из истории"
        onClick={() => onArchive(session)}
        className="invisible px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground group-hover:visible"
      >
        ×
      </button>
    </li>
  );

  return (
    <aside className="flex max-h-64 min-h-0 shrink-0 flex-col border-b border-border md:h-full md:max-h-none md:w-72 md:border-b-0 md:border-r">
      <div className="flex items-center gap-2 p-3">
        <span className="text-sm font-semibold">История</span>
        <Button
          type="button"
          size="sm"
          variant={activeId === null ? "default" : "outline"}
          onClick={onNew}
          className="ml-auto"
        >
          <Icon name="Search" className="size-3.5" />
          Новый поиск
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error !== null ? (
          <p className="px-1 text-xs text-destructive">Не удалось загрузить историю: {error}</p>
        ) : sessions === null ? (
          <p className="px-1 text-xs text-muted-foreground">Загрузка…</p>
        ) : sessions.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">Поисков пока нет.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {groups.length > 1 ? (
              <div className="flex flex-wrap gap-1 px-1" role="tablist" aria-label="Окружение">
                {[null, ...groups.map((group) => group.env)].map((env) => {
                  const count =
                    env === null
                      ? sessions.length
                      : (groups.find((group) => group.env === env)?.items.length ?? 0);
                  return (
                    <button
                      key={env ?? "*"}
                      type="button"
                      role="tab"
                      aria-selected={filter === env}
                      onClick={() => setFilter(env)}
                      className={cn(
                        "rounded-md px-2 py-0.5 text-xs",
                        filter === env
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {env ?? "Все"} <span className="opacity-70">{count}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {visible.map((group) => {
              // Группа с открытым поиском не сворачивается, чтобы его было видно.
              const isCollapsed = !!collapsed[group.env] && group.env !== activeEnv;
              return (
                <section key={group.env} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => toggle(group.env)}
                    aria-expanded={!isCollapsed}
                    className="flex items-center gap-1.5 px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  >
                    <span aria-hidden className="w-3 text-center">
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                    <span>{group.env}</span>
                    <span className="font-normal normal-case opacity-70">{group.items.length}</span>
                  </button>
                  {isCollapsed ? null : (
                    <ul className="flex flex-col gap-0.5">{group.items.map(row)}</ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Первый вопрос агенту о найденных логах — создаёт тред сессии. */
function AskAgent({ sessionId, onStarted }: { sessionId: string; onStarted: (threadId: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const { execution } = useDefaultExecution();
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const started = await rpc.call("askAgent", {
        id: sessionId,
        question: question.trim(),
        ...(execution ? { execution } : {}),
      });
      onStarted(started.threadId);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <span className="text-sm font-medium">Продолжить с агентом</span>
      <textarea
        className={cn(controlClass, "min-h-16 resize-y")}
        value={question}
        rows={3}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void ask();
          }
        }}
        placeholder="Вопрос о найденных логах. Пусто — агент кратко их разберёт."
      />
      <Button type="button" onClick={() => void ask()} disabled={pending} className="self-start">
        {pending ? "Передаю логи агенту…" : "Спросить агента"}
      </Button>
      {error === null ? null : (
        <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Сессия: что искали, найденные логи и диалог с агентом. */
function SessionView({
  id,
  initial,
  onChanged,
  onBack,
}: {
  id: string;
  initial: Found | null;
  onChanged: () => void;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [found, setFound] = useState<Found | null>(initial?.session.id === id ? initial : null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setRefreshing(true);
    setError(null);
    return rpc.call("session", { id }).then(
      (next) => setFound(next),
      (cause) => setError(errorText(cause)),
    ).finally(() => setRefreshing(false));
  }, [rpc, id]);

  useEffect(() => {
    if (initial?.session.id === id) {
      setFound(initial);
      return;
    }
    setFound(null);
    void load();
  }, [id, initial, load]);

  if (found === null) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {error === null ? "Загрузка поиска…" : `Не удалось открыть поиск: ${error}`}
      </div>
    );
  }
  const { session, result } = found;
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success("Скопировано."),
      () => toast.error("Не удалось скопировать."),
    );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={onBack} className="self-start">
          ← К поиску trace
        </Button>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 truncate text-base font-semibold">{session.title}</span>
          <span className="rounded bg-muted px-1.5 text-xs font-medium">{session.env}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={() => void load()}
            className="ml-auto"
          >
            {refreshing ? "Обновляю…" : "Обновить"}
          </Button>
        </div>
        {session.mode === "prompt" ? (
          <p className="text-xs text-muted-foreground">«{session.prompt}»</p>
        ) : null}
        <button
          type="button"
          title="Скопировать запрос"
          onClick={() => void copy(session.mode === "trace" && session.traceId ? session.traceId : session.query)}
          className="self-start break-all text-left font-mono text-xs text-muted-foreground hover:text-foreground"
        >
          {session.query} · последние {formatRange(session.rangeSeconds)}
        </button>
        {error === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </header>
      <LogPreview result={result} />
      {session.threadId ? (
        <section className="flex flex-col gap-2">
          <span className="text-sm font-medium">Диалог с агентом</span>
          <ThreadChat key={session.threadId} threadId={session.threadId} variant="full" layout="document" />
        </section>
      ) : (
        <AskAgent
          sessionId={session.id}
          onStarted={(threadId) => {
            setFound({ session: { ...session, threadId }, result });
            onChanged();
          }}
        />
      )}
    </div>
  );
}

const SESSIONS_REFRESH_MS = 15_000;

function useSessions() {
  const rpc = useRpc<typeof rpcContract>();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    rpc.call("sessions").then(
      (result) => {
        setSessions(result.sessions);
        setError(null);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, SESSIONS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  return { sessions, error, reload, setSessions };
}

function GraylogPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { sessions, error, reload, setSessions } = useSessions();
  const [justFound, setJustFound] = useState<Found | null>(null);
  const first = subPath.split("/")[0] ?? "";
  const activeId = first === "" ? null : decodeURIComponent(first);

  const open = (id: string | null) => {
    if (id === null) navigate.toPluginPanel(PANEL_PATH);
    else navigate.toPluginPanel(PANEL_PATH, { subPath: id });
  };

  const archive = async (session: Session) => {
    try {
      await rpc.call("archiveSession", { id: session.id });
      setSessions((list) => list?.filter((item) => item.id !== session.id) ?? null);
      if (activeId === session.id) open(null);
      toast.success("Поиск удалён из истории.");
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col md:flex-row">
      <SessionList
        sessions={sessions}
        error={error}
        activeId={activeId}
        onOpen={open}
        onNew={() => open(null)}
        onArchive={(session) => void archive(session)}
      />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {/* Форма остаётся смонтированной, чтобы состояние поиска trace сохранялось при возврате из логов. */}
        <div className={activeId === null ? undefined : "hidden"}>
          <SearchForm
            onFound={(found) => {
              setJustFound(found);
              reload();
              open(found.session.id);
            }}
          />
        </div>
        {activeId === null ? null : (
          <SessionView
            id={activeId}
            initial={justFound}
            onChanged={reload}
            onBack={() => open(null)}
          />
        )}
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "graylog",
    title: "Graylog",
    icon: "graylog/logs",
    path: PANEL_PATH,
    component: GraylogPage,
  });
});
