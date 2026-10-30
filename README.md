# LaunchPilot — AI Marketing Factory

Phase 1: the full product shell (auth, projects, intake, integrations, BYOK settings, uploads, workspace placeholder).
Phase 2: the **Mozaik runtime is integrated with NestJS** and proven end to end by an infrastructure smoke test.
Phase 3 (this milestone): **OpenAI BYOK + the first real Mozaik agents**: a text-only **Product Discovery report**
(see below). Full campaign generation (audit, strategy, creative, export) is still not implemented.

## Stack

- `apps/web`: Next.js 14 (App Router), Tailwind, shadcn-style components, React Hook Form + Zod, TanStack Query
- `apps/api`: NestJS 11, Prisma 6, PostgreSQL, JWT in an httpOnly cookie, bcrypt, class-validator
- `packages/agents`: `@launchpilot/agents`, the Mozaik runtime adapter, factory contracts and (later) the agents
- `packages/config`: shared tsconfig base

## Setup

Requires **Node 22.12+** (Mozaik's CJS build loads an ESM-only telemetry package through `require(esm)`), pnpm 9, Docker.

```powershell
pnpm install
copy .env.example .env        # then edit secrets (JWT_SECRET, APP_ENCRYPTION_KEY)
pnpm db:up                    # Postgres on localhost:5433
pnpm --filter @launchpilot/api db:generate
pnpm db:migrate               # applies ALL migrations, including campaign_runs
pnpm db:seed                  # demo data
pnpm dev                      # builds @launchpilot/agents, then web :3000 + api :4000
```

Open http://localhost:3000 and sign in with `demo@launchpilot.dev` / `demo12345`.
Postgres is mapped to host port **5433** so it does not clash with a local Postgres on 5432.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | web + api in watch mode (the API script builds `@launchpilot/agents` first) |
| `pnpm build` / `pnpm start` | production build / run |
| `pnpm typecheck` | typecheck every package |
| `pnpm test` | agents tests (node:test) then API e2e tests (Jest, needs PostgreSQL) |
| `pnpm db:migrate` / `db:seed` / `db:reset` | Prisma migrate / seed / reset |
| `pnpm format` | Prettier |

`@launchpilot/agents` compiles to CommonJS in `packages/agents/dist` (the API imports it). Rebuild it after changing
it: `pnpm --filter @launchpilot/agents build`. The old hello-world still runs with `pnpm --filter @launchpilot/agents hello`.

## Mozaik / NestJS integration

```
HTTP (authenticated)            apps/api                                   packages/agents
POST /projects/:id/runs/smoke-test
        │                  MozaikController
        ▼                       │
   MozaikService  ── create CampaignRun (RUNNING) ──► PostgreSQL
   (orchestration adapter)      │
        │  runtime.startRun()   ▼
        └──────────────────►  MozaikCampaignRuntime ──► one ActiveRun per run
                                                          ├─ its own defineRuntime() closure
                                                          ├─ FactoryRuntimeState (in memory)
                                                          └─ Mozaik participants:
                                                             Run Recorder · Factory Orchestrator · Smoke Test Participant
        ▲                                                          │ real Mozaik SemanticEvents
        │  onEvent(sanitized event, in order)  ◄───────────────────┘
        ▼
   EventWriter ──► CampaignEvent rows;  on terminal status ──► CampaignRun updated
```

- The API knows nothing about individual agents. It talks to the `CampaignRuntime` interface
  (`startRun`, `getRunStatus`, `stopRun`, `shutdown`) exported by `@launchpilot/agents`.
- **Real Mozaik.** Participants are created with `createAgent` / `createHuman`, join a `defineRuntime()` runtime and
  react to `SemanticEvent`s. The smoke participant is deterministic: it never calls a model.
- **Isolation.** `defineRuntime()` keeps its runtime in a closure, so every run owns a separate runtime, state, timers
  and participants. Nothing is shared between runs or users.
- **Event handlers do not accumulate.** When a run ends, its participants `leave()`, timers are cleared and the run is
  dropped from memory.
- Mozaik calls handlers synchronously and ignores their result, so every handler is wrapped: a thrown error or rejected
  promise becomes a `factory.failed` event instead of an unhandled rejection.

### Run the infrastructure smoke test

1. `pnpm db:up && pnpm db:migrate && pnpm dev`, sign in, open any project, then its **Workspace**.
2. In **Mozaik Runtime: Infrastructure** press **Run Infrastructure Test**. Status goes *Running → Passed* and the
   timeline shows `participant.joined ×3 → factory.started → test.acknowledged → factory.completed`.

It needs **no API key** and costs nothing. It is not a campaign: no phase is completed and no content is produced.
Or from a terminal (replace the cookie jar with a logged-in session):

```bash
curl -b cookies.txt -H 'Content-Type: application/json' -d '{"delayMs":500}' http://localhost:4000/projects/<projectId>/runs/smoke-test
curl -b cookies.txt http://localhost:4000/runs/<runId>/events
```

### API endpoints (all require a session)

| Method | Path | Notes |
|---|---|---|
| POST | `/projects/:projectId/runs/smoke-test` | Body `{ "delayMs"?: 0-10000 }`. 201 + run (async: poll it). 409 if this project already has a RUNNING run. If the runtime cannot start, 201 with `status: FAILED`. |
| GET | `/projects/:projectId/runs` | Latest 20 runs |
| GET | `/runs/:runId` | One run |
| GET | `/runs/:runId/events?afterSequence=&limit=` | Cursor pagination by `sequence` (limit 1–500, default 100). Response `{ items, nextCursor }` |
| POST | `/runs/:runId/cancel` | Stops work and ends `CANCELLED`. 409 if already finished |

Other users' projects and runs return **404**, never 403. There is deliberately no campaign-generation endpoint yet.

### Database

Migration `20261030120000_campaign_runs` (additive, non-destructive) adds `RunStatus`, `CampaignRun`, `CampaignEvent`.
It also creates a hand-written partial unique index, `CampaignRun_one_running_per_project`, which makes "no duplicate
execution" atomic under concurrent requests (Prisma cannot express partial indexes). Apply with `pnpm db:migrate`
(dev) or `pnpm --filter @launchpilot/api db:deploy` (production).

- **Persistent**: `CampaignRun` (status, timestamps, error) and `CampaignEvent` (ordered by `sequence`).
- **In memory only**: the live Mozaik state (`FactoryRuntimeState`: boards, findings, recent events). It is **not**
  restored after a restart.
- Run status: `RUNNING → COMPLETED | FAILED | CANCELLED | INTERRUPTED`.

### Run lifecycle and reliability

| Situation | Result |
|---|---|
| Normal | `COMPLETED` |
| Runtime fails to initialize | `FAILED` with message; project stays usable |
| Participant throws | `factory.failed` → `FAILED` |
| Participant never answers | `FAILED` after the timeout (15 s) |
| `POST /runs/:id/cancel` | pending timers cleared, `factory.cancelled`, `CANCELLED`, nothing recorded afterwards |
| Graceful shutdown (SIGTERM, `app.close()`) | active runs stopped, recorded as `INTERRUPTED` (`factory.cancelled`, reason `server_shutdown`), history flushed, then the DB connection closes |
| Crash / hard kill / restart | on boot, leftover `RUNNING` rows become `INTERRUPTED` with a `factory.failed` event. Runs are **never** falsely resumed |
| Event history could not be saved | run is `FAILED`, never `COMPLETED` |

### BYOK isolation (OpenAI and Gemini only)

- Keys stay in the existing encrypted `ApiCredential` table (AES-256-GCM). Responses return only masked values.
- `MozaikService.prepareInference(userId)` is the single place a key is decrypted for a run. It is keyed by `userId`,
  so one user's key cannot reach another user's run. The smoke test never calls it.
- The key is handed to `startRun({ credentials })`, which builds `buildInferenceRunnerConfig()`: Mozaik endpoints
  constructed with that `apiKey` **inside that run's own runtime**. `process.env` is never read or written, so concurrent
  runs cannot see each other's keys. Without credentials the model list is empty: inference is impossible by construction
  (no fallback to an environment key). No worker process is needed.
- Secrets never go into `FactoryRuntimeState`, events, logs or `CampaignRun`. As defence in depth, `redact()` strips
  key-shaped values and sensitive field names, both in the runtime and again at the database boundary (`EventWriter`).
- Missing key: only workflows that need inference are blocked (HTTP 422 with a clear message).

> **Mozaik Cloud telemetry is OFF by default.** Mozaik core's `runLoop` creates a Mozaik Cloud client that, once it
> finds a project key, streams every loop event (prompts, answers, tool output, full payloads by default) to
> app.jigjoy.ai. The key is picked up from `MOZAIK_API_KEY`, `MOZAIK_PROJECT_KEY`, **a `.env` in the working
> directory, or a paired-device file `~/.mozaik/credentials.json`** (one may already exist on a developer machine).
> `MozaikCampaignRuntime` therefore sets both key variables to an empty string at construction and at every
> `startRun` (`runtime/telemetry.ts`). The SDK resolves keys with `??`, so an empty value wins and none of the file
> fallbacks are read; no library code is modified. To opt in deliberately set `LAUNCHPILOT_MOZAIK_CLOUD=on` plus
> `MOZAIK_API_KEY`; payloads are then redacted to event types only (`MOZAIK_REDACTION=all`) unless you choose another
> level. Tests run the real `cloud-sdk` to prove both the threat and the guard. The smoke test never calls `runLoop`.

## Factory contracts

`packages/agents/src/factory`:

- `phases.ts`: the four phases (`F1_PRODUCT_DISCOVERY`, `F2_MARKETING_AUDIT`, `F3_MARKET_STRATEGY`,
  `F4_CREATIVE_PRODUCTION`) with `PHASE_CONTRACTS` (order, dependencies, owned board, entry/exit event).
- `events.ts`: all event names with typed payloads. **Emitted today** (Product Discovery / F1): `factory.started`, `phase.started`,
  `task.assigned`, `finding.posted`, `task.completed`, `phase.ready`, `crosscheck.answered`, `report.generated`,
  `phase.completed`, `phase.failed`, `factory.completed`, `factory.failed`, `factory.cancelled` (+ `test.acknowledged` for the
  smoke test). **Reserved, nothing emits them yet**: `participant.idle`, `check.passed`, `check.failed`.
- `state.ts`: `FactoryRuntimeState` (extends Mozaik `RuntimeState`): `currentPhase`, `status`, `manifest`, four boards,
  `findings`, capped `events`, timestamps.

### How agents and phases will be connected

1. A future agent package registers participant factories per phase in a `ParticipantRegistry`
   (`registry.register({ phase, name, create })`). A factory receives `{ runId, phase, state }` and returns a Mozaik
   `Participant` that reacts to events such as `phase.started` and posts `finding.posted` to its board.
2. Today only F1 is wired (`runtime/programs/discovery-program.ts`: orchestrator handlers + participants). A general phase runner (not written yet) will, per phase: set `state.currentPhase`, `join()` that phase's participants,
   emit `phase.started`, wait for `phase.ready` / `phase.completed`, `leave()` them, and only then start the next phase
   according to `PHASE_CONTRACTS[...].requires`. `phase.failed` / `check.failed` will end the run via `factory.failed`.
3. Inference-backed runs resolve the user's decrypted key server-side and pass it to `startRun`; agents call `runLoop` and
   use the run's isolated inference runner (`InferenceGateway`).
4. The backend does not change: it still persists whatever events the runtime emits.

## OpenAI BYOK and Product Discovery (text-only MVP)

The first real AI workflow: three Mozaik agents turn the text of a project into a saved, structured, evidence-aware
**Product Discovery report**, using **your own OpenAI API key**. It analyzes only the project's text (description,
intake form, notes). Websites, GitHub repos, social profiles and uploaded files are listed in the report as
"available but not analyzed". Crawling, repo, file and image analysis are future work.

