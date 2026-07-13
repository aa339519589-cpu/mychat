export type WorkspaceResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }
