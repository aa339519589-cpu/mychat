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

`npm run quality` runs the architecture check, strict TypeScript check, and tests. `npm run verify` adds a production build; pull requests and pushes to `main` run that full verification command in CI.

The budgets in `scripts/architecture-baseline.json` are enforceable ceilings: API entry points default to 300 lines, components to 350, libraries to 400, and every module to at most 18 local runtime dependencies. The checker rejects stale exceptions after a file shrinks, so temporary debt can only move downward. The current baseline contains no size, fan-out, or cycle exceptions.

## Current feature boundaries

The largest workflows are organized as feature packages with thin public entry points:

- `lib/chat/` owns model selection, media responses, history preparation, attachment OCR, and durable chat streaming.
- `lib/code-agent/` owns code-agent request validation, task context, prompts, runtime state, and SSE orchestration.
- `components/literary-chat/`, `components/code-console/`, `components/sidebar/`, and `components/agent-tasks/` separate workflow hooks from presentation.
- `lib/llm/media-generation/` and `lib/llm/openai-compatible/` isolate protocol transport and network-security policy behind stable facades.
- `lib/agent/snapshot/` and `lib/agent/git-publish/` isolate persistence, recovery, Git, pull-request, and publishing responsibilities.

Future changes must keep these dependency directions and budgets intact. Do not move code into a new oversized file or create a facade cycle to satisfy a budget mechanically.
