# MyChat Full Platform Audit

Baseline: `daacffad107a6513fa6b0ee5b63e512c102cdf2b`

Audit branch: `refactor/platform-v2`

Measured: 2026-07-16 (America/Chicago)

## Executive conclusion

The baseline is online and its release evidence is internally consistent: Verify,
Security, image publication, production activation, and an independent keepalive
all passed for the same Git revision and migration contract. This audit therefore
does not describe a current production outage.

The platform is not yet independently provable as production-grade. The largest
remaining risks are executable model output without a dedicated iframe policy,
an authenticated mutation route without bounded parsing or rate limiting, a
shared Web/worker failure domain, a release artifact identity split, per-client
database polling, and multiple competing browser/server data authorities. The
test suite is broad but does not currently prove the most important user journeys
against production-like dependencies.

Priority means:

- **P0**: close before expanding users or enabling untrusted workloads.
- **P1**: close before claiming scalable, recoverable production operation.
- **P2**: bounded maintainability or retirement work that can follow the P0/P1 path.

## Evidence and reproducibility

The complete measured inventory is in `docs/refactor/platform-inventory.md`.
Primary evidence commands are deterministic and do not require production
credentials:

```bash
npm run architecture
npm run migration:contract
npm run check
npm run lint
npm run test:coverage
npx knip --config knip.json
npx jscpd --workers 1 --min-lines 8 --min-tokens 70 app components lib scripts
rg -n "process\.env|\.rpc\(|\.from\(" app components lib job-worker.ts scripts
```

The quality baseline is 583 passing Node tests with 82.38% line, 80.91% branch,
and 87.64% function coverage. The architecture graph contains 356 files, 891
runtime edges, and no cycles. These facts are useful safeguards, not substitutes
for the missing system evidence described below.

## Finding register

| ID | Priority | Area | Current state |
| --- | --- | --- | --- |
| F-01 | P0 | Artifact isolation | Open |
| F-02 | P0 | Request resource boundary | Open |
| F-03 | P1 | Runtime topology | Open |
| F-04 | P1 | Release artifact identity | Open |
| F-05 | P1 | Realtime event delivery | Open |
| F-06 | P1 | Mutation authority | Open |
| F-07 | P1 | Database contracts | Open |
| F-08 | P1 | Worker control-plane load | Open |
| F-09 | P1 | SVG, Mermaid, and main CSP | Open |
| F-10 | P1 | Runtime configuration | Open |
| F-11 | P1 | Test realism | Open |
| F-12 | P1 | Staging, paging, restore, and soak | Open |
| F-13 | P1 | Outbox delivery semantics | Open |
| F-14 | P2 | Compatibility surface | Open |
| F-15 | P2 | Function complexity | Open |
| F-16 | P1 | Budget/catalog contract | Open |

## Detailed findings

### F-01: Executable model artifacts lack a dedicated trust boundary

**Priority:** P0 security

**Evidence:** `components/artifact-frame.tsx:88-130` builds an executable bootstrap
document; lines 112-118 accept wildcard-window messages, and lines 174 and 182
send model HTML with target origin `*`. The final iframe at line 190 uses
`sandbox="allow-scripts"`, which provides an opaque origin but still deliberately
executes script. No CSP is embedded in `srcdoc`. The parent only validates
`event.source`; there is no unguessable channel or message schema.

**Reproduce:** render an artifact containing script that sends a syntactically
valid `{__art:"h",v:...}` message or attempts `fetch`, form submission, navigation,
and remote resource loads. Inspect the iframe document and network log.

**Consequence:** model-controlled code has more capability than required for a
preview and can forge protocol messages. Its effective egress restrictions depend
on browser inheritance of the parent policy rather than an explicit artifact
contract. Future CSP relaxation can silently enlarge this surface.

**Fix:** keep the opaque origin, embed a restrictive iframe CSP (`default-src
'none'`) in the bootstrap before any model content, enable individual capabilities
only from a reviewed allowlist, and bind messages to a per-frame random token.
Validate source, token, discriminant, sizes, numeric ranges, and lifecycle. Render
static artifacts without scripts where possible.

**Acceptance:** malicious fixture coverage proves no network, forms, popups,
top-navigation, storage, or protocol forgery; only a correctly tokened parent can
update the preview; teardown invalidates the token; supported artifacts still
render in desktop and mobile Playwright projects.

