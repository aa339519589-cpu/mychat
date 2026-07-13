/** Strip soft command prefixes so the image API gets a clean prompt. */
export function extractImagePrompt(text: string): string {
  return text
    .trim()
    .replace(/^(请|麻烦|帮我|给我|请你)?(画|生成|做|绘制)(一张|一幅|一个|张|幅|个)?(图片|图像|插画|海报|壁纸|封面)?[：:\s]*/i, '')
    .replace(/^(please\s+)?(generate|create|draw|make)\s+(me\s+)?(an?\s+)?(image\s+(of\s+)?)?/i, '')
    .trim() || text.trim()
}
