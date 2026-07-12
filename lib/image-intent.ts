/**
 * Detect user requests that should hit the image generation API
 * instead of the chat model (which will only claim it cannot draw).
 */
const IMAGE_INTENT_RE = new RegExp(
  [
    // Chinese
    '画(?:一|一?张|个|幅)?',
    '生成(?:一|一?张|个|幅)?(?:图片|图像|插画|海报|壁纸|封面)',
    '做(?:一|一?张)?(?:图|图片|海报|壁纸)',
    '出(?:一|一?张)?图',
    '帮我画',
    '给我画',
    '文生图',
    'AI\\s*绘画',
    '绘制',
    // English
    'generate\\s+(an?\\s+)?image',
    'create\\s+(an?\\s+)?image',
    'draw\\s+(me\\s+)?(an?\\s+)?',
    'make\\s+(me\\s+)?(an?\\s+)?image',
    'text[- ]to[- ]image',
    'imagine\\s+',
  ].join('|'),
  'i',
)

export function isImageGenerationIntent(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 4000) return false
  // Avoid false positives on pure analysis of images
  if (/分析|解读|这张图|图中|what is in (this|the) image|describe (this|the) image/i.test(t) && !IMAGE_INTENT_RE.test(t)) {
    return false
  }
  return IMAGE_INTENT_RE.test(t)
}

/** Strip soft command prefixes so the image API gets a clean prompt. */
export function extractImagePrompt(text: string): string {
  return text
    .trim()
    .replace(/^(请|麻烦|帮我|给我|请你)?(画|生成|做|绘制)(一|一?张|个|幅)?(图片|图像|插画|海报|壁纸|封面)?[：:\s]*/i, '')
    .replace(/^(please\s+)?(generate|create|draw|make)\s+(me\s+)?(an?\s+)?(image\s+(of\s+)?)?/i, '')
    .trim() || text.trim()
}
