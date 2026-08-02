"use client"

import { useEffect, useId, useRef } from "react"
import { createPortal } from "react-dom"
import { Check, X } from "lucide-react"

import type { ModelCatalogItem } from "@/lib/model-catalog"
import { cn } from "@/lib/utils"
import { ACCENT, CONTROL_FOCUS, MONO } from "./shared"

function effortLabel(value: string): string {
  if (value === "none") return "Off"
  if (value === "xhigh") return "XHigh"
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function EffortOptions({ efforts, active, onSelect }: {
  efforts: string[]
  active: string | null
  onSelect: (effort: string) => void
}) {
  if (!efforts.length) return <p className="py-5 text-center text-[11px] text-muted-foreground">当前模型没有可调节的思考深度。</p>
  return <div className="space-y-1.5" role="listbox" aria-label="可用思考深度">
    {efforts.map(effort => <button key={effort} type="button" role="option"
      aria-selected={effort === active} onClick={() => onSelect(effort)}
      className={cn("fluid-press flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 text-left hover:bg-secondary/60", CONTROL_FOCUS,
        effort === active ? "border-[var(--code-accent)] bg-secondary/50" : "border-border")}>
      <span className="min-w-0 flex-1 text-[12px] text-foreground" style={{ fontFamily: MONO }}>{effortLabel(effort)}</span>
      {effort === active && <Check className="size-4 shrink-0" style={{ color: ACCENT }} aria-hidden="true" />}
    </button>)}
  </div>
}

export function EffortPickerSheet({ open, model, activeEffort, onClose, onSelect }: {
  open: boolean
  model: ModelCatalogItem | null
  activeEffort: string | null
  onClose: () => void
  onSelect: (effort: string) => void
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose() }
    document.addEventListener("keydown", onKeyDown)
    closeRef.current?.focus()
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus() }
  }, [open, onClose])
  if (!open || typeof document === "undefined") return null

  const raw = model?.reasoningEfforts ?? []
  const efforts = [...raw.filter(value => value !== "none"), ...raw.filter(value => value === "none")]
  const select = (effort: string) => { onSelect(effort); onClose() }
  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-black/50 sm:items-center"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="fluid-material-strong fluid-scroll max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-xl border border-border p-4 sm:rounded-lg">
        <div className="mb-2 flex min-h-11 items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[12px] font-medium text-foreground" style={{ fontFamily: MONO }}>Thinking depth</h2>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{model?.name ?? "No model selected"}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭思考深度选择"
            className={cn("fluid-press fluid-icon-press inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground", CONTROL_FOCUS)}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <EffortOptions efforts={efforts} active={activeEffort} onSelect={select} />
        <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">该值会随下一次 Code 请求传给后端，并映射为当前模型真实的 reasoning effort。</p>
      </div>
    </div>, document.body,
  )
}
