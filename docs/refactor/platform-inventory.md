# MyChat Platform Inventory

Baseline: `daacffad107a6513fa6b0ee5b63e512c102cdf2b`

Measured: 2026-07-16 (America/Chicago)

This document records counts and names, not quality claims. Generated output, `node_modules`, `.next`, coverage output, and Git metadata are excluded. SLOC uses cloc 2.06 with blank/comment/code separation and file uniqueness disabled so identical compatibility routes are counted.

## Source size

| Surface | Files | Effective code | Comments | Blank | Physical lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| `app/api` | 45 | 1,879 | 35 | 137 | 2,051 |
| Other `app` | 7 | 460 | 10 | 32 | 502 |
| `components` | 72 | 8,925 | 60 | 680 | 9,665 |
| `lib` | 232 | 25,213 | 695 | 2,250 | 28,158 |
| Root runtime (`job-worker.ts`, `proxy.ts`) | 2 | 188 | 0 | 12 | 200 |
| `scripts` | 11 | 2,420 | 84 | 197 | 2,701 |
| Tests and fixtures under `tests` | 155 | 17,830 | 68 | 1,382 | 19,280 |
| Playwright `e2e` | 1 | 124 | 0 | 15 | 139 |
| Canonical migrations | 44 | 14,112 | 406 | 879 | 15,397 |
| Other Supabase SQL/config | 10 | 638 | 113 | 71 | 822 |

The scanned set contains 581 files and 71,869 effective code lines. Application runtime TypeScript/JavaScript is 36,665 effective lines. Treating all `lib` code as backend overstates the server size because it includes browser data/cache helpers; the table preserves ownership boundaries instead of inventing a misleading single backend number.

## Delivery surfaces

- Next.js App Router pages and BFF/API routes.
- One production Render Web Service.
- `scripts/start-production.mjs` launches both Next.js and `job-worker.ts` by default.
- Four Job consumers: `chat`, `media`, `title`, and `agent`.
- One outbox dispatcher.
- Five worker-fleet heartbeat loops: four Job queues plus outbox.
- One lifecycle sweeper.
- One billing reconciliation monitor.
- One scheduled/manual GitHub keepalive workflow.

## API routes

There are 45 route files. Five routes intentionally return HTTP 410 for at least one method.

| Route | Methods |
| --- | --- |
| `/api/agent/tasks` | GET, POST |
| `/api/agent/tasks/:taskId` | GET |
| `/api/agent/tasks/:taskId/cancel` | POST |
| `/api/agent/tasks/:taskId/confirm` | GET, POST |
| `/api/agent/tasks/:taskId/events` | GET |
| `/api/agent/tasks/:taskId/resume` | POST |
| `/api/agent/tasks/:taskId/workspace` | GET, POST |
| `/api/agent/tasks/:taskId/workspace/cleanup` | POST |
| `/api/agent/tasks/:taskId/workspace/commands` | GET |
| `/api/agent/tasks/:taskId/workspace/diff` | GET |
| `/api/agent/tasks/:taskId/workspace/exec` | POST |
| `/api/agent/tasks/:taskId/workspace/file` | POST, PATCH, DELETE |
| `/api/agent/tasks/:taskId/workspace/files` | GET |
| `/api/agent/tasks/:taskId/workspace/git` | GET, POST |
| `/api/agent/tasks/:taskId/workspace/patch` | POST |
| `/api/agent/tasks/:taskId/workspace/restore` | POST |
| `/api/agent/tasks/:taskId/workspace/snapshot` | GET, POST |
| `/api/agent/tasks/:taskId/workspace/verify` | POST |
| `/api/auth/anonymous` | POST |
| `/api/auth/email` | POST |
| `/api/auth/github` | GET |
| `/api/auth/github/callback` | GET |
| `/api/auth/github/disconnect` | POST |
| `/api/chat` | POST |
| `/api/chat/title` | POST |
| `/api/code/apply` | POST |
| `/api/code/chat` | POST |
| `/api/conversations/:id` | DELETE |
| `/api/endpoints` | GET, POST |
| `/api/endpoints/:endpointId` | PATCH, DELETE |
| `/api/endpoints/discover` | POST |
| `/api/github/repos` | GET |
| `/api/github/status` | GET |
| `/api/health` | GET |
| `/api/live` | GET |
| `/api/messages/delete` | POST |
| `/api/metrics` | GET |
| `/api/ready` | GET |
| `/api/redeem-code` | POST |
| `/api/v1/conversations/:conversationId/generation` | GET |
| `/api/v1/jobs/:jobId` | GET |
| `/api/v1/jobs/:jobId/cancel` | POST |
| `/api/v1/jobs/:jobId/events` | GET |
| `/api/v1/jobs/:jobId/resume` | POST |
| `/api/v1/media/*` | GET |

