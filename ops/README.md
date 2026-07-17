# Workflow load, chaos, and soak tooling

These tools produce repeatable evidence for the `WorkflowRuntime` decision. They
default to an in-memory mock driver and use only Node.js standard-library modules.
They do not modify production configuration, create Render services, or install a
remote fault-injection endpoint.

## Safety model

Real mode is staging-only and fails closed unless all relevant controls are set:

- Pass `--mode real --allow-real`.
- Set `MYCHAT_OPS_ENVIRONMENT=staging`.
- Set `MYCHAT_OPS_REAL_ACK=staging-only`.
- Bind `MYCHAT_OPS_ALLOWED_HOST` exactly to the staging URL host, including its
  port when one is present.
- Bind `MYCHAT_OPS_EXPECTED_REVISION` to the deployed staging Git revision for any
  non-loopback target.
- Supply the authenticated staging cookie through `MYCHAT_OPS_COOKIE`. Never put
  it in a command argument or fixture file.
- Real title starts and cancellation additionally require `--allow-writes` and
  `MYCHAT_OPS_WRITE_ACK=disposable-staging-data`.

The known production hostname is hard blocked even when acknowledgements are
present. Remote targets require HTTPS; HTTP is accepted only for loopback testing.
Every real run verifies strict `/api/ready` before workload execution.

Result files contain no cookie or response bodies. Error messages redact URLs and
common credential labels. Keep `.artifacts/` private regardless, because execution
IDs and staging topology are operational data.

## Mock smoke runs

```bash
npm run ops:load -- --mode mock --operation title --requests 1000 --concurrency 20
npm run ops:chaos -- --mode mock --repetitions 100
npm run ops:soak -- --mode mock --iterations 1000
```

Each command creates a unique directory under `.artifacts/ops/` unless `--output`
is supplied. A pre-existing result directory is never overwritten.

## Staging fixture contract

Real authenticated workflow reads and writes use a JSON fixture file. Bind it to
one staging host and populate it only with disposable staging records:

```json
{
  "schemaVersion": 1,
  "environment": "staging",
  "targetHost": "mychat-staging.example.com",
  "titleRequests": [
    {
      "conversationId": "10000000-0000-4000-8000-000000000001",
      "userText": "staging fixture question",
      "assistantText": "staging fixture answer"
    }
  ],
  "jobIds": [
    "20000000-0000-4000-8000-000000000001"
  ]
}
```

Each title fixture must reference a conversation owned by the staging session and
containing a terminal assistant message. The tool validates shape and host binding,
but the application remains the authority for ownership. Do not use production IDs
or prompts.

Use environment variables instead of checking credentials into the repository:

```bash
export MYCHAT_OPS_ENVIRONMENT=staging
export MYCHAT_OPS_REAL_ACK=staging-only
export MYCHAT_OPS_BASE_URL=https://mychat-staging.example.com
export MYCHAT_OPS_ALLOWED_HOST=mychat-staging.example.com
export MYCHAT_OPS_EXPECTED_REVISION=0123456789abcdef
export MYCHAT_OPS_COOKIE='staging-session-cookie'
```

## Load profiles

Read an existing workflow without model usage:

```bash
npm run ops:load -- \
  --mode real --allow-real --operation status \
  --fixtures ./staging-fixtures.json \
  --requests 1800 --concurrency 20 --rate 30 \
  --output .artifacts/ops/staging-status-baseline
```

Start disposable title workflows only after write acknowledgement. By default one
unique fixture is required per request so the result measures starts rather than
idempotent replays:

```bash
export MYCHAT_OPS_WRITE_ACK=disposable-staging-data
npm run ops:load -- \
  --mode real --allow-real --allow-writes --operation title \
  --fixtures ./staging-fixtures.json \
  --requests 100 --concurrency 5 --rate 2 \
  --output .artifacts/ops/staging-title-baseline
```

`--allow-replay` permits cycling through fewer title fixtures. Replay results must
not be compared with unique-start throughput.

## Chaos profiles

Mock mode covers:

- `duplicate-start`: two simultaneous starts converge on one execution.
- `cancel-race`: concurrent cancellation retains execution identity.
- `poll-abort-recovery`: a client-aborted status read does not prevent a retry.
- `dependency-outage`: one injected dependency failure fails closed, then recovers.

Real mode deliberately supports only client-visible faults. A safe read-only run is:

```bash
npm run ops:chaos -- \
  --mode real --allow-real --scenarios poll-abort-recovery \
  --fixtures ./staging-fixtures.json --repetitions 100 \
  --output .artifacts/ops/staging-client-chaos
```

`duplicate-start` and `cancel-race` require the real-write controls. Worker kills,
database isolation, provider outages, and process restarts must be performed by an
external staging orchestrator or deployment operator. This repository intentionally
does not expose an HTTP chaos backdoor or execute arbitrary shell hooks. Run the
resumable soak monitor around those external actions and preserve both timelines.

## Resumable soak

A 24-hour read-only staging soak can repeatedly inspect known jobs:

```bash
npm run ops:soak -- \
  --mode real --allow-real --operation status \
  --duration-seconds 86400 --interval-ms 1000 \
  --fixtures ./staging-fixtures.json \
  --output .artifacts/ops/staging-soak-24h
```

The tool atomically updates `checkpoint.json` after every operation and again after
each interval. Resume the same run after an interruption:

```bash
npm run ops:soak -- \
  --mode real --allow-real --operation status \
  --duration-seconds 86400 --interval-ms 1000 \
  --fixtures ./staging-fixtures.json \
  --output .artifacts/ops/staging-soak-24h --resume
```

Immutable settings and the fixture digest must match the checkpoint. The iteration
or duration target may be extended, but not lowered below completed work. SIGINT and
SIGTERM request a checkpointed exit; abrupt termination loses at most the active
operation.

## Evidence files

Every output directory contains:

- `manifest.json`: immutable configuration digest, target revision, final state,
  counts, error classes, and latency summary.
- `events.jsonl`: one bounded, schema-versioned record per completed operation or
  invariant check.
- `checkpoint.json`: soak progress, cumulative histogram, and resume identity.

Exit code `0` means the configured gates passed, `1` means an invariant or error
threshold failed, and `130` means a soak stopped cleanly before its target. Mock
results prove harness behavior only; they are never evidence of staging capacity.