### How OpenAI BYOK works

- **Enter the key** in *Settings > AI providers > OpenAI*. It is encrypted with AES-256-GCM (`APP_ENCRYPTION_KEY`) before it
  is stored; the browser only ever sees a masked value (`sk-••••abcd`). There is no backend-wide OpenAI key and no
  fallback to any environment key. Replacing the key clears its verification.
- **Choose a model** in the same panel. Type any model id your account can use, or press **Load my models** (a free
  `GET /models` call) to fill the suggestion list. LaunchPilot has **no default model**, never picks one, and never
  switches to another or a pricier one. Ids that are obviously not text models (embeddings, audio, image...) are
  hidden from the suggestions unless you tick "Show non-text models".
- **Test connection** makes **one tiny paid call** (about 30 output tokens max) to the chosen model, only when you press it
  and confirm. A failed test clears any earlier "verified" mark. The result shows model, latency and token usage, or a
  fixed safe message for: invalid key, no quota/credit, unavailable model, rate limit, outage. The provider's own error
  text is never shown (it can echo parts of keys). A key that authenticates but cannot call the model reports
  "Your key was accepted, but this model could not be used" and stays **not ready**. *Ready* means: a model is chosen and a
  real test call succeeded for exactly that model.
- Raw keys are decrypted only inside the API process, for one run, and handed to that run's own isolated Mozaik runtime
  (see "BYOK isolation" above). They never enter `process.env`, events, logs, reports or responses.

