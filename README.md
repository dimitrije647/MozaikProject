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
| `pnpm db:deploy` / `db:status` | apply the pending migrations without prompts / show which are pending (read from the root `.env`) |
| `pnpm format` | Prettier |

`@launchpilot/agents` compiles to CommonJS in `packages/agents/dist` (the API imports it). Rebuild it after changing
it: `pnpm --filter @launchpilot/agents build`. The old hello-world still runs with `pnpm --filter @launchpilot/agents hello`.

## V4: one workflow — Campaign Production

LaunchPilot has ONE production workflow. There are no presets and no modes: the user creates a project, enters the business information,
optionally runs Get Content, chooses a template collection and palette, sets the campaign objective and audience, reviews ONE budget and
clicks **Generate Campaign** (`POST /projects/:id/factory`; the plan is free: `POST /projects/:id/factory/preflight`). The text provider and
model are the defaults saved under Settings → AI providers (OpenAI or Claude); they are used automatically and never switched.

**Stages and agents (real Mozaik participants and SemanticEvents):**

| Stage | Agent | Responsibility | Model calls |
|---|---|---|---|
| all | Campaign Coordinator (deterministic: `FactoryService` + the stage coordinators) | runs the stages in order, budget ledger, progress, failures | 0 |
| F1 Business Research | **Business Researcher** (A1) | reads the intake, website, GitHub repo, documents and images (authorized sources only); evidenced facts; the business brief. Not an SEO/GEO audit | 2 |
| F3 Marketing Strategy | **Marketing Strategist** (A2) | competitor pages and holiday calendar (deterministic tools), positioning, key messages, content pillars, channel strategy for X, TikTok, Facebook, Instagram, LinkedIn | ~2 |
| F4 Creative Production | **Content Writer** (A3) | concepts on the strategy; per-platform post text, hook, CTA, hashtags, posting format; TikTok video concept and script (no video is generated); web/display ad copy; billboard and flyer copy | 1 (+1 per repair) |
| | **Visual Researcher** (A4) | approved uploads, approved website/repository pictures, licensed stock (rights gate, provenance, credits); matches pictures to concepts | 0 |
| | **Creative Designer** (A5) | template selection in the chosen collection + deterministic rendering (sharp); never an AI image | 0 |
| | **Quality Reviewer** (A6) | deterministic checks (facts, claims, text limits, formats, rights, duplicates) + one text review and a small sampled vision review; at most one repair round | 1–2 |

Business Research is reused when the project's information has not changed since the last report (`refreshResearch` forces a new one); the
strategy and the creative stage always run for the campaign at hand. Stage limits are internal ceilings (`STAGE_LIMITS` in
`apps/api/src/mozaik/factory-plan.ts`), not user settings.

**Deliverables plan (`packages/agents/src/hybrid/deliverables.ts`).** Per concept one visual for each selected social platform (X 16:9,
TikTok 9:16 cover, Facebook feed, Instagram portrait, LinkedIn feed); web banner and display ad for the lead concepts; one billboard and one
flyer. At most 24. A format the chosen collection cannot draw is reported as not planned, with the reason; it is never faked or stretched.

**No AI images.** F4 has no image generator at all and the text transport refuses image requests. If no permitted picture exists, the visuals
are typography-first (brand colors, type, logo) and labelled so.

**The ZIP (`GET /campaigns/:id/export`).** `campaign/README.md`, `strategy/`, `social/{x,tiktok,facebook,instagram,linkedin}/` (images +
`post.txt`, TikTok `video-script.md`), `ads/{web,display}/`, `print/{billboards,flyers}/`, `brand/`, `sources/` (CREDITS.txt, provenance,
rights; originals only where the license allows), `review/`. Missing deliverables are listed in the README, never replaced by placeholders.

**Removed in V4:** the presets (First Test, Demo, Full Production, Hybrid Production, NO AI HYBRID), the F2 Marketing Audit (SEO, GEO,
PageSpeed, presence auditors), landing-page generation, AI image generation (Visual Creator, image models, image continuation), Channel
Scouts and analyst cross-checks, the per-stage start endpoints. **Historical data stays readable:** saved audits (`GET /audits/:id`),
pre-V4 strategies and campaigns (old packages keep their own ZIP layout), and factory runs with their preset.

**Migration:** `20261112090000_v4_optional_audit` makes `MarketingStrategyReport.f2AuditId` and `CreativeCampaign.f2AuditId` optional
(additive, no data change). Apply it with `pnpm db:deploy`.

### Copywriting: twelve principles, combinations and the brand voice

`packages/agents/src/copywriting/` is the ONE source of the copywriting guidance. It adds no agent and no model call.

- **Principles (`principles.ts`).** P1 Killer headline, P2 Say what only you can say, P3 Call out the right audience, P4 Reason why,
  P5 Damaging admission, P6 Show don't tell, P7 Tie benefits to status, P8 Genuine urgency, P9 Implied authority, P10 Powerful ending,
  P11 Clear CTA, P12 Third-grade clarity, plus optional P13 Humor. Each has one line on how to use it and one on what it must never become.
  The full text is in the Content Writer's system instruction only (a short version is in the Quality Reviewer's); agents exchange ids.
- **Combinations.** Awareness (P1 P3 P6, optional P7 P9), trust (P2 P4 P9, optional P5 P6), engagement (P3 P4 P6 P12, optional P9),
  conversion (P1 P4 P11, optional P7 P8 P2), leadership (P3 P7 P9 P12, optional P2 P10), product (P2 P6 P11, optional P1 P4 P8).
  These are starting patterns, not formulas.
- **Who decides what.** The Business Researcher gathers the evidence. The Marketing Strategist writes `creativeBrief.copyDirection`
  (purpose, main problem, practical and status benefit, the one next action, proof points, real urgency or limitation with the finding it
  cites, suitable principles). The policy drops urgency or limitations that cite no real finding. The Content Writer decides HOW, applies a
  few principles per piece and lists them (`principles`, `principleNote`). The Quality Reviewer judges against the plan.
- **Plan (`plan.ts`, deterministic).** Purpose (from the strategist, else the objective, else a default), primary, optional and
  **excluded** principles. P8 is excluded without a real deadline, season, capacity or offer (an offer or date the user entered counts).
  P5 is excluded without a documented limitation, and P13 when the voice is not playful or the industry is regulated. Per placement (each
  platform, web/display ad, billboard, flyer) the plan lists the few principles that fit, the length limits from `creative/limits.ts` and the
  format guidance. Billboards get at most two principles and no body text.
- **Brand Voice Profile (`voice.ts`, deterministic).** Tone, formality, directness, intensity, technical depth, personality, preferred and
  forbidden words, humor, sensitivity and evidence confidence. It is inferred from, in order: the user's override in the campaign setup
  (writing style, humor, words to avoid), the strategist's tone of voice, the research's brand notes, then the business type and industry.
  The collection only nudges directness and intensity. Regulated industries (finance, legal, health, governance...) get conservative claims
  and no humor. With little evidence the profile is a cautious default and the campaign says so.