### F-02: Message deletion has no bounded parser or distributed rate limit

**Priority:** P0 availability and abuse resistance

**Evidence:** `app/api/messages/delete/route.ts:5-15` authenticates and then calls
unbounded `request.json()`. It does not call `enforceRequestRateLimit` and returns
legacy `{error}` objects rather than the v1 error envelope. In contrast,
`app/api/chat/route.ts:28-49` rate-limits before bounded `readJson` parsing.

**Reproduce:** send an authenticated request with an oversized declared
`Content-Length`, then an oversized chunked body without that header. Repeat at a
high rate and observe that this route has no admission decision before parsing.

**Consequence:** an authenticated or anonymous-session principal can consume heap
and CPU before validation and can repeatedly invoke a write/RPC path without the
shared distributed budget.

**Fix:** enforce authentication and distributed rate limiting before reading the
body, use `readJson` with a small explicit byte cap, validate the ID array, and map
all errors through the stable v1 envelope with request ID and retry metadata.

**Acceptance:** focused tests cover declared and chunked oversized bodies, empty
and malformed JSON, ID count/shape limits, 429 and rate-limit dependency failure,
authentication failure, and all deletion result mappings. Body reads must not
start when admission rejects the request.

### F-03: Web and worker share one service and supervisor failure domain

**Priority:** P1 availability

**Evidence:** `render.yaml:1-9` declares one Web Service using `npm start`.
`scripts/start-production.mjs:22-36` selects Web and worker by default, and lines
83-93 terminate both children when either exits. `job-worker.ts:101-133` starts
four queue workers, five heartbeats, outbox, lifecycle sweeper, and billing monitor
inside that worker process.

**Reproduce:** run the production start command and terminate either the Next.js
or worker child. The supervisor stops the sibling and exits the service.

**Consequence:** a provider/worker defect can remove the HTTP plane, while a Web
defect removes all background progress. Resource scaling, readiness, rollouts, and
incident isolation cannot be tuned independently.

**Fix:** declare independent Web and background-worker units using one immutable
artifact and role-specific start commands. Run maintenance jobs separately or
with explicit singleton ownership. Give each role its own readiness, shutdown,
resource, concurrency, and scaling contract.

**Acceptance:** killing a worker does not interrupt Web readiness; restarting Web
does not create duplicate job side effects; worker absence is visible on a worker
SLO without marking Web liveness false; rolling each unit independently passes a
chaos scenario.

### F-04: CI-attested image is not the artifact Render executes

**Priority:** P1 supply chain and release correctness

**Evidence:** `.github/workflows/release-image.yml` publishes and verifies a GHCR
digest. `render.yaml:4-8` configures Render's Node source build, and the release
workflow asks Render to deploy an exact Git commit. The deployment manifest binds
the digest and commit as evidence, but Render rebuilds source rather than pulling
that digest.

**Reproduce:** compare the published GHCR image digest to the active Render deploy
metadata. The deploy exposes a commit and Render build, not the GHCR image digest
as its executable artifact identity.

**Consequence:** dependency registry state, build environment, or platform build
behavior can make the tested image differ from production while all commit-based
gates still pass.

**Fix:** deploy the exact CI-built digest to staging and production, or remove the
unused image attestation and make the Render build itself the sole signed artifact.
The preferred path is build once, promote one digest, and attest SBOM/provenance.

**Acceptance:** Verify, staging, canary, production runtime, and rollback records
all report the same digest and revision; a mismatched digest blocks promotion.

### F-05: Every SSE connection polls and renews against PostgreSQL

**Priority:** P1 scale and database availability

**Evidence:** `lib/jobs/event-stream.ts:5-10` starts event polling at 250 ms,
refreshes job state every five seconds, and renews admission every 15 seconds.
`supabase/migrations/20260713260000_stream_and_asset_lifecycle.sql:74-77` serializes
admission through one global advisory lock and deletes expired rows; the same
function performs principal, address, job, and global counts before admitting.

**Reproduce:** open N concurrent streams and measure calls to event reads, job
reads, admission renewal, and acquisition. Repeat at 2x expected peak and record
DB QPS, connections, lock wait, and p95 event latency.

**Consequence:** mostly idle browsers create continuing SQL work. Admission itself
becomes a serialized critical section, so connection bursts can amplify database
latency exactly when reconnect pressure is highest.

