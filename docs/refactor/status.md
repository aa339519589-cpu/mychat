# MyChat Platform Refactor Status

Updated: 2026-07-17T06:57:44-05:00

This is the authoritative continuation record for the platform refactor. The
audit in `docs/refactor/full-platform-audit.md` describes the production baseline;
this file records later branch changes without rewriting that baseline.

## Guardrails and identity

- Production baseline: `daacffad107a6513fa6b0ee5b63e512c102cdf2b`.
- Working branch: `refactor/platform-v2`.
- Working-tree base for the current hardening pass:
  `e1fd4d93eaaae080809b4c0c481225a6b6cd1083`.
- The platform authority v2 changes in this record are still uncommitted; they do
  not yet have an implementation commit or CI identity.
- The branch includes `origin/main` through
  `fa6dd1267d77a8747660f9a22bcd984370fb7728` without losing the request-bound
  nonce rendering in `app/layout.tsx`.
- Production is intentionally unchanged by this branch. No merge, production
  deploy, paid Render service, schema migration, or traffic change is authorized.
- Production rollback remains an exact-commit Render deploy plus forward-only
  database compatibility. Destructive database rollback is prohibited.

## Current phase

Phase: platform authority v2, generated database contracts, and pre-PR verification

Status: local verification complete; CI, independent review, and staging evidence pending

The highest-risk request, browser mutation, schema, runtime configuration, Worker
presence, stream admission, outbox ownership, and artifact/CSP boundaries now have
branch remediations. The complete local repository gate passes. CI,
container/security, independent review, and real staging evidence are still required
before any production claim.

## Completed branch work

### Baseline and audit

- Re-established the exact production release at `daacffad` before refactoring.
- Added a reproducible platform inventory and a 16-finding audit with consequences,
  acceptance tests, and remediation order.
- Extended architecture reporting with local dependency fan-in.
- Current architecture check: 382 files, 974 runtime edges, zero dependency cycles.
- Baseline inventory: 581 scanned files and 71,869 effective lines, including
  36,665 runtime TypeScript/JavaScript lines and 14,112 migration SQL lines. These
  are baseline measurements, not silently relabelled as post-refactor counts.
- The integrated head changes 59 files relative to the audit baseline with 5,590
  inserted and 251 deleted physical lines. That delta includes concurrent mainline
  product changes as well as documentation,
  tests, and operations tooling and must not be reported as backend SLOC.

### Request and worker containment

- `/api/messages/delete` now authenticates and applies distributed rate limiting
  before reading a body, enforces a 16 KiB streaming cap and 100-UUID limit, and
  returns stable v1 error envelopes.
- Tests cover declared and chunked oversized bodies, no-read admission rejection,
  rate-limit dependency failure, validation, use-case mappings, and success.
- Job lease renewal changed from a fixed two-second interval to one-third of the
  lease with bounded +/-10% jitter.
- Renewal scheduling is extracted and tested, including fail-closed behavior at
  the existing lease deadline.

### Artifact and application CSP

- Model-controlled HTML/SVG is sanitized with `isomorphic-dompurify`; SVG uses a
  strict tag/attribute allowlist and local-resource rules.
- Artifact `srcdoc` embeds a deny-by-default CSP. Only the nonce-bound bootstrap
  script can execute; connect, forms, frames, workers, objects, and base navigation
  are denied.
- Parent/frame communication uses a random 192-bit capability token and a one-time
  transferable `MessageChannel`; model output cannot use the control channel.
- `document.write`/`document.open` were removed and Mermaid explicitly uses strict
  security mode.
- The main application CSP is generated per request with a random nonce,
  `strict-dynamic`, and no production `script-src 'unsafe-inline'`. HTML is dynamic
  and marked `private, no-store`.
- Node and desktop/mobile Chromium tests cover sanitizer policy, channel binding,
  malicious script/network payloads, unique per-response nonces, framework script
  nonce propagation, and a usable page under enforcement.

### Workflow boundary

- Added a provider-independent `WorkflowRuntime` contract for `start`, `cancel`,
  `signal`, `status`, and ordered `events`.
- `PostgresWorkflowRuntime` adapts the existing durable Job control plane; no live
  durable state or worker handler changed.
