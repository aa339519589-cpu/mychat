"use client"

import { useEffect, useRef, useState } from "react"
import { Check, FileText, Loader2, Lock, Pencil, Plus, Trash2, X } from "lucide-react"

import type { Memory } from "@/lib/memory-data"
import type { Project, ProjectFile } from "@/lib/project-data"
import { cn } from "@/lib/utils"

export function ProjectMemorySection({ projectId, onLoad, onAdd, onEdit, onDelete }: {
  projectId: string
  onLoad: (pid: string) => Promise<Memory[]>
  onAdd: (content: string) => Promise<Memory | null>
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
}) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [newValue, setNewValue] = useState("")
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    onLoad(projectId).then(mems => { if (!cancelled) { setMemories(mems); setLoading(false) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  function startEdit(m: Memory) { setEditingId(m.id); setEditValue(m.content) }
  function saveEdit() {
    if (!editingId || !editValue.trim()) return
    onEdit(editingId, editValue.trim())
    setMemories(prev => prev.map(m => m.id === editingId ? { ...m, content: editValue.trim() } : m))
    setEditingId(null)
  }
  async function addMemory() {
    if (!newValue.trim()) return
    const mem = await onAdd(newValue.trim())
    if (mem) setMemories(prev => [...prev, mem])
    setNewValue(""); setAdding(false)
  }
  function removeMemory(id: string) {
    setMemories(prev => prev.filter(m => m.id !== id))
    onDelete(id)
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">记忆</span>
        <span className="flex items-center gap-1 rounded-full bg-sidebar-accent/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          <Lock className="size-3" />仅你可见
        </span>
      </div>
      <p className="mt-1 mb-2.5 text-[11px] leading-relaxed text-muted-foreground">本项目中积累的重要信息，对话时自动注入，与全局记忆分隔。</p>

      {loading ? (
        <p className="text-[11px] italic text-muted-foreground/60">载入中……</p>
      ) : (
        <div className="space-y-1.5">
          {memories.length === 0 && !adding && (
            <p className="text-center text-[11px] italic text-muted-foreground/60 py-1">还没有记忆</p>
          )}

          {memories.length > 0 && (
            <div className="max-h-[200px] overflow-y-auto space-y-1.5 pr-0.5">
              {memories.map(m => (
                <div key={m.id} className="rounded-xl bg-sidebar-accent/30 px-3 py-2">
                  {editingId === m.id ? (
                    <div className="space-y-1.5">
                      <textarea
                        autoFocus
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit() } if (e.key === "Escape") setEditingId(null) }}
                        className="w-full resize-none rounded-xl bg-sidebar-accent/60 border border-sidebar-accent/70 px-2 py-1.5 text-[11px] outline-none focus:bg-sidebar-accent/80"
                        rows={2}
                      />
                      <div className="flex gap-1.5">
                        <button onClick={saveEdit} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1 text-[11px] text-sidebar-primary-foreground"><Check className="size-3" />保存</button>
                        <button onClick={() => setEditingId(null)} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/60 py-1 text-[11px] text-muted-foreground"><X className="size-3" />取消</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <p className="flex-1 text-[11px] leading-relaxed text-foreground/85">{m.content}</p>
                      <div className="flex shrink-0 gap-0.5">
                        <button onClick={() => startEdit(m)} className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="编辑"><Pencil className="size-3" /></button>
                        <button onClick={() => removeMemory(m.id)} className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除"><Trash2 className="size-3" /></button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {adding ? (
            <div className="space-y-1.5 rounded-xl bg-sidebar-accent/30 px-3 py-2">
              <textarea
                autoFocus
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addMemory() } if (e.key === "Escape") setAdding(false) }}
                placeholder="输入要记住的内容……"
                className="w-full resize-none rounded-xl bg-sidebar-accent/60 border border-sidebar-accent/70 px-2 py-1.5 text-[11px] outline-none placeholder:text-muted-foreground/40 focus:bg-sidebar-accent/80"
                rows={2}
              />
              <div className="flex gap-1.5">
                <button onClick={addMemory} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1 text-[11px] text-sidebar-primary-foreground"><Check className="size-3" />添加</button>
                <button onClick={() => setAdding(false)} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/60 py-1 text-[11px] text-muted-foreground"><X className="size-3" />取消</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
              <Plus className="size-3.5" />手动添加记忆
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// 项目指令段：点开就地编辑
export function ProjectInstructionsSection({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const has = value.trim().length > 0

  if (editing) {
    return (
      <div className="space-y-2 p-4">
        <span className="text-sm font-medium text-foreground">项目指令</span>
        <textarea
          autoFocus value={draft} onChange={e => setDraft(e.target.value)}
          placeholder="例如：你是我的英语学习教练，回答时多结合本项目里的资料……"
          className="w-full resize-none rounded-xl border border-sidebar-border bg-background/40 px-3 py-2 text-[12px] leading-relaxed outline-none placeholder:text-muted-foreground/45 focus:border-sidebar-primary/50"
          rows={4}
        />
        <div className="flex gap-2">
          <button onClick={() => { onSave(draft.trim()); setEditing(false) }} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[12px] text-sidebar-primary-foreground"><Check className="size-3.5" />保存</button>
          <button onClick={() => { setDraft(value); setEditing(false) }} className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-sidebar-border py-1.5 text-[12px] text-muted-foreground"><X className="size-3.5" />取消</button>
        </div>
      </div>
    )
  }

  return (
    <button onClick={() => setEditing(true)} className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-sidebar-accent/30">
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">项目指令</span>
          <Pencil className="size-3.5 shrink-0 text-muted-foreground/60" />
        </span>
        <span className={cn("mt-1 block text-[11px] leading-relaxed", has ? "text-muted-foreground line-clamp-3" : "text-muted-foreground/70")}>
          {has ? value : "添加指令，定制小克在本项目中的回答与人设。"}
        </span>
      </span>
    </button>
  )
}

// 资料段：列表 + 右上角「+」上传
export function ProjectFilesSection({ project, onLoadFiles, onAddFile, onDeleteFile }: {
  project: Project
  onLoadFiles: (projectId: string) => Promise<ProjectFile[]>
  onAddFile: (projectId: string, file: File) => Promise<ProjectFile | null>
  onDeleteFile: (fileId: string) => void
}) {
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    onLoadFiles(project.id).then(fs => { if (!cancelled) { setFiles(fs); setLoading(false) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ""
    if (!picked.length) return
    setErr(null); setUploading(true)
    for (const f of picked) {
      const added = await onAddFile(project.id, f)
      if (added) setFiles(prev => [...prev, added])
      else setErr(`「${f.name}」添加失败，目前仅支持 PDF 和文本文件`)
    }
    setUploading(false)
  }

  function remove(id: string) {
    setFiles(prev => prev.filter(f => f.id !== id))
    onDeleteFile(id)
  }

  return (
    <div className="p-4">
      <input ref={inputRef} type="file" multiple
        accept=".pdf,.txt,.md,.markdown,.csv,.json,.log,.xml,.yaml,.yml,.html,.htm,text/*"
        className="hidden" onChange={handlePick} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">资料{files.length > 0 ? ` · ${files.length}` : ""}</span>
        <button onClick={() => inputRef.current?.click()} disabled={uploading} className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50" aria-label="添加资料">
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        </button>
      </div>
      {err && <p className="mt-1 text-[11px] text-destructive">{err}</p>}

      {loading ? (
        <p className="mt-2 text-[12px] italic text-muted-foreground/60">载入中……</p>
      ) : files.length === 0 ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">上传 PDF 或文本，本项目的对谈会以它为参考。</p>
      ) : (
        <div className="mt-2.5 space-y-1.5">
          {files.map(f => (
            <div key={f.id} className="group flex items-center gap-3 rounded-xl bg-sidebar-accent/30 px-3 py-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10 text-sidebar-primary"><FileText className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-foreground">{f.name}</span>
                <span className="block text-[10px] text-muted-foreground">{f.content ? `约 ${f.content.length} 字` : "未提取到文字"}</span>
              </span>
              <button onClick={() => remove(f.id)} className="shrink-0 rounded-full p-1.5 text-muted-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除资料">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 会话行：标题 + 置顶/收藏角标 + "更多"按钮；改名时就地变输入框 ──

