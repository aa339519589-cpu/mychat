export type WorkspaceResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export type WorkspaceMutationAuthority = {
  signal?: AbortSignal
  assertAuthority?: () => void
}

export function assertWorkspaceMutationActive(authority: WorkspaceMutationAuthority): void {
  authority.signal?.throwIfAborted()
  authority.assertAuthority?.()
  authority.signal?.throwIfAborted()
}