- `chat.title` is the first vertical slice. `postgres-v1` is the default and
  `legacy` is the immediate code-path rollback.
- Compatibility tests prove identical execution IDs, idempotency keys, input
  payloads and digests, queues, budgets, retries, metrics, response shape, and
  worker handler. An initially proposed payload version field was removed because
  it would have caused an idempotency conflict with existing title jobs.
- ADR 0002 keeps the PostgreSQL adapter now, rejects a low-value second PostgreSQL
  queue migration, and targets a managed TypeScript workflow staging pilot only
  after representative measurements.

### Reliability evidence tooling

- Added repeatable `ops:load`, `ops:chaos`, and `ops:soak` commands with shared
  bounded response parsing, secret-safe errors, configuration digests, JSONL event
  records, and atomic manifests.
- Mock chaos covers duplicate starts, cancellation races, client-abort recovery,
  and dependency outage recovery.
- Soak progress is atomically checkpointed after every operation and interval;
  resume validates configuration, counters, and cumulative latency histograms.
- Real mode is staging-only: it requires command and environment acknowledgements,
  exact host and revision binding, strict readiness, and separate disposable-write
  authorization. The known production host is permanently rejected.
- The tools do not create a remote chaos endpoint or execute arbitrary hooks.
  Worker/database/provider faults remain external staging operator actions.
- Mock runs verify the harness only. They are not capacity, recovery, cost, or
  production-readiness evidence.

### Platform authority v2

- Chat turn creation is one service-owned transaction covering an optional
  conversation, user message, assistant placeholder, Job, and generation projection.
  Regeneration uses an expected-tail CAS and commits branch replacement, cleanup
  receipts, replacement placeholder, Job, and projection together. Browser code no
  longer directly inserts, updates, or deletes authoritative message rows.
- Agent requested and effective token limits now come from the same activated price
  catalog used by admission, and the chosen price version is recorded in the payload.
- One process heartbeat reports exact per-queue capacity. Readiness v3 accepts only
  fresh, non-draining processes from the requested revision and no longer overcounts a
  process once per queue.
- SSE admission uses bounded O(1) global, principal, address, and Job counters with
  deterministic lock order, lease expiry, hard duration limits, and concurrent tests.
- Only `assets.cleanup` and `payloads.cleanup` are deliverable outbox topics. Lifecycle
  topics without a real consumer are suppressed instead of being labelled published;
  their facts remain in authoritative Job/event/audit records.
- Runtime v15 and immutable schema contract v2 bind all 45 manifest migrations to
  digest `c0c1dd9dcf788761cae5ac5a0bcb3ddd49e13ab8c59638e2c91d53ce1c5fcacc`.

### Generated database and runtime contracts

- A disposable PostgreSQL 16 + pgvector database now replays both canonical baselines,
  the legacy compatibility baseline, all manifest migrations, and the v2 seal before
  generating `lib/supabase/database.types.ts` from catalogs.
- `npm run database:types:check` compares generated output byte-for-byte and is part of
  `npm run verify`; CI uses a digest-pinned PostgreSQL 16 pgvector image.
- Runtime clients use `SupabaseClient<Database>`. Generic RPC correlation is isolated in
  one `typedRpc` adapter; JSON writes use a bounded plain-JSON normalizer that rejects
  non-finite, circular, accessor, class-instance, sparse, oversized, and over-deep data.
- Agent database text values are validated against closed domain enums. Production
  startup now resolves one immutable, role-aware configuration and fails before child
  processes start when a required URL, secret pair, revision, sandbox, role, mode, or
  concurrency value is invalid.
- Architecture budgets count runtime dependencies rather than type-only contracts.
  Oversized generated files require an explicit config entry and generated-code marker;
  handwritten modules retain the 400-line/18-runtime-dependency ceiling.

### Interface and accessibility

- The login surface now uses a neutral operational palette with rust primary actions
  and teal focus state instead of a low-contrast single beige/orange palette.
- Inputs have persistent labels, 48 px targets, 15/16 px text, visible focus rings,
  autocomplete contracts, and an announced error node. The mode switch is 44 px high.
- Browser evidence at 1440x900 and Pixel 7 412x915 found no horizontal overflow,
  element overlap, console warning/error, or target below 44 px; primary contrast is
  5.52:1 in light mode and the dark token pair is 5.63:1.

### Maintainability ratchet

- A repository-wide function-complexity gate now caps new functions at cyclomatic
  complexity 15 and 80 effective lines. Existing exceptions are tracked per file;
  their count and descending peaks may only decrease, and every improvement must
  lower the checked-in baseline.
- Request validation, Code Agent tool dispatch, chat streaming, Agent/model loops,
  project command detection, authoritative operation input, and the Agent workspace
  panel were split into bounded units with focused regression coverage.
- This pass reduced legacy complexity exceptions from 130 to 106 and effective-line
  exceptions from 67 to 49. Repository peaks fell from 175/324 to 41/292. The
  remaining exceptions are explicit debt, so F-15 is only partially remediated.

## Finding disposition

| ID | Branch state | Remaining acceptance work |
| --- | --- | --- |
| F-01 | Closed on branch | Independent review and any later production rollout remain. |
| F-02 | Closed on branch | Independent review remains. |
| F-03 | Partially remediated | Role-aware startup and process heartbeat are complete; split Web/worker topology and independent staging restarts remain. |
| F-04 | Partially remediated | Release evidence and exact-commit Render promotion exist; staging and production promotion evidence remains. |
| F-05 | Partially remediated | Admission is bounded O(1); per-client PostgreSQL event polling and representative 2x-peak measurement remain. |
| F-06 | Closed on branch | Chat creation and both regeneration paths are server-authoritative and transaction/CAS tested; independent review remains. |
| F-07 | Closed on branch | PostgreSQL-generated types, typed clients/RPCs, domain enum validation, bounded JSON conversion, and drift CI are present. |
| F-08 | Partially remediated | Renewal and heartbeat pressure are reduced with process ownership; representative database RPC budget remains unmeasured. |
| F-09 | Partially remediated | Code and browser gates pass; monitored rollout evidence remains. |
| F-10 | Closed on branch | Role-wide startup configuration is centralized, immutable, bounded, and fail-closed. |
| F-11 | Closed on branch | Critical chat transaction success, replay, concurrent CAS, rollback, CSP, and dual-viewport browser paths are covered. |
| F-12 | Partially remediated | Tools exist; staging, paging, restore, and 30m/6h/24h records do not. |
| F-13 | Closed on branch | Unconsumed lifecycle topics are suppressed; only cleanup topics with durable consumers are dispatchable. |
| F-14 | Partially remediated | A reproducible legacy compatibility baseline exists; tombstone traffic and deprecation evidence remain absent. |
| F-15 | Partially remediated | A fail-on-regression ratchet is active and the highest peaks were reduced; 106 complexity and 49 effective-line exceptions remain. |
| F-16 | Closed on branch | Agent requested/effective limits share the activated price catalog and record their source/version. |

No open or partially remediated finding is waived by test count or by the absence
of a current incident.

## Verification record

Current working-tree local verification on 2026-07-17:

- Architecture: 382 files, 974 runtime edges, zero baseline cycles.
- Function-complexity ratchet: 106 complexity exceptions and 49 effective-line
  exceptions remain; current maxima are 41 cyclomatic complexity and 292 effective
  lines.
- Migration contract: version 2, 45 sealed files, digest
  `c0c1dd9dcf788761cae5ac5a0bcb3ddd49e13ab8c59638e2c91d53ce1c5fcacc`.
- Strict TypeScript and repository-wide zero-warning ESLint: passed.
- 160 Node test files: 691 passed, zero failed/skipped/cancelled.
- Coverage gate: 81.59% lines, 81.32% branches, 85.99% functions.
- `npm audit --omit=dev --audit-level=high`: zero production vulnerabilities.
- Deterministic PostgreSQL database type replay/drift check: passed.
- PostgreSQL 16 migration/replay/permissions/concurrency/CAS/failure-rollback/SIGKILL
  verification: passed.
- Next.js 16.2.6 optimized production build and route collection: passed.
- Playwright: 10/10 passed across desktop Chromium and Pixel 7, including auth
  geometry/accessibility, authenticated shell/history, artifact containment, unique
  CSP nonces, and framework nonce binding.
