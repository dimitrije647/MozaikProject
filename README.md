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

## OpenAI BYOK and Product Discovery (F1, seven agents)

The first real AI workflow: up to seven Mozaik agents turn your project (text, website, public GitHub repository, uploaded
documents and images) into a saved, structured, evidence-aware **Product Discovery report** and a **Product Manifest**,
using **your own OpenAI API key**. Agents activate only for sources that exist; the others are skipped with a reason.

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

### How Product Discovery (F1) runs through Mozaik

Click **Analyze Idea** in a project's Workspace (a confirmation shows the model and limits). Nothing runs on page load,
refresh or in tests that use the real API.

**Seven real Mozaik participants** (all created through `createAgent`, registered in the participant registry):

| # | Agent | Source | Tool (deterministic, no AI) | Activated when |
|---|---|---|---|---|
| A1 | Input Analyzer | intake form, description, notes | none | always |
| A2 | Text Analyzer | the same text, read independently | none | always |
| A3 | Web Analyzer | your website (homepage + a few relevant same-site pages) and, if configured, a search provider | `WebFetchTool`, `WebSearchTool` | a website URL is set |
| A4 | Repo Analyzer | README, manifests and structure of a **public** GitHub repository | `GitHubRepositoryTool` (official REST API only) | a GitHub URL is set |
| A5 | File Analyzer | uploaded PDF / DOCX / TXT / Markdown / JSON / CSV | `DocumentExtractionTool` (local parsers) | documents are uploaded |
| A6 | Visual Analyzer | uploaded images (vision on **your** OpenAI model) | `ImagePreparationTool` (resize, EXIF strip, measured palette) | images are uploaded |
| A7 | Product Synthesizer | the findings and cross-check outcomes of all the others | none | always |

A deterministic **Phase Coordinator** (a Mozaik agent without an LLM, so it costs nothing) plans which agents run, waits at
bounded fan-in barriers and pairs reviewers. A text-only idea runs A1, A2 and A7; the other four are **skipped, not failed**,
and the report lists why.

```
factory.started -> phase.started (plan: activated + skipped with reasons)
  task.assigned -> source.retrieved (tools) -> finding.posted -> task.completed     (A1..A6 concurrently)
  barrier 1 (every activated analyst reported success, failure or timeout)
  crosscheck.requested -> crosscheck.answered     (a DIFFERENT agent reviews selected claims, same conversation memory)
  barrier 2 (answers or the review deadline)
  phase.ready -> A7 reads the board -> report.generated
Orchestrator saves the report, THEN phase.completed -> factory.completed  (run = COMPLETED)
```

- **Real collaboration:** findings travel as Mozaik `SemanticEvent`s, every participant sees them, and the shared
  `FactoryRuntimeState` F1 board has a single writer. A reviewer is always a different agent than the producer
  (`input<->text`, `web->input/text`, `repo->text/input`, `files->input/text`, `visual->web/text/input`) and answers with
  its own earlier analysis in its context. Disagreements become `disputed` findings and report contradictions in code,
  whatever the model wrote.
- **Fan-in, not sleeps:** barriers conclude when all expected participants have reported, or at a deadline.
- **Partial failure:** a failed or timed-out analyst makes the report `partial`; the others continue. If all analysts fail or the
  synthesizer fails, the run fails and **no report is saved**. A skipped agent never makes a report partial.
- **No loops or storms:** each agent acts per assigned job, repairs malformed JSON at most once, never subscribes to events it
  emits, and a run above 600 events fails.
- Models answer through OpenAI **structured outputs** (Responses API, strict JSON schema), validated with zod. The report
  language follows the project language (Serbian is written in natural Serbian Latin).

### Evidence classes and provenance

| Label | Meaning |
|---|---|
| **Verified** | Confirmed by a **live** website page or repository file retrieved in this run, with a verbatim excerpt found in the stored source text. Only A3/A4 can produce it. |
| **Claimed** | A statement you or your documents made. Must cite an intake field or a verbatim quote. Never upgraded to verified. |
| **Inferred** | An AI conclusion drawn from the evidence (all visual findings are at most inferred). |
| **Disputed** | Another agent contradicted it in a cross-check, or sources conflict. |
| **Unknown** | Cannot be determined from what was supplied. |

Every finding carries its id, producer agent, source (type, URL or file reference, locator), a verbatim excerpt,
confidence, cross-check status and timestamp. Sources are marked **live**, **unavailable** or **fixture**; fixtures (test
data) can never be `verified`. A coded policy (`discovery/f1/policy.ts`) downgrades anything the model over-claims, empties
sections of agents that never ran, caps report statements at the strength of the findings they cite, and sets the manifest
palette from measured pixels, not from the model.

### Tools and security

- **Web:** http/https only, ports 80/443, no credentials in URLs, blocks localhost, private, link-local, multicast, cloud
  metadata and IPv6 equivalents (including mapped/NAT64/6to4), DNS resolution validated and **re-validated at connect time**
  (DNS rebinding), every redirect validated, robots.txt respected, size, content-type, timeout, redirect and page limits,
  per-run cache. Fetched content is **untrusted data**: scripts and hidden elements are dropped, instruction-like text is
  flagged, prompts delimit it and tell the agents never to follow it. A page cannot make LaunchPilot fetch other URLs.
