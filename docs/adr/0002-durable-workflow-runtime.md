# ADR 0002: Durable workflow runtime boundary

Status: accepted for staging evaluation; no production runtime change

Date: 2026-07-16

Owners: MyChat platform

## Context

MyChat currently runs durable work through a custom PostgreSQL control plane. The
control plane supplies idempotent enqueue, queue claims, fenced leases, retries,
cancellation, resumable checkpoints, ordered events, accounting, outbox delivery,
and tenant-scoped reads. In production the Next.js server and worker processes
still share one Render Web Service and one supervisor failure domain.

The first provider-independent boundary is the `chat.title` path. The public
`WorkflowRuntime` contract names workflow concepts rather than PostgreSQL tables
or Supabase RPCs: `start`, `cancel`, `signal`, `status`, and `events`. The initial
`PostgresWorkflowRuntime` adapter delegates to the existing Job repository, so
the boundary is reversible and does not migrate durable state.

This ADR decides what runs behind that boundary now and which class of runtime
should be tested next. It does not approve a production cutover or a paid service.

## Decision drivers

- Preserve tenant authority, idempotency, event ordering, cancellation, budgets,
  accounting, and existing worker behavior during migration.
- Recover from process termination, duplicate delivery, network loss, and delayed
  signals without duplicate external side effects.
- Keep rollback independent of a database down-migration.
- Reduce custom orchestration code only after replacement behavior is proven.
- Support TypeScript handlers and the current Next.js/PostgreSQL deployment.
- Expose enough history and correlation data to diagnose an individual execution.
- Avoid selecting a vendor from feature claims without representative staging
  latency, failure, throughput, data-retention, and operating-cost evidence.

## Assumptions and current evidence

- Production remains at baseline commit
  `daacffad107a6513fa6b0ee5b63e512c102cdf2b` while this ADR is evaluated.
- `chat.title` is a short, tool-free workflow, but the shared contract must also
  represent cancellation, ordered events, and a version-bound resume signal.
- The PostgreSQL implementation already has migration, replay, concurrency,
  SIGKILL, accounting, and authorization tests.
- The refactor branch has 606 passing Node tests and zero static dependency cycles
  at the time of this decision.
- No representative load, 24-hour soak, vendor outage, restore, or production-like
  split-role staging record exists yet. Scores that depend on those measurements
  are provisional.
- Vendor pricing, retention, regional availability, quotas, and support terms can
  change. They must be captured from an actual pilot quote and configuration, not
  copied into this long-lived architecture record.

## Options

### A. Existing PostgreSQL adapter

Keep the current Job repository behind `PostgresWorkflowRuntime`.

Strengths:

- No state migration or behavior change for the first vertical slice.
- Existing fencing, accounting, event, authorization, and rollback semantics stay
  intact.
- Data remains in the existing PostgreSQL authority and can be inspected with the
  current operational tooling.

Costs:

- MyChat continues to own lease, polling, recovery, schema, and control-plane code.
- Web and worker topology remains coupled until separately changed in staging.
- Execution history and debugging are less mature than dedicated workflow tools.

### B. Temporal-class managed workflow

Use a managed Temporal service and the TypeScript SDK, while running MyChat-owned
workers.

Strengths:

- Strong workflow-history, timer, retry, signal, cancellation, and replay model.
- Mature visibility and a clear separation between orchestration history and
  activity side effects.
- Best fit if long-running, multi-signal Agent workflows become the dominant case.

Costs:

- Existing handlers must be separated into deterministic workflow code and
  activity code; this is not a repository swap.
- Identity, event projection, accounting, payload storage, and cancellation still
  need explicit adapters to MyChat contracts.
- Cutover and rollback are harder while executions are live in two histories.

### C. Trigger.dev/Inngest-class managed TypeScript jobs

Pilot a managed TypeScript-oriented durable job platform behind the same runtime
contract. Trigger.dev and Inngest remain separate products to evaluate; grouping
them here describes the integration class, not identical semantics.

Strengths:

- Lowest TypeScript integration friction among the managed candidates.
- Managed scheduling, retries, run history, and operational UI can remove a useful
  portion of custom orchestration and diagnostics work.
- A small `chat.title` adapter can test the platform without first rewriting Agent
  workflows.

Costs:

- Cancellation, signals, event replay, exact idempotency, retention, concurrency,
  and failure semantics must be proven against MyChat's contract.
- Vendor SDK calls can leak into domain handlers unless the runtime boundary is
  enforced by architecture tests.
- Accounting and external side-effect fencing remain MyChat responsibilities.

### D. pg-boss/Graphile Worker-class PostgreSQL queue

Replace the custom queue mechanics with a maintained PostgreSQL-backed TypeScript
queue while keeping PostgreSQL as the durable authority.

Strengths:

- Familiar deployment and data ownership, with no separate workflow service.
- Mature queue primitives can reduce some custom claim, retry, and scheduling code.
- Usually the smallest infrastructure change after the current adapter.

Costs:

- It does not by itself replace MyChat's signals, ordered public events, accounting,
  outbox, payload lifecycle, authorization, or projection contracts.
- It retains PostgreSQL queue load and the same broad database failure domain.
- Migrating tables and live jobs is material, while the resulting capability is
  close to what the existing control plane already supplies.

## Weighted comparison

Scores are 1 (poor) through 5 (strong). Each weighted contribution is
`weight * score`; the total is divided by 100. Scores describe fit for the current
MyChat migration, not general product quality.

| Criterion | Weight | Existing PG adapter | Temporal class | Managed TS jobs | PG queue library |
| --- | ---: | ---: | ---: | ---: | ---: |
| Durable failure semantics | 22 | 4 | 5 | 4 | 3 |
| Migration compatibility | 18 | 5 | 2 | 3 | 3 |
| Operational burden | 15 | 3 | 4 | 4 | 3 |
| Visibility and debugging | 12 | 3 | 5 | 4 | 3 |
| Cost predictability at current scale | 10 | 4 | 3 | 3 | 5 |
| Data control and portability | 8 | 5 | 3 | 3 | 5 |
| TypeScript delivery speed | 8 | 4 | 3 | 5 | 4 |
| Rollback simplicity | 7 | 5 | 2 | 3 | 3 |
| **Weighted total** | **100** | **4.06** | **3.58** | **3.65** | **3.44** |

The existing adapter wins the immediate decision because migration compatibility
and rollback are deliberately weighted highly before staging evidence exists. The
score is not a decision to keep custom infrastructure indefinitely. Managed
TypeScript jobs are the next pilot because they offer the best expected reduction
in platform ownership per unit of migration work. Temporal remains the preferred
candidate to revisit if Agent workflows require richer deterministic histories or
multi-day signal orchestration than the managed TypeScript pilot can prove.

## Decision

1. Keep `PostgresWorkflowRuntime` as the default runtime now.
2. Preserve `MYCHAT_WORKFLOW_RUNTIME=legacy` as an immediate code-path rollback
   while the new boundary is introduced. Both paths must emit identical Job IDs,
   idempotency keys, input digests, payloads, queues, budgets, retries, metrics, and
   worker-handler behavior.
3. Do not introduce a second queue library. A pg-boss/Graphile Worker migration
   changes durable storage without removing enough of MyChat's control-plane
   responsibilities.
4. After the current PostgreSQL baseline is measured in a production-like staging
   topology, implement one managed TypeScript adapter for `chat.title`. Select
   Trigger.dev or Inngest only after a contract spike records actual behavior.
5. Do not dual-execute user work. Shadow comparisons use synthetic, side-effect-free
   staging fixtures. A real staging canary begins only after contract tests pass.
6. Any production pilot, vendor account commitment, merge, or traffic change needs
   a separate explicit decision and authorization.

## Pilot acceptance gates

The staging record must include raw commands, configuration, timestamps, runtime
versions, and machine-readable results. A candidate passes only when all gates do.

- Contract: the same adapter suite passes for start, replay, cancel, supported and
  unsupported signals, status, ordered event replay, timeouts, and authorization.
- Compatibility: `chat.title` HTTP responses and worker-visible payloads remain
  byte-for-byte compatible where the current idempotency digest depends on them.
- Recovery: repeated worker termination before and after each durable boundary
  produces zero duplicate terminal projections, accounting entries, or external
  effects, and every accepted execution reaches a terminal or explicitly
  awaiting-input state.
