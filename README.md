# LaunchPilot — AI Marketing Factory

Phase 1: the full product shell (auth, projects, intake, integrations, BYOK settings, uploads, workspace placeholder).
Phase 2 (this milestone): the **Mozaik runtime is integrated with NestJS** and proven end to end by an
infrastructure smoke test. **There are still no marketing agents** and no campaign generation.

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

## Factory contracts (declared, not executed)

`packages/agents/src/factory`:

- `phases.ts`: the four phases (`F1_PRODUCT_DISCOVERY`, `F2_MARKETING_AUDIT`, `F3_MARKET_STRATEGY`,
  `F4_CREATIVE_PRODUCTION`) with `PHASE_CONTRACTS` (order, dependencies, owned board, entry/exit event).
- `events.ts`: every planned event name. **Implemented now**: `factory.started`, `test.acknowledged` (infrastructure only),
  `factory.completed`, `factory.failed`, `factory.cancelled`. **Planned, names reserved**: `phase.started`, `phase.ready`,
  `phase.completed`, `phase.failed`, `finding.posted`, `crosscheck.answered`, `participant.idle`, `task.assigned`,
  `task.completed`, `check.passed`, `check.failed`.
- `state.ts`: `FactoryRuntimeState` (extends Mozaik `RuntimeState`): `currentPhase`, `status`, `manifest`, four boards,
  `findings`, capped `events`, timestamps.

### How agents and phases will be connected

1. A future agent package registers participant factories per phase in a `ParticipantRegistry`
   (`registry.register({ phase, name, create })`). A factory receives `{ runId, phase, state }` and returns a Mozaik
   `Participant` that reacts to events such as `phase.started` and posts `finding.posted` to its board.
2. A phase runner (not written yet) will, per phase: set `state.currentPhase`, `join()` that phase's participants,
   emit `phase.started`, wait for `phase.ready` / `phase.completed`, `leave()` them, and only then start the next phase
   according to `PHASE_CONTRACTS[...].requires`. `phase.failed` / `check.failed` will end the run via `factory.failed`.
3. Inference-backed runs call `prepareInference(userId)` and pass the credentials to `startRun`; agents call
   `runLoop` and use the run's isolated inference runner.
4. The backend does not change: it still persists whatever events the runtime emits.

## Tests

```powershell
pnpm test:agents    # 25 tests, real Mozaik runtime + real cloud-sdk, no database
pnpm test:api       # 21 e2e tests, needs PostgreSQL on :5433
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

- No marketing agents, no phase runner, no campaign generation. "Run campaign" stays disabled.
- Single API instance assumed: the startup sweep marks every `RUNNING` row `INTERRUPTED`. Multiple instances would need
  an owner/heartbeat column first. Runs are executed in-process (no job queue, no separate worker).
- The live Mozaik state is not persisted or restored; interrupted runs are reported as interrupted, not resumed.
- A hard kill (Windows `Stop-Process`, `kill -9`) skips graceful shutdown; the run is repaired on the next boot instead.
- The event timeline in the UI shows the first 200 events and polls once per second while a run is active.
- Real OAuth (Google, Meta, X, GitHub…), API key live validation, scheduled publishing, billing, dark theme, avatar upload.