- **Search:** optional. `TAVILY_API_KEY` (preferred) or `BRAVE_SEARCH_API_KEY` in `.env`. Results are leads, never verified.
  LaunchPilot never scrapes Google and never falls back to a paid service. Without a key the report says that no web search
  was done. (The Brave adapter follows the documented API but has not been exercised against the live service.)
- **GitHub:** official REST API, `GET` only, no clone, no code execution. `GITHUB_TOKEN` is optional (raises the rate limit
  from 60 to 5000/hour). Rate limits are reported, not retried. Private repositories are not supported.
- **Documents:** PDF parsed in an isolated worker thread (memory and time limits, JavaScript/eval disabled), DOCX text only
  (macros detected and reported, never executed), size/page/character limits.
- **Images:** resized to at most 1024 px, converted to JPEG, metadata removed, SVG refused. The model is told not to identify
  people.
- Keys are never written to events, boards, reports, logs or prompts; the OpenAI key exists only in the HTTP client.

### Where reports are stored

`ProductDiscoveryReport` (one per run; reruns **add** a report and never overwrite an older one): `reportJson` (the validated
v2 report: 17 sections plus the **Product Manifest**; sections that do not apply are omitted) and `metadataJson` (model, usage
per agent, activation plan, participants, sources, findings with provenance, cross-checks, policy corrections, input
snapshot). Reports from the earlier text-only version (`schemaVersion` 1) still open. The run's event history stays in
`CampaignEvent`.

| Method | Path | Notes |
|---|---|---|
| GET | `/integrations/openai/status` | masked status: configured, model, ready |
| GET | `/integrations/openai/models` | models visible to the key (free); never selects one |
| PUT | `/integrations/openai/model` | `{ "model": "..." }` |
| POST | `/integrations/openai/test` | one tiny paid call; 3 s cooldown against double clicks |
| POST | `/projects/:id/runs/product-discovery` | `{ model?, maxModelCalls? (3-40), maxReviews? (0-8), maxOutputTokens? (800-8000) }`; 422 without key/model; 409 if a run is active |
| GET | `/runs/:id/analysis` | activation plan, agents, sources, findings, cross-checks, usage per agent (works while running) |
| GET | `/runs/:id/events`, POST `/runs/:id/cancel` | persisted event history, cancellation |
| GET | `/projects/:id/reports` | summaries, newest first (previous analyses stay available) |
| GET | `/reports/:id` | full report + metadata |

All of them require a session and return 404 for other users' resources.

The Workspace has tabs **Overview** (plan, skipped agents with reasons, source retrieval status), **Agents** (state, AI calls and
tokens per agent, findings, events), **Evidence** (filter by class, agent, text), **Cross-Checks** and **Report**, all read
from the persisted run, plus a selector for previous analyses. The infrastructure smoke test stays a separate panel.

### Token usage and cost controls

- Token counts come from OpenAI's `usage` field and are shown per agent and in total. **No price is shown**: there is no
  trustworthy pricing source in the app, and cost is never guessed. Check platform.openai.com/usage.
- Per run, enforced **locally**: a hard cap on model calls (default 16: roughly one per analyst, up to 4 reviews, one
  synthesis, plus repairs/retries), `max_output_tokens` (analysts 3000, reviews up to 1800, synthesis up to double),
  bounded retries (429/5xx/network only, never for quota/auth), per-call, per-agent and per-run timeouts, and
  cancellation that aborts requests and tools. When the budget is tight, cross-checks are dropped first, never the
  synthesis. No run starts automatically.
- These limits are **not** an OpenAI account spending cap. Set a budget in your OpenAI account too.
- Failure handling: unreachable site, robots.txt disallow, GitHub rate limit or missing repo, unreadable/scanned PDF,
  oversized files, search provider unavailable, missing key, quota or rate limit all produce a specific, safe message and a
  partial report where possible; none leak keys or provider text.

### Testing

```powershell
pnpm test:agents    # tools (SSRF, fetch, GitHub, documents, images, SEO, PageSpeed, YouTube) + F1, F2 and F3 end to end + runtime/provider tests
pnpm test:api       # e2e: HTTP API + PostgreSQL + the same fakes
```

The F1 tests run the **real Mozaik runtime and participants** against local fake HTTP servers for OpenAI, a website, the
GitHub API and Tavily (`packages/agents/src/testing/`). Everything those servers return is a **fixture**: sources are marked
`fixture` and are never counted as real-world evidence. There is no automated test against real OpenAI, GitHub or Tavily; in
tests the OpenAI base URL can be redirected (`LAUNCHPILOT_OPENAI_BASE_URL`) **only when `NODE_ENV=test`**.

### Manual test steps (uses your own keys; a few cents of OpenAI credit)

1. `pnpm dev`, sign in (`demo@launchpilot.dev` / `demo12345`).
2. *Settings > AI providers > OpenAI*: add **your** key in the UI (never in files or chat), **Load my models**, choose a
   model (e.g. `gpt-4.1-mini`), **Save model**, **Test connection**. Optionally put `TAVILY_API_KEY` / `GITHUB_TOKEN` in `.env`
   and restart the API.
3. **Demo A, Deep Diving School** (seed project): set its website to a real public site you control or a real dive-school
   site, upload a small PDF brochure and a logo image, then Workspace > Product Discovery > **Analyze Idea**.
