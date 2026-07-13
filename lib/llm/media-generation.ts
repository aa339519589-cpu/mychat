import type { GeneratedMedia } from '@/lib/generated-media'
import {
  MediaGenerationError,
  validateOptions,
  type GenerateMediaOptions,
} from './media-generation/contracts'
import { generateOpenAICompatibleImage } from './media-generation/image'
import {
  generateGrokProxyVideo,
  generateOpenAICompatibleVideo,
} from './media-generation/video'

export type { GeneratedMedia } from '@/lib/generated-media'
export type {
  GenerateMediaOptions,
  MaterializeGeneratedMediaOptions,
  MediaOutputKind,
  ModelEndpointFetcher,
} from './media-generation/contracts'
export {
  combineMediaGenerationSignals,
  MediaGenerationError,
} from './media-generation/contracts'
export { materializeOpenAICompatibleMedia } from './media-generation/materialize'
export { generateOpenAICompatibleImage } from './media-generation/image'
export {
  generateGrokProxyVideo,
  generateOpenAICompatibleVideo,
} from './media-generation/video'

export async function generateOpenAICompatibleMedia(
  options: GenerateMediaOptions,
): Promise<GeneratedMedia> {
  const kind = validateOptions(options)
  if (kind === 'image') {
    return generateOpenAICompatibleImage({ ...options, outputKind: 'image', forceKind: 'image' })
  }

  try {
    return await generateGrokProxyVideo({ ...options, outputKind: 'video', forceKind: 'video' })
  } catch (error) {
    if (error instanceof MediaGenerationError
      && (error.code === 'media_not_found' || error.status === 404)) {
      return generateOpenAICompatibleVideo(options)
    }
    throw error
  }
}
