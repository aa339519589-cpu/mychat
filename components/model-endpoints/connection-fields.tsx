"use client"

import { KeyRound, Link2 } from "lucide-react"

type ConnectionFieldsProps = {
  baseUrl: string
  apiKey: string
  onBaseUrlChange: (value: string) => void
  onApiKeyChange: (value: string) => void
}

export function ConnectionFields({
  baseUrl,
  apiKey,
  onBaseUrlChange,
  onApiKeyChange,
}: ConnectionFieldsProps) {
  return (
    <>
      <label className="block">
        <span className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Link2 className="size-3.5" />Base URL
        </span>
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={baseUrl}
          onChange={event => onBaseUrlChange(event.target.value)}
          placeholder="https://api.example.com/v1"
          className="w-full rounded-lg border border-sidebar-border bg-background/45 px-3 py-2 text-[13px] outline-none transition-colors focus:border-sidebar-primary/50"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <KeyRound className="size-3.5" />API Key
        </span>
        <input
          type="password"
          name="model-api-key"
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={apiKey}
          onChange={event => onApiKeyChange(event.target.value)}
          placeholder="可留空"
          className="w-full rounded-lg border border-sidebar-border bg-background/45 px-3 py-2 text-[13px] outline-none transition-colors focus:border-sidebar-primary/50"
        />
      </label>
    </>
  )
}
