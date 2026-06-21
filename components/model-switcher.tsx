"use client"

import { MODELS, type ModelId } from "@/lib/chat-data"
import { cn } from "@/lib/utils"

export function ModelSwitcher({
  active,
  onChange,
}: {
  active: ModelId
  onChange: (id: ModelId) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="选择对谈者"
      className="inline-flex items-stretch rounded-sm border border-border bg-card/60"
    >
      {MODELS.map((m, i) => {
        const isActive = m.id === active
        return (
          <button
            key={m.id}
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(m.id)}
            className={cn(
              "group relative flex flex-col items-start px-5 py-2 text-left transition-colors",
              i > 0 && "border-l border-border",
              isActive
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "font-heading text-base leading-none tracking-wide",
                isActive && "italic",
              )}
            >
              {m.name}
            </span>
            <span className="mt-1 text-[11px] leading-none tracking-widest opacity-80">
              {m.subtitle}
            </span>
            {isActive && (
              <span
                aria-hidden
                className="absolute -bottom-px left-3 right-3 h-px bg-primary"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