4. **Demo B, software product:** `pnpm --filter @launchpilot/api db:seed:samples` adds the additive "TaskFlow" project; set its
   GitHub URL to a **real public repository** you choose (the seed value is a placeholder) and analyze it.
5. Open the tabs: Overview (which agents ran or were skipped and why), Agents (tokens per agent), Evidence (provenance),
   Cross-Checks, Report. Refresh or restart the API and reopen the analysis; run again and pick the older one in the selector.

Placeholder `.example` URLs are never live sources: they fail to resolve and are recorded as unavailable.

### Known limitations of Product Discovery

- Social profiles are listed but not read (no scraping of networks; official APIs are future work). Google is never scraped.
- Pages that need JavaScript to render are read as served (no headless browser). Scanned PDFs need OCR, which is not included.
- Private repositories and non-GitHub hosts are not supported. Only the first few pages, files and images are analyzed (limits
  are shown in the Overview as "not analyzed").
- OpenAI only (Gemini keys remain stored but unused here); the chosen model must support structured outputs, and vision for
  images. Models with large hidden reasoning can exhaust output tokens: raise "max output tokens" in Cost limits.
- "Verified" means checked against a live source in this run, not independently fact-checked in the world; the report is an
  early hypothesis document, not market research.
- Aborting stops waiting and blocks further calls, but OpenAI may still bill a request already in flight.
- Single API instance, in-process runs. Prices are not shown.
- Future: phases F2 to F4.

## F2 Marketing Audit (six agents)

F2 is a **diagnostic** of the CURRENT marketing state of a business, built on one completed F1 Product Discovery report.
It does not write ads, campaign strategy, creative or calendars (that is F3/F4). It runs in the same Mozaik runtime, with the
same event protocol, shared-board pattern, evidence classes, cross-check protocol, BYOK isolation, cancellation and timeouts as F1.

### The six agents

| # | Agent | Audits | Tools (deterministic, no AI) | Activated when |
|---|---|---|---|---|
| A8 | SEO Auditor | title, meta description, headings, canonical, robots meta/robots.txt, sitemap, viewport, structured data, alt text, bounded broken-internal-link scan, optional PageSpeed | `auditSite` (SSRF-safe `WebFetchTool` from F1), `PageSpeedTool` | a valid website URL |
| A9 | Social Media Auditor | supplied social profiles, only from official APIs, user-typed details, user exports/screenshots | `YouTubeTool`, `parseSocialUrl`, `DocumentExtractionTool` | social profiles or details supplied |
| A10 | Brand Auditor | brand coherence: F1 visual evidence (reused), website-declared colors/fonts/logo, tone, stated vs. actual identity | the page inspector, `ImagePreparationTool` (only if F1 has no visual analysis) | any brand material exists |
| A11 | Messaging Auditor | clarity, headline, consistency with the Product Manifest, CTA, hierarchy, trust, claims that need evidence | the page inspector | always |
| A12 | Presence Auditor | cross-channel consistency and completeness: website vs. supplied URLs, contact, trust signals | `checkPresence` | always (no model call when there is nothing to compare) |
| A13 | Audit Synthesizer | consolidates the five audits into the report | none | always |

An **Audit Coordinator** (a deterministic Mozaik agent, no model) plans activation, fans out `task.assigned`, is the single
writer of the F2 board (`FactoryRuntimeState.f2`), waits at bounded fan-in barriers, pairs reviewers, and emits `phase.ready`.

```
factory.started -> phase.started (plan: activated + skipped with reasons)
  task.assigned -> source.retrieved (shared website collection, owned by the SEO Auditor) -> finding.posted -> task.completed   (A8..A12 concurrently)
  barrier 1 (every activated auditor reported success, failure, skip or timeout)
  crosscheck.requested -> crosscheck.answered   (a DIFFERENT auditor reviews selected claims, answering from its own earlier analysis)
  barrier 2 (answers or the review deadline) -> phase.ready -> A13 reads the board -> audit.completed
Orchestrator saves the report, THEN phase.completed -> factory.completed
```

Cross-check pairs: SEO -> Messaging (e.g. a missing page description vs. how the page communicates), Messaging -> Brand (wording
vs. identity), Social -> Presence (profile description vs. cross-channel identity), Brand -> Messaging, Presence -> Social/SEO.
Reviews are capped (`maxReviews`, default 4, one request per producer, at most 3 claims) and are the first thing dropped when the
model-call budget is tight. An auditor that made no model call (deterministic result) cannot review. Every review logs the original
finding, its author, the reviewer, the reviewer's response and the final classification.

### How F1 results reach F2

The backend loads the selected (default: newest completed, schema v2) `ProductDiscoveryReport`, validates it and builds an
`F1Context` (Product Manifest, findings with provenance, sources, measured palette). The exact report id travels with the run and
is stored on the audit (`MarketingAuditReport.f1ReportId`, shown in the report and in `GET /audits/:id`). F1 findings are referenced by
id (`sourceType f1_finding`) and an F2 finding can never be stronger than the F1 finding it cites. F1's visual analysis is reused;
images are viewed again only when F1 had none. With no completed F1 report, `POST .../marketing-audit` answers 422 and nothing runs.
F2 audits what exists NOW (current website, profiles and uploads); F1 only supplies the product understanding.

### Evidence rules (enforced in code, `audit/policy.ts`)

* **verified** = an *observation* of a measurable property of a **live** source retrieved in this run (a page's title, a missing tag,
  an API number) with a verbatim excerpt. It never certifies that a claim on a page is true: *"the site says 10,000 customers"* is a
  `claim_on_source`, at most **claimed**. Judgments are at most **inferred**.
* Fixtures, user-typed data and exports are never verified. Every source carries an origin: `public_page`, `live_api`, `user_provided`,
  `export`, `fixture`, `previous_phase`. Reports show them.
* Report statements are capped by the strongest finding they cite; severities cannot exceed their cited findings; disputed findings are
  always added to the contradictions; measured sections (website health, per-platform access, channels, limitations, evidence
  appendix, product context) are filled by code from tool results, never by the model.
* No indexing/ranking claims (Search Console is not connected), no invented scores or social metrics. Missing data is reported as
  missing, never as a weakness. "Not supplied", "unavailable / unverified", "not found" and "confirmed absent" stay distinct.

### External APIs

| Tool | Official API | Needs | Without it |
|---|---|---|---|
| Website / SEO | the site itself, through the F1 SSRF-safe fetcher (robots.txt respected, bounded) | nothing | n/a |
| PageSpeed Insights | `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed` (Lighthouse lab data, single run) | `PAGESPEED_API_KEY` (+ the API enabled in Google Cloud) | **not called**; performance reported as unavailable. A quota error is reported, never retried. |
| YouTube | YouTube Data API v3 `channels` + `playlistItems` (subscribers may be hidden by the owner) | `YOUTUBE_API_KEY` | no live YouTube data; user-provided details still work |
| Instagram, Facebook, LinkedIn, X, TikTok, Pinterest, Reddit | **no live adapter** (their official APIs need an authorized app and account tokens LaunchPilot does not hold; public pages are not scraped) | n/a | metrics reported as unavailable; use typed details, an export or a screenshot |

Keys stay on the server, travel only in requests to that provider and are never logged, stored in events/reports or sent to the model.
A basic audit needs none of them (nor Tavily, Brave or Meta credentials).

### Database, API and UI

One additive migration (`20261101090000_marketing_audit`): table `MarketingAuditReport` (`reportJson`, `metadataJson`, `f1ReportId`,
one row per run; reruns add rows, nothing is overwritten). `CampaignRun`/`CampaignEvent` are reused (`mode = marketing_audit`).

| Method | Path | Notes |
|---|---|---|
| POST | `/projects/:id/runs/marketing-audit` | `{ f1ReportId?, model?, maxModelCalls? (3-30), maxReviews? (0-8), maxOutputTokens? (800-6000), socialDetails? }`; 422 without an F1 report/key/model; 409 if a run is active |
| GET | `/projects/:id/audits?limit=&cursor=` | summaries, newest first, cursor pagination |
| GET | `/audits/:id` | full report + metadata (404 for other users) |
| GET | `/runs/:id/analysis` | same endpoint as F1: plan, agents, sources (with origin), findings, cross-checks, usage per agent |

The Workspace has a **Marketing Audit** card below Product Discovery with the F1 prerequisite state, a report selector, the start
button and cost limits, and tabs **Overview** (plan, skipped agents with reasons, sources with access type, limitations), **Agents**
(state, AI calls and tokens per agent), **Findings** (filter by area/severity/class), **Cross-Checks** and **Report** (15 sections),
plus a selector for previous audits. All of it is read from the persisted run.

### Cost controls

Explicit click only; hard cap on model calls (default 14, typical audit 8-10), `max_output_tokens` (auditors 2500, reviews up to 1500,
synthesis up to double), bounded retries, per-agent/per-run timeouts, cancellation that aborts requests, compact contexts (each
auditor sees only its own slice of the shared page data), F1 evidence reused, no image generation, vision only when necessary.
Agents with nothing to analyze (e.g. social profiles without data) make **no** model call. Token usage is measured and shown per agent;
no price is displayed (no trustworthy pricing source).

### Manual test (uses your own keys)

1. `pnpm dev`; sign in; configure your OpenAI key and model (Settings > AI providers); optional: `PAGESPEED_API_KEY` / `YOUTUBE_API_KEY` in `.env`, restart the API.
2. **Deep Diving School:** set a real website URL and social URLs in its intake, run **Product Discovery** (Analyze Idea), then **Marketing Audit > Start**.
3. **TaskFlow:** same, with a real website URL. Social profiles are optional.
4. Check **Overview** (skipped agents and why; sources show `live`/`user provided`/`FIXTURE`), **Findings**, **Cross-Checks**, **Report**; reload or restart the API and reopen the audit.

### Limitations

* Only YouTube has a live social adapter. No Meta/LinkedIn/X/TikTok data without your own authorized integration.
* Pages that need JavaScript are read as served (no headless browser); the crawl is bounded (default 5 pages + 8 link checks).
* No Search Console: nothing is claimed about indexing or rankings. PageSpeed is a single lab run.
* The audit uses a single model and is only as good as the F1 report beneath it.

## F3 Market Research & Strategy (five base roles + dynamic Channel Scouts)