- Load: both the current adapter and candidate complete the same 30-minute staging
  profile at twice the measured representative arrival rate. Record p50/p95/p99
  enqueue-to-start and enqueue-to-terminal latency, error classes, retries, queue
  depth, database connections, CPU, and memory; no threshold may be relaxed after
  seeing the candidate result.
- Soak: a resumable 24-hour run has zero lost executions, tenant-boundary errors,
  duplicate effects, or unexplained nonterminal executions. Resource growth after
  warm-up must be bounded and explained.
- Outage: loss of the workflow API, worker, PostgreSQL, and provider is injected
  separately. Backpressure must be bounded and recovery must not require manual
  database edits.
- Observability: a request ID, execution ID, actor-safe identifier, attempt, and
  terminal reason can be correlated without exposing prompts, credentials, or
  customer endpoint secrets.
- Portability: export/offboarding and retention behavior are documented and tested
  with a restore or replay drill.
- Operations: projected usage and limits are recorded, but cost alone neither
  passes nor rejects a technically unsafe runtime.

## Migration order

1. Keep `chat.title` on the PostgreSQL adapter and land the provider-independent
   boundary plus compatibility tests.
2. Run repeatable load, chaos, and soak tooling against mock and real staging modes
   to establish the current baseline.
3. Implement one managed TypeScript adapter with no imports from its SDK outside
   `lib/workflows/<provider>/`.
4. Run the contract suite and synthetic shadow profile. Do not copy production
   payloads into the vendor environment.
5. Route staging-only `chat.title` fixtures to the candidate with an environment
   flag; retain the PostgreSQL adapter for immediate rollback.
6. Evaluate the acceptance record and write a follow-up ADR naming the product,
   region, retention, quotas, security controls, measured results, and outcome.
7. Only after separate production authorization, canary newly created title
   executions. Never move an in-flight execution between runtimes.
8. Migrate additional workflow types one at a time, ordered from short and
   side-effect-free to long-running and side-effecting.

## Rollback

- Boundary rollback: set `MYCHAT_WORKFLOW_RUNTIME=legacy` and redeploy the exact
  approved revision. No schema rollback is needed because both paths use the same
  current Job records.
- Staging candidate rollback: stop admitting new candidate executions, allow safe
  executions to drain, explicitly cancel the rest through the candidate adapter,
  and return new starts to `postgres-v1`.
- A runtime choice is recorded on every execution before any production canary.
  Reads, events, signals, and cancellation must dispatch by that immutable choice;
  changing an environment flag must never strand in-flight work.
- Database rollback remains forward-only. No destructive migration or history
  deletion is part of runtime rollback.

## Code deletion conditions

The `legacy` route branch may be deleted only when:

- the new boundary has served every title start for two release windows;
- replay and rollback drills have passed in staging;
- no supported deployment configuration selects `legacy`; and
- production removal is separately approved.

The custom PostgreSQL workflow control plane may be deleted only when:

- every workflow type has migrated and no queued, running, cancelling, or
  awaiting-input execution remains on it;
- public status/event/cancel/resume APIs dispatch entirely through
  `WorkflowRuntime` and pass the provider contract suite;
- accounting, outbox, payload, asset, and side-effect fencing have replacement
  owners with reconciliation evidence;
- required history has been exported and its restore/read path tested;
- at least one full rollback and vendor-outage drill has passed after the final
  migration; and
- the deletion is a dedicated, reversible release with explicit authorization.

Until every condition is met, apparently unused tables, RPCs, worker handlers, and
migrations are retained. Historical migrations are never rewritten.

## Consequences

- The immediate refactor adds an abstraction without claiming an operational win.
- Title generation behavior and durable state remain unchanged and easy to roll
  back.
- Vendor-specific code has a narrow future integration point.
- MyChat continues to carry the custom control-plane burden until measurements
  justify and validate a replacement.
- A follow-up ADR is required before any managed runtime becomes a production
  dependency.

## References

Accessed 2026-07-16:

- Temporal Cloud: <https://docs.temporal.io/cloud>
- Temporal TypeScript SDK: <https://docs.temporal.io/develop/typescript>
- Trigger.dev architecture: <https://trigger.dev/docs/how-it-works>
- Inngest execution model:
  <https://www.inngest.com/docs/learn/how-functions-are-executed>
- pg-boss: <https://github.com/timgit/pg-boss>
- Graphile Worker: <https://github.com/graphile/worker>
