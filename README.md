# bb-plugin-graylog

Плагин [BB](https://getbb.app/): страница **Graylog** в левой навигации — поиск трейсов в Jaeger
и логов в Graylog через MCP, подробный просмотр логов и диалог с агентом о найденном.

## Возможности

- **Окружение** (общее для Jaeger и Graylog): инстансы из MCP graylog + `stage`
  (instance `hotfix`, свой стрим).
- **Jaeger**: Service → Operation → Lookback (5 минут … 7 дней), «только с ошибками»;
  клик по трейсу подставляет TraceId, ссылка открывает трейс в Jaeger UI.
- **Поиск** (без анализа):
  - по TraceId — `TraceId:"<id>"` за 7 дней, до 200 сообщений;
  - по описанию («логи с ошибками за последний час») — короткий скрытый служебный тред
    агента переводит фразу в запрос Graylog и удаляется; логи ищет сам плагин (до 200 свежих).
- **Логи**: сводка (ошибки, предупреждения, сервисы, длительность), уровень и сервис цветом,
  смещение от начала, HTTP-метки (метод, путь, статус, время), тело запроса/ответа
  (JSON с отступами), атрибуты, исключение, SpanId/EventId.
- **Продолжить с агентом**: первый вопрос создаёт скрытый тред с найденными логами,
  дальше — встроенный чат в окне плагина.
- **История поисков**: группы по окружениям, фильтр, удаление; хранится в `bb.storage.kv`.

## Требования

- MCP graylog, настроенный у Claude Code: `~/.claude.json` → `mcpServers.graylog`
  (stdio). Плагин запускает его сам; токены остаются в этом файле, плагин их не хранит.
- Доступ к MCP Jaeger окружений (`https://jaeger-query…/api/ai/mcp/`, адреса в `lib/jaeger.ts`).
- Провайдер для агента. По умолчанию — opencode, модель On-Prem
  (`acp-opencode` / `finbeat/qwen3.8-27b-fp8`); меняется в настройках или в форме.

## Установка

Из GitHub (приватный репозиторий — нужен ваш git-доступ):

```
bb plugin install git:https://github.com/<owner>/bb-plugin-graylog.git
bb plugin update graylog          # подтянуть новую версию
```

Конкретная версия: `git:https://github.com/<owner>/bb-plugin-graylog.git@^0.1`
(по тегам `vX.Y.Z`).

## Настройки

`bb plugin config graylog`:

| Ключ | Назначение |
|---|---|
| `claudeConfigPath` | файл с `mcpServers` (пусто — `~/.claude.json`) |
| `mcpServerName` | имя MCP-сервера Graylog (по умолчанию `graylog`) |
| `jaegerMcpUrls` | JSON `{"dev": "https://…/api/ai/mcp/"}` — переопределение адресов Jaeger |
| `defaultProviderId`, `defaultModel`, `defaultReasoningLevel` | модель агента по умолчанию; пустой провайдер — модель BB |

## Устройство

- `server.ts` — MCP-клиенты (graylog по stdio, Jaeger по HTTP) и RPC:
  `instances`, `search`, `defaults`, `jaeger*`, `runSearch`, `sessions`, `session`,
  `archiveSession`, `askAgent`.
- `lib/graylog.ts` — окружения и стримы, разбор `search_messages` (атрибуты, тела, HTTP),
  промты агенту и перевод описания в запрос.
- `lib/jaeger.ts` — окружения Jaeger, интервалы, разбор ответов MCP jaeger.
- `lib/logview.ts` — уровни, сервисы, сводка, тела, статусы, группировка истории.
- `app.tsx` — страница (`navPanel`): история, форма поиска, просмотр логов, чат.

## Разработка

```
npm install
npm run typecheck
npm test
bb plugin install .
bb plugin dev
```
