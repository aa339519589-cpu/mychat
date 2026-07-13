# Architecture

This project uses a layered Next.js architecture with explicit browser/server boundaries. The goal is to keep entry points thin, domain code testable, and infrastructure details replaceable without requiring an immediate rewrite of legacy modules.

## Dependency direction

```text
app/page.tsx ───────► components ───────► browser-safe lib modules
      │                                      │
      └──────────────────────────────────────┘

app/api/**/route.ts ─► server services ─────► server infrastructure
                           │                         │
                           └────────► domain ◄──────┘
```

- `app/` is the delivery layer. Pages compose UI; route handlers authenticate, validate, call a service, and translate the result to HTTP.
- `components/` contains client presentation and interaction. It can use browser-safe utilities and browser data gateways, but cannot import server runtimes.
- `lib/data/` and `lib/supabase/client.ts` are browser data gateways. Components may call them; API routes and server services may not execute them.
- `lib/api/`, `lib/agent/`, `lib/code-tools/`, `lib/tools/`, server Supabase, quota, rate-limit, and generation persistence/runtime modules are server-only.
- Pure domain types, parsers, policies, and transformations live in browser/server-neutral `lib/` modules. They must not depend on `app/` or `components/`.

Dependencies point inward: `lib/` never imports UI or framework entry points, and API routes never import components. Type-only imports can cross the browser/server split when the target is a declaration-only contract; runtime imports cannot.

## Module contracts

For new work:

1. Keep route handlers focused on transport concerns. Put orchestration in a named service module.
2. Keep components focused on rendering and interaction. Extract stateful workflows to focused hooks and pure transformations to `lib/`.
3. Import the narrowest module that owns a symbol. Avoid adding broad barrels that hide subsystem ownership.
4. Put shared request/response shapes in a neutral contract module, not in a route handler or server implementation.
5. Keep browser and server Supabase clients separate. A module that imports Node APIs, secrets, cookies, or privileged credentials is server-only.

## Automated guardrails

Run `npm run architecture` locally. The checker validates:

- forbidden dependency directions and browser/server crossings;
- Node and Next.js server runtime imports from client components;
- runtime dependency cycles;
- per-layer file-size budgets;
- local dependency fan-out budgets.

`npm run quality` runs the architecture check, strict TypeScript check, ESLint, and unit/integration tests with minimum exercised-module coverage gates of 70% lines, 75% branches, and 75% functions. ESLint errors fail immediately and the existing 164-warning count is ratcheted, so new warnings cannot silently increase the baseline. `npm run verify` adds a production build plus Playwright smoke tests against `next start` on desktop Chromium and a Pixel 7 viewport. Pull requests and pushes to `main` run that full command plus an actual PostgreSQL 16 baseline/expand/replay/contract migration verification in CI.

The budgets in `scripts/architecture-baseline.json` are enforceable ceilings: API entry points default to 300 lines, components to 350, libraries to 400, and every module to at most 18 local runtime dependencies. The checker rejects stale exceptions after a file shrinks, so temporary debt can only move downward. The current baseline contains no size, fan-out, or cycle exceptions.

## Current feature boundaries

The largest workflows are organized as feature packages with thin public entry points:

- `lib/chat/` owns model selection, media responses, history preparation, attachment OCR, and durable chat streaming.
- `lib/code-agent/` owns code-agent request validation, task context, prompts, runtime state, apply/publish orchestration, and SSE orchestration.
- `components/literary-chat/`, `components/code-console/`, `components/sidebar/`, and `components/agent-tasks/` separate workflow hooks from presentation.
- `lib/llm/media-generation/` and `lib/llm/openai-compatible/` isolate protocol transport and network-security policy behind stable facades.
- `lib/agent/snapshot/` and `lib/agent/git-publish/` isolate persistence, recovery, Git, pull-request, and publishing responsibilities.

Future changes must keep these dependency directions and budgets intact. Do not move code into a new oversized file or create a facade cycle to satisfy a budget mechanically.

## Runtime topology

- The browser mounts one responsive chat/sidebar tree at every viewport. `/c/[conversationId]` is the canonical deep link; history navigation is synchronized through the route controller.
- Durable generation state, cancellation markers, and execution leases live in Supabase. A request can reconnect to another application instance and continue polling until a terminal state. Before any model or tool side effect, the canonical assistant placeholder must already exist with the exact verified user/conversation/role identity, then a runner atomically claims the generation. Claim, renewal, progress, cancellation, stale settlement, and finalization are service-role-only; browser roles cannot read fencing credentials.
- A cold client fetches fresh message history, reconciles the latest generation snapshot, and only then unlocks the composer. React state, localStorage, and IndexedDB all merge terminal snapshots by generation sequence, so a late pre-terminal read cannot overwrite canonical history or contaminate the next model request.
- Cancellation is a database compare-and-set, not a local UI guess. The cancel response and resume stream carry the complete winning terminal snapshot; clients keep the stream open and apply the same canonical content, thinking, media, error, and sequence idempotently.
- A duplicate request for an active generation is rejected before model execution. An expired lease is atomically finalized as failed and must be retried with a new generation ID; the system deliberately does not replay a tool-capable generation without an idempotent checkpoint.
- Image and video jobs use the same pre-provider claim and terminal CAS. Provider media is validated and uploaded server-side under a user/conversation/generation-scoped object key before its durable HTTPS reference enters the database terminal snapshot. Direct streams and reconnects render only that authoritative reference; cancellation or a lost CAS removes the non-canonical upload.
- History deletion is service-owned: the browser cannot delete conversations or messages directly. One database transaction verifies ownership, locks the conversation against new generation claims, records scoped object-cleanup receipts, and deletes the rows. Storage removal then acknowledges those receipts; failures remain durably queued and never leave a retained message pointing at an object that was already removed.
- Conversation titles use a separate owned, one-round, tool-free endpoint. `/api/chat` requires a complete stable conversation/generation/assistant-message identity for every chat or media job.
- Production API rate limits use an atomic, service-role-only PostgreSQL RPC. In-memory limiting is a development fallback only; production fails closed if the shared limiter is unavailable.
- `/api/health` is a liveness probe. `/api/health?ready=1` and the deployment-facing `/api/ready` verify the privileged database dependency, rate limiter, generation lease/finalization RPCs, and terminal-state guard without revealing credentials or connection details.