HTTP 410 compatibility routes:

- `/api/agent/tasks` POST
- `/api/agent/tasks/:taskId/resume` POST
- `/api/agent/tasks/:taskId/workspace` POST
- `/api/agent/tasks/:taskId/workspace/git` POST
- `/api/agent/tasks/:taskId/workspace/snapshot` POST

## Runtime database calls

Static analysis finds 50 distinct Supabase RPC names:

```text
advance_agent_workspace_head
append_job_events
bind_agent_operation_repository
bind_agent_workspace_branch
cancel_idle_agent_task
cancel_job
claim_job_outbox
claim_next_job
complete_job_outbox
consume_agent_confirmation_gate
consume_api_rate_limit
create_agent_confirmation_gate
create_agent_operation_confirmation
delete_conversation_with_media_cleanup
delete_github_connection
delete_messages_with_media_cleanup
enqueue_agent_operation
enqueue_agent_task_job
enqueue_job
finalize_job
finish_job_asset_cleanup
finish_job_payload_cleanup
get_agent_confirmation_gate
get_ledger_quota_status
github_connection_status
heartbeat_job_worker
mark_job_worker_draining
match_conversation_chunks
match_conversation_chunks_text
merge_agent_run_state
merge_agent_task_meta
prepare_job_asset_cleanup
prepare_job_payload_cleanup
read_agent_operation_authority
read_billing_reconciliation_v1
read_github_connection
read_job_observability_v1
read_job_worker_readiness_v2
read_stream_lifecycle_metrics_v1
record_job_asset
record_job_tool_effect
record_quota_usage
redeem_invitation_code
redrive_job_outbox
refresh_billing_reconciliation_v1
renew_job_lease
renew_job_outbox
resolve_agent_confirmation_gate
sweep_job_lifecycle
upsert_github_connection
```

The code references 25 distinct `.from(...)` identifiers. This set includes database tables and Storage bucket identifiers and must not be read as 25 relational tables without schema classification:

```text
agent_artifacts
agent_task_steps
agent_tasks
agent_tool_calls
agent_workspace_heads
agent_workspaces
artifacts
chat_generations
code_memories
code_messages
code_sessions
conversation_chunks
conversations
endpoints
generated
job
job_assets
job_events
jobs
memories
messages
profiles
project_files
project_memories
projects
```

There is no generated Supabase `Database` type in application source. Sixteen exact `as unknown as` bridges remain in runtime/scripts; additional ordinary assertions exist beyond that narrow count.

## Migration inventory

- 44 canonical SQL files exist in `supabase/migrations`.
- The sealed manifest contains the 43 migrations before the seal migration.
- Seal migration: `20260713310000_schema_contract_attestation.sql`.
- Contract version: `1`.
- Contract digest: `e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d`.
- The directory contains 147 `CREATE [OR REPLACE] FUNCTION` statements and 130 `SECURITY DEFINER` occurrences across history. These are historical statement counts, not the number of distinct functions in the final schema.

## Browser write authority

