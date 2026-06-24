"use client"

import { cn } from "@/lib/utils"

// 2×2 点阵：3 亮 1 暗，暗点在四个角逆时针轮转
// 顺序：暗点从右下开始 → 右上 → 左上 → 左下 → 右下 ...
// 等效果：3 个亮点的「星座」在正方形里旋转
//
// 视觉：纯像素点，不是圆球，不是圆圈，1.5px × 1.5px 正方形

type Props = { className?: string; style?: React.CSSProperties }

export function WorkingDots({ className, style }: Props) {
  return (
    <span
      className={cn("inline-grid shrink-0 select-none", className)}
      style={{
        width: "0.45em",
        height: "0.45em",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
        gap: "0",
        ...style,
      }}
      aria-label="AI 工作中"
    >
      {/* tl (左上) — 第 3 帧暗 */}
      <span style={{
        display: "block",
        width: "100%",
        height: "100%",
        backgroundColor: "currentColor",
        animation: "dot-blink-tl 1.2s step-start infinite",
      }} />
      {/* tr (右上) — 第 2 帧暗 */}
      <span style={{
        display: "block",
        width: "100%",
        height: "100%",
        backgroundColor: "currentColor",
        animation: "dot-blink-tr 1.2s step-start infinite",
      }} />
      {/* bl (左下) — 第 4 帧暗 */}
      <span style={{
        display: "block",
        width: "100%",
        height: "100%",
        backgroundColor: "currentColor",
        animation: "dot-blink-bl 1.2s step-start infinite",
      }} />
      {/* br (右下) — 第 1 帧暗 */}
      <span style={{
        display: "block",
        width: "100%",
        height: "100%",
        backgroundColor: "currentColor",
        animation: "dot-blink-br 1.2s step-start infinite",
      }} />
      <style>{`
        /* 默认全亮，只在对应帧变暗 */
        @keyframes dot-blink-br { 0%, 24.9% { opacity: 1 } 25%, 99.9% { opacity: 0.15 } 100% { opacity: 1 } }
        @keyframes dot-blink-tr { 0%, 24.9% { opacity: 0.15 } 25%, 49.9% { opacity: 1 } 50%, 99.9% { opacity: 1 } 100% { opacity: 0.15 } }
        @keyframes dot-blink-tl { 0%, 49.9% { opacity: 1 } 50%, 74.9% { opacity: 0.15 } 75%, 99.9% { opacity: 1 } 100% { opacity: 1 } }
        @keyframes dot-blink-bl { 0%, 74.9% { opacity: 1 } 75%, 99.9% { opacity: 0.15 } 100% { opacity: 1 } }
      `}</style>
    </span>
  )
}