**Fix:** keep the sequenced event log for durable replay, but add a fan-out layer
for online notification. Reconnect by `afterSeq`; use O(1) distributed connection
counters or a managed gateway and multiplex subscriptions per browser/user.

**Acceptance:** 2x peak load stays within the declared connection/QPS budget,
p95 event delivery is under one second, reconnect replay loses no events, duplicate
and out-of-order deliveries are idempotent, and admission has no global scan/lock.

### F-06: The browser remains a business-write coordinator

**Priority:** P1 data correctness

**Evidence:** `lib/data/conversations.ts:142-181` directly creates and mutates
conversations; lines 221-251 insert messages and update IndexedDB; lines 265-330
read/merge/write message projections. `components/literary-chat/use-chat-generation.ts`
inserts user and assistant placeholders before enqueue. Direct writes also remain
in `lib/data/projects.ts`, `lib/data/memory.ts`, `lib/data/profile.ts`,
`lib/data/artifacts.ts`, and `lib/code-data.ts`.

**Reproduce:** interrupt the network between placeholder insertion, `/api/chat`
enqueue, SSE terminal delivery, server message persistence, and local cache update.
Refresh at each point and compare Supabase, job snapshot, React state, IndexedDB,
and local storage.

**Consequence:** there is no single atomic authority for a chat turn. Partial
failure can leave orphan placeholders, stale terminal data, lost media projections,
or client-specific repair behavior.

**Fix:** move critical mutations behind versioned BFF use cases. Atomically create
conversation/messages/job or use an explicit idempotent saga. Treat server snapshot
plus event sequence as authority; make browser caches disposable projections.

**Acceptance:** a fault-injection matrix at every boundary always converges after
refresh; duplicate submit is idempotent; one reducer applies `(jobId, seq)` once;
the browser performs no direct writes for the migrated vertical slice.

### F-07: Database and RPC contracts are not generated or drift-checked

**Priority:** P1 correctness

**Evidence:** runtime code references 50 distinct RPCs and 25 `.from(...)`
identifiers, but no generated Supabase `Database` type exists. Sixteen exact
`as unknown as` bridges remain. Repository adapters manually decode JSON results.

**Reproduce:** search for `interface Database`/`type Database` and inspect the
Supabase client generic. Compare RPC arguments/results in application code to the
latest migration definitions.

**Consequence:** schema or RPC changes can compile while shifting nullability,
names, enums, or result shapes. Runtime decoders catch some failures but do not
provide producer-consumer compatibility at change time.

**Fix:** generate database types from the canonical schema, add typed RPC wrappers
and runtime schemas at external boundaries, and fail CI when regenerated output
differs. Do not rewrite historical migrations.

**Acceptance:** every runtime RPC is typed, schema generation is deterministic,
CI detects drift, broad bridge casts in migrated modules are zero, and PG16
contract tests validate representative success, tenant denial, and malformed input.

### F-08: Lease and heartbeat cadence spend control-plane capacity unnecessarily

**Priority:** P1 capacity and failure recovery

**Evidence:** `job-worker.ts:101-117` creates five independent heartbeat loops and
four workers with 120-second leases but an explicit two-second renewal. The
`JobWorker` default at `lib/jobs/worker.ts:62-73` already derives one-third of the
lease. This turns four active jobs into up to 120 lease RPCs per minute rather
than roughly six, before heartbeats and other monitors.

**Reproduce:** run four occupied workers for one minute and count `renew_job_lease`
and `heartbeat_job_worker` calls. Compare the explicit setting to the class default.

**Consequence:** avoidable database traffic reduces capacity for event and product
queries and creates synchronized renewal spikes. Excess polling also obscures the
real recovery-time tradeoff.

**Fix:** derive renewal near one-third of lease with bounded jitter, measure lease
loss/recovery, and consolidate heartbeats to process/fleet scope unless per-queue
readiness is proven necessary.

**Acceptance:** timing tests prove renewals remain safely before expiry under
bounded delay, workers fail closed at the lease deadline, jitter prevents a herd,
and measured RPC volume meets a documented budget.

### F-09: SVG, Mermaid, and main-page CSP hardening is incomplete

**Priority:** P1 security

