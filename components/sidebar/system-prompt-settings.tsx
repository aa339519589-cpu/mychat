"use client"

import { useEffect, useState } from "react"
import { Save, ShieldCheck } from "lucide-react"

import { fetchCustomSystemPrompt, saveCustomSystemPrompt } from "@/lib/data"
import { MAX_CUSTOM_SYSTEM_PROMPT_CHARS } from "@/lib/user-system-prompt"

function usePromptEditor() {
  const [value, setValue] = useState("")
  const [savedValue, setSavedValue] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    let cancelled = false
    void fetchCustomSystemPrompt()
      .then(prompt => {
        if (cancelled) return
        setValue(prompt)
        setSavedValue(prompt)
      })
      .catch(() => {
        if (!cancelled) setMessage("系统提示词加载失败，请稍后重试")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const dirty = value !== savedValue
  async function save() {
    if (!dirty || saving) return
    setSaving(true)
    setMessage("")
    try {
      const persisted = await saveCustomSystemPrompt(value)
      setValue(persisted)
      setSavedValue(persisted)
      setMessage("已保存，新对话与后续回复会立即使用")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  return { value, setValue, loading, saving, message, setMessage, dirty, save }
}

export function SystemPromptSettings() {
  const editor = usePromptEditor()
  return (
    <div className="space-y-3 px-4">
      <div className="flex items-start gap-3 rounded-2xl border border-sidebar-border bg-sidebar-accent/45 p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-sidebar-primary" />
        <div>
          <p className="text-sm text-foreground">高优先级附加指令</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            内容会在 MyChat 后台系统提示词之后注入。除与后台规则、安全边界或工具约束冲突外，模型会严格执行。
          </p>
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-sidebar-border bg-card">
        <textarea
          value={editor.value}
          onChange={event => { editor.setValue(event.target.value); editor.setMessage("") }}
          disabled={editor.loading}
          maxLength={MAX_CUSTOM_SYSTEM_PROMPT_CHARS}
          placeholder="例如：回答时先给结论，再解释依据；默认使用简体中文；写代码时给出可直接运行的完整版本。"
          className="h-[48dvh] min-h-[360px] max-h-[560px] w-full resize-y bg-transparent px-4 py-4 text-[13px] leading-7 text-foreground outline-none placeholder:text-muted-foreground/45 disabled:opacity-60"
        />
        <div className="flex items-center justify-between border-t border-sidebar-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>{editor.message || (editor.dirty ? "有未保存的修改" : "已同步")}</span>
          <span>{editor.value.length.toLocaleString()} / {MAX_CUSTOM_SYSTEM_PROMPT_CHARS.toLocaleString()}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void editor.save()}
        disabled={editor.loading || editor.saving || !editor.dirty}
        className="fluid-press flex w-full items-center justify-center gap-1.5 rounded-2xl bg-sidebar-primary py-3 text-[13px] text-sidebar-primary-foreground transition-opacity disabled:opacity-45"
      >
        <Save className="size-4" />{editor.saving ? "保存中…" : "保存系统提示词"}
      </button>
    </div>
  )
}
