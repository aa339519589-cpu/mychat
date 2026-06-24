import type { ProviderAdapterId } from './provider-adapters'

export type ModelCapability = {
  id: string
  supportsVision: boolean
  supportsImageInput: boolean
  maxContext: number
  provider: {
    id: 'deepseek' | 'xiaomi-mimo'
    adapter: ProviderAdapterId
    baseUrl: string
    apiKeyEnv: 'DEEPSEEK_API_KEY' | 'MIMO_API_KEY'
  }
}

export const MODEL_REGISTRY = {
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    supportsVision: false,
    supportsImageInput: false,
    maxContext: 128_000,
    provider: {
      id: 'deepseek',
      adapter: 'deepseek-openai',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    supportsVision: false,
    supportsImageInput: false,
    maxContext: 128_000,
    provider: {
      id: 'deepseek',
      adapter: 'deepseek-openai',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },
  'mimo-v2.5': {
    id: 'mimo-v2.5',
    supportsVision: true,
    supportsImageInput: true,
    maxContext: 1_000_000,
    provider: {
      id: 'xiaomi-mimo',
      adapter: 'mimo-openai',
      baseUrl: 'https://api.xiaomimimo.com',
      apiKeyEnv: 'MIMO_API_KEY',
    },
  },
} as const satisfies Record<string, ModelCapability>

export function getModelCapability(model: string): ModelCapability {
  return MODEL_REGISTRY[model as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY['deepseek-v4-flash']
}

export function modelSupportsImageInput(model: string): boolean {
  return getModelCapability(model).supportsImageInput
}