F3 turns the product understanding (F1) and the audit of the current marketing (F2) into a **campaign strategy** and a
machine-readable **creative brief** for the next phase. It does not write ads, copy or images. It runs in the same Mozaik
runtime, with the same event protocol, shared-board pattern, evidence classes, cross-check protocol, BYOK isolation, cancellation
and timeouts as F1 and F2.

### The roles

| # | Agent | Does | Tools (deterministic, no AI) |
|---|---|---|---|
| A14 | Audience Researcher | customer segments (B2B/B2C), needs, pain points, motivations, barriers, decision process, product fit. **Hypotheses** unless evidenced. | none (F1/F2 context) |
| A15 | Competitor Researcher | real competitors from retrieved pages and search leads; positioning, offerings, crowded themes. Existence is **confirmed only if the competitor's own page was retrieved**. | `competitorQueries`/`pickCandidates`, SSRF-safe `WebFetchTool`, Tavily/Brave search |
| A16 | **Channel Scouts** (dynamic) | one participant per relevant channel: audience fit, organic vs. paid, content types, complexity, constraints, measurement, risks, role | none (context only) |
| A17 | Seasonal Intelligence | public holidays from a calendar, recurring-pattern hypotheses, user events; lead times | `HolidayTool` (Nager.Date, free, no key) |
| A18 | Campaign Strategist | the strategy, with the reasons and the finding ids behind every recommendation, plus the F4 creative brief | none |

A deterministic **Strategy Coordinator** (a Mozaik agent, no model) plans, waits at bounded fan-in barriers, registers scouts,
pairs reviewers, and is the single writer of the F3 board (`FactoryRuntimeState.f3`).

### Dynamic Channel Scouts (genuine Mozaik dynamic registration)

```
phase.started -> task.assigned x3  (Audience, Competitor, Seasonal run concurrently)
  barrier 1 (all three reported)
  Coordinator evaluates 9 channels with transparent rules (strategy/scouts.ts), then for each SELECTED channel:
      createAgent(...)  ->  runtime.join(participant)   (Mozaik emits participant.joined with a NEW id)
                        ->  participant.registered { agent, channel, score, ruleHits, reason }
  for each NOT selected channel:  participant.idle { agent, skipped, reason, score, ruleHits }
  task.assigned -> the scouts work concurrently, each with its own memory and instruction
  barrier 2 (all scouts reported or timed out)
  crosscheck.requested / crosscheck.answered   (different participants, bounded)
  barrier 3 -> phase.ready -> Campaign Strategist -> strategy.completed
Orchestrator saves the report, THEN phase.completed -> factory.completed
```

`ActiveRun.join()` calls the live Mozaik runtime's `join`, the same API used at start-up; the scouts do not exist before the
research ends. The rules (examples: LinkedIn needs a business audience or a professional business type; TikTok needs a consumer
audience with a visual offer or a supplied profile; Google Search wants a website or local intent) score each channel; the
threshold is 4 and the cap is `maxScouts` (default 4, hard maximum 6, also limited by the model-call budget). Every decision,
selected or not, is recorded with the rules that fired, shown in the UI and stored in the report. The rules choose WHICH
specialists to spend model calls on; they make no claim about what works on a channel.

### Cross-checks between different participants

* Audience Researcher → the scout that fits the segments (a B2B segment goes to the LinkedIn Scout): *does this channel really reach these people?*
* Seasonal Intelligence → a scout: *do your formats and lead times fit this window?*
* Best-fit scout ↔ next scout: disagreements between channels are recorded, not hidden.
* Competitor Researcher → Audience Researcher: *does this positioning match what the segments need?*

Reviewers answer from their own earlier analysis, only participants that made a model call can review, requests are
deduplicated and capped (`maxReviews`, default 6). A disputed claim stays `disputed`, appears in the report's **disagreements**
as unresolved, and the strategist must state each side and its resolution. A theme that competitors share
(`crowdedTheme`) can never be presented as a unique advantage: the policy adds a caveat and caps its evidence class.

### Data flow F1 → F2 → F3

You pick an F2 audit (default: the newest completed). The backend resolves **the F1 report that audit was built on** and
refuses anything inconsistent (an audit of another project, a report from a different project, an old v1 report). The exact
ids and ages travel with the run; `MarketingStrategyReport` stores `f1ReportId` and `f2AuditId`. F3 does not re-run F1 or F2.
An audit older than 30 days is shown with its age, a limitation is added and its "verified" observations are not carried
forward as verified.

### Evidence rules (`strategy/policy.ts`)

* `verified` only for an observation of a live source retrieved in this run (a competitor page's wording, a holiday line from the
  calendar) with a verbatim excerpt. Audience segments, channel fit and seasonal demand are always hypotheses (`inferred`).
  Search results are leads; fixtures, user text and model knowledge are never verified.
* A competitor is `confirmed` only if a page of it was retrieved; a holiday date is attributed to the calendar only if the calendar
  was queried; unsupported **money, percentage and ROI/CPC/CPM figures are removed** from findings and from the strategy.
* A recommended channel must have been evaluated by a scout and cannot outrank that scout (`weak` fit is at most a test,
  `unsuitable` is dropped).
* The creative brief's identity, palette (F1 measured), provenance and "claims to avoid" (unsupported claims flagged by F2) are
  filled by code, not by a model.

### Research tools and keys

| Tool | Needs | Without it |
|---|---|---|
| Competitor pages | the SSRF-safe fetcher (F1); URLs you supply, or search results | n/a |
| Web search | `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` (optional, official APIs only, never Google scraping) | only URLs you supplied are analyzed; with neither, "insufficient research" is reported and **no competitor is invented** (no model call) |
| Holiday calendar | none (Nager.Date). Used only if the intake's "seasonal calendar" is on (or you choose it in the run options) and one country can be resolved from the geography | seasonal analysis is limited to labeled hypotheses |

At most 3 searches and 4 competitor pages per run (configurable lower). All fetched content is untrusted data.

### Database, API and UI

One additive migration (`20261102090000_market_strategy`): table `MarketingStrategyReport` (`reportJson` incl. the creative brief,
`metadataJson` incl. the scout decisions, `f1ReportId`, `f2AuditId`). `CampaignRun`/`CampaignEvent` are reused (`mode = market_strategy`).

| Method | Path | Notes |
|---|---|---|
| POST | `/projects/:id/runs/market-strategy` | `{ auditId?, model?, maxModelCalls? (6-40), maxScouts? (0-6), maxReviews? (0-10), maxOutputTokens?, competitorUrls? (≤5), goal?, budgetNote?, useHolidayCalendar? }`; 422 without F1/F2/key/model; 409 if a run is active |
| GET | `/projects/:id/strategies?limit=&cursor=` | summaries, newest first |
| GET | `/strategies/:id` | full report + metadata (404 for other users) |
| GET | `/runs/:id/strategy-analysis` | plan incl. the dynamically created scouts, scout decisions, participants, sources, findings, cross-checks, usage per agent (also while running) |

The Workspace card **F3 · Market Research & Strategy** shows the F1 → F2 prerequisite chain, the selected audit, cost limits and
research inputs, and tabs **Overview** (base participants, the Channel Scouts created at run time with their rule hits, those not
created and why, sources with access type), **Agents**, **Audience**, **Competitors**, **Channels**, **Cross-Checks** and
**Strategy** (20 sections, the creative brief with a JSON download).

### Cost controls

Explicit click only. Backend-enforced: model calls (default 24, typical 12-16), scouts (4), cross-checks (6), `max_output_tokens`
(2500 per call, up to 3× for the strategist), bounded retries, per-agent and per-run timeouts, cancellation. When the budget is
tight, scouts are reduced and reviews are dropped before the strategist. A competitor researcher without material makes no
model call. Token usage is measured per agent; no price is shown. These limits are not an OpenAI spending cap.

### Manual test (uses your own keys)

1. Run **Product Discovery** and then **Marketing Audit** on a project (see above); optional: `TAVILY_API_KEY` in `.env`, restart the API.
2. In the F3 card choose the audit, optionally add up to five competitor URLs you know, and press **Start Research & Strategy**.
3. Watch **Overview**: the three researchers run, then *Channel Scouts created at run time* appear (and the channels that were not created, with reasons). The event log highlights `participant.registered`.
4. Read **Audience**, **Competitors**, **Channels**, **Cross-Checks** (who challenged whom) and **Strategy**; download the creative brief JSON.

### Limitations

* Audience, channel fit and seasonality are hypotheses until validated with real data; no market size, reach, CPC/CPM, conversion or ROI is claimed.
* Competitor research is only as good as the pages and search results that could be retrieved (no scraping of search engines or social networks).
* Scout eligibility is rule-based and simple; it can be wrong for unusual businesses (raise or lower the cap, or review the rule hits).
* One model for all participants; strategy quality depends on the F1/F2 reports beneath it.

## F4 Creative Production (six agents, images through your own key)

F4 turns ONE completed F3 strategy (and the exact F1 report and F2 audit it names) into a campaign package: creative
concepts, channel copy, one original base image per concept, every channel format cut from it, landing page content, a
quality review with a bounded repair loop, and a downloadable ZIP. It runs on the same Mozaik runtime, event protocol
and evidence rules as F1 to F3 (`packages/agents/src/creative`, `runtime/programs/f4*`).

### The six agents

| Code | Participant | Model calls | What it does |
| --- | --- | --- | --- |
| A19 | Copywriter | text | Concepts (angle, key message, audience, CTA, visual idea) and channel copy with typed claims (`brief`/`f1`/`f2`/`f3`/`user`/`hypothesis`). Near-identical variants and channels you did not select are dropped. |
| A20 | Visual Creator | text + **image** | Plans one picture per concept with the text model, has the Copywriter cross-check the plan, then calls the Images API (`gpt-image-*` only) through your key. No text, logos or UI in the picture. A failed image becomes a brand-colored background, said so. |
| A21 | Layout Designer | none | Deterministic (`sharp` + SVG): cuts each format (Instagram 1080×1080 / 1080×1350, Story 1080×1920, Facebook 1200×628, LinkedIn 1200×627, 16:9) from the base image, never stretches, places headline / supporting line / CTA / your logo in the safe area, measures text fit and contrast, skips formats that would need blurry upscaling. 5 images × 4 formats = 20 assets, **0** extra image calls. |
| A22 | Landing Content Builder | text | Structured landing content (SEO title, hero, benefits, sections, FAQ, trust signals only with support, one CTA objective). Preview = escaped fixed template + strict CSP, shown in a sandboxed iframe, deployed nowhere. |
| A23 | Content & Brand Reviewer | text (+ vision, opt-in) | Deterministic checks first (forbidden claims from the brief, invented figures, promise words, CTA mismatch, wrong dimensions, text overflow, low contrast, missing logo), then one text review per round; vision review only if you allow it. Findings carry id, severity, asset reference, evidence, suggested correction, responsible agent and status. |
| A24 | Fixer | none | **Created at run time** (`participant.registered`) only if blocker/major findings exist. Picks the repair (revise copy / revise landing / re-render layout / regenerate image), asks the owner by `revision.requested`, waits for `revision.applied`, re-renders affected layouts, and reports what it could not fix. Originals are kept as superseded versions. At most 2 repair rounds; regeneration is off unless enabled. |