**Evidence:** `lib/artifact.ts:138-160` sanitizes SVG with regular expressions and
injects the result into the DOM. It does not parse namespaces, CSS URL values,
animation references, unquoted handlers, or all external-resource attributes.
`components/mermaid-chart.tsx:54-63` does not explicitly set Mermaid
`securityLevel: "strict"` before assigning returned SVG to `innerHTML`.
`next.config.mjs:1-15` includes production `script-src 'unsafe-inline'`.

**Reproduce:** run a malicious SVG corpus covering namespace aliases, embedded
style, external/data URLs, animation, mixed quoting, and malformed markup. Render
Mermaid payloads with links/HTML labels and collect CSP reports.

**Consequence:** regex transformations are not a complete HTML/XML security
boundary. Inline script permission enlarges the blast radius of any markup sink.

**Fix:** use a maintained sanitizer with an explicit SVG profile or render in an
isolated non-script document; set Mermaid strict mode and sanitize output; deploy
a nonce/hash CSP through report-only measurement before enforcing it.

**Acceptance:** a reviewed malicious corpus is blocked, supported diagrams render,
Mermaid is explicitly strict, production pages run without `script-src
'unsafe-inline'`, and CSP violation telemetry is monitored during rollout.

### F-10: Configuration is scattered and role validation is late

**Priority:** P1 operability

**Evidence:** Render declares 37 environment keys and runtime/scripts contain 38
statically named `process.env` reads plus dynamic concurrency/provider keys.
Validation is distributed across provider, health, sandbox, OAuth, and worker
helpers. `package.json` also executes `patch:seedream` during install, dev, build,
check, and test, mutating a dependency/source surface as a lifecycle side effect.

**Reproduce:** enumerate `process.env` reads and boot `web` and `worker` roles with
one required value missing or malformed. Observe that failure timing and ownership
differ by subsystem.

**Consequence:** deployments can build and partially start before discovering bad
role configuration; documentation and Render declarations can drift from runtime.

**Fix:** introduce one typed, role-aware startup config module and generated
`.env.example`/documentation. Encode URL, enum, secret-length, mutual-exclusion,
and production-only constraints. Replace the lifecycle patch with normal tested
source or a pinned upstream patch mechanism.

**Acceptance:** Web and worker each fail before serving/claiming on invalid required
configuration, ignore unrelated optional role values, and have exhaustive table
tests; declared and consumed keys are CI-diffed.

### F-11: E2E coverage does not exercise real application transactions

**Priority:** P1 verification

**Evidence:** 133 Node test files pass, but `e2e/smoke.spec.ts` contains only three
scenarios executed in two viewports. The authenticated scenario intercepts
Supabase and application APIs, so it proves shell/navigation behavior rather than
a real enqueue, worker, database, replay, or deletion transaction.

**Reproduce:** inspect Playwright route interception and list the network calls
that reach a real isolated backend. Compare against critical flows below.

**Consequence:** broad unit coverage can still miss contract mismatches, RLS,
serialization, worker handoff, cache convergence, and deployment wiring.

**Fix:** run the built app, isolated PostgreSQL/Supabase-equivalent services, a real
worker, and deterministic mock providers. Cover send/stream/refresh, cancel,
resume, media, delete, Agent confirmation, and GitHub dry-run without mocking the
application's own APIs.

**Acceptance:** CI records real transaction E2E for every critical flow, cross-
tenant negative tests, and provider failure/retry; mocked shell tests remain
separately named and are not counted as transaction E2E.

### F-12: Production-like staging and recovery evidence do not exist

**Priority:** P1 SRE and disaster recovery

**Evidence:** the repository has production health checks, metrics definitions,
dashboards, and runbooks, but no declared production-like staging topology, external
paging destination evidence, PITR/restore drill artifact, or 6/24/48-hour soak
result. Keepalive is a scheduled workflow, not human paging.

**Reproduce:** request the latest immutable staging deploy/digest, restore drill
record with RPO/RTO, delivered test page, and soak time series. None is currently
versioned in the repository or release evidence.

**Consequence:** backup recoverability, alert delivery, memory stability, capacity,
and rolling-restart behavior are assumptions rather than demonstrated properties.

**Fix:** define staging from the same digest, external notification ownership,
RPO/RTO, restore-to-new-database drill, and repeatable load/chaos/soak tooling.
Persist summarized evidence without secrets or user content.

**Acceptance:** restore plus core E2E meets RPO/RTO; a test alert reaches a named
destination; 30-minute then 6-hour then 24-hour gates record RED/USE, DB, queue,
event, memory, and correctness invariants; failures preserve diagnostics.

