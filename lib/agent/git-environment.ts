const PASSTHROUGH = new Set([
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
])

const GIT_OVERRIDE = /^(?:GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|GIT_ASKPASS|GIT_TERMINAL_PROMPT|GCM_INTERACTIVE)$/

/** Build a Git-only environment without inheriting application credentials. */
export function isolatedGitEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const candidates = { ...source, ...overrides }
  const nodeEnvironment = candidates.NODE_ENV === 'development' || candidates.NODE_ENV === 'test'
    ? candidates.NODE_ENV
    : 'production'
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: nodeEnvironment,
    LANG: candidates.LANG || 'C.UTF-8',
    LC_ALL: candidates.LC_ALL || candidates.LANG || 'C.UTF-8',
    TMPDIR: candidates.TMPDIR || '/tmp',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GCM_INTERACTIVE: 'never',
  }
  for (const [key, value] of Object.entries(candidates)) {
    if (value !== undefined && (PASSTHROUGH.has(key) || GIT_OVERRIDE.test(key))) {
      environment[key] = value
    }
  }
  return environment
}
