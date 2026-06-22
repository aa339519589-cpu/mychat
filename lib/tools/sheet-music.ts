// 预制五线谱工具：常用样板库，快速返回
import type { ToolDef, ToolOutcome } from './types'

// 预制五线谱样板库
const SHEET_MUSIC_PRESETS: Record<string, string> = {
  default: `<svg viewBox="0 0 800 300" xmlns="http://www.w3.org/2000/svg">
  <!-- 五根线 -->
  <line x1="40" y1="80" x2="760" y2="80" stroke="currentColor" stroke-width="1"/>
  <line x1="40" y1="110" x2="760" y2="110" stroke="currentColor" stroke-width="1"/>
  <line x1="40" y1="140" x2="760" y2="140" stroke="currentColor" stroke-width="1"/>
  <line x1="40" y1="170" x2="760" y2="170" stroke="currentColor" stroke-width="1"/>
  <line x1="40" y1="200" x2="760" y2="200" stroke="currentColor" stroke-width="1"/>
  <!-- 高音谱号 -->
  <text x="60" y="160" font-size="60" fill="currentColor" font-family="serif">𝄞</text>
  <!-- 示范音符 -->
  <circle cx="150" cy="140" r="5" fill="currentColor"/>
  <line x1="155" y1="140" x2="155" y2="80" stroke="currentColor" stroke-width="2"/>
  <circle cx="200" cy="110" r="5" fill="currentColor"/>
  <line x1="205" y1="110" x2="205" y2="50" stroke="currentColor" stroke-width="2"/>
  <circle cx="250" cy="80" r="5" fill="currentColor"/>
  <line x1="255" y1="80" x2="255" y2="20" stroke="currentColor" stroke-width="2"/>
</svg>`,

  c_major: `<svg viewBox="0 0 1000 300" xmlns="http://www.w3.org/2000/svg">
  <!-- 五根线 -->
  <line x1="60" y1="80" x2="950" y2="80" stroke="currentColor" stroke-width="1"/>
  <line x1="60" y1="110" x2="950" y2="110" stroke="currentColor" stroke-width="1"/>
  <line x1="60" y1="140" x2="950" y2="140" stroke="currentColor" stroke-width="1"/>
  <line x1="60" y1="170" x2="950" y2="170" stroke="currentColor" stroke-width="1"/>
  <line x1="60" y1="200" x2="950" y2="200" stroke="currentColor" stroke-width="1"/>
  <!-- 高音谱号 -->
  <text x="70" y="160" font-size="70" fill="currentColor" font-family="serif">𝄞</text>
  <!-- C大调（do re mi fa sol） -->
  <circle cx="200" cy="200" r="6" fill="currentColor"/>
  <line x1="206" y1="200" x2="206" y2="120" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="280" cy="170" r="6" fill="currentColor"/>
  <line x1="286" y1="170" x2="286" y2="90" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="360" cy="140" r="6" fill="currentColor"/>
  <line x1="366" y1="140" x2="366" y2="60" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="440" cy="110" r="6" fill="currentColor"/>
  <line x1="446" y1="110" x2="446" y2="30" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="520" cy="80" r="6" fill="currentColor"/>
  <line x1="526" y1="80" x2="526" y2="0" stroke="currentColor" stroke-width="2.5"/>
</svg>`,

  happy_birthday: `<svg viewBox="0 0 1200 350" xmlns="http://www.w3.org/2000/svg">
  <!-- 五根线 -->
  <line x1="80" y1="100" x2="1150" y2="100" stroke="currentColor" stroke-width="1"/>
  <line x1="80" y1="130" x2="1150" y2="130" stroke="currentColor" stroke-width="1"/>
  <line x1="80" y1="160" x2="1150" y2="160" stroke="currentColor" stroke-width="1"/>
  <line x1="80" y1="190" x2="1150" y2="190" stroke="currentColor" stroke-width="1"/>
  <line x1="80" y1="220" x2="1150" y2="220" stroke="currentColor" stroke-width="1"/>
  <!-- 高音谱号 -->
  <text x="90" y="175" font-size="80" fill="currentColor" font-family="serif">𝄞</text>
  <!-- Happy Birthday 旋律 -->
  <circle cx="200" cy="220" r="6" fill="currentColor"/>
  <line x1="206" y1="220" x2="206" y2="140" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="270" cy="220" r="6" fill="currentColor"/>
  <line x1="276" y1="220" x2="276" y2="140" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="340" cy="190" r="6" fill="currentColor"/>
  <line x1="346" y1="190" x2="346" y2="110" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="410" cy="160" r="6" fill="currentColor"/>
  <line x1="416" y1="160" x2="416" y2="80" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="480" cy="220" r="6" fill="currentColor"/>
  <line x1="486" y1="220" x2="486" y2="140" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="550" cy="190" r="6" fill="currentColor"/>
  <line x1="556" y1="190" x2="556" y2="110" stroke="currentColor" stroke-width="2.5"/>
  <circle cx="620" cy="160" r="6" fill="currentColor"/>
  <line x1="626" y1="160" x2="626" y2="80" stroke="currentColor" stroke-width="2.5"/>
</svg>`,
}

async function renderSheetMusic(type: string): Promise<{ svg: string; displayType: string }> {
  const svg = SHEET_MUSIC_PRESETS[type.toLowerCase()] || SHEET_MUSIC_PRESETS.default
  const displayType = type === 'default' ? '五线谱' : type === 'c_major' ? 'C大调' : type === 'happy_birthday' ? '生日快乐' : '五线谱'
  return { svg, displayType }
}

export const sheetMusicTool: ToolDef = {
  name: 'render_sheet_music',
  description: '渲染预制的五线谱。支持类型：default（基础示范）、c_major（C大调）、happy_birthday（生日快乐）。当用户要求这些类型时直接调用，秒级返回。',
  schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: '五线谱类型：default、c_major、happy_birthday',
      },
    },
    required: ['type'],
  },
  enabled: () => true,
  execute: async (input): Promise<ToolOutcome> => {
    const type = String(input?.type ?? 'default').trim()
    const { svg, displayType } = await renderSheetMusic(type)
    // 返回 SVG 包在 inline-artifact 标签里，这样前端会自动识别并渲染
    const result = `<inline-artifact>\n${svg}\n</inline-artifact>`
    return { result, event: { sheetMusic: { type, svg } } }
  },
}
