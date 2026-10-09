import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createLiveJobEventStream } from '../lib/jobs/live-event-stream'
import { receiveProcessLiveMessage } from '../lib/jobs/process-live-events'
import type { JsonObject } from '../lib/jobs/contracts'
import type { PublicJobSnapshot } from '../lib/jobs/read-model'

type StreamFrame = { kind: string; payload: JsonObject }
type QueryResult = { data: never[]; error: null }
type InertChannel = { on: () => InertChannel; subscribe: () => InertChannel }

const NOW = '2026-10-09T00:00:00.000Z';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await turn();
  assert.ok(predicate(), 'Synthetic event ordering did not reach its bounded checkpoint');
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture(status: 'running' | 'completed' = 'running') {
  const firstRead = deferred();
  const abort = new AbortController();
  let reads = 0;
  const frames: StreamFrame[] = [];
  const id = randomUUID(), streamId = randomUUID();
  const initialJob: PublicJobSnapshot = { id, type: 'chat.generation', queue: 'chat', subject: {}, status,
    attempt: 1, maxAttempts: 4, priority: 0, availableAt: NOW, cancelRequestedAt: null,
    progress: { content: 'AB', thinking: '', reasoningSummary: 'Checking ' },
    result: status === 'completed' ? { content: 'AB', thinking: '', reasoningSummary: 'Checking ' } : null,
    errorClass: null, errorCode: null, eventSequence: 2, createdAt: NOW, updatedAt: NOW,
    startedAt: NOW, terminalAt: null };
  const channel: InertChannel = { on: () => channel, subscribe: () => channel };
  const client = {
    channel: () => channel,
    removeChannel: async () => {},
    from(table: string) {
      assert.equal(table, 'job_events', 'Every read must remain at the controlled event boundary');
      const query: Record<string, unknown> = {};
      for (const name of ['select', 'eq', 'gt', 'order', 'limit', 'abortSignal']) query[name] = () => query;
      query.then = (resolve: (result: QueryResult) => unknown, reject: (error: unknown) => unknown) => {
        reads += 1;
        const gate = reads === 1 ? firstRead.promise : status === 'completed' ? Promise.resolve() : new Promise<void>(done => {
          if (abort.signal.aborted) done();
          else abort.signal.addEventListener('abort', done, { once: true });
        });
        return gate.then(() => ({ data: [], error: null })).then(resolve, reject);
      };
      return query;
    },
  };
  const reader = createLiveJobEventStream({ client: client as never, principalId: randomUUID(), jobId: id,
    fromSequence: 0, initialJob, requestSignal: abort.signal, maxDurationMs: 2_000 }).getReader();
  const finished = (async () => {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      for (const line of new TextDecoder().decode(result.value).split('\n')) {
        if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  let revision = 0;
  return {
    frames, firstRead, reads: () => reads,
    publish(kind: string, payload: JsonObject, offset?: number) {
      receiveProcessLiveMessage({ type: 'mychat.job.live.v1', jobId: id, publishedAt: Date.now(),
        event: { kind, payload, revision: ++revision, streamId, ...(offset === undefined ? {} : { offset }) } });
    },
    async close() { firstRead.release(); abort.abort(); await finished; },
  };
}

test('terminal authority does not flush an orphan tail after its final snapshot', { timeout: 2_000 }, async () => {
  const f = fixture('completed');
  try {
    await until(() => f.reads() === 1);
    f.publish('text.delta', { text: 'STALE_TAIL' }, 2);
    f.publish('reasoning.summary.delta', { reasoningSummary: 'STALE_SUMMARY' }, 9);
    f.publish('fixture.barrier', {});
    await until(() => f.frames.some(frame => frame.kind === 'fixture.barrier'));
    f.firstRead.release();
    await until(() => f.frames.some(frame => frame.kind === 'job.terminal'));
    assert.equal(f.frames.filter(frame => frame.kind.endsWith('.delta')).length, 0);
    assert.equal(f.frames.filter(frame => frame.kind === 'job.snapshot').at(-1)?.payload.content, 'AB');
    assert.equal(f.frames.at(-1)?.kind, 'job.terminal');
  } finally { await f.close(); }
});

test('control: a tail received after the snapshot is relayed without a durable read', { timeout: 2_000 }, async () => {
  const f = fixture();
  try {
    f.firstRead.release();
    await until(() => f.frames.some(frame => frame.kind === 'job.snapshot'));
    f.publish('text.delta', { text: 'C' }, 2);
    f.publish('reasoning.summary.delta', { reasoningSummary: 'inputs.' }, 9);
    f.publish('fixture.barrier', {});
    await until(() => f.frames.some(frame => frame.kind === 'fixture.barrier'));
    assert.deepEqual(f.frames.filter(frame => frame.kind.endsWith('.delta')).map(frame => frame.kind),
      ['text.delta', 'reasoning.summary.delta']);
    assert.equal(f.reads(), 1, 'No later database poll may establish the control result');
  } finally { await f.close(); }
});

for (const [kind, key, tail, offset] of [
  ['text.delta', 'text', 'C', 2],
  ['reasoning.summary.delta', 'reasoningSummary', 'inputs.', 9],
] as const) {
  test(`regression: queued ${kind} drains when the snapshot supplies its missing prefix`, { timeout: 2_000 }, async () => {
    const f = fixture();
    try {
      await until(() => f.reads() === 1);
      f.publish(kind, { [key]: tail }, offset);
      f.publish('fixture.barrier', {});
      await until(() => f.frames.some(frame => frame.kind === 'fixture.barrier'));
      assert.equal(f.frames.some(frame => frame.kind === kind), false, 'A tail cannot be emitted before its prefix');
      f.firstRead.release();
      await until(() => f.frames.some(frame => frame.kind === 'job.snapshot'));
      // A later marker proves the production processing chain got another turn.
      // The second database read remains held and cannot conceal delayed delivery.
      f.publish('fixture.after-snapshot', {});
      await until(() => f.frames.some(frame => frame.kind === 'fixture.after-snapshot'));
      assert.equal(f.frames.some(frame => frame.kind === kind && frame.payload[key] === tail), true,
        'Snapshot supplied the complete prefix, but the already-received tail was not delivered');
    } finally { await f.close(); }
  });
}

test('snapshot drains eligible summary and body tails in their queued order', { timeout: 2_000 }, async () => {
  const f = fixture();
  try {
    await until(() => f.reads() === 1);
    f.publish('reasoning.summary.delta', { reasoningSummary: 'inputs.' }, 9);
    f.publish('text.delta', { text: 'C' }, 2);
    f.publish('fixture.barrier', {});
    await until(() => f.frames.some(frame => frame.kind === 'fixture.barrier'));
    f.firstRead.release();
    await until(() => f.frames.some(frame => frame.kind === 'job.snapshot'));
    f.publish('fixture.after-snapshot', {});
    await until(() => f.frames.some(frame => frame.kind === 'fixture.after-snapshot'));
    assert.deepEqual(f.frames.filter(frame => frame.kind.endsWith('.delta')).map(frame => frame.kind),
      ['reasoning.summary.delta', 'text.delta']);
  } finally { await f.close(); }
});
