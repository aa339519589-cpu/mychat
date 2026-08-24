import { OAuthConsent } from "@/components/oauth-consent"
import { maestroOAuthClientName } from "@/lib/maestro/oauth-server"

export const dynamic = "force-dynamic"

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params[key] = value
  }
  const clientName = params.client_id ? maestroOAuthClientName(params.client_id) : "ChatGPT"
  return <OAuthConsent params={params} clientName={clientName} />
}