OpenAI API usage is billed to your OpenAI account and is **separate from any ChatGPT subscription**.

### How Product Discovery runs through Mozaik

Click **Analyze Idea** in a project's Workspace (a confirmation shows the model and limits). Nothing runs on page load,
refresh or in tests that use the real API.

```
factory.started -> phase.started (F1) -> task.assigned x2
   Input Analyzer ─┐ two Mozaik agents, run concurrently, each through Mozaik's agent loop (runLoop)
   Text Analyzer  ─┘   -> finding.posted + task.completed
Evidence Cross-Checker  (deterministic Mozaik participant, no LLM; bounded fan-in barrier)
   -> phase.ready -> crosscheck.answered   (carries both findings + the issues it found)
Product Synthesizer     (Mozaik agent; reads the ACTUAL findings from that event)
   -> task.completed -> report.generated
Orchestrator: saves the report, THEN phase.completed -> factory.completed  (run = COMPLETED)
```

- **Input Analyzer**: category, problem, solution, value proposition, goals, known facts (each with a traceable source),
  missing information, assumptions, confidence.
- **Text Analyzer**: independent deeper read: offerings, customer needs, differentiators, strengths, weaknesses,
  ambiguities, validation questions, messaging opportunities, evidence.
- **Product Synthesizer**: combines both outputs plus the cross-check into the 14-section report (executive summary,
  overview, problem and solution, value proposition, audience hypotheses, features/services, differentiators, strengths,
  weaknesses and risks, missing information, evidence and assumptions, marketing opportunities, next steps,
  follow-up questions), plus contradictions. It never works from the raw input alone.