### F-13: Lifecycle outbox topics are acknowledged after logging only

**Priority:** P1 observability contract

**Evidence:** `lib/jobs/outbox-dispatcher.ts:56-60` maps `jobs.poison` and other
lifecycle topics to log calls. Lines 121-129 then mark those records published.
Cleanup topics perform real work, but `jobs.terminal`/`jobs.poison` have no durable
external consumer in the default dispatcher.

**Reproduce:** enqueue a lifecycle outbox record, run the dispatcher without a
custom observer, and inspect its final state and external effects.

**Consequence:** the system presents reliable-publication semantics while the
only side effect is best-effort process logging. Downstream alerting/audit can be
silently absent after the database marks delivery complete.

**Fix:** either publish to a real durable consumer with delivery ownership and
dead-letter handling, or remove these ceremonial topics and drive metrics/logging
directly from terminal persistence.

**Acceptance:** every retained topic has a named consumer, idempotency contract,
delivery SLO, replay test, and failure alert; otherwise no row is labelled published.

### F-14: Compatibility tombstones and migration history inflate the surface

**Priority:** P2 maintenance

**Evidence:** five POST methods under `/api/agent/tasks` and workspace routes
return HTTP 410. There are 44 immutable canonical migration files, 14,112 effective
SQL lines, 147 historical function-definition statements, and 130 historical
`SECURITY DEFINER` occurrences.

**Reproduce:** list route methods and search for status 410; count migration SQL
and historical function/security-definer statements as documented in the inventory.

**Consequence:** tombstones remain part of routing, test, and security review.
Migration history is valid and must remain immutable, but a large history without
a generated baseline makes new-environment and final-schema review expensive.

**Fix:** prove tombstone traffic is zero, publish deprecation evidence, then remove
routes and tests. Freeze migration history, generate a checksummed schema baseline
for new environments, and continue forward-only migrations.

**Acceptance:** no current client references removed routes, deprecation metrics
remain zero for the agreed window, migration replay still passes PG16, and the
baseline plus migrations produce the same contract digest. Historical files are
never rewritten.

### F-15: Several core functions exceed reviewable complexity

**Priority:** P2 maintainability and defect risk

**Evidence:** ESLint reports 128 functions above complexity 15 and 68 above 80
effective lines. `executeTool` is complexity 175/324 lines; `validateChatRequest`
99; `runChatStream` 73; `runAgentLoop` 64; `runTurn` 57. The dependency graph has
no cycles, so the immediate problem is function responsibility rather than module
cycles.

**Reproduce:** run the recorded complexity and function-length ESLint invocation
from the inventory process and sort violations descending.

**Consequence:** branch interactions become hard to review and mutation-test;
small feature changes can alter unrelated tool, stream, or retry behavior.

**Fix:** extract policy/schema/transport handlers and explicit state reducers in
small behavior-preserving commits. Enforce complexity <=15 and effective length
<=80 for new/changed functions, with explicit generated-code exceptions.

**Acceptance:** targeted characterization tests pass before/after extraction,
changed functions meet thresholds, overall violation counts only decrease, and no
new dependency cycles appear.

### F-16: Agent budget is declared above the active catalog cap

**Priority:** P1 accounting contract clarity

**Evidence:** historical/current enqueue function text in
`supabase/migrations/20260713170000_agent_atomicity_and_balance.sql:134` declares
an Agent `tokenLimit` of 500,000. The active `agent.task` price catalog cap in
`20260713240000_admission_and_reservations.sql:29-53` is 160,000. The admission
trigger at lines 147-152, later reinforced by the reconciliation migration, clamps
the stored budget to the catalog cap.

**Reproduce:** enqueue an Agent task in isolated PG16 and compare requested budget,
stored job budget, reservation quote, and final accounting. Exercise retry and
concurrent enqueue with one idempotency key.

**Consequence:** current database enforcement prevents a 500,000-token stored
budget, but two sources advertise different limits. Operators and application code
cannot tell whether 500,000 is intentional product capacity or stale configuration.

**Fix:** define product execution budget and price/admission cap in one versioned
contract. Preserve the user's available execution resources; this is contract
alignment, not an arbitrary quota reduction. Make retries settle once and expose
requested/effective limits explicitly.

