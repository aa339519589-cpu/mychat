export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_MODELS = 500
export const MAX_MODEL_ID = 512
export const CONNECT_TIMEOUT_MS = 15_000
export const PROBE_TIMEOUT_MS = 60_000

export type EndpointStage = 'url' | 'network' | 'models' | 'chat'

export class ModelEndpointError extends Error {
  constructor(
    message: string,
    public readonly stage: EndpointStage,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = 'ModelEndpointError'
  }
}
