# MyChat Platform Refactor Status

Updated: 2026-07-16T23:15:36-05:00

## Phase 0: Re-establish the factual baseline

Status: in_progress

Baseline SHA: `daacffad107a6513fa6b0ee5b63e512c102cdf2b`

Working branch: `refactor/platform-v2`

Environment:

- Host: Darwin 27.0.0 arm64
- Node.js: 26.5.0 locally; production and CI contract: 24
- npm: 11.17.0
- Git: 2.54.0
- PostgreSQL client: 16.14
- Playwright: 1.61.1
- Local Docker CLI: unavailable; container verification runs in GitHub Actions

Changes:

- Restored the production release path before starting the platform refactor.
- Replaced the ineffective Render restart drain transition with an exact redeploy of the currently live commit.
- Bound the old-runtime drain check, target drain deploy, activation, image digest, migration contract, and GitHub deployment evidence to immutable identities.
- Created this status file as the authoritative continuation record for the refactor.
- Added `docs/refactor/platform-inventory.md` with reproducible source-size, route,
  RPC, storage/table identifier, migration, browser-write, event-path, provider,
  configuration, complexity, dependency, duplication, dead-code, and test inventories.
- Extended the architecture report with local dependency fan-in so shared-module
  concentration is measured in addition to fan-out.

Deleted legacy code or complexity:

- Removed the release workflow's Render restart path. No application-runtime code has been deleted in phase 0 yet.

Tests and results:

- Local `npm run quality`: passed, 583 tests; 82.38% lines, 80.91% branches, 87.64% functions.
- Main Verify run `29552401035`: passed, including PostgreSQL 16 migration/replay/concurrency/SIGKILL checks, production build, six Playwright desktop/mobile tests, container runtime smoke, production audit, Trivy, SBOM, provenance, and release manifest.
- Main Security run `29552401040`: passed CodeQL and secret scan.
- Release Image run `29552598051`: passed.
- Activate Production run `29552925340`: passed.
- Manual keepalive run `29553099519`: passed strict readiness and protected authoritative metrics.
- Architecture graph: 356 files, 891 runtime edges, zero dependency cycles;
  highest fan-in is 43 and highest fan-out is 18.
- Static complexity baseline: 128 functions over complexity 15 and 68 functions
  over 80 effective lines. The current maximum is `executeTool` at 175.
- Knip 6.27.0: zero unused files or dependencies after correcting dynamic test
  entries; 52 unused export candidates and 50 unused type candidates remain for
  ownership review rather than blind deletion.
- jscpd 5.0.12 in single-worker mode: 17 clone groups, 189 duplicated lines,
  0.54% duplication. Automatic worker mode was non-progressing and is not used
  as evidence.

Runtime evidence:

- Production revision: `daacffad107a6513fa6b0ee5b63e512c102cdf2b` (`/api/*` reports the safe prefix `daacffad107a`).
- Published image digest: `sha256:3c6ac740315424c593a095cb7b00a2fb20ee217d9616ea5e52b50ad85b30da1a`.
- Migration contract: version `1`, count `43`, digest `e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d`.
- Production `/api/live`, `/api/ready`, and `/api/health`: HTTP 200 at the target revision.
- Strict readiness: all required checks ready; worker `draining=false`.
- Unauthenticated `/api/metrics`: HTTP 404; authenticated release metrics passed in activation and keepalive.
- Render active deploy: `dep-d9cq85m1a83c739kbub0`.
- No paid Render service was created.

Resource use:

- Render currently uses one free Web Service with an embedded worker process.
- No representative load, database connection, memory-growth, or long-soak baseline has been recorded yet.

Baseline size and test surface:

- 581 scanned source files and 71,869 effective lines after excluding generated
  output, dependencies, build output, coverage, and Git metadata.
- 36,665 effective runtime TypeScript/JavaScript lines, 14,112 canonical
  migration SQL lines, 2,420 script lines, 17,830 Node test lines, and 124
  Playwright lines.
- 45 API routes, including five HTTP 410 compatibility methods; 50 distinct RPC
  names and 25 distinct `.from(...)` database/storage identifiers.
- 44 canonical migrations. The first 43 are sealed by migration contract version
  1 with digest `e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d`.
- 133 Node test files produce 583 passing tests. One Playwright file supplies
  three heavily mocked scenarios across two viewports; it is not treated as a
  real transaction E2E suite.

Commits:

- `8c7dbd2` establishes the isolated refactor baseline and status record.
- `25ce74e` adds local dependency fan-in to the architecture report and fixture.

Risks and rollback:

- Web and worker still share one Render service and one supervisor failure domain.
- Render rebuilds from Git even though CI attests a GHCR digest; the release record binds them, but runtime artifact identity is still split.
- The custom PostgreSQL workflow control plane, per-client event polling, browser write authority, broad database casts, and artifact/CSP risks remain open pending measurement.
- Production rollback remains an exact-commit Render deploy plus forward-compatible database roll-forward; destructive database rollback is prohibited.

Next:

1. Write `docs/refactor/full-platform-audit.md` and decision ADRs with evidence,
   consequences, fixes, and acceptance tests.
2. Bound and rate-limit `/api/messages/delete`, then verify oversized declared and
   chunked bodies plus rate-limit failure behavior.
3. Replace the explicit two-second worker lease renewal with a lease-relative,
   jittered cadence and focused failure-timing tests.
4. Implement the first architecture vertical slice, load/chaos/soak tooling, and
   artifact isolation fixes before opening a draft PR. Do not merge or change
   production from this branch.

Blockers and minimum user decision required:

- None for local analysis and implementation.
- A production-like staging topology and external monitoring destinations will be required before production-grade soak, restore, paging, and topology claims can be closed.
