"use client"

import { useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { ChevronDown, GitBranch, X, Loader2, Plus, ImageIcon, FileText, Globe } from "lucide-react"
import type { Endpoint } from "@/lib/chat-data"
import { extractFileText, type ExtractedFile } from "@/lib/file-extract"

type GithubContext = { repo: string; context: string }

export function ChatInput({
  onSend, endpoints, activeEndpointId, onEndpointChange, mobile,
  githubContext, onGithubConnect,
  webSearch, onWebSearchChange,
}: {
  onSend: (text: string, images?: string[]) => void
  endpoints: Endpoint[]
  activeEndpointId: string
  onEndpointChange: (id: string) => void
  mobile: boolean
  githubContext: GithubContext | null
  onGithubConnect: (ctx: GithubContext | null) => void
  webSearch: boolean
  onWebSearchChange: (on: boolean) => void
}) {
  const [value, setValue] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  const [githubOpen, setGithubOpen] = useState(false)
  const [githubUrl, setGithubUrl] = useState("")
  const [githubLoading, setGithubLoading] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [images, setImages] = useState<string[]>([])
  const [files, setFiles] = useState<ExtractedFile[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState("")
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [githubError, setGithubError] = useState("")

  function resize() {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 180) + "px"
  }

  function submit() {
    const text = value.trim()
    if (!text && images.length === 0 && files.length === 0) return
    let full = text
    if (files.length > 0) {
      const blocks = files.map(f => `［附件：${f.name}］\n${f.text}`).join("\n\n")
      full = text ? `${text}\n\n${blocks}` : blocks
    }
    onSend(full, images.length > 0 ? images : undefined)
    setValue("")
    setImages([])
    setFiles([])
    setFileError("")
    if (ref.current) ref.current.style.height = "auto"
  }

  function readImagesAsBase64(fileList: FileList | null) {
    if (!fileList) return
    Array.from(fileList).forEach(file => {
      const reader = new FileReader()
      reader.onload = e => {
        const result = e.target?.result as string
        if (result) setImages(prev => [...prev, result])
      }
      reader.readAsDataURL(file)
    })
    setPlusOpen(false)
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setPlusOpen(false)
    setFileError("")
    setFileLoading(true)
    try {
      for (const file of Array.from(fileList)) {
        try {
          const extracted = await extractFileText(file)
          setFiles(prev => [...prev, extracted])
        } catch (e: any) {
          setFileError(e?.message ?? "文件解析失败")
        }
      }
    } finally {
      setFileLoading(false)
    }
  }

  async function connectGithub() {
    const raw = githubUrl.trim()
    if (!raw) return
    setGithubError("")
    setGithubLoading(true)
    try {
      const res = await fetch(`/api/github?repo=${encodeURIComponent(raw)}`)
      const data = await res.json()
      if (!res.ok) {
        setGithubError(data.error ?? "连接失败")
        return
      }
      onGithubConnect({ repo: data.repo, context: data.context })
      setGithubOpen(false)
      setGithubUrl("")
      setGithubError("")
    } catch {
      setGithubError("网络错误，请重试")
    } finally {
      setGithubLoading(false)
    }
  }

  const showToolbar = endpoints.length > 0 || githubContext || true

  return (
    <div className={cn(
      "relative z-10 mx-auto w-full shrink-0",
      mobile
        ? "border-t border-border/30 bg-background/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-sm"
        : "max-w-[44rem] px-10 pb-8 pt-2",
    )}>
      {/* 工具栏 */}
      {showToolbar && (
        <div className="mb-2 flex items-center gap-2 px-1">
          {/* 模型选择器 */}
          {endpoints.length > 0 && (
            <div className="relative">
              <select
                value={activeEndpointId}
                onChange={e => onEndpointChange(e.target.value)}
                className="appearance-none rounded-full border border-border/50 bg-secondary/50 pl-3 pr-7 py-1 text-xs text-muted-foreground outline-none cursor-pointer hover:border-border transition-colors"
              >
                {endpoints.map(ep => (
                  <option key={ep.id} value={ep.id}>{ep.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
            </div>
          )}

          {/* 联网开关 */}
          <button
            onClick={() => onWebSearchChange(!webSearch)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              webSearch
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border/50 bg-secondary/50 text-muted-foreground hover:border-border",
            )}
          >
            <Globe className="size-3" />
            <span>联网</span>
          </button>

          {/* GitHub 连接器 */}
          {githubContext ? (
            <div className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 pl-2.5 pr-1.5 py-1">
              <GitBranch className="size-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground max-w-[120px] truncate">{githubContext.repo}</span>
              <button onClick={() => onGithubConnect(null)} className="rounded-full p-0.5 hover:bg-muted transition-colors">
                <X className="size-3 text-muted-foreground" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setGithubOpen(v => !v)}
              className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground hover:border-border transition-colors"
            >
              <GitBranch className="size-3" />
              <span>连接仓库</span>
            </button>
          )}
        </div>
      )}

      {/* GitHub 输入弹出框 */}
      {githubOpen && (
        <div className="mb-2 space-y-1.5">
          <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-card/80 px-3 py-2">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              type="text"
              value={githubUrl}
              onChange={e => { setGithubUrl(e.target.value); setGithubError("") }}
              onKeyDown={e => { if (e.key === "Enter") connectGithub(); if (e.key === "Escape") { setGithubOpen(false); setGithubError("") } }}
              placeholder="owner/repo 或 GitHub 链接"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
            />
            {githubLoading
              ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
              : <button onClick={connectGithub} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs text-primary hover:bg-primary/20 transition-colors">连接</button>
            }
            <button onClick={() => { setGithubOpen(false); setGithubError("") }} className="text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
          {githubError && <p className="px-3 text-xs text-destructive">{githubError}</p>}
        </div>
      )}

      {/* 隐藏的文件输入 */}
      <input ref={imageInputRef} type="file" accept="image/*" multiple capture="environment" className="hidden"
        onChange={e => { readImagesAsBase64(e.target.files); e.currentTarget.value = "" }} />
      <input ref={fileInputRef} type="file" accept=".pdf,.txt,.md,.csv,.json,.log,.xml,.html,.yaml,.yml,text/*,application/pdf" multiple className="hidden"
        onChange={e => { handleFiles(e.target.files); e.currentTarget.value = "" }} />

      {/* 图片预览条 */}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {images.map((img, i) => (
            <div key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img} alt="" className="size-16 rounded-xl object-cover border border-border/50" />
              <button
                onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 文件预览条 */}
      {(files.length > 0 || fileLoading) && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/50 px-2.5 py-1.5">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-[140px] truncate text-xs text-muted-foreground">{f.name}</span>
              <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="rounded-full p-0.5 hover:bg-muted transition-colors">
                <X className="size-3 text-muted-foreground" />
              </button>
            </div>
          ))}
          {fileLoading && (
            <div className="flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/50 px-2.5 py-1.5">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">解析中……</span>
            </div>
          )}
        </div>
      )}
      {fileError && <p className="mb-2 px-2 text-xs text-destructive">{fileError}</p>}

      {/* + 号菜单 */}
      {plusOpen && (
        <div className="mb-2 flex gap-2 px-1">
          <button
            onClick={() => { imageInputRef.current?.click() }}
            className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground hover:border-border transition-colors"
          >
            <ImageIcon className="size-3.5" />
            上传图片
          </button>
          <button
            onClick={() => { fileInputRef.current?.click() }}
            className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground hover:border-border transition-colors"
          >
            <FileText className="size-3.5" />
            上传文件
          </button>
        </div>
      )}

      {/* 输入框 */}
      <div className="flex min-w-0 items-end gap-2 rounded-3xl border border-border/70 bg-card/80 py-2 pl-2 pr-2">
        {/* + 按钮 */}
        <button
          onClick={() => setPlusOpen(v => !v)}
          aria-label="添加附件"
          className={cn(
            "mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors",
            plusOpen
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground",
          )}
        >
          <Plus className={cn("size-4 transition-transform", plusOpen && "rotate-45")} />
        </button>

        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={e => { setValue(e.target.value); resize() }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit() } }}
          placeholder="说点什么……"
          className={cn(
            "block min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-[1.7] tracking-wide text-foreground outline-none placeholder:italic placeholder:text-muted-foreground",
            mobile ? "max-h-[120px]" : "max-h-[180px]",
          )}
        />
        <button
          onClick={submit}
          disabled={!value.trim() && images.length === 0 && files.length === 0}
          aria-label="发送"
          className={cn(
            "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border transition-colors font-heading text-base",
            (value.trim() || images.length > 0 || files.length > 0)
              ? "border-primary/50 bg-primary/10 text-primary hover:bg-primary/20"
              : "cursor-not-allowed border-border/40 text-muted-foreground/30",
          )}
        >
          发
        </button>
      </div>
    </div>
  )
}
