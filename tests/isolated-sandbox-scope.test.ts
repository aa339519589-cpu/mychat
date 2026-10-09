import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const source = stripTypeScriptTypes(readFileSync(new URL('../lib/agent/isolated-sandbox-scope.ts', import.meta.url), 'utf8'), { mode: 'strip' })
  .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '').replace(/^export\s+/gm, '')
const { createIsolatedSandboxScope, isIsolatedSandboxScope } = new Function(source +
  '\nreturn { createIsolatedSandboxScope, isIsolatedSandboxScope };')()

function gate() {
  let open: () => void = () => {}
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

function fixture(options: {
  createGate?: ReturnType<typeof gate>; receiptGate?: ReturnType<typeof gate>; cleanupGate?: ReturnType<typeof gate>
  failCreate?: boolean; failReceiptBefore?: boolean; failReceiptAfter?: boolean; failCleanup?: boolean; replay?: boolean
} = {}) {
  const controller = new AbortController()
  const calls: string[] = []
  const enteredCreate = gate(), enteredReceipt = gate(), enteredCleanup = gate()
  const owner = { jobId: 'synthetic-job', workerId: 'synthetic-worker', leaseVersion: 7,
    userId: 'synthetic-owner', taskId: 'synthetic-task' }
  let authority = true
  const scope = createIsolatedSandboxScope({
    owner, signal: controller.signal,
    assertAuthority: () => { if (!authority) throw new Error('Synthetic lease expired') },
    withCreationReceipt: async (create: () => Promise<string>) => {
      calls.push('receipt.reserve')
      if (options.failReceiptBefore) throw new Error('Synthetic fence denied')
      if (options.replay) return { result: 'old-receipt', replayed: true }
      const result = await create()
      enteredReceipt.open()
      await options.receiptGate?.promise
      if (options.failReceiptAfter) throw new Error('Synthetic receipt outcome unavailable')
      calls.push('receipt.created')
      return { result, replayed: false }
    },
  })
  const create = async (binding: typeof owner) => {
    assert.deepEqual(binding, { jobId: 'synthetic-job', workerId: 'synthetic-worker', leaseVersion: 7,
      userId: 'synthetic-owner', taskId: 'synthetic-task' })
    calls.push('create'); enteredCreate.open()
    await options.createGate?.promise
    if (options.failCreate) throw new Error('Synthetic create failure')
    return { sandbox: { sandboxId: 'synthetic-owned-sandbox' }, syncInitialized: false,
      cleanupCreated: async () => {
        calls.push('kill:synthetic-owned-sandbox'); enteredCleanup.open()
        await options.cleanupGate?.promise
        if (options.failCleanup) throw new Error('Synthetic kill outcome unknown')
      } }
  }
  return { scope, owner, calls, controller, enteredCreate, enteredReceipt, enteredCleanup,
    expire: () => { authority = false }, create,
    acquire: () => scope.acquire('synthetic-owner', 'synthetic-task', create),
    run: (operation: () => Promise<unknown>) => scope.run('synthetic-owner', 'synthetic-task', operation) }
}

test('same-lease concurrent acquisition creates and records one instance', async () => {
  const pending = gate(), value = fixture({ createGate: pending })
  const first = value.acquire(), second = value.acquire()
  assert.strictEqual(first, second)
  await value.enteredCreate.promise
  assert.equal(value.calls.filter(call => call === 'create').length, 1)
  pending.open()
  assert.strictEqual(await first, await second)
  assert.equal(value.calls.filter(call => call === 'receipt.reserve').length, 1)
  await value.scope.dispose()
})

test('same-lease workspace operations are serialized around the shared instance', async () => {
  const value = fixture(), entered = gate(), release = gate()
  const order: string[] = []
  const first = value.run(async () => { order.push('first'); entered.open(); await release.promise; order.push('first.done') })
  await entered.promise
  const second = value.run(async () => { order.push('second') })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['first'])
  release.open(); await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'first.done', 'second'])
  await value.scope.dispose()
})

test('a different user or task cannot use a server-owned scope', async () => {
  const value = fixture()
  await assert.rejects(async () => value.scope.acquire('other-owner', 'synthetic-task', value.create), /归属不匹配/)
  await assert.rejects(async () => value.scope.run('synthetic-owner', 'other-task', async () => {}), /归属不匹配/)
  assert.deepEqual(value.calls, [])
  await value.scope.dispose()
})

test('owner values are captured and scope-shaped unregistered objects are rejected', async () => {
  const value = fixture()
  value.owner.taskId = 'changed-after-creation'
  assert.equal(isIsolatedSandboxScope(value.scope), true)
  assert.equal(isIsolatedSandboxScope({ ...value.scope }), false)
  assert.equal(isIsolatedSandboxScope(null), false)
  await value.acquire()
  await value.scope.dispose()
})

for (const failure of ['failCreate', 'failReceiptBefore', 'failReceiptAfter'] as const) {
  test(failure + ' prevents automatic recreation in the same lease', async () => {
    const value = fixture({ [failure]: true })
    await assert.rejects(value.acquire(), failure === 'failCreate' ? /创建结果未确认/ : /Synthetic/)
    await assert.rejects(async () => value.acquire(), /已关闭/)
    assert.equal(value.calls.filter(call => call === 'create').length, failure === 'failReceiptBefore' ? 0 : 1)
    assert.equal(value.calls.filter(call => call.startsWith('kill:')).length, failure === 'failReceiptAfter' ? 1 : 0)
    if (failure === 'failCreate') await assert.rejects(value.scope.dispose(), /创建结果未确认/)
    else await value.scope.dispose()
  })
}