**Acceptance:** one source generates enqueue and catalog values, stored/effective
limits are visible and tested, retry/concurrency never double-settle, and PG16
tests prove reservation plus final accounting invariants.

## Critical data and state paths

### Authentication

```text
Browser -> /api/auth/anonymous or /api/auth/email -> rate limit -> Supabase Auth
        -> HttpOnly/session cookies -> resolveAuth -> tenant-scoped API/RLS
Browser -> /api/auth/github -> signed state -> GitHub OAuth callback
        -> encrypted service-only connection -> opaque browser connection ID
```

Primary gap: authentication boundaries are stronger than several downstream route
contracts; error envelopes and rate limits are not uniform.

### Text and media generation

```text
Browser -> direct conversation/message placeholder writes -> IndexedDB projection
        -> POST /api/chat -> auth/rate/body/quota/model selection
        -> payload object + enqueue_job -> jobs/job_admission_reservations
        -> chat or media worker -> provider -> messages/assets/job_events/finalize
        -> SSE polling/replay -> React reducer -> IndexedDB + browser DB repair
```

Primary gap: enqueue and placeholder creation do not share one authoritative
transaction, and online delivery creates per-client SQL polling.

### Stop, reconnect, and resume

```text
Browser cancel -> /api/v1/jobs/:id/cancel -> cancel_job -> worker lease observes flag
Disconnect -> reconnect with from_seq -> durable job_events replay
Refresh -> generation snapshot + local caches -> resume endpoint when eligible
       -> checkpointed worker attempt -> new events -> terminal snapshot
```

Primary gap: server replay is durable, but browser reconciliation has multiple
writers and lacks a single explicit state machine.

### History deletion

```text
Browser -> /api/messages/delete or /api/conversations/:id
        -> auth -> cleanup RPC -> message/conversation rows + generated-media outbox
        -> outbox cleanup -> private storage deletion -> local cache eviction
```

Primary gap: the message route lacks bounded input/rate/error contracts; cleanup
correctness is otherwise centralized better than ordinary browser mutations.

### Code Agent and confirmation

```text
Browser -> /api/code/chat -> agent.task job -> Agent worker -> E2B workspace/tools
        -> durable steps/events/checkpoint -> waiting_for_user confirmation gate
        -> resume/signal -> fenced continuation -> terminal snapshot/artifacts
```

Primary gap: the workflow abstraction is coupled to the custom job control plane,
and transaction E2E does not prove worker-kill, duplicate signal, or timeout paths.

### GitHub publication

```text
GitHub OAuth -> encrypted service-only credential -> Agent publication plan
             -> user confirmation bound to repo/head/diff/workspace hash
             -> agent.operation job -> GitHub API side effect -> durable result
```

Primary gap: the safety design is strong locally, but real dry-run E2E, token
revocation drill, and side-effect replay/duplicate tests are not release gates.

### Admission, quota, and accounting

```text
enqueue -> active price catalog -> atomic reservation/effective budget
        -> worker checkpoints usage -> terminal settlement -> reconciliation RPC
        -> protected metrics/readiness alert surface
```

Primary gap: requested Agent budget and effective catalog cap have separate source
values; external paging and long-running invariant evidence are absent.

### Worker crash recovery

```text
claim_next_job -> fenced attempt + lease -> periodic renewal/checkpoint
SIGKILL/DB loss -> lease expires -> next worker claims new attempt
               -> replay-safe handler/tool effects -> finalize once -> outbox
```

Primary gap: correctness has detailed unit/PG16 coverage, but the production cadence
is unnecessarily aggressive and no sustained chaos/soak record demonstrates it
under representative concurrency.

## Remediation order

1. Close F-02 with focused tests, then F-08 to reduce control-plane load safely.
2. Close F-01 and F-09 together so artifact and page CSP policies are coherent.
3. Introduce typed config and database/contracts boundaries (F-07/F-10).
4. Deliver `chat.title` behind a provider-independent `WorkflowRuntime` as the
   first vertical slice, preserving the existing implementation as a rollback.
5. Separate runtime roles and artifact identity (F-03/F-04) in staging first.
6. Migrate one complete chat mutation/replay path to server authority (F-05/F-06).
7. Add real transaction E2E, load/chaos tools, staging, paging, and restore evidence
   before any production traffic change (F-11/F-12).

No item in this audit authorizes merging this refactor or changing production.