- Reliability harness regression remains part of the Node suite: mock load/chaos,
  resumable soak extension, corrupt checkpoint rejection, staging acknowledgements,
  and permanent production-host rejection.
- Complete working-tree `npm run verify`: passed locally.

Draft PR #42 evidence on implementation head `6fb708f`:

- Linux Verify and container build/runtime smoke: passed.
- Security CodeQL analysis, CodeQL new-alert gate, secret scan, and dependency
  review: passed.
- Vercel Preview and Preview Comments: passed.
- Image publication was skipped as designed for a pull request.

Still pending outside automated repository scope:

- Independent review.
- Production-like staging load, role-isolation chaos, restore, paging, and long
  soak evidence.

## Production evidence retained from the baseline

- Production revision: `daacffad107a6513fa6b0ee5b63e512c102cdf2b`.
- Published image digest:
  `sha256:3c6ac740315424c593a095cb7b00a2fb20ee217d9616ea5e52b50ad85b30da1a`.
- Migration contract: version 1, count 43, digest
  `e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d`.
- Baseline activation, strict readiness, protected metrics, keepalive, CodeQL,
  secret scan, container smoke, Trivy, SBOM, and provenance checks passed for the
  baseline release.
- Render uses one free Web Service with the worker embedded. No paid Render service
  was created.

These retained facts do not say the refactor branch is deployed or production-
verified.

Concurrent mainline production observation on 2026-07-17:

- `main` revision `fa6dd1267d77a8747660f9a22bcd984370fb7728` completed Verify,
  Security, immutable image publication, and automatic activation independently of
  this draft branch.
- Activation run `29557953992` completed successfully.
- Production `/api/live` and strict `/api/ready` report revision `fa6dd1267d77`;
  every required dependency is ready and worker `draining=false`.
- No refactor-only commit from PR #42 is deployed.

## Remaining risks and evidence gaps

- Web and worker still share one service, supervisor, artifact build path, and
  broad failure domain.
- Render rebuilds Git source instead of executing the CI-attested GHCR digest.
- Event delivery still polls PostgreSQL per connection. The O(1) global capacity
  counter is bounded but has not been measured at representative peak concurrency.
- Chat writes are server-authoritative, but other browser data gateways and local
  cache projections still require compatibility retirement evidence.
- Compatibility retirement and the remaining 106 complexity/49 effective-line
  exceptions remain unresolved.
- The custom PostgreSQL workflow control plane remains operationally owned by
  MyChat even though it now has a provider-independent boundary.
- No representative arrival rate, database connection/QPS budget, memory-growth
  baseline, production-like staging topology, external page, restore drill, or
  long-soak record exists.

## Commits

- `8c7dbd2` Establish platform refactor baseline
- `25ce74e` Report architecture dependency fan-in
- `682d05b` Document platform refactor inventory
- `ac42704` Audit platform production risks
- `db2534d` Harden message deletion requests
- `04417b7` Reduce job lease renewal pressure
- `e9e6528` Extract lease renewal scheduling
- `1dd883c` Isolate untrusted artifact rendering
- `5e7a69f` Enforce nonce-bound application CSP
- `5f960ff` Introduce chat title workflow boundary
- `cb4f3d9` Record durable workflow runtime decision
- `88de1d6` Add guarded workflow reliability harnesses
- `75e6f38` Record refactor verification evidence
- `9f3434a` Merge latest main into platform refactor
- `666fdd0` Refresh evidence after main integration
- `6fb708f` Parse CSP script tags with the DOM

## Next actions

1. Review the working-tree diff and create a coherent commit before updating draft
   PR #42; require the exact committed head to pass CI.
2. Obtain independent review; do not merge or deploy this branch.
3. Create a production-like staging topology before running real load/chaos/soak,
   restore, paging, or role-isolation acceptance gates.
4. Continue the next architecture slice only in small reversible commits with this
   status file updated after each evidence boundary.

## Blockers and required decisions

- No blocker exists for local verification or preparing a reviewed commit/PR update.
- Production-like staging resources, isolated disposable fixtures, and external
  monitoring ownership are required before F-03/F-04/F-08/F-12 can close.
- Merge, vendor commitment, paid service creation, production canary, and production
  deployment require separate explicit authorization.
