import type { DiscoveredModel, EndpointAuthType, ModelEndpointSummary, ModelOutputKind } from "@/lib/model-endpoints"

type ApiErrorBody = { error?: string; stage?: string; code?: string }

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as ApiErrorBody & T
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`)
  return body
}

export async function fetchModelEndpoints(): Promise<ModelEndpointSummary[]> {
  const response = await fetch("/api/endpoints", { cache: "no-store" })
  const body = await responseJson<{ endpoints: ModelEndpointSummary[] }>(response)
  return Array.isArray(body.endpoints) ? body.endpoints : []
}

export async function discoverModels(input: {
  baseUrl?: string
  apiKey?: string
  authType?: EndpointAuthType | "auto"
  endpointId?: string
}): Promise<{ baseUrl: string; authType: EndpointAuthType; models: DiscoveredModel[] }> {
  const response = await fetch("/api/endpoints/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return responseJson(response)
}

export async function createModelEndpoint(input: {
  baseUrl: string
  apiKey: string
  authType: EndpointAuthType | "auto"
  model: string
  outputKind: ModelOutputKind
  displayName?: string
}): Promise<ModelEndpointSummary> {
  const response = await fetch("/api/endpoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = await responseJson<{ endpoint: ModelEndpointSummary }>(response)
  return body.endpoint
}

export async function updateModelEndpoint(id: string, input: {
  baseUrl?: string
  apiKey?: string
  authType?: EndpointAuthType | "auto"
  model?: string
  outputKind?: ModelOutputKind
  displayName?: string
}): Promise<ModelEndpointSummary> {
  const response = await fetch(`/api/endpoints/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = await responseJson<{ endpoint: ModelEndpointSummary }>(response)
  return body.endpoint
}

export async function deleteModelEndpoint(id: string): Promise<void> {
  const response = await fetch(`/api/endpoints/${encodeURIComponent(id)}`, { method: "DELETE" })
  await responseJson<{ ok: true }>(response)
}
