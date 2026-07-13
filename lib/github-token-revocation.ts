type OAuthAppCredentials = {
  clientId?: string
  clientSecret?: string
}

/** Revoke exactly one OAuth token using the app-owner endpoint. */
export async function revokeGitHubOAuthToken(
  token: string,
  credentials: OAuthAppCredentials = {},
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const clientId = credentials.clientId?.trim() || process.env.GITHUB_CLIENT_ID?.trim()
  const clientSecret = credentials.clientSecret?.trim() || process.env.GITHUB_CLIENT_SECRET?.trim()
  if (!token || !clientId || !clientSecret) return false

  const authorization = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')
  const response = await fetchImpl(
    `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/json',
        'User-Agent': 'mychat-app',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(15_000),
    },
  ).catch(() => null)
  return response?.status === 204
}
