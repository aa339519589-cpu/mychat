# MyChat Platform Refactor Status

Updated: 2026-07-16T22:47:41-05:00

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

Deleted legacy code or complexity:

- Removed the release workflow's Render restart path. No application-runtime code has been deleted in phase 0 yet.

Tests and results:

- Local `npm run quality`: passed, 583 tests; 82.38% lines, 80.91% branches, 87.64% functions.
- Main Verify run `29552401035`: passed, including PostgreSQL 16 migration/replay/concurrency/SIGKILL checks, production build, six Playwright desktop/mobile tests, container runtime smoke, production audit, Trivy, SBOM, provenance, and release manifest.
- Main Security run `29552401040`: passed CodeQL and secret scan.
- Release Image run `29552598051`: passed.
- Activate Production run `29552925340`: passed.
- Manual keepalive run `29553099519`: passed strict readiness and protected authoritative metrics.

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

Risks and rollback:

- Web and worker still share one Render service and one supervisor failure domain.
- Render rebuilds from Git even though CI attests a GHCR digest; the release record binds them, but runtime artifact identity is still split.
- The custom PostgreSQL workflow control plane, per-client event polling, browser write authority, broad database casts, and artifact/CSP risks remain open pending measurement.
- Production rollback remains an exact-commit Render deploy plus forward-compatible database roll-forward; destructive database rollback is prohibited.

Next:

1. Produce reproducible SLOC and API/RPC/table/env/worker/provider/client-write inventories.
2. Measure function complexity, dead code, duplication, and dependency fan-in/fan-out with correctly scoped tools.
3. Write `docs/refactor/full-platform-audit.md` and decision ADRs with evidence, consequences, fixes, and acceptance tests.
4. Implement the first independently reversible P0/P1 fixes and open a draft PR. Do not merge or change production from this branch.

Blockers and minimum user decision required:

- None for local analysis and implementation.
- A production-like staging topology and external monitoring destinations will be required before production-grade soak, restore, paging, and topology claims can be closed.
