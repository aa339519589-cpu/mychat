import type { ShellOptions, ShellResult } from './shell'

/** A selected backend never falls back to another location on failure. */
export interface ExecutionBackend {
  readonly id: 'isolated' | 'local'
  readonly location: 'cloud' | 'local_test'
  execute(command: string, options: ShellOptions): Promise<ShellResult>
}