- **Fan-in, not sleeps:** the cross-checker waits until both analyzers have reported success *or* failure. Every agent
  has a deadline (default 150 s) and the barrier has its own safety deadline, so it always concludes.
- **Partial failure:** if one analyzer fails, the report is still produced from the other and flagged `partial`. If both
  fail, or the synthesizer fails, the run fails and **no report is saved**.
- **No loops:** each agent acts once, reacts to `model.answer` only when it is its own, gets at most one repair attempt for
  malformed JSON, never subscribes to events it emits, and a run that exceeds 600 events is failed.
- Models answer through OpenAI **structured outputs** (strict JSON schema, Responses API) and every answer is validated with
  zod. Output language follows the project's selected language (Serbian is written in natural Serbian Latin).

Implementation notes (verified against the installed Mozaik 4.2.0):

- Mozaik's `runLoop` does not await or catch its loop, so an exception from the inference runner would be an unhandled
  rejection that crashes a Node server. LaunchPilot therefore supplies its own `InferenceRunner` (`ai/gateway.ts`) that
  **never throws**; a provider failure is carried through the loop as a marked assistant message and turned into a normal
  task failure.
- Mozaik's OpenAI mapper sends no `max_output_tokens` and no `store: false`. The gateway adds both (OpenAI is told not to
  retain your text) while still reusing Mozaik's mapper and agent loop.
- Mozaik loop events carry whole prompts and raw provider responses. The history recorder reduces them to small summaries
  (counts and token usage), so prompts and keys are not duplicated into `CampaignEvent`.

### Where reports are stored

`ProductDiscoveryReport` (one per run; reruns **add** a report and never overwrite an older one):
`reportJson` (the validated report) and `metadataJson` (model, token usage, per-agent outcomes, cross-check issues, each
agent's finding, and the exact input snapshot the agents saw). Reports survive page refreshes and backend restarts.
The run's event history stays in `CampaignEvent`.

| Method | Path | Notes |
|---|---|---|
| GET | `/integrations/openai/status` | masked status: configured, model, ready |
| GET | `/integrations/openai/models` | models visible to the key (free); never selects one |
| PUT | `/integrations/openai/model` | `{ "model": "..." }` |
| POST | `/integrations/openai/test` | one tiny paid call; 3 s cooldown against double clicks |
| POST | `/projects/:id/runs/product-discovery` | `{ model?, maxModelCalls? (3-12), maxOutputTokens? (800-8000) }`; 422 without key/model; 409 if a run is active |
| GET | `/projects/:id/reports` | summaries, newest first |
| GET | `/reports/:id` | full report + metadata |

### How to read the evidence labels

| Label | Meaning |
|---|---|
| **Claimed** | You stated it in the input. It is **not** independently verified. Must cite an input field or a verbatim quote. |
| **Inferred** | An AI conclusion derived from what you supplied. |
| **Disputed** | Conflicting information (including disagreements between the two analyzers). |
| **Unknown** | Cannot be determined from the supplied text. |
| **Verified** | Independently checked against an identifiable source. **Nothing can be verified in this version** (no browsing or lookups), so any `verified` label an agent produces is automatically downgraded. |

A deterministic cross-check (code, not an LLM) enforces this: a "claimed" fact whose source cannot be traced to the
supplied text is downgraded to "inferred"; analyzer disagreements (e.g. different business types) are surfaced as
contradictions and disputed evidence even if the model glossed over them. The agents are instructed never to invent
URLs, competitors, numbers, citations, testimonials or market size.

### Token usage and cost controls

- Token counts come from OpenAI's own `usage` field and are shown live (from persisted events) and in the report.
- **No price is shown.** There is no reliable pricing source in the app, and cost is never guessed. Check
  platform.openai.com/usage.
- Per run, LaunchPilot enforces **locally**: a hard cap on model calls (default 6; about 3 are normal; retries and
  repair attempts count), `max_output_tokens` per call (default 3500), at most 2 bounded retries for 429/5xx/network
  errors (never for quota or auth errors), per-call timeout, and cancellation that aborts in-flight requests and blocks
  further calls. Adjust them under "Cost limits".
- These limits are **not** an OpenAI account spending cap. Set a monthly budget/limit in your OpenAI account as well.
- Nothing paid runs on page load, refresh or in automated tests.

### Testing

```powershell
pnpm test:agents    # 47 tests: real Mozaik runtime + agents against a LOCAL FAKE OpenAI HTTP server
pnpm test:api       # 46 e2e tests: HTTP API + PostgreSQL + the same fake server
```

The fake server (`packages/agents/src/testing/fake-openai.ts`) speaks real HTTP, so the Mozaik agent loop, gateway,
mapper, HTTP client, timeouts and aborts all run for real; only OpenAI itself is replaced, so nothing is billed. In tests
the API's OpenAI base URL can be redirected (`LAUNCHPILOT_OPENAI_BASE_URL`), and **only when `NODE_ENV=test`**; it is
ignored otherwise so no stray variable can redirect requests that carry users' keys.
There is no automated test against the real OpenAI API.

### Manual real-API check (opt-in, costs a few cents at most)

1. `pnpm dev`, sign in (`demo@launchpilot.dev` / `demo12345`).
2. *Settings > AI providers > OpenAI*: add **your** key in the UI (never in files or chat). Press **Load my models**, pick a
   low-cost model, **Save model**, then **Test connection**.
3. Open *Deep Diving School* (or run `pnpm --filter @launchpilot/api db:seed:samples` to add an additive software sample,
   "TaskFlow") > Workspace > **Product Discovery** > **Analyze Idea**.
4. Watch the agents, then read the report; refresh the page or restart the API and reopen it.

### Known limitations of Product Discovery

- Text only: no website/GitHub/social/file/image analysis. The report says what was *not* analyzed.
- Nothing can be "verified"; the report is an early hypothesis document, not market research.
- OpenAI only (Gemini keys remain stored but unused here). Runs on the Responses API with structured outputs, so the chosen
  model must support them; if it does not, the test/run reports "model may not support structured output".
- Models with large hidden reasoning can spend output tokens before answering; if a run reports a truncated answer,
  raise "max output tokens" in Cost limits.
- Aborting stops *waiting* and blocks further calls, but OpenAI may still finish and bill a request that was already in
  flight.
- Prices are not shown. Single API instance, in-process runs (see below).
- Future: Web Analyzer, Repo Analyzer, File Analyzer, Visual Analyzer (agents slot in through the participant registry and
  the same event contracts); phases F2 to F4.

## Tests

```powershell
pnpm test:agents    # 47 tests, real Mozaik runtime + real cloud-sdk + fake OpenAI server, no database
pnpm test:api       # 46 e2e tests, needs PostgreSQL on :5433 (fake OpenAI server, no real calls)
```

The API suite creates a separate `launchpilot_test` database next to the dev one (dev data is untouched) and applies the
migrations there. If PostgreSQL is not running it **fails**; nothing is skipped. Under Jest the ESM-only telemetry
package `@mozaik-ai/cloud-sdk` is replaced by a no-op stub (`apps/api/test/stubs`) because Jest cannot load ESM; Mozaik's
runtime and events are real.

## Architecture notes (phase 1)

- The browser only calls `/api/*` on the Next origin; `next.config.mjs` proxies it to Nest, so the session cookie is first-party.
- Every API route requires a session unless marked `@Public()`. All project data is scoped to the owner (others get 404).
- **BYOK:** keys are encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY`; only masked values are returned.
- **Uploads:** `StorageDriver` abstraction with a local-disk implementation (`apps/api/uploads`), served through an authenticated endpoint. Swap in an S3 driver in `StorageModule` later.
- **Integrations:** catalog in `integrations/provider-catalog.ts`; OAuth providers go through `connectors.ts` (placeholder connector).

## Known limitations / placeholders

- Only Product Discovery (F1, text-only) exists. No phase runner for F2 to F4, no campaign generation; "Run campaign" stays disabled.
- Single API instance assumed: the startup sweep marks every `RUNNING` row `INTERRUPTED`. Multiple instances would need
  an owner/heartbeat column first. Runs are executed in-process (no job queue, no separate worker).
- The live Mozaik state is not persisted or restored; interrupted runs are reported as interrupted, not resumed.
- A hard kill (Windows `Stop-Process`, `kill -9`) skips graceful shutdown; the run is repaired on the next boot instead.
- The event timeline in the UI shows the first 200 events and polls once per second while a run is active.
- Real OAuth (Google, Meta, X, GitHub…), API key live validation, scheduled publishing, billing, dark theme, avatar upload.