test('a replayed creation receipt cannot cause another scope to adopt the old provider instance', async () => {
  const value = fixture({ replay: true })
  await assert.rejects(value.acquire(), /拒绝接管旧实例/)
  assert.deepEqual(value.calls, ['receipt.reserve'])
  await assert.rejects(async () => value.acquire(), /已关闭/)
  await value.scope.dispose()
})

test('cancellation while create is pending cleans up only the late returned instance', async () => {
  const pending = gate(), value = fixture({ createGate: pending })
  const acquired = value.acquire()
  const rejected = assert.rejects(acquired)
  await value.enteredCreate.promise
  value.controller.abort()
  const first = value.scope.dispose(), second = value.scope.dispose()
  assert.strictEqual(first, second)
  pending.open()
  await Promise.all([rejected, first])
  assert.equal(value.calls.filter(call => call.startsWith('kill:')).length, 1)
})

test('cancellation while the creation receipt is pending cannot return an already released instance', async () => {
  const pending = gate(), value = fixture({ receiptGate: pending })
  const acquired = value.acquire()
  const rejected = assert.rejects(acquired)
  await value.enteredReceipt.promise
  value.controller.abort(); await value.scope.dispose()
  pending.open(); await rejected
  assert.equal(value.calls.filter(call => call.startsWith('kill:')).length, 1)
})

test('repeated cleanup shares one in-flight provider request', async () => {
  const pending = gate(), value = fixture({ cleanupGate: pending })
  const created = await value.acquire()
  const first = created.cleanupCreated(), second = value.scope.dispose()
  assert.strictEqual(first, second)
  await value.enteredCleanup.promise
  assert.equal(value.calls.filter(call => call.startsWith('kill:')).length, 1)
  pending.open(); await Promise.all([first, second])
  await value.scope.dispose()
  assert.equal(value.calls.filter(call => call.startsWith('kill:')).length, 1)
})

test('failed cleanup stays explicitly uncertain and cannot trigger a replacement', async () => {
  const value = fixture({ failCleanup: true })
  await value.acquire()
  await assert.rejects(value.scope.dispose(), /清理未确认/)
  await assert.rejects(value.scope.dispose(), /清理未确认/)
  await assert.rejects(async () => value.acquire(), /已关闭/)
  assert.equal(value.calls.filter(call => call === 'create').length, 1)
  assert.equal(value.calls.filter(call => call.startsWith('kill:')).length, 1)
})

test('disposal before first use prevents creation and remains idempotent', async () => {
  const value = fixture()
  await value.scope.dispose()
  await assert.rejects(async () => value.acquire(), /已关闭/)
  await assert.rejects(value.run(async () => { throw new Error('must not run') }), /已关闭/)
  assert.deepEqual(value.calls, [])
})

test('worker authority is checked again after a queued operation wakes', async () => {
  const value = fixture(), entered = gate(), release = gate()
  const first = value.run(async () => { entered.open(); await release.promise })
  await entered.promise
  const second = value.run(async () => { throw new Error('must not run') })
  const rejected = assert.rejects(second, /Synthetic lease expired/)
  value.expire(); release.open()
  await Promise.all([first, rejected])
  assert.deepEqual(value.calls, [])
  await value.scope.dispose()
})

test('an unknown provider create outcome never becomes a successful cleanup acknowledgement', async () => {
  const value = fixture({ failCreate: true })
  const failure = await value.acquire().then(() => assert.fail('creation should fail'), (error: Error & { cause?: Error }) => error)
  const first = value.scope.dispose(), second = value.scope.dispose()
  assert.strictEqual(first, second)
  await assert.rejects(first, /无法确认清理/)
  await assert.rejects(second, /无法确认清理/)
  assert.match(failure.message, /创建结果未确认/)
  assert.equal(failure.cause?.message, 'Synthetic create failure')
  assert.equal(value.calls.filter(call => call === 'create').length, 1)
  assert.equal(value.calls.some(call => call.startsWith('kill:')), false)
})

test('cancellation before the SDK starts needs no provider cleanup and is not mislabeled as an unknown create', async () => {
  const value = fixture()
  const pending = value.acquire()
  const rejected = assert.rejects(pending, (error: Error) => error.name === 'AbortError')
  value.controller.abort()
  await value.scope.dispose()
  await rejected
  assert.deepEqual(value.calls, ['receipt.reserve'])
})

test('a late create whose cancellation cleanup fails remains uncertain across repeated disposal', async () => {
  const pending = gate(), value = fixture({ createGate: pending, failCleanup: true })
  const acquisition = value.acquire()
  const rejected = assert.rejects(acquisition, /清理未确认/)
  await value.enteredCreate.promise
  value.controller.abort()
  const disposed = assert.rejects(value.scope.dispose(), /清理未确认/)
  pending.open()
  await Promise.all([rejected, disposed])
  await assert.rejects(value.scope.dispose(), /清理未确认/)
  assert.equal(value.calls.filter(call => call.startsWith('kill:')).length, 1)
})