### Protocol (all real Mozaik events, persisted in `CampaignEvent`)

`copy.proposed` → (Visual Creator starts; `crosscheck.requested` Visual Creator → Copywriter) · `landing.proposed` ·
cross-checks Landing ↔ Copywriter · `visual.generated` → `layout.completed` per concept · bounded fan-in barrier →
`review.requested` → `review.completed` → if needed `participant.registered` (Fixer) → `fix.requested` →
`revision.requested` / `revision.applied` (wave 1 copy, landing, image; wave 2 layouts) → `revision.completed` →
re-review of only what changed → … → `campaign.completed`. The Creative Coordinator is the single writer of the F4
board and makes no model call. Binaries never travel in events or JSON: participants exchange asset ids.

### Data flow, storage and API

* Prerequisite check: the strategy, its audit and its report must all belong to the same project (never mixed).
* `CreativeCampaign` row (created at start, completed with the validated `CampaignPackage` JSON, never overwritten) and
  `CampaignAsset` rows (metadata + storage key) in PostgreSQL; files in project storage, served **only** through
  `GET /campaigns/:id/assets/:assetId/file` (owner, `nosniff`, `no-store`). Deleting the project removes the files.
* `POST /projects/:id/runs/creative-production` (+ `/preflight`, free: only `GET /models`), `GET /projects/:id/campaigns`,
  `GET /campaigns/:id`, `/assets`, `/reviews`, `/landing-preview`, `/export` (ZIP with image binaries, `campaign.json`,
  copy text files, landing content + preview, review, README, manifest with SHA-256), `GET /runs/:id/creative-analysis`.
* UI: the F4 panel in the workspace (Overview, Agents with the recorded timeline, Creative Concepts, Generated Images,
  Channel Formats, Landing Page, Quality Review, Final Campaign) with a mandatory preflight before the start button.

### Cost controls

Separate caps, all enforced locally per run and **not** an OpenAI spending cap: text calls (default 16), original
images (default one per concept, max 10), regenerations (default 0), repair rounds (default 2), vision reviews
(default 0). Nothing runs on page load, startup, tests or restart. The image model must be a `gpt-image-*` id your key
lists; a text model is refused. No price is computed anywhere: only measured tokens and counts are shown.

### Image generation: what is checked, what is recorded, what is never hidden

* **The image model.** The default is `auto`: LaunchPilot reads the model list of *your* key (free) and picks a current
  `gpt-image-*` model, never a shut-down one. An explicit model is accepted only if it is a GPT Image model, is listed and is not
  retired. OpenAI keeps **listing** models it has shut down (`gpt-image-1`, `dall-e-2`, `dall-e-3`), so a listing never proves a
  model works. The plan shows the model that will really be requested and whether it was chosen automatically.
* **Only a request proves a model works.** Settings > AI providers has **Test image model (billed)**: exactly one image request at the
  lowest quality and size, after a confirmation, with a cooldown. The picture is discarded. A shut-down model is refused without any
  request. The result shows OpenAI's HTTP status, error code and (sanitized) message, for example when an organization still needs
  verification for a GPT Image model. API: `POST /integrations/openai/image-test`. Nothing makes this request by itself.
* **Four different numbers.** The plan shows concepts requested, original images the limit permits, image requests planned and
  concepts left to brand-colored backgrounds. With 3 concepts and a limit of 1 you get one request, two concepts marked as skipped
  because of the configured maximum, and a warning. LaunchPilot never raises the limit for you, and regeneration cannot be used to get
  around it.
* **One result per concept, always.** The saved package has `imageResults`: for every concept whether an image was generated, failed
  or skipped, whether a request was made, the stage (`configuration`, `budget`, `planning`, `provider`, `decoding`, `storage`), the
  provider status/code, a one-sentence explanation and whether a brand-colored background stands in. A concept with a stand-in is
  labelled **NOT an AI image** in the Generated images tab and counted in the summary. A failed image makes the run `partial` and a
  failure that hits every concept (wrong key, no permission, unknown model, no credit) stops further image requests.
* **Provider errors.** The provider's status, code, parameter and message are kept (sanitized: keys, bearer tokens and session ids
  are removed, length bounded). The text of an authentication failure is never kept.

### Manual low-cost test (uses your own key)

Settings > AI providers: model `gpt-4.1-mini`. Workspace: with a completed F3 strategy, choose image model
`Automatic` (a current `gpt-image-*` model your key lists; `gpt-image-1` was shut down by OpenAI on 2026-10-23 and is refused), quality `low`, 1 concept, 1 channel, landing page on, max text calls 12, regeneration off, press
**Preflight** (free), read the counts (1 image request, ~5 text calls), then **Start**. Expect one image, four layouts,
a review and a package; the Agents tab shows the real events. Then scale to 2 to 3 concepts.

