import type { Sandbox } from 'e2b'
import type { JobFence } from '@/lib/jobs/contracts'

export type SandboxScopeOwner = Readonly<JobFence & { userId: string; taskId: string }>

export type ScopedSandbox = {
  sandbox: Sandbox
  syncInitialized: boolean
  cleanupCreated: () => Promise<void>
}

export type IsolatedSandboxScope = {
  run: <T>(userId: string, taskId: string, operation: () => Promise<T>) => Promise<T>
  acquire: (userId: string, taskId: string,
    create: (owner: SandboxScopeOwner) => Promise<ScopedSandbox>) => Promise<ScopedSandbox>
  resume: (userId: string, taskId: string, connect: (sandboxId: string) => Promise<Sandbox>) => Promise<ScopedSandbox>
  dispose: () => Promise<void>
}

const registeredScopes = new WeakSet<object>()

export function isIsolatedSandboxScope(value: unknown): value is IsolatedSandboxScope {
  return typeof value === 'object' && value !== null && registeredScopes.has(value)
}

async function resumeOwnedSandbox(input: {
  resource: Promise<ScopedSandbox> | undefined
  sandboxId: string | undefined
  assertActive: () => void
  dispose: () => Promise<void>
  connect: (sandboxId: string) => Promise<Sandbox>
}): Promise<ScopedSandbox> {
  try {
    input.assertActive()
    if (!input.resource || !input.sandboxId) throw new Error('隔离沙箱 lease 尚未创建实例')
    const resource = await input.resource
    input.assertActive()
    if (resource.sandbox.sandboxId !== input.sandboxId) throw new Error('隔离沙箱实例归属不匹配')
    const connected = await input.connect(input.sandboxId)
    input.assertActive()
    if (connected.sandboxId !== input.sandboxId) throw new Error('隔离沙箱恢复返回了不同实例')
    resource.sandbox = connected
    return resource
  } catch (error) {
    await input.dispose()
    throw error
  }
}

type SandboxScopeInput = {
  owner: SandboxScopeOwner
  signal: AbortSignal
  assertAuthority: () => void
  withCreationReceipt: (create: () => Promise<string>) => Promise<{ result: string; replayed: boolean }>
}

/** One trusted worker lease owns one provider instance. A different lease never adopts it. */
export function createIsolatedSandboxScope(input: SandboxScopeInput): IsolatedSandboxScope {
  const owner = Object.freeze({ ...input.owner })
  let closed = false
  let acquisition: Promise<ScopedSandbox> | undefined
  let providerCreation: Promise<ScopedSandbox> | undefined
  let providerStarted = false
  let sandboxId: string | undefined
  let cleanup: Promise<void> | undefined
  let queue: Promise<void> = Promise.resolve()

  const assertActive = () => {
    input.signal.throwIfAborted()
    input.assertAuthority()
    if (closed) throw new Error('隔离沙箱 lease 已关闭，禁止自动重建')
  }
  const assertOwner = (userId: string, taskId: string) => {
    if (owner.userId !== userId || owner.taskId !== taskId) throw new Error('隔离沙箱 lease 归属不匹配')
  }
  const dispose = (): Promise<void> => {
    closed = true
    input.signal.removeEventListener('abort', onAbort)
    cleanup ??= (async () => {
      let created: ScopedSandbox | undefined
      try { created = await providerCreation } catch (error) {
        if (providerStarted) throw new Error('隔离沙箱创建结果未确认，无法确认清理', { cause: error })
      }
      if (created) {
        try { await created.cleanupCreated() } catch { throw new Error('新建隔离沙箱清理未确认') }
      }
    })()
    return cleanup
  }
  const onAbort = () => { void dispose().catch(() => {}) }
  input.signal.addEventListener('abort', onAbort, { once: true })

  const acquire = async (create: (value: SandboxScopeOwner) => Promise<ScopedSandbox>) => {
    try {
      const receipt = await input.withCreationReceipt(async () => {
        assertActive()
        providerCreation = Promise.resolve().then(() => { assertActive(); providerStarted = true; return create(owner) })
        const created = await providerCreation
        sandboxId = created.sandbox.sandboxId
        assertActive()
        return JSON.stringify({ schemaVersion: 1, ...owner, sandboxId: created.sandbox.sandboxId })
      })
      assertActive()
      // A receipt does not prove that a previous in-memory owner has no pending kill.
      if (receipt.replayed || !providerCreation) throw new Error('隔离沙箱创建回执已存在，拒绝接管旧实例')
      const created = await providerCreation
      assertActive()
      return { ...created, cleanupCreated: dispose }
    } catch (error) {
      await dispose()
      throw error
    }
  }
  const scope: IsolatedSandboxScope = {
    run: (userId, taskId, operation) => {
      assertOwner(userId, taskId)
      const pending = queue.then(() => { assertActive(); return operation() })
      queue = pending.then(() => undefined, () => undefined)
      return pending
    },
    acquire: (userId, taskId, create) => {
      assertOwner(userId, taskId)
      assertActive()
      acquisition ??= acquire(create)
      return acquisition
    },
    resume: (userId, taskId, connect) => {
      assertOwner(userId, taskId)
      return resumeOwnedSandbox({ resource: acquisition, sandboxId, assertActive, dispose, connect })
    },
    dispose,
  }
  registeredScopes.add(scope)
  return Object.freeze(scope)
}

export function sandboxCancellation(sandbox: Sandbox, signal?: AbortSignal, cleanupCreated?: () => Promise<void>): () => void {
  if (signal?.aborted && cleanupCreated) void cleanupCreated().catch(() => {})
  signal?.throwIfAborted()
  const cancel = () => { void (cleanupCreated ? cleanupCreated() : sandbox.kill()).catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  return () => signal?.removeEventListener('abort', cancel)
}

export function createdSandboxCleanup(sandbox: Sandbox): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    pending ??= Promise.resolve().then(() => sandbox.kill()).then(() => undefined)
    return pending
  }
}
