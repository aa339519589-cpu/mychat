# Stream and asset lifecycle

Migration `20260713260000_stream_and_asset_lifecycle.sql` closes the realtime
connection, oversized context, and private Job payload lifecycle boundaries.
The database is authoritative for every distributed quota and cleanup state.

## Job event streams

The events route acquires a service-role-only `job_stream_leases` row after it
has verified Job ownership. Admission is serialized by a transaction advisory
lock, so simultaneous requests reaching different web instances cannot exceed:

- 4 live streams per principal
- 12 live streams per client-address digest
- 2 live streams per Job
- 256 live streams globally

The table stores a scoped HMAC-SHA-256 digest, never the raw client address. The
HMAC requires an independent `STREAM_ADMISSION_HASH_KEY` of at least 32 bytes in
production; it never reuses the Supabase service-role credential. Production
fails closed if this dedicated key is absent or too short. Leases
expire after 45 seconds unless renewed every 15 seconds. A connection has an
unextendable 15-minute hard deadline; clients resume using `Last-Event-ID` or
`from_seq`. Process death releases capacity through lease expiry.

Event polling backs off from 250 ms to 2 seconds while idle and refreshes the
Job snapshot at most every 5 seconds. The global lease cap therefore bounds
database amplification. The stream queue holds one frame: if `desiredSize`
does not recover within 5 seconds, the server disconnects the slow consumer
instead of buffering unbounded event data.

Capacity rejection is HTTP 429 with `Retry-After`; database admission failure
is HTTP 503 and fails closed. Operators can inspect current cardinality without
exposing leases to browser roles:

```sql
select count(*) as global,
       count(distinct principal_id) as principals,
       min(expires_at) as next_expiry
from public.job_stream_leases
where expires_at > clock_timestamp();
```

## Payload lifecycle

New private Job payloads are limited to 8 MiB at the HTTP reader, canonical
serializer, Job insert trigger, and Storage bucket. `job_payload_assets` binds
the immutable object key, digest, byte count, principal, and Job identity.

Terminal completion retains payloads for 15 minutes. Failed or cancelled Jobs
retain them for one hour. The terminal transition atomically creates a delayed
`payloads.cleanup` outbox message. Its fenced protocol is:

1. Claim the outbox generation.
2. Change `retained` to `deleting` and return the validated object key.
3. Delete through the private Storage API.
4. Commit a `deleted` tombstone and decrement tenant resource usage.
5. Publish the outbox row.

Crashes before step 4 replay the idempotent Storage delete. A stale outbox
generation cannot finish or publish a newer generation. Tombstones remain for
deletion evidence; only published transport rows older than seven days are
removed by the bounded lifecycle sweeper.

## Tenant limits

Database triggers maintain `tenant_resource_usage` atomically for direct DML,
service projections, and cleanup transitions. New writes cannot exceed:

| Resource | Row limit | Tenant count | Tenant bytes |
| --- | ---: | ---: | ---: |
| Project file | 1 MiB | 200 | 64 MiB |
| Message materialization | 2 MiB | 100,000 | 1 GiB |
| Active/retained Job payload | 8 MiB | 128 | 512 MiB |

Legacy usage may be above a new ceiling after expand. The migration records its
actual value without failing deployment, but rejects further growth until the
tenant deletes data or lifecycle cleanup brings usage below the ceiling.
Before scanning legacy rows, the migration installs trigger write barriers on
the old application write paths. In-flight transactions finish before that DDL
lock is acquired and are visible to the scan; later writes resume after commit
and execute the new triggers. A final source-of-truth reconciliation makes the
cutover repeatable and repairs counters from an interrupted earlier rollout.

## Operations

`JobLifecycleSweeper` calls `sweep_job_lifecycle` immediately at Worker startup
and every five minutes. Each category is limited to 500 rows per call and uses
`FOR UPDATE SKIP LOCKED`, so multiple Worker replicas remain safe. Dead-letter
outbox rows, ledger entries, audit records, and payload tombstones are excluded.
The same sweep reclaims expired admission reservations. Terminal Jobs settle
directly; non-terminal Jobs without a fresh Worker lease transition through the
canonical failed projection with `JOB_ADMISSION_EXPIRED`. A fresh lease is
never interrupted, even if its financial hold has reached its nominal expiry.

Readiness uses `runtime_healthcheck_v12`. The migration also evolves v5's
Storage-size assertion so old v8 application instances remain healthy during a
rolling deployment. Production must not fall back to an older readiness RPC.

Suggested alerts:

- active streams above 80 percent of 256 for five minutes
- any stream lease older than its hard expiry
- `payloads.cleanup` dead letters above zero
- retained payloads more than 15 minutes past `retain_until`
- tenant usage above 90 percent of any byte limit
- lifecycle sweep failures for two consecutive intervals