### Workspace stage cards (persisted state)

The five cards and the hero strip on the workspace page, and the F1 to F4 badges on the dashboard, projects list and project
page, are read from `GET /projects/:id/pipeline` (and the light `pipeline` summary on `GET /projects`). The state is derived
only from stored `CampaignRun` rows and the saved report, audit, strategy and campaign: **completed** needs a saved result,
**running / failed / cancelled / interrupted** mirror the newest run, **not started** means the prerequisite result exists, and
**waiting** names the missing earlier phase. A failed rerun never hides an earlier completed result (both are shown), and a
result built on an older upstream result is marked as such. The project's own `Ready` / `Draft` label is a user setting and is
not changed by runs.

### Limitations

* Images come only from GPT Image models; DALL·E uses a different contract and is not offered.
* Layouts use system fonts and a fixed template; they are solid, not art-directed.
* The deterministic checks are word-based; the model review judges meaning. Vision review is opt-in and budgeted.
* A repair the owner cannot make (or a rejected picture with regeneration off) stays visible as unresolved.

## Run campaign: the full factory (F1 → F2 → F3 → F4 in one go)

The **Run campaign** button (workspace, or `/projects/:id/campaign`) runs the four phases in order through ONE deterministic
orchestrator (`apps/api/src/mozaik/factory.service.ts`). It does not replace anything: it calls the existing phase services, so
each phase keeps its own Mozaik runtime, participants, cross-checks, dynamic Channel Scouts / Fixer, events and persistence.

* **Plan first (free).** `POST /projects/:id/factory/preflight` shows which phases are reused (from exactly which saved result) and
  which run, the models, every limit, the expected counts and the warnings. It makes no paid request (only `GET /models`).
* **Continue (default) or fresh.** *Continue* reuses ONE coherent chain of completed reports (F4 ← that F3 ← that F2 ← that F1,
  all from this project, all saved), not the newest report of each kind, and runs only what is missing. *Fresh* runs every phase.
  Partial reports are reused only with a visible flag (switchable); older F1 reports without a Product Manifest are never reused;
  a complete chain has "nothing to run"; a new creative round is an explicit option.
* **State is persisted** (`FactoryRun`, additive migration `20261104090000_factory_run`): status, current phase, the four phase
  states (pending / reused / running / completed / failed / cancelled / skipped), child run ids, saved result ids, the settings
  snapshot (never credentials), warnings and the final campaign id. A refresh shows the same run; a restart marks an active run
  **interrupted** and never resumes or repeats a paid request. One active run per project (partial unique index); a phase started
  by hand is refused while it runs.
* **Reliable sequencing.** The orchestrator waits for each phase's own completion (its persisted terminal status and saved result),
  resolves the new result id, and starts the next phase from it. A failed, cancelled or interrupted phase stops the run; nothing is
  retried automatically. **Cancel** stops only the active phase of this run and prevents later ones.
* **Honest result.** `completed` means all four results exist and the campaign package is saved; the label then follows the review:
  *approved*, *approved with notes*, or *completed with unresolved review issues* (never "ready to publish"). `partial` = the
  package is saved but a creative participant failed or timed out (for example every image failed and brand-colored backgrounds
  were used, which are shown as such).
* **Limits.** Per-phase hard caps (the plan shows their sum). The default preset is the lowest-cost *first test*: reuse F1/F2; F3 up
  to 14 calls, 3 Channel Scouts, 3 cross-checks, calendar off; F4 with `gpt-4.1-mini` text, an automatically chosen current GPT Image model at `low`, 1 concept,
  Instagram, landing page, up to 12 text calls, 1 original image, regeneration off, vision off, 2 repair rounds. *Demo quality* is
  richer and is never preselected. No dollar figure is shown (LaunchPilot does not know your pricing).
* API: `GET /factory/presets`, `POST /projects/:id/factory/preflight`, `POST /projects/:id/factory`, `GET /projects/:id/factory-runs`,
  `GET /factory-runs/:id`, `GET /factory-runs/:id/events` (the recorded agent activity of the phases it ran),
  `POST /factory-runs/:id/cancel`.

## Tests

```powershell
pnpm test:agents    # 208 tests, real Mozaik runtime + real cloud-sdk + fake OpenAI (text and image) server, no database
pnpm test:api       # 102 e2e tests, needs PostgreSQL on :5433 (fake OpenAI server, no real calls)
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

- F1 to F4 run as separate, explicitly started phases. There is deliberately no one-click "Run campaign" chain (the button stays disabled); each phase shows its limits first.
- Single API instance assumed: the startup sweep marks every `RUNNING` row `INTERRUPTED`. Multiple instances would need
  an owner/heartbeat column first. Runs are executed in-process (no job queue, no separate worker).
- The live Mozaik state is not persisted or restored; interrupted runs are reported as interrupted, not resumed.
- A hard kill (Windows `Stop-Process`, `kill -9`) skips graceful shutdown; the run is repaired on the next boot instead.
- The event timeline in the UI shows the first 200 events and polls once per second while a run is active.
- Real OAuth (Google, Meta, X, GitHub…), API key live validation, scheduled publishing, billing, dark theme, avatar upload.
