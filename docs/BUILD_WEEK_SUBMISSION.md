# MyChat — OpenAI Build Week submission notes

## Recommended track

**Developer Tools**

## One-line tagline

**Build and ship real software from your phone — no laptop required.**

## The memorable idea

**Your phone is the command center. The cloud sandbox is the computer.**

MyChat Code is not a tiny IDE squeezed onto a phone and it is not a remote desktop. The user describes the outcome and makes the important decisions from a mobile browser. A durable cloud agent handles the heavy work against a real GitHub repository: understanding the codebase, editing files, running tests, recovering from interruptions, and publishing the verified result.

## Devpost-ready description

MyChat is a mobile-first AI workspace whose standout feature, Code, lets people build and ship real software from a phone without using a computer.

After connecting GitHub, a user can select an existing repository or describe a new project in natural language. MyChat creates a durable agent job, runs the work inside an isolated E2B sandbox, reads and edits the repository, executes commands and tests, checkpoints progress, and streams an understandable activity trail back to the phone. Consequential operations remain behind explicit confirmation. Once the user approves, MyChat can commit and push the change, create a Pull Request, and deploy supported projects.

The mobile interface is only the control surface. The development environment lives in the cloud, so there is no terminal to configure, no local dependencies to install, and no need to keep a laptop awake. Database-backed leases, fencing, idempotent effects, durable events, and reconnectable streams let work survive the short disconnects and app switching that are normal on a phone.

MyChat also includes multimodel chat, search, media generation, conversation memory, and custom OpenAI-compatible endpoints, but Code is the defining experience: a complete intent-to-deployment loop that fits in a pocket.

## Inspiration

Ideas do not wait until a developer is back at a desk, but most AI coding tools still assume a laptop, terminal, editor, and stable connection. We wanted to separate software development from the physical computer. If a phone can safely direct a cloud agent and GitHub can remain the source of truth, meaningful engineering work can happen anywhere.

## How it works

1. The user enters MyChat on a mobile browser and connects GitHub.
2. They choose an existing repository or ask Code to create a project from scratch.
3. The request becomes a durable database-backed job rather than a fragile browser request.
4. An E2B sandbox clones the repository and gives the agent isolated tools for reading, editing, running, and testing code.
5. Progress and confirmation requests stream to the phone and can reconnect from persisted event history.
6. The user approves consequential actions, then MyChat publishes the real GitHub result and can deploy supported projects.

## What makes it different

- **Mobile-first, not mobile-compatible:** the primary interaction is designed around short instructions, progress visibility, interruption recovery, and explicit confirmations.
- **Real outcomes:** it changes actual GitHub repositories and returns publication receipts rather than stopping at a pasted code block.
- **No local machine dependency:** compute, dependencies, and commands run in an isolated cloud sandbox.
- **Durable by design:** jobs use leases, fencing, checkpoints, idempotent tool effects, event replay, cancellation, and outbox recovery.
- **Human control at trust boundaries:** the agent can work autonomously while publication and other consequential operations remain reviewable.

## How Codex and GPT-5.6 were used

Codex with GPT-5.6 Sol served as an implementation and review partner throughout the Build Week extension. It traced the existing system across the Next.js frontend, APIs, Supabase schema, worker runtime, E2B execution, GitHub integration, and release pipeline. It then accelerated the durable job control plane, migrations, recovery logic, security gates, tests, observability, and production verification.

The human made the key product and engineering decisions: focusing the entry point on phone-only development; treating GitHub as the publication source of truth; requiring isolated production execution; choosing the confirmation boundaries; deciding how much autonomy the agent receives; and prioritizing reliable recovery over a visually complex editor.

The project runtime can use configurable model providers. That is separate from the required Build Week workflow: GPT-5.6 was used through Codex to build and harden MyChat.

## Existing project versus Build Week work

Before July 13, MyChat already had a working chat product, model routing, history, an early Code flow, and GitHub integration. Build Week transformed the backend and release path needed for that mobile idea to operate reliably against real projects.

The pre-event baseline is [`c1f22de`](https://github.com/aa339519589-cpu/mychat/commit/c1f22de9da5f7806e39517933e12850de1ed70eb). The Build Week work added or substantially hardened:

- the database-authoritative job state machine;
- worker leases, fencing, heartbeats, cancellation, and recovery;
- checkpointed workspaces and idempotent tool effects;
- durable event replay and reconnectable streaming;
- E2B production execution and publication confirmation gates;
- private generated-media handling and scoped cleanup;
- quota and billing reconciliation contracts;
- observability, schema attestation, container checks, security scans, and release gates; and
- the public judge path, mobile-first positioning, and submission documentation.

Implementation evidence is concentrated in [PR #25](https://github.com/aa339519589-cpu/mychat/pull/25), [PR #26](https://github.com/aa339519589-cpu/mychat/pull/26), [PR #27](https://github.com/aa339519589-cpu/mychat/pull/27), and [PR #36](https://github.com/aa339519589-cpu/mychat/pull/36), followed by release validation commits.

## Suggested three-minute demo story

**0:00–0:20 — The problem**<br>
Show only the phone. Explain that most coding agents still require a laptop and that MyChat makes the phone the command center.

**0:20–1:35 — The product**<br>
Enter as a guest, open Code, connect GitHub, choose a small repository, and request one visible change. Show repository inspection, an edit, a test, the progress trail, and the confirmation step.

**1:35–2:05 — The real outcome**<br>
Confirm publication, open the resulting GitHub commit or Pull Request, and show the deployed result on the same phone.

**2:05–2:40 — Why it is technically credible**<br>
Briefly show the E2B sandbox boundary and the durable job flow: database job, lease, checkpoint, reconnectable events, and confirmation-gated publication.

**2:40–3:00 — Codex and GPT-5.6**<br>
Explain that Codex with GPT-5.6 Sol accelerated the control plane, migrations, tests, security review, and release verification, while the human chose the mobile-first product direction and safety boundaries.

The public YouTube demo must stay below three minutes and include spoken audio covering the project, Codex, and GPT-5.6. The required Codex `/feedback` Session ID belongs in the Devpost submission field rather than this public repository.
