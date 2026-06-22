"use client"

import { useRef, useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { ChevronDown, X, Loader2, Plus, ImageIcon, FileText, Globe, ArrowUp, ExternalLink, LogOut, Square, CornerUpLeft } from "lucide-react"
import type { Endpoint } from "@/lib/chat-data"
import { prepareFile, type AttachedFile } from "@/lib/file-extract"

type GithubContext = { repo: string; context: string }
type GithubRepo = { name: string; full_name: string; private: boolean; description: string }

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  )
}

export function ChatInput({
  onSend, endpoints, activeEndpointId, onEndpointChange, mobile,
  githubContext, onGithubConnect,
  githubConnected, githubLogin, onGithubDisconnect,
  webSearch, onWebSearchChange,
  isLoading, onStop,
  replyTo, onClearReply,
}: {
  onSend: (text: string, images?: string[], files?: AttachedFile[]) => void
  endpoints: Endpoint[]
  activeEndpointId: string
  onEndpointChange: (id: string) => void
  mobile: boolean
  githubContext: GithubContext | null
  onGithubConnect: (ctx: GithubContext | null) => void
  githubConnected: boolean
  githubLogin: string | null
  onGithubDisconnect: () => void
  webSearch: boolean
  onWebSearchChange: (on: boolean) => void
  isLoading: boolean
  onStop: () => void
  replyTo: string | null
  onClearReply: () => void
}) {
  const [value, setValue] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  const [plusOpen, setPlusOpen] = useState(false)
  const [images, setImages] = useState<string[]>([])
  const [files, setFiles] = useState<AttachedFile[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState("")
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [repos, setRepos] = useState<GithubRepo[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [repoConnecting, setRepoConnecting] = useState(false)
  const repoPickerRef = useRef<HTMLDivElement>(null)

  // 点选择器外部时关闭
  useEffect(() => {
    if (!repoPickerOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (repoPickerRef.current && !repoPickerRef.current.contains(e.target as Node)) {
        setRepoPickerOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [repoPickerOpen])

  function resize() {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 180) + "px"
  }

  function submit() {
    const text = value.trim()
    if (!text && images.length === 0 && files.length === 0) return
    const finalText = replyTo ? `> ${replyTo.replace(/\n/g, '\n> ').slice(0, 300)}\n\n${text}` : text
    onSend(finalText, images.length > 0 ? images : undefined, files.length > 0 ? files : undefined)
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
          const prepared = await prepareFile(file)
          setFiles(prev => [...prev, prepared])
        } catch (e: any) {
          setFileError(e?.message ?? "文件解析失败")
        }
      }
    } finally {
      setFileLoading(false)
    }
  }

  async function openRepoPicker() {
    setRepoPickerOpen(true)
    if (repos.length > 0) return
    setReposLoading(true)
    try {
      const res = await fetch("/api/github/repos")
      if (res.ok) {
        const data = await res.json()
        setRepos(data.repos ?? [])
      }
    } finally {
      setReposLoading(false)
    }
  }

  async function selectRepo(fullName: string) {
    setRepoPickerOpen(false)
    setRepoConnecting(true)
    try {
      const res = await fetch(`/api/github?repo=${encodeURIComponent(fullName)}`)
      const data = await res.json()
      if (res.ok) onGithubConnect({ repo: data.repo, context: data.context })
    } finally {
      setRepoConnecting(false)
    }
  }

  const canSend = !isLoading && (!!value.trim() || images.length > 0 || files.length > 0)

  return (
    <div className={cn(
      "relative z-10 mx-auto w-full shrink-0",
      mobile
        ? "bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"
        : "max-w-[44rem] px-10 pb-8 pt-2",
    )}>
      {/* 工具栏 */}
      <div className="mb-2 flex items-center gap-2 px-1">
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

        {githubContext ? (
          <div className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 pl-2 pr-1.5 py-1">
            {repoConnecting
              ? <Loader2 className="size-3 animate-spin text-muted-foreground" />
              : <GitHubIcon className="size-3 text-muted-foreground" />
            }
            <span className="text-xs text-muted-foreground max-w-[120px] truncate">{githubContext.repo}</span>
            <button onClick={() => onGithubConnect(null)} className="rounded-full p-0.5 hover:bg-muted transition-colors">
              <X className="size-3 text-muted-foreground" />
            </button>
          </div>
        ) : githubConnected ? (
          <button
            onClick={openRepoPicker}
            className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground hover:border-border transition-colors"
          >
            {repoConnecting
              ? <Loader2 className="size-3 animate-spin" />
              : <GitHubIcon className="size-3" />
            }
            <span>选择仓库</span>
            <ChevronDown className="size-3" />
          </button>
        ) : (
          <button
            onClick={() => { window.location.href = "/api/auth/github" }}
            className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground hover:border-border transition-colors"
          >
            <GitHubIcon className="size-3" />
            <span>连接仓库</span>
          </button>
        )}
      </div>

      {/* 仓库选择器（点外部关闭） */}
      {repoPickerOpen && (
        <div ref={repoPickerRef} className="mb-2 overflow-hidden rounded-2xl border border-border/60 bg-card shadow-lg">
          <div className="max-h-64 overflow-y-auto">
            {reposLoading ? (
              <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span>加载仓库列表……</span>
              </div>
            ) : repos.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">没有找到仓库</div>
            ) : (
              repos.map(r => (
                <button
                  key={r.full_name}
                  onClick={() => selectRepo(r.full_name)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-secondary/60 transition-colors"
                >
                  <GitHubIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 min-w-0 truncate text-sm">{r.name}</span>
                  <span className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                    r.private ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary/80"
                  )}>
                    {r.private ? "私有" : "公开"}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-border/40">
            <a
              href="https://github.com/settings/connections/applications/Ov23li6Pfgts4Ye4a5FL"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground hover:bg-secondary/60 transition-colors"
            >
              <ExternalLink className="size-3" />
              管理仓库权限
            </a>
            <button
              onClick={async () => {
                setRepoPickerOpen(false)
                await fetch("/api/auth/github/disconnect", { method: "POST" })
                onGithubDisconnect()
              }}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-xs text-destructive/80 hover:bg-destructive/5 transition-colors"
            >
              <LogOut className="size-3" />
              断开 GitHub{githubLogin ? `（${githubLogin}）` : ""}
            </button>
          </div>
        </div>
      )}

      <input ref={imageInputRef} type="file" accept="image/*" multiple capture="environment" className="hidden"
        onChange={e => { readImagesAsBase64(e.target.files); e.currentTarget.value = "" }} />
      <input ref={fileInputRef} type="file" accept=".pdf,.txt,.md,.csv,.json,.log,.xml,.html,.yaml,.yml,text/*,application/pdf" multiple className="hidden"
        onChange={e => { handleFiles(e.target.files); e.currentTarget.value = "" }} />

      {/* 引用回复条 */}
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border-l-2 border-primary/40 bg-muted/30 pl-3 pr-2 py-2">
          <CornerUpLeft className="size-3.5 mt-0.5 shrink-0 text-primary/50" />
          <span className="flex-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">{replyTo}</span>
          <button onClick={onClearReply} className="rounded p-0.5 hover:bg-muted transition-colors">
            <X className="size-3 text-muted-foreground" />
          </button>
        </div>
      )}

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

      {plusOpen && (
        <div className="mb-2 flex gap-2 px-1">
          <button onClick={() => { imageInputRef.current?.click() }}
            className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground hover:border-border transition-colors">
            <ImageIcon className="size-3.5" />上传图片
          </button>
          <button onClick={() => { fileInputRef.current?.click() }}
            className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground hover:border-border transition-colors">
            <FileText className="size-3.5" />上传文件
          </button>
        </div>
      )}

      <div className="flex min-w-0 items-end gap-2 rounded-3xl border border-border/70 bg-card/80 py-2 pl-2 pr-2">
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
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !isLoading) { e.preventDefault(); submit() } }}
          placeholder="说点什么……"
          className={cn(
            "block min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-[1.7] tracking-wide text-foreground outline-none placeholder:italic placeholder:text-muted-foreground",
            mobile ? "max-h-[120px]" : "max-h-[180px]",
          )}
        />

        {isLoading ? (
          <button
            onClick={onStop}
            aria-label="停止生成"
            className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:opacity-80"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            aria-label="发送"
            className={cn(
              "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border transition-colors",
              canSend
                ? "border-primary/50 bg-primary text-primary-foreground hover:opacity-90"
                : "cursor-not-allowed border-border/40 text-muted-foreground/30",
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}
