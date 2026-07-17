# MyChat Platform Refactor Status

Updated: 2026-07-17T00:38:38-05:00

This is the authoritative continuation record for the platform refactor. The
audit in `docs/refactor/full-platform-audit.md` describes the production baseline;
this file records later branch changes without rewriting that baseline.

## Guardrails and identity

- Production baseline: `daacffad107a6513fa6b0ee5b63e512c102cdf2b`.
- Working branch: `refactor/platform-v2`.
- Integrated implementation head covered by this status record:
  `9f3434ad4df6a8c5ca3858238cbfd62b194fabdc`.
- The branch includes `origin/main` through
  `fa6dd1267d77a8747660f9a22bcd984370fb7728` without losing the request-bound
  nonce rendering in `app/layout.tsx`.
- Production is intentionally unchanged by this branch. No merge, production
  deploy, paid Render service, schema migration, or traffic change is authorized.
- Production rollback remains an exact-commit Render deploy plus forward-only
  database compatibility. Destructive database rollback is prohibited.

## Current phase

Phase: risk containment, workflow boundary, and pre-PR verification

Status: local verification complete; staging evidence not started

The first P0 request boundary and the highest-risk artifact/CSP code paths have
branch remediations. A provider-independent workflow boundary and reversible title
vertical slice now exist. Every local repository gate passes; CI/container/security
and real staging evidence are still required before any production claim.

## Completed branch work

### Baseline and audit

- Re-established the exact production release at `daacffad` before refactoring.
- Added a reproducible platform inventory and a 16-finding audit with consequences,
  acceptance tests, and remediation order.
- Extended architecture reporting with local dependency fan-in.
- Current architecture check: 362 files, 901 runtime edges, zero dependency cycles.
- Baseline inventory: 581 scanned files and 71,869 effective lines, including
  36,665 runtime TypeScript/JavaScript lines and 14,112 migration SQL lines. These
  are baseline measurements, not silently relabelled as post-refactor counts.
- The integrated head changes 59 files relative to the audit baseline with 5,580
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

## Finding disposition

| ID | Branch state | Remaining acceptance work |
| --- | --- | --- |
| F-01 | Closed on branch | Independent review and any later production rollout remain. |
| F-02 | Closed on branch | Independent review remains. |
| F-03 | Open | Split Web/worker topology and independently kill/restart roles in staging. |
| F-04 | Open | Promote one immutable CI-built digest through staging and production. |
| F-05 | Open | Replace per-client PostgreSQL polling/admission bottleneck and measure 2x peak. |
| F-06 | Open | Move one complete browser mutation/replay path to server authority. |
| F-07 | Open | Generate database types, typed RPCs, runtime schemas, and drift CI. |
| F-08 | Partially remediated | Renewal pressure is reduced; heartbeat ownership and measured RPC budget remain. |
| F-09 | Partially remediated | Code and browser gates pass; monitored rollout evidence remains. |
| F-10 | Open | One workflow enum is typed, but role-wide startup config remains scattered. |
| F-11 | Open | Security browser tests are real Chromium, but critical transaction E2E is absent. |
| F-12 | Partially remediated | Tools exist; staging, paging, restore, and 30m/6h/24h records do not. |
| F-13 | Open | Lifecycle topics still need real consumers or removal. |
| F-14 | Open | Tombstone traffic/deprecation evidence and schema baseline are absent. |
| F-15 | Open | High-complexity functions have not yet been systematically reduced. |
| F-16 | Open | Agent requested/effective budget still has two source values. |

No open or partially remediated finding is waived by test count or by the absence
of a current incident.

## Verification record

Current integrated-head local verification on 2026-07-17:

- Full `npm run verify`: passed after merging the latest `main`.
- Architecture: 362 files, 901 runtime edges, zero baseline cycles.
- Migration contract: 43 sealed files with digest
  `e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d`.
- TypeScript, backend ESLint, and repository-wide ESLint including `ops/`: passed.
- 140 Node test files: 613 passed, zero failed/skipped/cancelled.
- Coverage: 82.20% lines, 80.62% branches, 87.48% functions.
- `npm audit --omit=dev --audit-level=high`: zero production vulnerabilities.
- PostgreSQL 16 migration/replay/concurrency/SIGKILL verification: passed.
- Next.js 16.2.6 optimized production build and route collection: passed.
- Playwright: 10/10 passed across desktop Chromium and Pixel 7. This includes
  artifact network/script containment, unique application CSP nonces, framework
  script nonce binding, and the existing shell/navigation scenarios.
- Reliability harness regression: mock load/chaos, resumable soak extension,
  corrupt checkpoint rejection, required staging acknowledgements, and permanent
  production-host rejection all passed inside the 613-test suite.

Still pending outside local repository scope:

- Draft-PR CI on the final pushed merge head, including Linux container
  build/runtime smoke, CodeQL, secret scan, Trivy, SBOM, and provenance jobs.
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

## Remaining risks and evidence gaps

- Web and worker still share one service, supervisor, artifact build path, and
  broad failure domain.
- Render rebuilds Git source instead of executing the CI-attested GHCR digest.
- Event delivery still polls PostgreSQL per connection and admission retains a
  global serialized path.
- The browser still coordinates business writes and multiple cache projections.
- Database contracts, role config, lifecycle outbox ownership, compatibility
  retirement, core-function complexity, and Agent budget sources remain unresolved.
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

## Next actions

1. Commit this integrated-head evidence record.
2. Push the final `refactor/platform-v2` head to draft PR #42.
3. Require final draft-PR CI and independent review; do not merge or deploy this
   branch.
4. Create a production-like staging topology before running real load/chaos/soak,
   restore, paging, or role-isolation acceptance gates.
5. Continue the next architecture slice only in small reversible commits with this
   status file updated after each evidence boundary.

## Blockers and required decisions

- No blocker exists for local verification, branch push, or a draft PR.
- Production-like staging resources, isolated disposable fixtures, and external
  monitoring ownership are required before F-03/F-04/F-11/F-12 can close.
- Merge, vendor commitment, paid service creation, production canary, and production
  deployment require separate explicit authorization.