- **Checks (`checks.ts`, no model).** Generic slogans and superlatives (EN/DE plus the voice's forbidden words), artificial urgency without
  evidence, excluded principles that were used anyway, overlong sentences and jargon, overloaded billboards, a forced "P.S.", repeated
  openings and one CTA everywhere. The reviewer rubric adds headline strength, specificity, clarity, CTA quality, platform fit and
  principle fit (these criteria are optional in rubrics stored before they existed). There is still at most one repair round.
- **Stored and exported.** `CampaignPackage.copywriting` holds the plan. The ZIP has `brand/voice.md` and `review/copywriting-plan.json`.
  Each post also carries a `visualLine`, the short line printed on the visual, so captions are not cut off on the image.

FIRMENFELS GRUPPE (independent Swiss asset managers and trustees) is the reference case in `copywriting/copywriting.test.ts`: one audience,
one real problem, credibility before exaggeration, status as control and preparedness, no invented credentials or urgency. It is only a test
case: no brand language from it is in any prompt.

## V3: Claude provider

**AI providers (Settings → AI providers).** The campaign agents run on ONE provider, the one you mark as default: **OpenAI** or
**Claude** (Anthropic). The default provider (`User.defaultAiProvider`) and its model (`ApiCredential.model`) are stored on the server and used
by every new project, campaign, factory run, agent and continuation until you change them. A run never mixes providers and never switches
on its own: a missing key or model, or a model of the other provider, is refused before anything is sent. Keys are encrypted per user and
never returned to the browser. `GET /ai-providers` returns the masked overview; Claude has `GET /integrations/anthropic/status|models`,
`PUT /integrations/anthropic/model` and `POST /integrations/anthropic/test` (one tiny billed call, only on a button press).

**Claude = Claude Console API key only.** LaunchPilot calls the Claude API through the official `@anthropic-ai/sdk` with the user's own
`sk-ant-api…` key (`packages/agents/src/ai/anthropic-http.ts`). A Claude.ai / Claude Code **subscription login is not supported** and is
shown as unavailable: Anthropic does not permit third-party apps to offer Claude.ai login or to route requests through Free/Pro/Max/Ultra
plan credentials, and developers may not collect or intermediate Claude.ai credentials or session tokens
([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). LaunchPilot therefore never reads Claude Code credential
files, OAuth tokens or cookies, never starts a Claude Code process, and refuses a pasted `sk-ant-oat…` subscription token. If you have a
**Max, Ultra or Team** plan, its monthly API credits can be linked to a Claude Console organization and are then used by an ordinary API key
([API credits for subscribers](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)); when they run out, API
requests stop (they are never charged to the plan). To cap spending, give LaunchPilot its own Console workspace with a spend limit.

Claude costs are computed from the **Claude** price book (`pricing.ts`, verified on the Anthropic pricing page; never an OpenAI price).
Current Claude models think adaptively and that counts against `max_tokens`, so LaunchPilot adds a thinking headroom (medium effort: +4,096
tokens) and reserves the full value in the campaign budget. Claude writes text only: an AI-image campaign on Claude is refused.

**Real content only.** Since V4 every campaign renders its visuals from approved pictures and the template collection; see the V4 section above.

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

### BYOK isolation (OpenAI, Claude API key and Gemini)

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

## OpenAI BYOK and Business Research (F1; historical design notes, see V4 for the current agents)

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
  The Web Analyzer runs two bounded queries: the business name with its domain, and the quoted name with the business's own
  domain excluded (mentions elsewhere). LaunchPilot never scrapes Google and never falls back to a paid service. Without a key
  the report says that no web search was done. (The Brave adapter follows the documented API but has not been exercised
  against the live service.)
- **JavaScript sites and bot protection:** the fetcher recognizes an application shell (almost no visible text, a framework
  root element) and challenge pages served by Cloudflare, Imperva, DataDome, PerimeterX or Akamai (reported as
  "bot protected", never as a plain HTTP error). With `TAVILY_API_KEY` the rendered text of such pages is requested from the
  official Tavily Extract API (`tools/web-extract.ts`, basic depth, bounded per run) and the source record says so; a page
  that robots.txt disallows is never sent there. Without the key, only what the server sent is read and the source says why.
  Every page also yields its JSON-LD types, the declared organization and the social profile links it carries.
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
- Pages that need JavaScript to render are read through the Tavily Extract API only when `TAVILY_API_KEY` is set; otherwise as served (no headless browser). Scanned PDFs need OCR, which is not included.
- Private repositories and non-GitHub hosts are not supported. Only the first few pages, files and images are analyzed (limits
  are shown in the Overview as "not analyzed").
- OpenAI only (Gemini keys remain stored but unused here); the chosen model must support structured outputs, and vision for
  images. Models with large hidden reasoning can exhaust output tokens: raise "max output tokens" in Cost limits.
- "Verified" means checked against a live source in this run, not independently fact-checked in the world; the report is an
  early hypothesis document, not market research.
- Aborting stops waiting and blocks further calls, but OpenAI may still bill a request already in flight.
- Single API instance, in-process runs. Prices are not shown.
- Future: phases F2 to F4.

## F3 Marketing Strategy (historical design notes; V4 runs one Marketing Strategist)

F3 turns the product understanding (F1) and the audit of the current marketing (F2) into a **campaign strategy** and a
machine-readable **creative brief** for the next phase. It does not write ads, copy or images. It runs in the same Mozaik
runtime, with the same event protocol, shared-board pattern, evidence classes, cross-check protocol, BYOK isolation, cancellation
and timeouts as F1 and F2.

### The roles

| # | Agent | Does | Tools (deterministic, no AI) |
|---|---|---|---|
| A14 | Audience Researcher | customer segments (B2B/B2C), needs, pain points, motivations, barriers, decision process, product fit. **Hypotheses** unless evidenced. | none (F1/F2 context) |
| A15 | Competitor Researcher | real competitors from retrieved pages and search leads; positioning, offerings, crowded themes. Existence is **confirmed only if the competitor's own page was retrieved**. Each site is read up to 3 pages deep (home, pricing, about, services); its social links and JSON-LD are extracted in code. | `competitorQueries` (localized), `pickNamed`/`pickCandidates`, SSRF-safe `WebFetchTool` + Tavily Extract fallback, Tavily/Brave search |
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
| Web search | `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` (optional, official APIs only, never Google scraping). Queries use the report language (`najbolji … cene …` for Serbian) and boost the market's country when it can be resolved from the geography | only URLs you supplied are analyzed; with neither, "insufficient research" is reported and **no competitor is invented** (no model call) |
| Named competitors | the same search provider: one lookup per name you supplied (up to 5); the result is used only if its host or title carries the name, directories and social networks never qualify | names are reported as "not found" (add the URL instead); nothing is guessed |
| Rendered pages | `TAVILY_API_KEY` (Tavily Extract, basic depth, bounded per run) for JavaScript shells and bot-protected competitor pages | such pages are read as served, and the source says why |
| Holiday calendar | none (Nager.Date). Used only if the intake's "seasonal calendar" is on (or you choose it in the run options) and one country can be resolved from the geography | seasonal analysis is limited to labeled hypotheses |

At most 3 category searches plus one lookup per named competitor, 4 competitor sites and 3 pages per site per run (configurable
lower). The scouts receive `<competitor_presence>`: which social networks each retrieved competitor links to from its own website
(an observation about links, never about activity or audience). All fetched content is untrusted data.

### Database, API and UI

One additive migration (`20261102090000_market_strategy`): table `MarketingStrategyReport` (`reportJson` incl. the creative brief,
`metadataJson` incl. the scout decisions, `f1ReportId`, `f2AuditId`). `CampaignRun`/`CampaignEvent` are reused (`mode = market_strategy`).

| Method | Path | Notes |
|---|---|---|
| POST | `/projects/:id/runs/market-strategy` | `{ auditId?, model?, maxModelCalls? (6-40), maxScouts? (0-6), maxReviews? (0-10), maxOutputTokens?, competitorUrls? (≤5), competitorNames? (≤5), goal?, budgetNote?, useHolidayCalendar? }`; 422 without F1/F2/key/model; 409 if a run is active |
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
* Competitor research is only as good as the pages and search results that could be retrieved (no scraping of search engines or social networks). Figures the user states in the brief (a budget, a duration) are allowed in the strategy; every other money, percentage or ROI figure that appears in no source is removed.
* Scout eligibility is rule-based and simple; it can be wrong for unusual businesses (raise or lower the cap, or review the rule hits).
* One model for all participants; strategy quality depends on the F1/F2 reports beneath it.

## F4 Creative Production (historical design notes; V4 agents and deliverables are described in the V4 section)

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
| A22 | Landing Content Builder | text | Structured landing content (SEO title, hero, benefits, sections, FAQ, trust signals only with support, one CTA objective). Preview = escaped fixed template + strict CSP, shown in a sandboxed iframe, deployed nowhere; its own section headings follow the campaign language (en, sr, hr, de, es, fr, it). |
| A23 | Content & Brand Reviewer | text (+ vision, opt-in) | Deterministic checks first (forbidden claims from the brief, invented figures, promise words in the campaign language plus English (`creative/lexicon.ts`: en, sr, hr, de, es, fr, it, diacritics folded), copy longer than its channel allows or shows (`creative/limits.ts`: platform maximums are major, recommendations minor), CTA mismatch, wrong dimensions, text overflow, low contrast, missing logo), then one text review per round; vision review only if you allow it. Findings carry id, severity, asset reference, evidence, suggested correction, responsible agent and status. |
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

### One campaign budget (shared by text, images, reviews and repairs)

**Why it changed.** Earlier versions split the approved amount into a *text pool* (about $2 by default) and an *image pool* (the rest). That asked the
user to predict what the AI agents and the images would each cost, and it produced screens such as "Text budget $3.00 approved, used $0.13" next to
"Images budget $0.00 approved, usage unknown". There is now **one amount** and one ledger.

**The ledger** (`packages/agents/src/ai/budget.ts`, one `SpendBudget` per factory run, shared by F1, F2, F3, F4, the image provider, the vision
reviews and the repairs; a direct F4 run or an image continuation gets one of its own):

1. before every billable call it **reserves** the worst case (published price, estimated input plus the FULL output cap; the per-image price from the
   price book, or the dearest real image seen so far for a model without a published price);
2. the call is **refused, unsent,** when it would knowingly exceed the approved total, when it would use money that more important work still needs
   (below), or (images) when it would exceed the approved maximum number of image requests;
3. after the call the reservation is **reconciled**: replaced by the cost computed from the usage the provider *reported* (known); if no usage came
   back, a priced request keeps its reservation as an *estimated* cost and a request of unknown price is recorded as *unknown*, never as $0; the unused
   part of the reservation returns to the budget;
4. a request the provider rejected (HTTP error, rate limit) is released; one that timed out or was cancelled **after being sent** stays as *uncertain*
   spend; when a run ends, anything still in flight becomes uncertain, so no reservation is ever leaked;
5. reservations are made one at a time (JavaScript runs `tryReserve` synchronously), so concurrent workers can never reserve the same money.

Counters: `knownUsd`, `estimatedUsd`, `reservedUsd`, `uncertainUsd`, `remainingUsd` (+ `remainingBasis`: *exact*, *estimated*, *unknown* or *uncapped*),
requests started (text, image, the image cap) and `unknownCostRequests`. Each phase sees its own figures next to the campaign's remaining budget.
The ledger is saved on the run (`FactoryRun.ledgerJson`, one additive nullable column) while the run goes and when it ends, so a page refresh shows it;
the saved copy is final before the run is marked finished.

**Dynamic allocation, not pools.** Money one kind of work does not use stays available to the rest, and nothing is spent just to use it up. To keep
early optional work from starving the required deliverables, the ledger holds a **revisable projection** of the unspent mandatory work (typical text
cost of the phases that still run, with a 25% margin, and the required originals at the price book's per-image price) and applies deterministic
priorities: **1** essential analysis, **2** required original images, **3** template rendering (local, normally no API money), **4** useful quality
checks and corrections, **5** optional refinements (the optional direction refinement and assisted template selection are 5; cross-checks, the creative
review, vision reviews, concept critique and repairs are 4). Priority decides who is held back, never the other way round: essential analysis outranks
the images, so a priority-1 call is only kept from using the money that the essential analysis of the LATER phases needs; the required images are protected
from the same later analysis; a priority-4 or -5 call may not use money that ANY mandatory work (analysis or required images) still needs. If analysis itself
uses up the money, the images that no longer fit are reported as stopped by the budget, never as done. The projection shrinks as phases finish and images start.
A request that does not fit only because other requests still hold their worst-case reservations is **deferred** until they settle (they release the
difference at the cost the provider reports) instead of being refused for good; it is refused only when nothing in flight could still free money. A budget that
cannot cover the required work is said so *before* the run (the plan is refused below the estimate), and optional work is the first thing to go, with the figures; the creative counts are never reduced by the
budget (a plan below the estimate is refused, with the options *raise the budget / another model / lower quality / fewer images*, never applied by
themselves). If something required cannot be paid for mid-run, the phase stops with the reason and the finished phases are saved and reusable
("Continue campaign" does not pay for them again); images that did not fit are reported as stopped by the budget, never as done.

**Unknown image pricing.** For a model without a published per-image price the plan shows the exact model, "Image pricing unavailable", the number
of image requests and: *"Image pricing is not available. Your approved campaign budget is an application-level spending target, not a guaranteed
billing cap for unpriced requests."* There is no second checkbox: the ONE approval also covers at most N image requests (`approvedImageRequests`, computed
from the plan and sent by the page; the API refuses a different number) and the model offers two bounded alternatives (a model with a published price,
or no original images). The first image goes alone; its real cost then protects the rest; an unpriced request is never started when nothing is left.

**The one confirmation** reads: *"I approve up to $3.00 in estimated campaign spending, subject to the disclosed limitations of provider billing."*
For First Test and Demo a budget stays optional (without one the run says "no limit" and only measures usage); when an unpriced image model is chosen
the budget and the confirmation become required for every preset.

**Existing runs.** Runs made before this change keep their data: `FactoryRun.ledgerJson` is `NULL`, their `configJson.textBudgetUsd` is untouched, and
the run view shows their approved total and recorded usage as *derived*, with the old text/image amounts as history only (never a new permission).
`textBudgetUsd` is still accepted by the API (older clients) but ignored, with a warning.

**Limits that no application can remove.** The ledger is an application-side control, not an OpenAI billing cap: a request that timed out may still be
billed (it is counted as uncertain); a model without a published price can only be bounded by the request count and by its first real cost; prices
come from a dated price book and can be out of date; set a hard limit at platform.openai.com as well.

**Why a long answer is given a longer clock (incident 2026-11-02).** A real Hybrid Production run failed in F3 after 17 paid requests: the Campaign Strategist
(the longest answer of the campaign, up to 8,000 output tokens) was still writing when the fixed 90 s per-request limit ran out, so the phase failed, F4
was never reached and no image was requested. The campaign budget did not cause it (nothing was refused or deferred; most of the $4 was still available).
The saved events showed long structured answers produced at 53 to 70 tokens/s (the F1 and F2 synthesizers already needed 65 to 70 s). So a request that
writes a phase's final document (a *synthesis*) now gets `output cap / 40 tokens per second + 20 s` (never above 10 minutes; 220 s for 8,000 tokens), a speed
slower than anything measured; every other request keeps its own limit, and an explicit `callTimeoutMs` of a caller or test is never overridden. The clock
starts when the request is **sent**, not while it waited for room in the campaign budget. A request that still times out is **not repeated** (it may have
been billed): it stays as *uncertain* spend, and the failure says how long the request was given and that it may have been billed.

**When a campaign stops** the run page says where (phase and agent), the specific safe reason, why no image was requested, the known and the uncertain
spending, the remaining budget, what is saved, and the recommended next action. The reason is saved on the failed phase (`phasesJson[].failure`, sanitized:
no provider text, prompts or credentials); for runs saved before that it is derived, read-only, from the events of the failed phase. **Continue from saved
work** only opens the free plan: the finished phases are reused (not paid for again), the failed run stays exactly as it was, and a new campaign budget has to be
approved before anything is sent. Nothing is ever retried automatically.

**Saved reports and the format check.** A phase builds on the report the previous phase saved, so the two must agree on its format. F1, F2 and F3 each save a
report with an explicit schema version; every reader goes through one place (`packages/agents/src/contracts/`), which validates the report in memory, lists
every deterministic adjustment it had to make (a field the schema fills with its declared default, a field this version does not read) and never rewrites the
stored report. The limits of a *stored* report are declared once (`STORED_LIMITS`, `STORED_AUDIT_LIMITS`) and used by both the producer and the schema: the model's
draft keeps its stricter limits, and when the policy layer has to cut a list it records that as a policy issue instead of cutting silently. A report that does
not conform when it is finished is still saved (paid work is never thrown away) with the exact fields in its policy issues. Before you approve anything, the
**free plan** reads every saved report it will reuse and says so ("Existing strategy is compatible and will be reused."); a report that cannot be read blocks the
plan with the report, the field, the count and the limit, and says whether anything has to run again (a format difference never does; missing or damaged
information does). A failed run whose saved reports are readable shows that on its page ("Saved reports now"), so **Continue from saved work** reuses F1, F2
and F3 and runs only the phase that did not finish.

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
* The deterministic checks are word-based (promise lexicons exist for en, sr, hr, de, es, fr and it; other languages get the English list only); the model review judges meaning. Channel length limits are configurable defaults, not live platform specifications. Vision review is opt-in and budgeted.
* A repair the owner cannot make (or a rejected picture with regeneration off) stays visible as unresolved.

## Template creatives: library, rendering and selection

**Hybrid Production** is a fourth preset next to First Test, Demo and Full Production (which are unchanged). Instead of buying one AI image per creative, it asks the image model for a **small number of original images** (default **5**) and builds the other creatives **locally** from a library of professionally designed, declarative **templates** (default **15**): each one is a real layout rendered from a template, your brand colors and logo, your approved copy and one of the originals (or a brand image). Default: 5 concepts × (1 original + 3 template creatives) = **5 original AI images + 15 template creatives = 20 finished creatives**.

What this is *not*: the 15 template creatives are **not AI images** and are never labelled or counted as such. LaunchPilot does not promise a saving: the estimate shows what *this* plan costs (text calls + original image requests); how it compares with another preset depends on the models, quality and sizes you choose (see *Cost comparison methodology*).

Everything is configurable: number of originals (0–40), number of template creatives (0–60), concepts (1–5), image model (Automatic = **Quality First**, or explicit), image quality (**Medium** by default, High selectable), visual style (Auto or one of 10), template selection (Automatic / Assisted / Manual), channels, inspiration source, the facts only you can supply (offer, date, quote…), an optional direction review, an optional picture-free fallback, and the approved spending limit. The saved text model is kept; nothing is changed silently.

### How a Hybrid run works (real Mozaik participants, persisted events)

```
F1 → F2 → F3                          (reused or run exactly as in the other presets)
F4:  Copywriter ┐                      concepts + channel copy              (model)
     Landing    ├ start together
     Visual Researcher ┘               Visual Direction Brief                (deterministic; ONE optional model call refines it)
        └─ visual.direction.published ─► Visual Creator plans + generates the ORIGINALS (5 requests, bounded concurrency)
     Template Selector  ◄─ copy + direction     template.selection.completed (deterministic scoring; optional ONE call re-ranks a shortlist)
     Layout Designer    ◄─ selection + each original as it appears      renders template creatives locally (no model call)
     Template Quality Reviewer  ◄─ template.quality.requested            opens every file, checks it against the plan
     Content & Brand Reviewer → Fixer (created at run time only if needed) → bounded review/repair rounds
     campaign.completed
```

| Participant | Role | Model call? |
|---|---|---|
| Copywriter, Landing Content Builder, Visual Creator, Content & Brand Reviewer, Fixer | unchanged | as before |
| **Visual Researcher** (A25) | Builds the **Visual Direction Brief** from the strategy, the brand, the style library and the references you may share; publishes `visual.direction.published`. Runs **concurrently** with the Copywriter and the Landing Content Builder. | Optional, one bounded call (`directionRefine`); the deterministic brief is the fallback. A style *you* chose cannot be overridden. |
| **Template Selector** (A26) | Chooses a library template for every planned creative; publishes `template.selection.completed`. Starts after the copy and the direction exist (sequential, not concurrent). | None by default. `assisted` mode: one call that may re-rank a **validated shortlist**; a pick outside the shortlist is rejected. |
| **Layout Designer** (extended) | In Hybrid mode renders the *template creatives*: each as soon as its original exists, **concurrently** with the generation of the other originals. | None |
| **Template Quality Reviewer** (A27) | Before every review round, opens each template creative and checks it against the plan (file exists and decodes, exact size, template id + version, source files recorded, not a duplicate of another creative, correct origin label); publishes `template.quality.completed`. | None |

All of these are registered in the real Mozaik runtime, communicate only through SemanticEvents (`visual.direction.published`, `template.selection.completed`, `layout.completed` with `templateCreatives`, `template.quality.requested/completed`, the existing review/fix events), and are persisted like every other event. The Creative Coordinator remains the single writer of the F4 board. Nothing claims concurrency that is sequential: the order above is the one the tests assert.

### Deterministic quota allocation

`hybrid/plan.ts` is pure and has no model call. The original images are placed by the existing allocation planner (weights from the channels a concept covers; at least one per concept when the target allows). The template creatives are shared **evenly**, any remainder going to the concepts with the best-ranked channels, so the default is exactly 3 per concept. Inside a concept, channels and formats take turns (a format is repeated only after the others were used). Each creative is assigned to one original of its concept (an original may serve several creatives; the lineage says which). Each original's requested size follows the formats that will be built from it (a story/portrait creative asks for a tall picture) unless you fixed a size. If there are fewer originals than concepts, the concepts without one use your **brand images** or picture-free templates, and the plan says so; nothing is reduced silently.

### The template library

A template is a typed, **declarative** document (`packages/agents/src/templates/schema.ts`, validated with zod): `id`, `name`, `version`, `status`, `category`, `description`, `styles`, `industries`, `channels`, the format **classes** it is designed for (`square` ~1:1, `portrait` ~4:5, `story` ~9:16, `landscape` 1.2–2.6, `banner` ≥ 3:1), `requires` (content it cannot do without), `density`, `family` (composition family), `composition`, `sample` copy, `tone`, and an ordered list of **layers** in unit coordinates (fill, rect, ellipse, line, pattern, polygon, image, text, button, logo) with colors expressed as **roles** (primary, secondary, accent, ink, paper, onX…) so one template fits any brand. Per-class patches (`at`) re-compose the layout for each class; a format of a class the template was not designed for is **refused, never stretched**. A template contains **no code, no HTML and no URLs**; the same definition is used by the API, the selector, the renderer, the web preview and the export.

The built-in library holds **31 templates** in 6 categories (library version in `templates/library/index.ts`):

| Category | Template (id) | Composition family | Formats | Needs |
|---|---|---|---|---|
| Tech / SaaS | Product launch (full-bleed photo) (`tech_product_launch`) | full-bleed | square, portrait, story, landscape | image |
| Tech / SaaS | Feature highlight (product window) (`tech_feature_highlight`) | inset-card | square, portrait, story, landscape | only copy and the brand |
| Tech / SaaS | Workflow steps (process diagram) (`tech_workflow_steps`) | panel | square, story, landscape, banner | only copy and the brand |
| Tech / SaaS | Testimonial (speech bubble) (`tech_testimonial`) | quote-focus | square, portrait, story, landscape | quote |
| Tech / SaaS | Minimalist tech (selection frame) (`tech_minimalist`) | frame | square, portrait, landscape, banner | only copy and the brand |
| Tech / SaaS | Dark premium (horizon glow) (`tech_dark_premium`) | centered | square, portrait, story, landscape | only copy and the brand |
| Hospitality | Restaurant promo (split panel) (`hospitality_restaurant_promo`) | split | square, portrait, story, landscape | image |
| Hospitality | Cafe atmosphere (framed photo print) (`hospitality_cafe_atmosphere`) | frame | square, portrait, story, landscape | image |
| Hospitality | Food showcase (peeking plate) (`hospitality_food_showcase`) | centered | square, portrait, story, landscape | image |
| Hospitality | Event announcement (headline band) (`hospitality_event_announcement`) | band | square, story, landscape, banner | only copy and the brand |
| Hospitality | Premium dining (inset menu card) (`hospitality_premium_dining`) | inset-card | square, portrait, story, landscape | image |
| E-commerce | Product spotlight (notch panel) (`ecommerce_product_spotlight`) | panel | square, portrait, story, landscape | image |
| E-commerce | Seasonal promo (tilted ribbon) (`ecommerce_seasonal_promo`) | diagonal | square, story, landscape | image |
| E-commerce | Discount (giant offer figure) (`ecommerce_discount`) | stat-focus | square, story, landscape, banner | offer |
| E-commerce | New collection (bento collage) (`ecommerce_new_collection`) | collage | square, story, landscape, banner | image |
| E-commerce | Comparison (split pictures) (`ecommerce_comparison`) | split | square, story, landscape | image |
| Professional services | Corporate announcement (band) (`services_corporate_announcement`) | band | square, portrait, landscape, banner | only copy and the brand |
| Professional services | Trust and credibility (tile mosaic) (`services_trust`) | collage | square, portrait, landscape | only copy and the brand |
| Professional services | Service explainer (split columns) (`services_explainer`) | split | square, portrait, landscape | only copy and the brand |
| Professional services | Recruitment badge (ID card) (`services_recruitment`) | inset-card | square, portrait, story | only copy and the brand |
| Professional services | Case study (big number) (`services_case_study`) | stat-focus | square, portrait, story, landscape | stat |
| Editorial / Brand | Editorial minimal (typographic poster) (`editorial_minimal`) | poster-type | square, portrait, story, banner | only copy and the brand |
| Editorial / Brand | Bold typography (type as the picture) (`editorial_bold_typography`) | poster-type | square, portrait, story, banner | only copy and the brand |
| Editorial / Brand | Premium luxury (framed invitation) (`editorial_premium_luxury`) | frame | square, portrait, story, landscape | only copy and the brand |
| Editorial / Brand | Lifestyle story (photo with story card) (`editorial_lifestyle_story`) | inset-card | square, portrait, story, landscape | image |
| Editorial / Brand | Modern geometric (color blocks) (`editorial_modern_geometric`) | collage | square, portrait, story, landscape | only copy and the brand |
| Events / Entertainment | Event promo (ticket) (`events_event_promo`) | split | square, portrait, landscape, banner | only copy and the brand |
| Events / Entertainment | Countdown (date in a ring) (`events_countdown`) | centered | square, portrait, story, landscape | date |
| Events / Entertainment | Headline poster (banded type) (`events_headline_poster`) | band | square, portrait, story, banner | only copy and the brand |
| Events / Entertainment | Entertainment (tilted night out) (`events_entertainment`) | diagonal | square, portrait, story, landscape | only copy and the brand |
| Events / Entertainment | Community event (bunting and circles) (`events_community`) | collage | square, portrait, story, landscape | only copy and the brand |

Formats: `square` 1080×1080, `portrait` 1080×1350, `story` 1080×1920, `landscape` (Facebook/LinkedIn feed 1200×628, 16:9 1920×1080, landing hero 1920×800), `banner` 1200×300. "Needs" lists content the template cannot be used without; `image` means a picture (an original or a brand image).

Adding a template: write it with the helpers in `templates/dsl.ts` (the header comment is the authoring guide), look at it with `node --import tsx src/templates/tools/sheet.ts <outDir> <id>` (contact sheets per class and palette), and run `pnpm --filter @launchpilot/agents test`: `validateTemplate` (schema, unique ids, every declared class has a headline layer and layers for what `requires` lists), the render tests (exact size, no overflow, fits long/Cyrillic/CJK text, brand colors really appear, logo placement, safe areas, deterministic bytes) and the **diversity test** (perceptual hash, edge hash and geometry signature must differ from every other template, so a recolor cannot pass).

### The rendering engine

`templates/render.ts` extends the idea of the deterministic Layout Designer (sharp + SVG, no third-party design service, no network): cover-crop with a focus point, masks, scrims, duotone/tint, gradients, borders, shadows, patterns, **dynamic text fitting** (render-and-measure, shrink, hyphenate, trim with an ellipsis and a flag), contrast checks against what is behind the text, safe areas per format (text, buttons and the logo are clamped inside), responsive geometry per class, layer ordering, fallback when a picture or logo is missing (`hero_missing_fallback`, `logo_missing_name_used`), and honest flags (`text_shrunk`, `text_trimmed`, `moved_into_safe_area`, `low_contrast_adjusted`, `image_low_resolution`…). Inputs are only read (originals are never modified), only raster images are accepted (SVG/PDF are refused), strings are XML-escaped, nothing is fetched. Fonts are **system font stacks** (no bundled fonts): output is deterministic on one machine, and text metrics adapt to the fonts present.

### Template selection

`hybrid/selector.ts` never invents a template. A template is **eligible** only if it is active, designed for the slot's format class, and the content it requires exists: an offer card needs an offer *you* gave, a countdown a date, a testimonial a quote; without them those templates are simply not used (the free preview tells you how many more templates a fact would unlock). Among eligible templates the score combines style fit, industry, channel, density, objective (conversion / awareness / consideration), brand tone, your favourites and use of the concept's picture, and penalizes repeating a template or layout family; ties are broken by a fixed hash, so the same inputs always give the same plan. Modes: **automatic** (deterministic), **assisted** (the same, then one model call may re-rank a validated shortlist), **manual** (your per-creative choices, validated against the library, the slot's format and the available content; an invalid choice is reported and the automatic choice is used, never silently swapped). If an original image fails and picture-free fallback is **off** (default), its creatives are left out and reported; with it **on**, a picture-free template is rendered and labelled `FALLBACK`.

### Visual Direction Brief and the local style library

The brief (`VisualDirectionBrief`) states the style, palette (from your brand first), typography families, composition, mood, image subjects and treatment, per-channel notes, **every reference with its permission status**, its origin (deterministic / model-refined), a confidence and its limitations. It feeds the image prompts (which ask for imagery **without text**: typography is added by the renderer, and say the picture will be re-cropped) and the template choice. The **style library** has 10 original style guides (not copied from any site or brand): Minimalist Tech, Premium Editorial, Bold Startup, Modern Corporate, Luxury Hospitality, Lifestyle Photography, Clean E-commerce, Dynamic Events, Soft Lifestyle, Contemporary Geometric. Each states typography hierarchy, color logic, composition preferences, photography direction, density, decorative rules, suitable channels and recommended template categories. Choose one, or let the deterministic matcher (keywords in English and Serbian, industry, channels) pick.

| Reference kind | May be analyzed? | Stored? | Contributes to the brief? |
|---|---|---|---|
| Brand assets, files you upload to the project (type *reference*), licensed assets, our style library | yes (colors are read locally) | yes (your project) | palette colors / a short note |
| A link you paste | **no** — kept so you can open it | the address only | **nothing** |
| A Pinterest Pin link you paste | **no** | the address only (label fixed to "Pinterest pin (link only)"; it is **not** put into an export) | **nothing** |
| Pinterest content shown through the optional panel | **no** | **no** | **nothing** (shown to you only) |

The server decides these permissions; the ones sent by a client are not trusted. Pasted links are never fetched.

### Pinterest (optional)

An optional, read-only panel that lets a user browse **their own** Pinterest boards for visual inspiration while choosing a creative direction. **LaunchPilot works fully without it.** With no Pinterest credentials the panel only explains that Pinterest is not set up; nothing else changes.

> **Verification status, read this first.** This integration was written against Pinterest's published documentation (read on 2026-11-02) and tested **only with mocked HTTP**. There are no Pinterest developer credentials in this repository, no request was ever made to Pinterest, and **none of the live behavior (OAuth consent, token exchange, boards and Pins responses, images loading from Pinterest's CDN, Pinterest's approval of the app) has been verified against the real Pinterest API.** Treat everything below marked "UNVERIFIED" as an open question until a Pinterest-approved app has been tried end to end.

#### What is implemented, what is disabled, what depends on Pinterest

| | Status |
|---|---|
| OAuth 2.0 authorization-code connect (`state`, single use, 10 minutes, bound to the signed-in LaunchPilot session), disconnect | Implemented. Disabled until `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, `PINTEREST_REDIRECT_URI` are set. |
| Token storage: AES-256-GCM via the existing `CryptoService`, lazy refresh before expiry (single-flight per user), "reconnect" state when Pinterest rejects the tokens | Implemented (mock-tested). |
| Live, on-demand listing of the user's boards and of the Pins of one board the user picks (paginated with `bookmark`) | Implemented (mock-tested). Nothing is persisted. |
| Pin grid with attribution ("From Pinterest", owner, "View on Pinterest" link), Pinterest-notice banner | Implemented in `apps/web/src/components/pinterest-panel.tsx`. |
| Optional "use link as reference" and "paste a Pinterest Pin link" (a string check only, never fetched) | Implemented. Hands a **link** to the caller, never an image. |
| Reading **real** boards and Pins of real users | **Depends on Pinterest approving the app.** New apps get Trial access; whether Trial can read real (non-sandbox) data is UNVERIFIED. Production use needs Standard access (see below). |
| Sandbox | Supported by setting `PINTEREST_API_BASE=https://api-sandbox.pinterest.com`. Untested against the real sandbox. |
| Writing to Pinterest (create/save/delete Pins or boards), secret boards, account profile, analytics, ads | **Not implemented and not requested** (no write or `*_secret` scope). |

#### Setup

1. In the [Pinterest developer portal](https://developers.pinterest.com/) sign in with a business account, verify its email, accept the Developer Terms, and choose **Connect app**. The app name must contain at least 3 Latin letters or numbers and must not contain the word "Pinterest". Submit the request for **Trial** access and wait for Pinterest's email (applications are reviewed by Pinterest).
2. Open **My apps -> Manage -> Configure -> Redirect URIs** and add the redirect URI **exactly** as it will be used (Pinterest requires an exact match). Recommended: `<WEB_ORIGIN>/api/integrations/pinterest/callback` (the Next.js proxy forwards it to the API), for local development `http://localhost:3000/api/integrations/pinterest/callback`. The direct API address `http://localhost:4000/integrations/pinterest/callback` also works. Outside localhost the URI must be `https`.
3. Put the credentials in the server environment (never in the browser, never committed):
   ```
   PINTEREST_APP_ID=<App ID from the portal>
   PINTEREST_APP_SECRET=<App secret from the portal>
   PINTEREST_REDIRECT_URI=<the exact URI registered in step 2>
   ```
   Optional: `PINTEREST_API_BASE=https://api-sandbox.pinterest.com` (sandbox), `PINTEREST_CONTINUOUS_REFRESH=1` (only for Pinterest apps created before 2025-09-25). `PINTEREST_API_BASE` accepts **only** `https://api.pinterest.com` and `https://api-sandbox.pinterest.com`. For local mock servers only, a different base is honored when `NODE_ENV` is not `production` **and** `PINTEREST_ALLOW_TEST_BASE=1`.
4. Restart the API. The panel (Settings, or wherever the Hybrid production settings embed `PinterestPanel`) now offers **Connect Pinterest**.
5. For anything beyond testing, request **Standard** access in the portal (**My apps -> Upgrade**). Per Pinterest's access-tier page this involves a screen recording of the app making an API call through the OAuth flow and a link to a privacy policy. You must publish a privacy policy that matches how LaunchPilot handles Pinterest data (see "What is shown and stored").

#### Scopes and why

Requested: **`boards:read`** ("See your public boards, including group boards you join") and **`pins:read`** ("See your public Pins"). The OpenAPI description requires `boards:read` for `GET /v5/boards` and `boards:read` + `pins:read` for `GET /v5/boards/{board_id}/pins`.

Deliberately **not** requested: any `*:write` scope; `boards:read_secret` / `pins:read_secret` (secret boards stay invisible); `user_accounts:read` (it would only be needed to read the account's username, and Pinterest's guidelines forbid storing API-accessed information, so LaunchPilot neither needs nor keeps a profile label; the board owner's username that comes with boards and Pins is shown transiently for attribution).

#### What is shown and stored

| Data | Handling |
|---|---|
| OAuth access and refresh tokens | Stored in `PinterestConnection`, **AES-256-GCM encrypted** (`APP_ENCRYPTION_KEY`), one row per LaunchPilot user. Never returned by any endpoint, never logged. Wiped when the connection is lost; deleted on **Disconnect**. |
| Token metadata | Granted scopes, expiry timestamps, status, a fixed safe sentence for the last failure. |
| OAuth `state` | `PinterestOAuthState`: SHA-256 hash only, user id, expiry, used flag. Swept opportunistically. |
| Boards, Pins, titles, descriptions, image URLs, usernames | **Never persisted.** Fetched live when the user presses "Browse my boards" / opens a board, sent to the browser with `Cache-Control: no-store`, held in memory only while the panel is open. |
| Pin images | **Never downloaded by the server.** The API passes Pinterest's own image URL to the browser, which displays it unchanged (no filter, crop or overlay). |
| Anything sent to OpenAI or any other model/third party | **Nothing.** Pinterest content is never part of a prompt, a brief, a run or an export. |
| What can leave the panel | A **link** the user explicitly chooses (`onSelectLink({ boardName, pinUrl })`). `boardName` is API content shown for display: do **not** persist it (persist `pinUrl` only, or let the user type their own label). |

Endpoints (all need the LaunchPilot session except the OAuth callback): `GET /integrations/pinterest/status`, `POST /integrations/pinterest/connect`, `GET /integrations/pinterest/callback` (browser redirect from Pinterest; checks `state` and that the session cookie belongs to the user who started the flow), `DELETE /integrations/pinterest`, `GET /integrations/pinterest/boards?bookmark=`, `GET /integrations/pinterest/boards/:boardId/pins?bookmark=`.

#### Pinterest rules this design follows (read 2026-11-02)

| Rule (verbatim, short) | Source | How LaunchPilot complies |
|---|---|---|
| "you may not store any information accessed through any Pinterest Materials including the API." / "Instead, call the API each time you need to access information." | https://policy.pinterest.com/en/developer-guidelines (read 2026-11-02) | Boards/Pins are fetched live and never persisted; no profile data stored (no `user_accounts:read`); only OAuth tokens are kept (see the open question below). |
| "Keep your API access credentials private." / "Do not use someone else's API credentials, and do not allow anyone else to use yours." | same | App id/secret live only in server env; no endpoint returns them. |
| "End users may request API access credentials for use with a 'bring-your-own-key' application, as long as the application stores the end user's API credentials locally (not server-side)" | same | Not applicable: users do not supply Pinterest developer credentials; the operator's own app does. |
| "Only access someone's account with authorization, for example by using an access token." | same | OAuth consent per user; no passwords or cookies are ever collected. |
| "Only use information from someone's account to provide the services as specified to that person" / "Don't combine someone's account information with information from other people's accounts" | same | Per-user connection; every query is keyed by the signed-in user; tested for cross-user isolation. |
| "Link Pins back to their source on Pinterest" / "make sure it's clear that the content comes from Pinterest." | same | Each card says "From Pinterest", names the owner and links to the Pin. |
| "Not cover or obscure content from Pinterest." / "For example, don't apply filters to Pins." / "Not create new content from Pins that can be distributed on your app or service." | same | Images shown as delivered (no overlay, filter, crop); LaunchPilot derives nothing from Pins. |
| "Using any Pinterest Materials to train, fine-tune, or otherwise improve or develop any artificial intelligence or machine learning models, except as expressly permitted by Pinterest." / "Don't share or sell information from our API with a third party" | same | Nothing from Pinterest is sent to OpenAI or any model; tested (no outbound call except the mocked Pinterest transport). |
| "Using any automated means or form of scraping or data extraction to access information from Pinterest, except as expressly permitted by Pinterest." | same | Only three fixed API endpoints are called, on the official API host. No page is fetched, no image downloaded; a pasted Pin link is checked as text and never opened. |
| "Using your API access or developer tools to test Pinterest's rate limits or other abuse prevention systems without specific authorization" | same | Per-user and app-wide request limiter, a cool-down after any 429, no automatic retries. |
| "Using information from Pinterest to target people with advertising outside of Pinterest" | same | Not applicable: no advertising use. |
| "You must have a privacy policy that's consistent with all applicable laws." | same; also required when upgrading to Standard access (https://developers.pinterest.com/docs/key-concepts/access-tiers/, read 2026-11-02) | Operator's responsibility. |
| Redirect URIs "must be an exact match"; "The redirect must not cause the server to send a secondary redirect to another URI." | https://developers.pinterest.com/docs/getting-started/connect-app/ (read 2026-11-02) | Register the exact URI. Our callback finishes by redirecting the browser into the web app (as every OAuth callback does). Whether Pinterest objects to that is UNVERIFIED. |

#### Technical facts the implementation relies on

| Fact | Source (read 2026-11-02) |
|---|---|
| Authorization page `https://www.pinterest.com/oauth/` with `client_id`, `redirect_uri`, `response_type=code`, `scope` ("Separate multiple scopes with spaces or commas."), optional `state`. | https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/ and the official OpenAPI description (`authorizationUrl`) |
| **PKCE is not mentioned** in the docs page or in the OpenAPI description (v5.28.0), so it is not used; `state` plus the session binding protect the flow. | same + https://github.com/pinterest/api-description (`v5/openapi.json`, release 5.28.0, 2026-06-04) |
| Token endpoint `POST https://api.pinterest.com/v5/oauth/token`, HTTP Basic auth with App ID as user and secret as password, `application/x-www-form-urlencoded`; `grant_type=authorization_code` with `code` and `redirect_uri`; refresh with `grant_type=refresh_token` and `refresh_token`. | set-up-authentication page |
| Access token `expires_in` 2592000 s (30 days). Continuous refresh token lasts 60 days and is refreshable indefinitely; the legacy 365-day token is no longer supported; apps created on or after 2025-09-25 get continuous refresh automatically, older apps send `continuous_refresh=true`. | set-up-authentication page; OpenAPI `oauth/token` description |
| `GET /v5/boards` needs `boards:read`; `GET /v5/boards/{board_id}/pins` needs `boards:read` and `pins:read`; both take `bookmark` and `page_size` (default 25, max 250); the last page returns `bookmark: null`. | OpenAPI description; https://developers.pinterest.com/docs/reference/pagination/ |
| Pin media: `media.media_type` (`image`, `video`, `multiple_*`); `media.images` offers `150x150`, `400x300`, `600x`, `1200x` with `url`, `width`, `height`; board cover in `media.image_cover_url`; owner in `owner.username` / `board_owner.username`. LaunchPilot shows the `600x` image. | OpenAPI description |
| Rate limits: category `org_read` (boards/Pins): Trial 1,000 requests per day per app; Standard 1,000 per minute per user per app. Headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` appear in the page's example. 429 is a documented response. | https://developers.pinterest.com/docs/reference/rate-limits/ and OpenAPI description |
| Sandbox host `api-sandbox.pinterest.com`; a sandbox-specific token is required; `boards/list` "can return an empty items array with a bookmark even when Sandbox boards exist". | https://developers.pinterest.com/docs/developer-tools/sandbox/ |
| Trial access is "best for exploring our API features"; "Application requests are reviewed by Pinterest"; Standard access is requested by upgrading the app. | https://developers.pinterest.com/docs/key-concepts/access-tiers/ and connect-app page |
| `POST /v5/oauth/token/revoke`: "Only tokens issued for system users are currently supported." | OpenAPI description. **Therefore Disconnect only deletes LaunchPilot's copy of the tokens**; the user can also remove the app's access in their Pinterest account settings. |
| Errors are `{ "code": <number>, "message": <text> }`. | OpenAPI description (`Pinterest.Lib.Error`). LaunchPilot shows only its own wording plus the numeric code. |

#### UNVERIFIED / open questions

- **Developer and API Terms of Service** (https://developers.pinterest.com/terms/) could **not** be read (the page returned only navigation; `policy.pinterest.com/en/developer-and-api-terms-of-service` returned 404). Read it before going live; it may contain rules not reflected here. Some third-party pages mention a revision of the developer guidelines effective August 2026; this could not be confirmed. Re-read https://policy.pinterest.com/en/developer-guidelines before launch.
- The Pinterest API reference pages themselves (e.g. `/docs/api/v5/boards-list`) are client-rendered and could not be read; their content was taken from Pinterest's own OpenAPI description on GitHub.
- **Storing the user's OAuth tokens server-side.** The guidelines forbid storing "information accessed through" the API and mention storing credentials only for bring-your-own-key apps. They say nothing explicit about the end user's OAuth tokens, which every web OAuth integration must keep to work after the first request. LaunchPilot treats the tokens as credentials, not as Pinterest content, and keeps them encrypted. This interpretation has not been confirmed with Pinterest; raise it in the Standard-access review. If Pinterest objects, the alternative is a session-only connection (the user reconnects each session), which is not implemented.
- Whether **Trial** access can read **real** boards and Pins of authorized users (not just sandbox entities): not stated in the pages read.
- **Hotlinking.** The guidelines page does not mention hotlinking or caching of images. LaunchPilot displays the image URLs returned by the API directly in the user's browser (`<img src>` with `referrerPolicy="no-referrer"`), never through a proxy and never stored. Whether Pinterest's CDN serves them this way in practice is unverified.
- `Retry-After` on 429 is **not documented**; LaunchPilot honors it if present and otherwise backs off 60 seconds. The unit of `x-ratelimit-reset` is not defined in the page read, so it is only used when it looks like a small number of seconds.
- The Pin address format `https://www.pinterest.com/pin/<id>/` and the profile address `https://www.pinterest.com/<username>/` are built by LaunchPilot by convention; the API does not return a Pin URL field.
- How Pinterest reports a user who clicks "cancel" on the consent page (assumed: an `error` query parameter, as in standard OAuth).

#### Known limitations

- Rate limiting, the 429 cool-down and refresh single-flight are per API process. With several API instances each has its own budget, and two instances could refresh the same token at the same moment (Pinterest may then reject the second); a shared lock would be needed for horizontal scaling.
- One Pinterest connection per LaunchPilot user.
- A connection that is not used for longer than the refresh-token lifetime (60 days for continuous refresh) expires; the user reconnects.
- Pinterest's rate limit is per app: on Trial, 1,000 board/Pin reads per day are shared by every LaunchPilot user of that app.
- Mock-tested only (`apps/api/test/pinterest.e2e-spec.ts`). Run it with `pnpm --filter @launchpilot/api test -- test/pinterest.e2e-spec.ts`; it uses the real test database and a mocked HTTP function, never the network.

### Starting from a business name and one sentence (progressive input, one spending approval)

Hybrid Production is meant for real users who may only know their business name and what it does. **Only two things are required** (the server decides, `apps/api/src/mozaik/input-readiness.ts`; the screen only displays the result):

| Level | Items | What a missing item does |
|---|---|---|
| **Required** (blocks Start) | business or product name; a meaningful short description (at least a short sentence of 4 words / 20 characters that is not just the name) | Start stays disabled, the review says exactly what to add, and the API refuses the same request with the same message |
| **Recommended** (a warning) | website, logo, target audience | the campaign runs; the warning says what is done instead |
| **Optional** (information) | geographic market, marketing goal, GitHub repository, social profiles, competitors, brand colors, photographs, design style, channels, campaign duration, Pinterest connection, reference images | the campaign runs; the information says what is done instead |

The fallbacks are real and tested, not wording: *no website* → website SEO analysis is "Not evaluated — no website supplied" and **no creative may show a web or e-mail address** (a deterministic check blocks and repairs any model-written address, and any calendar date that no source supports); *no logo* → the business name is drawn in the logo box (`logo_missing_name_used`); *no brand colors* → the palette comes from the built-in style library and is not presented as the brand's own; *no audience / goal / duration* → the agents propose one and label it an assumption; *no social profiles / competitors* → account-specific analysis is skipped ("Not evaluated"), no competitor is named, no figure is invented, and category-level talk is a labelled hypothesis; *no Pinterest* → the built-in styles are used; *no channels* → the strategy's recommendation (up to four) is used; *no style or template choice* → deterministic automatic selection, and a template that needs an offer, date, quote or statistic is not used unless you supplied it. Product Discovery is told exactly what was **not supplied** (`notSupplied`, computed from the data), may propose a value only as `inferred` (an AI assumption), and can never mark anything `verified` without a live source. The project form no longer forces a marketing goal. Nothing in an existing campaign or record is modified.

**One spending approval.** Hybrid Production uses the single campaign budget described under *One campaign budget* (the separate "I accept that the image price is unknown" checkbox no longer exists for any preset). The plan shows the **exact image model**, the words **"Image pricing unavailable"** when OpenAI publishes no per-image price (GPT Image 2.5, which Quality First picks), the number of image requests ("5 planned, at most 5") and the warning that actual charges may differ. You then approve with **one** checkbox: *"I approve up to $X in estimated campaign spending, subject to the disclosed limitations of provider billing"* — when the price is unknown the same sentence also says that the dollar amount cannot be guaranteed as an external billing cap and that the approval covers at most N image requests. Behind it:

- the API requires `approvedBudgetUsd` + `confirmCost`, and (only while the image price is unknown) `approvedImageRequests`, which must equal the maximum the plan showed (`budget.imageRequestCap`); the run can never send more image requests than that (the generator's `maxImages` is the same number);
- an unpublished price is **never** treated as free and the dollar limit is **not** described as a guarantee of what OpenAI bills for the images; the first image still goes alone and the rest of the campaign is protected with its real, provider-reported cost; the request counts, cancellation, `Retry-After` handling and the "no automatic retry of a failed phase" rule are unchanged;
- where the cost cannot be bounded, the plan offers two explicit, never automatic, alternatives: **a model with a published price** (e.g. `gpt-image-1.5`) or **running without original AI images**;
- the Start button is enabled exactly when the visible **checklist** has no open item (plan reviewed, name and description present, no configuration problem, the ONE budget entered and large enough, approval ticked, visual direction confirmed if you asked to review it). There is no invisible blocker, and the server enforces the same rules.

"Complete missing creatives" on a Hybrid campaign uses the same single approval.

### Asset lineage

Every asset carries an `origin` (`AI_GENERATED`, `TEMPLATE_RENDERED`, `USER_UPLOADED`, `BRAND_ASSET`, `LICENSED_ASSET`, `FALLBACK`), the `templateId` and `templateVersion` for template creatives, the `sourceAssetIds` it was built from (the original, brand images prefixed `brand:`), and a `rights` note (generated for the user on their provider account / original template / user provided / licensed / none). Template creatives have `source: 'template_render'` and are stored as `kind: 'layout'`; they are not counted as AI images anywhere (`generatedImages`, `imageCounts`, usage). Assets saved before Hybrid Production have none of these fields and are read through `originOf()`; no migration was needed. The campaign package gets an optional `hybrid` block (settings, direction, selection plan, one record per planned creative with status `rendered` / `fallback_rendered` / `failed` / `skipped` and the reason, honest counters, quality report, notes).

### Cost control and the cost comparison methodology

Paid requests are: the text calls (as in every preset; the optional direction refinement and assisted selection add at most two) and **one request per original image**. Template selection, rendering, the visual direction, the quality check and the free preview make **no** paid request. The run reports separate counters: original image requests made, successful AI images, template creatives planned, renders completed, failed renders, text calls/tokens, estimated and confirmed provider spending (`hybrid.counts`). The start still needs an approved spending limit and a confirmation like Full Production; the limit is enforced before every paid request but is not an OpenAI billing cap.

*Methodology.* The only meaningful comparison is of the **image requests** each plan makes, at the price book's figures for the same model (`ai/pricing.ts`, OpenAI prices read 2026-10-31): for `gpt-image-1.5` Full Production's 20 *High* 1024×1536 images are 20 × $0.20 = $4.00, while Hybrid's 5 *Medium* 1024×1536 originals are 5 × $0.05 = $0.25. That is arithmetic on a price table for one model, not a promise: the text part of the estimate is similar, the figures change with the model, quality and sizes you choose, a model without a published per-image price shows "Cost estimate unavailable", the two plans differ in what they deliver (20 AI images vs 5 AI images + 15 template layouts), and nothing here says one is better. The preflight shows the estimate for *your* settings.

### Failure handling and completing a campaign

An image-model failure is recorded with its reason; no cheaper model is substituted and no image is invented. Partial results are kept (for example 3 of 5 originals): the creatives of the originals that exist are still rendered, the others are listed as `skipped`/`failed` with the reason and are **not** counted as delivered, and the campaign is marked *approved with notes* or *unresolved*, never "approved". **Complete missing creatives** (the existing image-only continuation, extended) generates only the missing originals (billed, with your approval) and renders the template creatives that do not exist yet or were made without their original (free), **without running research, strategy, copy or the landing page again**; the earlier campaign is never modified. Pinterest being unavailable never affects a run.

### The export (ZIP)

```
campaign.json  manifest.json  README.md  summary.html
strategy/  creative-brief/  visual-direction/  copy/  landing/  review/  usage/
images/originals/concept-NN-variation-MM.png        (AI_GENERATED)
images/templates/concept-NN/<slot>-<template>-<format>.png    (TEMPLATE_RENDERED / FALLBACK)
layouts/<slot>.json  layouts/selection.json  layouts/template-quality.json
```

`manifest.json` lists every file with its hash, origin, size, template id and version, source files and rights, plus a `hybrid` block (production mode, counts, original → template relationships, statuses). Only files that exist are referenced; there is no Pinterest content and no temporary file. Also: `GET /campaigns/:id/export/originals`, `/export/templates`, `/export/creatives` (originals + template creatives).

### API

`GET /templates` (filters: `category`, `style`, `industry`, `channel`, `class`, `q`), `GET /templates/:id`, `GET /templates/:id/preview?class=&palette=&style=&image=` (a PNG rendered from the definition), `GET /styles`, `POST /projects/:id/hybrid/preview` (**free**: no OpenAI or Pinterest request, real local renders, the plan, the direction, the cost estimate), the existing `POST /projects/:id/factory/preflight` and `POST /projects/:id/factory` with `preset: "hybrid_production"` and a `hybrid` object. All require a session; previews are scoped to your own project.

### Security notes

Tenant isolation (a project's assets, references and campaigns are only reachable by its owner; other users get 404), validated overrides (slot names and template ids are checked against the library), validated input everywhere (class-validator DTOs and zod), no arbitrary HTML/JS in templates, XML-escaped text, raster-only image decoding with size and pixel limits, no server-side fetch of any reference URL (SSRF), no secrets in events or packages (the existing redaction), Pinterest tokens encrypted at rest and never returned or logged.

### Manual test (uses your own key; a few dollars at most, never run by a test)

1. Run the app, sign in, open the **Templates** page: browse, filter, switch palettes and formats, open a template, star favourites (stored in this browser only). Nothing here calls OpenAI.
2. Open a project → *Run campaign* → **Hybrid Production**. Change the numbers, style and selection mode. Press **Preview the plan (free)**: you see the Visual Direction Brief, the chosen templates rendered with sample text and placeholder pictures (labelled as placeholders), the distribution, what you could add to unlock more templates, and the estimated spending. Override a template for one creative.
3. Only when you are happy: approve a spending limit, confirm, and start. After the run, open the campaign: the three counters (Original AI images / Template creatives / Total), the gallery grouped by concept / channel / production type / template / format, the lineage of each creative, the direction, the selection and the quality check, and the four downloads.
4. To test failure handling for free, use the automated tests (they fail chosen images on purpose).

### Implemented, disabled, and not verified

| Part | State |
|---|---|
| Template schema, library, renderer, selector, quota planner, style library, visual direction, lineage, export, quality reviewer, free preview, template gallery, Hybrid settings and output UI, continuation | Implemented and covered by automated tests with mocked providers |
| Real image generation of the originals | Uses your OpenAI key exactly as Full Production does; **not exercised by any test** (the tests use a fake OpenAI server); the first real run is yours |
| Pinterest OAuth and boards | Implemented against the published documentation; **disabled until credentials are configured; never run against the real Pinterest API** (see the Pinterest section) |
| A visual comparison of template quality against designer-made work, fonts other than system fonts, RTL/CJK shaping beyond what the system fonts provide | Not claimed |

### Known limitations

- Template text uses **system fonts**; the exact pixels (and text metrics) depend on the fonts installed on the machine that renders.
- Emoji may render as boxes without a colour-emoji font; Thai/Indic scripts get no word breaking.
- The library is a fixed built-in set (31 templates); users cannot upload their own templates yet.
- Facts such as an offer, a date or a quote are never extracted automatically; templates that need them are used only when you provide them.
- Contrast is judged from a coarse sample of the pixels behind the text; very busy photos may end with a `low_contrast_unresolved` flag.
- The visual-direction refinement and the assisted selection are single model calls with deterministic fallbacks; their quality was only tested with a fake model.
- Brand images used as a stand-in picture are the project's own images of type *image* (at most 6, 8 MB each).
- The Content & Brand Reviewer checks **every template creative** by measurement (size, text fit, contrast, logo) and a **sample** of them with the vision model (`visionReviews`, up to 4 per round in Hybrid Production); the original AI images are not individually reviewed beyond the concept critique and the Template Quality Reviewer's existence/lineage checks.
- The free preview uses placeholder pictures and each template's sample text; it cannot show your final copy or the generated originals.

## Visual system: template collections, the campaign design and web visual discovery

One decision decides how a campaign looks, and it is made in ONE place: the **campaign design** of a Hybrid Production run. The project creation wizard no longer asks for a visual style or for formats; the Hybrid settings no longer have a style picker; the Visual Researcher, the Template Selector, the Layout Designer, the Template Quality Reviewer and the exporter all read the same approved design.

### The ten template collections

A **collection** is a cohesive design system; a **template** is one composition. `packages/agents/src/collections/`:

| | |
|---|---|
| `library.ts` | the ten collections (`minimal_tech`, `bold_startup`, `premium_editorial`, `modern_corporate`, `luxury_hospitality`, `lifestyle_human`, `clean_ecommerce`, `dynamic_events`, `contemporary_geometric`, `soft_organic`): id, number, description, industries, audiences, the template list and the role each template plays (hero, highlight, benefit, promo), type system, layout principles, picture treatment, decorative system, default palette, palette rules, preview assets, version, enabled. Ids are stable API (stored with campaigns). |
| `theme.ts` | `applyCollection(template, collection)`: the collection's **design tokens** (type per text role, corner radii, button shape and label, hairline weight, picture mask / saturation / scrim / tint, decorative pattern) are applied to a template at render time. Pure and deterministic; the library template is never copied or changed, the result keeps its id and version. Geometry belongs to the template, the way things look belongs to the collection. |
| `registry.ts` | lookup, `validateCollections` (ten collections, valid and active templates, every role covered, story / feed / banner coverage without any user-supplied fact), `coverageOf`, `themedTemplates`. |
| `design.ts` | the **campaign design** object (collection id and version, the five palette colors with the source and confidence of each, the colors the user edited by hand, output formats, picture sourcing, confirmed), its validation, palette contrast checks, `switchCollection` (edited and brand colors are kept; only colors that were mere defaults follow the new collection), format options (Instagram post / story, Facebook post, LinkedIn post, website banner, flyer, billboard, other). |

The 31 original templates are all still in the library and all belong to at least one collection; 20 new templates (`templates/library/collections-a..d.ts`) give every collection compositions of its own. The library version is `launchpilot-builtin-2` and the collection library `launchpilot-collections-1`; both are stored with a campaign. `node --import tsx src/collections/tools/collection-sheet.ts <outDir> [--collection id] [--class square|story|banner ...] [--palette p,s,a,bg,text]` writes contact sheets drawn by the real renderer.

### The campaign design (single source of truth)

* **Where:** the "Campaign design" section of the Hybrid settings (`apps/web/src/components/campaign-design.tsx`): A choose a collection (ten cards with real renderer previews), B review and edit the palette (real color pickers, source and confidence per color, reset to detected colors, restore the collection defaults, re-analyze), C choose output formats (a format the collection cannot draw is marked and blocks the start with the options listed), D picture sources, E free live preview with your logo, then "Use this design for the campaign". The plan, the budget and the single spending approval follow, unchanged.
* **Stored:** as a per-project draft (`CampaignDesignDraft`, one row per project: a refresh keeps it) and, when a run starts, inside the run's Hybrid settings (`FactoryRun.configJson`, the campaign package and the ZIP `design/campaign-design.json`). Cancelling, failing, continuing or exporting never changes it. A later edit of the draft never alters a campaign that already ran.
* **Used by:** `directionFor` locks the collection's style, the approved palette and the collection's type system into the Visual Direction Brief (a model refinement can sharpen the brief but never replace them); the Template Selector only sees the collection's templates (drawn with its tokens) and scores them by the role they play in a campaign; the Layout Designer renders with exactly the approved palette (the approved background and text become the renderer's paper and ink); every creative records its collection, collection version and palette key; the Template Quality Reviewer reports a `design_mismatch` for any creative that does not belong to the approved design.
* **Plan checks (free):** the design must be confirmed, the text must be readable on the background (contrast), and the collection must be able to draw the chosen formats with the content the campaign has. These are blockers shown before any approval, with what you can do instead; nothing is switched silently.
* **Legacy:** a project that stored a style word (`minimal`, `cinematic`...) keeps it as an "earlier style note" and as a first suggestion for a collection; it is never an active choice. A campaign configured before collections has no design and behaves exactly as before. `HybridSettings.style` is kept only so older runs stay readable; with a design it mirrors the collection.

### Brand palette analysis (no model, no paid call)

`packages/agents/src/brand/`. Source priority (a lower tier wins, but disagreements are shown and lower the confidence): the user's own colors, declared design tokens and brand guidelines, the logo, the website's visible branding, the repository's styles, other pictures, and last the collection default (which says it is a default).

* **Website:** one page and up to three of the site's own stylesheets through `WebFetchTool` (https/http only, public addresses only, every redirect re-validated, DNS checked at connect time, robots.txt honored, bot-protection pages reported, byte and time limits). CSS custom properties named like roles (`--primary`, `--accent`, shadcn HSL triples, OKLCH), `theme-color`, button / header / body / link styling. A white page background is only ever a background candidate. Dark-mode scopes are ignored.
* **Repository:** the official GitHub REST API for PUBLIC repositories only; a few theme files (`tailwind.config.*`, design-token JSON, `theme.css`, `globals.css`, brand notes) are read as text and never executed. Evidence names the file ("Repository file tailwind.config.ts: color brand"). A private or missing repository is reported, never read.
* **Logo and pictures:** local Sharp pixel analysis: transparent pixels ignored, the border-dominant color is the background, near-white is never a brand color, similar colors merged, anti-aliasing blends dropped, ranked by share weighted by saturation. SVG and PDF are refused.
* **Brand documents:** a color counts only when a role word ("Primary", "Accent") is on the same line.
* The readings are cached for 24 hours per project and input fingerprint (`BrandPaletteAnalysis`), so editing colors or trying another collection never fetches a site again; "Re-analyze" does.

### Web visual discovery and licensed pictures

`packages/agents/src/imagery/`. Nothing is configured by default: a fresh install contacts no image provider, and nothing is invented when none is configured.

| Provider | Kind | Switch on | Terms checked (read 2026-11-02) |
|---|---|---|---|
| Pixabay | licensed | `PIXABAY_API_KEY` | Pixabay Content License: commercial use, cropping and text overlays allowed; credit optional; download and store allowed, no permanent hotlinking |
| Pexels | licensed | `PEXELS_API_KEY` | Pexels License; Pexels has paused issuing new keys (existing keys work); asks for a credit |
| Openverse | licensed | `OPENVERSE_ENABLED=true` | per-work Creative Commons license; asked with `license_type=commercial,modification`; NC / ND are dropped, BY-SA is flagged, and **every** result needs a check at its source (Openverse does not verify licenses) |
| Brave web images | **reference only** | `BRAVE_SEARCH_API_KEY` + `LAUNCHPILOT_REFERENCE_IMAGE_SEARCH=on` | its terms grant no right to store or adapt a result |

Not used: Google Custom Search (closed to new customers), Bing search (retired), Unsplash (its API requires hotlinked URLs and does not clearly cover storing a cropped copy for an ad; it can be added when Unsplash confirms that use), Pinterest (see below).

* A **licensed** candidate becomes a project picture only when you choose it ("Add to project"); the license must allow advertising use, a picture that shows people always needs your confirmation, and the file is downloaded through the SSRF-guarded fetcher from the provider's own host. The provenance (provider, creator, license, credit line, hash, time) is stored with it (`ImageProvenance`) and its credits are written to `CREDITS.txt` in the export of every campaign built from it.
* **Reference-only** results (search engines, Pinterest) are shown for inspiration with a link. They are never downloaded, never stored (the 24-hour search cache holds licensed candidates only), never sent to a model, never an asset and never in an export: `assetOriginOf('REFERENCE_ONLY')` is `null` and the only gate through which a third-party picture can enter a campaign (`acquireLicensedImage`) refuses them.
* The **Visual Researcher** builds focused search intents deterministically from the business text and the visual direction, queries the configured providers (a failing provider never blocks the run) and records candidates and reference links in the campaign; none of it is added to the campaign. No paid OpenAI call is made to compensate for a missing provider.
* The **Source Selection Planner** (free, deterministic) shows where each concept's picture comes from and how many paid image requests the plan makes. It never changes the number of AI images you asked for: when your own or licensed pictures could replace some, it offers a smaller number as a suggestion that only your click applies. The modes are "prefer existing / licensed", "balanced" and "prefer original AI images".
* **Pinterest:** campaigns never need a Pinterest account. A Pinterest result is never downloaded, copied, analyzed or reused, and Pinterest links are not copied into an exported package. The older optional board browser in Settings > Integrations is untouched but is no longer part of the campaign flow.

### Migration

`20261107090000_visual_system` is additive: four new tables (`CampaignDesignDraft`, `BrandPaletteAnalysis`, `VisualDiscoveryRun`, `ImageProvenance`). Apply it with `pnpm db:deploy` (check first with `pnpm db:status`; the Prisma CLI does not read the root `.env` by itself, which is why the root scripts go through `dotenv`). Until it is applied the design endpoints answer 503 with that instruction; nothing else is affected.

`20261108090000_no_ai_image_library` (NO AI HYBRID) is additive too: one new table (`ProjectImage`, the image library with rights) and four new nullable/defaulted columns on `ImageProvenance` (`sourceKind`, `originalUrl`, `perceptualHash`, `rightsJson`). Apply it the same way (`pnpm db:deploy`).

## Real pictures: sourcing, rights and provenance

**NO AI HYBRID** (preset `no_ai_hybrid`) is Hybrid Production without any image generation. The Mozaik agents still do the thinking: Product Discovery, the Marketing Audit and the Strategy read the business, the copywriter writes, the Visual Researcher sources pictures, the Template Selector matches them to your collection, the Layout Designer renders and the reviewers check. The text model is the only paid thing. **No image-generation request is ever made**: not for a missing picture, not for a background, not for a "just this once". The screen says it plainly: *AI-generated images: 0 · Existing/licensed imagery: enabled · AI agents for strategy and copywriting: enabled*.

Defaults: 5 concepts × 4 template creatives = **20 finished creatives**, 0 AI images, 1 template collection, 1 approved palette, the formats you chose, local Sharp/SVG rendering for everything. The counts are settings; the guarantee is not.

### Where the pictures come from (priority order)

1. **Your uploads** (logo, product photos, screenshots): approved by default, because you provided them.
2. **Your website**: a bounded read of a few public pages of the *same* site (`<img>`, `srcset`, `<picture>`, Open Graph/Twitter/schema.org images), through the same SSRF-guarded, robots-respecting fetcher as the rest of the product (`discoverWebsiteImages`). Icons, logos, tracking pixels, vectors and tiny files are rejected; several sizes of one picture are one candidate. **Not one picture is downloaded** at this stage. A picture on a site belongs to whoever made it, so each is a *candidate* until you confirm that you own it or hold the rights (an *attestation*, recorded with its time). Only then is the file fetched, measured, de-duplicated and stored with its provenance. A page behind robots.txt or bot protection is reported and skipped, never worked around. Pictures served by another host are flagged and not previewed.
3. **Your GitHub repository**: the file *tree* is listed through the official REST API (`listImageFiles`; nothing is cloned or executed). A public repository is not a license to reuse its pictures and its license usually covers code only, so these are candidates with the same attestation rule; the file is fetched through the API only after it.
4. **Social profiles**: **reference links only.** LaunchPilot has no integration that reads pictures from Instagram, Facebook, LinkedIn, TikTok or X, so none is claimed; nothing is scraped and Google Search is not used as a proxy. The link is shown so you can open it; if you own a picture there, save it and upload it (it becomes your own upload). Pinterest results are links only, always. The campaign never needs a social connection.
5. **Licensed stock** (Pixabay, Pexels, Openverse; see the provider table above): rights come from the provider's license, not from the search result. `REFERENCE_ONLY` results can never be exported.

### Rights are a hard gate

`exportEligibility` is the one function that says whether a picture may enter a creative, and it is applied three times (when the library is loaded, when the Visual Researcher builds the library, and again when the Layout Designer draws the picture; the Template Quality Reviewer reports `ineligible_source` as a blocker). A blocked license, a reference, an unattested website/repository picture, a stock license that needs a check and an unapproved picture are all outside the selection, whatever their score. Ranking can only reorder what is already allowed: in the candidate list a cleared picture always sorts above one the owner could still clear, which always sorts above one that can never be used. Approval never overrides a third-party license, and an upload is the only thing approved by default.

### Scoring, de-duplication and allocation (deterministic, free, no vision model)

* **Score** = relevance to the business and the concept, resolution, aspect ratio for the chosen formats, composition and exposure, subject visibility, room for typography, brand-color compatibility, originality and uniqueness, weighted by what the chosen collection needs from its pictures (Premium Editorial wants negative space, Clean E-commerce a clear subject, Minimal Tech product screenshots…). The measurements are taken locally with sharp (`analyzeImage`); a candidate that has not been downloaded is scored from its words and declared size and says "estimated".
* **Near-duplicates** are removed by a 64-bit perceptual hash (a resized or re-compressed copy is caught; a different picture is not).
* **Allocation**: a concept uses 1–3 pictures, a picture may serve several creatives, and every reuse of a picture gets a *different crop* and, through the selector's penalty for the same template on the same picture, a different composition. 20 creatives do not need 20 photographs. With no picture the creatives are text-first templates of your collection; if no template fits, the creative is **blocked with its reason**, counted as planned and not delivered, and the campaign is labelled **PARTIAL**. Nothing is faked to reach 20.

### Fully automatic authorized-stock mode (optional)

Off by default (`design.autoStock`). When on and the library is thin, the Visual Researcher searches the configured licensed providers with queries built from the concepts, the audience, the objective and what the collection needs, and adds the best pictures **whose license the provider clears** (never one that needs a check, e.g. pictures of people), through the same single download gate as a manual choice. Credits are recorded in `CREDITS.txt`. With a provider not configured it says so and adds nothing. Paid search providers (Brave, reference only) are never used in a run unless you allow it.

### Budget

One total, as everywhere. The plan shows AI image requests **0**, the maximum text-model calls, the pictures found/approved and the cost estimate of the text model; image-generation cost is 0, not unknown. Starting needs the one budget approval and your confirmation: the text model is paid. Nothing else is silently paid for.

### Provenance and the archive

Every picture records its source, address, creator, license, how the license was verified (provider / owner / owner-attested / owner-reviewed), whether download, commercial use, derivatives and passing the original on are allowed, who approved it and when, and a hash. Every creative records its collection, template, source pictures, concept, format, palette and rendering version. The ZIP contains `campaign.json`, `strategy/`, `copy/`, `design/`, `images/approved-sources/`, `images/templates/`, `layouts/`, `usage/` (`sources.json`, `rights.json`), `manifest.json` and `CREDITS.txt`. **An original picture is included only where its rights allow handing the unaltered file on** (yours and attested ones: yes; Pixabay and Pexels originals: no, only the advertisements made from them).

### Providers: what works today

| Source | Status |
|---|---|
| Uploads, image gallery, rights gate, scoring, allocation, rendering, archive | operational (verified with mocked providers and an isolated database) |
| Website image discovery | operational; verified against a local fixture site (a real website was not contacted) |
| GitHub image discovery | operational through the official API; verified with a mocked client (the real API was not contacted) |
| Pixabay | operational code, **needs `PIXABAY_API_KEY`**; verified with a mocked API |
| Pexels | operational code, **needs `PEXELS_API_KEY`** (the provider has paused new keys); mocked |
| Openverse | operational code, **needs `OPENVERSE_ENABLED=true`**; mocked |
| Brave web images | reference only, paid, **needs a key and the opt-in**; mocked |
| Instagram, Facebook, LinkedIn, TikTok, X, Pinterest | **no integration**: reference links only |
| Unsplash, Google Images, Bing | **not used** (see above) |

### Manual test

1. `pnpm db:deploy`, then `pnpm dev`. Create a project with a name, a one-sentence description and (optionally) a website and a repository.
2. Open **Campaign → Campaign design**, choose a collection, check the palette and the formats, then confirm. Open **AVAILABLE IMAGES**: upload a few pictures, press **Find images**, and approve a website candidate (tick the confirmation) or add a stock picture.
3. Choose **NO AI HYBRID**. Review the plan: *AI-generated images: 0*, the pictures per source and the free preview. Approve the one budget and start.
4. When it finishes: 20 creatives, the counts, the rights per creative, the ZIP with `usage/` and `CREDITS.txt`. For a partial campaign, add pictures and start again.

## Get Content: an optional step before the campaign (logo, photographs, palette)

**Get Content** is a button in **Campaign Design** (Hybrid Production and NO AI HYBRID). It is **optional**: if you never press it, the campaign runs exactly as it did before (no new gate, no new required data, no website analysis you did not ask for, no extra model call). Pressing it starts a small, separate, **free** discovery job (`GetContentRun`). It does **not** create a campaign run, needs **no budget** and makes **no OpenAI request** (it is deterministic code over material you already supplied).

### What it looks at

| Source | What it does |
|---|---|
| Project uploads | the logo you uploaded, and any picture whose name says it is a logo |
| Official website | a bounded read of the same site through the existing SSRF-guarded, robots-respecting fetcher: structured-data `logo`, header/nav images, `<link rel=icon>`, and the photographs (`discoverWebsiteImages`) |
| GitHub repository | the file **tree** through the official REST API (nothing is cloned, nothing is executed): `logo*`, `brand*`, SVG/PNG marks and photographs |
| Existing approved assets | the logo and the photographs you approved earlier (reused, never downloaded again) |
| Palette | `suggestPaletteFor` over the same sources (uploaded logo, website CSS and meta, repository) |

Every source is its own step with its own status (`ok`, `empty`, `unavailable`, `blocked`, `failed`, `skipped`, `cancelled`), its own timeout (website 45 s, repository 40 s, palette 40 s) and its own message. A source that fails or cannot be reached never fails the others and is **never reported as analysed**. One run per project at a time (pressing the button again returns the running job), a cancel button, and a run younger than 24 hours for an unchanged project (same website, repository, uploads, approved logo, collection) is reused; **Try again** forces a new one.

### The logo

Candidates are listed with a preview, the source, the file name, dimensions, format, a confidence (high/medium/low with the reasons: *structured data*, *header*, *names the business*, ...) and the rights state. The order is: **uploaded logo, previously approved logo, website, repository, other uploads**. A weak candidate never wins just because of its source, partner/client/social/technology marks (`partner-logo-padi.png`, `react-logo.svg`) are penalized or left out, and a **favicon is a last resort**: capped at low confidence, listed after every real logo and **never selected automatically**. Nothing is approved for you. You can approve one, reject it, upload another or continue without a logo.

A logo found on the website or in the repository is a *candidate* until you confirm that you own it or hold the rights (a recorded attestation); only then is the file downloaded (≤ 5 MB), measured and stored. SVG logos are fetched as text, **sanitized** (scripts, event handlers, entities, `foreignObject`, embedded documents and every external reference are removed) and **rasterized to a PNG**; the original SVG is not kept.

### The photographs

They go into the existing image library (the same `ProjectImage` rows, provenance and rights gate as NO AI HYBRID; a new `role` column separates `photo` from `logo`). Select any number, then **Approve selected images** (website and repository pictures need the rights confirmation first and are downloaded only then), **Skip images** or **Continue without images**. Tiny icons, tracking pixels and logos are excluded; duplicates are caught by the content hash (logos) or a perceptual hash (photographs). A rejected picture stays rejected.

### The palette

Five colors (primary, secondary, accent, background, text) with hex, source and confidence. **Use suggested palette** fills the **existing** Campaign Design palette editor (there is no second palette store). Colors you edited yourself are never overwritten; a suggestion never changes the collection, which stays authoritative.

### Storage, reuse and what reaches the agents

* Approved content is stored at the **project** level (`ProjectBrandContent`: the canonical logo asset, rights, approval time; the logo is also a normal `logo` project asset) and reused by every later campaign of the project. Nothing is erased without confirmation; existing campaigns are not modified. All of it is tenant-isolated by project ownership.
* `ProjectBrandService.logoAsset(projectId)` is the one logo chooser: the approved logo, else the newest uploaded logo (the earlier behavior).
* An approved logo reaches the design config, the Template Selector, the Layout Designer, the Brand Reviewer and the export. It is placed in eligible creatives with its aspect ratio kept and padding; where it would not read on the background, the renderer adds a quiet plate (`logo_plate_added`); where it cannot be placed legibly it is **omitted with a recorded reason** (`logo_omitted`, minor). The result shows *Logo applied in N of 20 creatives*.
* Approved photographs reach the Visual Researcher, the Selector and the Layout Designer through the same rights gate (`exportEligibility`) as any other picture.
* Text taken from a website or repository is **data, never an instruction**: no raw external text is passed to a language model by this feature (only counts).
* The ZIP gains `design/brand-content.json` and `design/brand/logo-*` (logo file, source, rights, creatives with / without it, approved photographs).

### API

`GET /projects/:id/get-content`, `POST /projects/:id/get-content` (`{refresh?}`), `POST .../cancel`, `POST .../logo/upload`, `POST .../logo/:candidateId/{approve,reject,restore}`; photographs use the image-library endpoints `.../images/approve-batch` and `.../images/reject-batch`.

### Migration

`apps/api/prisma/migrations/20261109090000_get_content` (adds `ProjectImage.role`, `GetContentRun`, `ProjectBrandContent`; additive, existing rows keep working). Apply it with `pnpm db:deploy`; without it the button reports that the tables are missing and the rest of the product is unaffected.

### Manual test (nothing is contacted unless you press the button; no paid call)

1. `pnpm db:deploy`, then `pnpm dev`. Open the project (e.g. Firmenfels), **Campaign**, choose Hybrid Production or NO AI HYBRID and a collection.
2. Press **Get Content (optional)**. Watch the five source rows, review the **logo** candidates (a favicon is last and never pre-selected), tick the rights statement and approve the right one, or upload another.
3. Review the **photographs**: select the ones you may use, tick the rights statement, **Approve selected images** (or **Skip images**).
4. Review the **palette**: **Use suggested palette** or edit the colors yourself.
5. Confirm the design, **Review plan**, the free preview, approve the one budget and start. In the result you should see the logo line and the approved photographs; the ZIP has `design/brand-content.json`. Skipping every step above gives the earlier flow unchanged.

### Limitations

* Verified against fixtures and mocked clients; a real website or repository was not contacted by the tests.
* A logo that exists only as inline `<svg>` markup in a page (no address) cannot be imported; upload it instead.
* Social profiles are not read (no integration); upload a picture you own.
* The palette step re-reads the site or repository through the existing palette analyzer (its own 24 h cache).

## Tests

```powershell
pnpm test:agents    # 538 tests, real Mozaik runtime + real cloud-sdk + fake OpenAI (text and image) server, no database; includes the
                    # template library, the renderer, the style library, the Hybrid planner/selector and the Hybrid end-to-end runs
pnpm test:api       # 173 e2e tests, needs PostgreSQL on :5433 (fake OpenAI server, mocked Pinterest HTTP, no real calls)
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