Browser-importable data modules still issue direct mutations:

- `lib/data/conversations.ts`: create/update conversations; insert/update messages.
- `lib/data/projects.ts`: create/update/delete projects, files, and project memories.
- `lib/data/memory.ts`: create/update/delete global memories.
- `lib/data/profile.ts`: upsert profile and memory settings.
- `lib/data/artifacts.ts`: upsert/delete artifact projections.
- `lib/code-data.ts`: create/update code sessions, messages, and memories.

RLS limits tenant scope, but the browser still coordinates multi-step business writes and local projection repair.

## Event path

```text
Browser EventSource/fetch loop
  -> /api/v1/jobs/:jobId/events
  -> acquire_job_event_stream RPC
  -> global advisory lock + four count(*) admission checks
  -> repeated job_events reads starting at 250 ms
  -> periodic Job status read and stream-lease renewal
  -> SSE response
  -> browser reducer/cache merge
```

The server poll backs off to 2 seconds when idle. Browser reconnection starts at 250 ms and backs off to 5 seconds. Durable `seq` replay exists, but online fan-out is still per-connection database polling.

## Configuration and providers

Render declares 37 environment keys. Application and operational scripts contain 38 statically named `process.env` reads plus dynamic media and concurrency key lookup. Configuration is validated in several local helpers rather than one role-aware module.

Provider surfaces:

- DeepSeek chat/agent.
- Mimo chat/image understanding.
- Deep-tier OpenAI-compatible chat proxy.
- Deep-tier image and video transports.
- Customer-owned OpenAI-compatible endpoints.
- OpenAI-compatible embeddings with `OPENAI_API_KEY` fallback.
- Tavily search.
- E2B isolated command sandbox.
- GitHub OAuth, Git Data, Pages, and publication APIs.
- Supabase Auth, PostgREST/RPC, and Storage.

## Analysis metrics

- Architecture graph: 356 files, 891 runtime edges, zero cycles.
- Highest local fan-in: `lib/unknown-value.ts` at 43 direct dependents.
- Highest local fan-out: `lib/jobs/handlers/chat-text.ts` at 18 direct dependencies.
- ESLint complexity threshold 15: 128 violations.
- Function length threshold 80 effective lines: 68 violations.
- Highest complexity: `executeTool` 175, `validateChatRequest` 99, `runChatStream` 73, `runAgentLoop` 64, `runTurn` 57.
- Knip 6.27.0 after dynamic-entry correction: zero unused files/dependencies; 52 unused export candidates and 50 unused type candidates.
- jscpd 5.0.12, strict mode, minimum 8 lines/70 tokens: 17 clone groups, 189 duplicated lines, 0.54% line duplication.

## Test inventory

- 133 `*.test.ts` files are dynamically loaded by the Node test runner.
- Current quality run: 583 passing tests.
- Coverage: 82.38% lines, 80.91% branches, 87.64% functions.
- One Playwright file contains three scenarios.
- Two Playwright projects execute those scenarios on desktop Chromium and Pixel 7, producing six executions.
- The authenticated Playwright scenario mocks Supabase and application API responses; it is a shell/navigation test, not a full text-generation transaction.

## Production evidence at baseline

- Main revision: `daacffad107a6513fa6b0ee5b63e512c102cdf2b`.
- Published image digest: `sha256:3c6ac740315424c593a095cb7b00a2fb20ee217d9616ea5e52b50ad85b30da1a`.
- Main Verify: `29552401035`, success.
- Main Security: `29552401040`, success.
- Release Image: `29552598051`, success.
- Activate Production: `29552925340`, success.
- Independent keepalive: `29553099519`, success.
- Production `/api/live`, `/api/ready`, and `/api/health`: HTTP 200 at revision prefix `daacffad107a`.
- Strict readiness reports every required dependency ready and worker `draining=false`.
- Unauthenticated metrics return HTTP 404; authenticated authoritative metrics passed activation and keepalive.
