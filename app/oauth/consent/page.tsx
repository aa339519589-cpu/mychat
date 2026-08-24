import { OAuthConsent } from "@/components/oauth-consent"

export const dynamic = "force-dynamic"

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>
}) {
  const params = await searchParams
  return <OAuthConsent authorizationId={params.authorization_id ?? ""} />
}
