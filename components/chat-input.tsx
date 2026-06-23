"use client"

import { useRef, useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { ChevronDown, X, Loader2, Plus, ImageIcon, FileText, Globe, ArrowUp, Square, CornerUpLeft, Camera, Check, Microscope } from "lucide-react"
import { TIERS, TIER_MAP, type Tier } from "@/lib/chat-data"
import { prepareFile, type AttachedFile } from "@/lib/file-extract"

export function ChatInput({
  onSend, activeTier, onTierChange, mobile,
  webSearch, onWebSearchChange,
  deepResearch, onDeepResearchChange,
  isLoading, onStop,
  replyTo, onClearReply,
}: {
  onSend: (text: string, images?: string[], files?: AttachedFile[]) => void
  activeTier: Tier
  onTierChange: (t: Tier) => void
  mobile: boolean
  webSearch: boolean
  onWebSearchChange: (on: boolean) => void
  deepResearch: boolean
  onDeepResearchChange: (on: boolean) => void
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
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)

  const [tierMenuOpen, setTierMenuOpen] = useState(false)
  const tierMenuRef = useRef<HTMLDivElement>(null)

  // 点模型菜单外部时关闭
  useEffect(() => {
    if (!tierMenuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (tierMenuRef.current && !tierMenuRef.current.contains(e.target as Node)) {
        setTierMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [tierMenuOpen])

  // 点加号菜单外部时关闭
  useEffect(() => {
    if (!plusOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setPlusOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [plusOpen])

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

  const hasActiveTools = webSearch || deepResearch
  const canSend = !isLoading && (!!value.trim() || images.length > 0 || files.length > 0)

  return (
    <div className={cn(
      "relative z-10 mx-auto w-full shrink-0",
      mobile
        ? "bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"
        : "max-w-[44rem] px-10 pb-8 pt-2",
    )}>
      {/* 三类图片/文件输入：拍照=唤起相机，图片=相册，文件=文档 */}
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={e => { readImagesAsBase64(e.target.files); e.currentTarget.value = "" }} />
      <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden"
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

      <div className="flex min-w-0 items-end gap-2 rounded-3xl bg-secondary/50 py-2 pl-2 pr-2">
        {/* 加号：展开 Add(拍照/照片/文件) + 联网/仓库 */}
        <div ref={plusMenuRef} className="relative mb-0.5 shrink-0">
          {plusOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-[8rem] overflow-hidden rounded-xl border border-border/60 bg-card shadow-lg">
              <PlusItem icon={<ImageIcon className="size-4" />} label="照片" onClick={() => { setPlusOpen(false); imageInputRef.current?.click() }} />
              <PlusItem icon={<Camera className="size-4" />} label="拍照" onClick={() => { setPlusOpen(false); cameraInputRef.current?.click() }} />
              <PlusItem icon={<FileText className="size-4" />} label="文件" onClick={() => { setPlusOpen(false); fileInputRef.current?.click() }} />
              <div className="border-t border-border/40" />
              <PlusItem
                icon={<Globe className={cn("size-4", webSearch && "text-primary")} />}
                label="联网"
                onClick={() => onWebSearchChange(!webSearch)}
                active={webSearch}
              />
              <PlusItem
                icon={<Microscope className={cn("size-4", deepResearch && "text-primary")} />}
                label="深度研究"
                onClick={() => onDeepResearchChange(!deepResearch)}
                active={deepResearch}
              />
            </div>
          )}
          <button
            onClick={() => setPlusOpen(v => !v)}
            aria-label="添加"
            className={cn(
              "relative flex size-8 items-center justify-center rounded-full transition-colors",
              plusOpen
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-background/40 hover:text-foreground",
            )}
          >
            <Plus className={cn("size-4 transition-transform", plusOpen && "rotate-45")} />
            {hasActiveTools && !plusOpen && (
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-card" />
            )}
          </button>
        </div>

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

        {/* 模型选择（可展开，从上到下：深度＞均衡＞快速） */}
        <div ref={tierMenuRef} className="relative mb-0.5 shrink-0">
          {tierMenuOpen && (
            <div className="absolute bottom-full right-0 mb-2 min-w-[6.5rem] overflow-hidden rounded-2xl border border-border/60 bg-card shadow-lg">
              {[...TIERS].reverse().map(t => (
                <button
                  key={t.id}
                  onClick={() => { onTierChange(t.id); setTierMenuOpen(false) }}
                  className={cn(
                    "flex w-full items-center justify-center px-4 py-2.5 text-sm transition-colors",
                    activeTier === t.id
                      ? "bg-secondary/70 text-foreground"
                      : "text-muted-foreground hover:bg-secondary/50",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setTierMenuOpen(v => !v)}
            aria-label="选择模型"
            className="flex h-8 items-center gap-1 rounded-full px-3 text-xs text-muted-foreground transition-colors hover:bg-background/40 hover:text-foreground"
          >
            <span>{TIER_MAP[activeTier]?.label ?? activeTier}</span>
            <ChevronDown className={cn("size-3 transition-transform", tierMenuOpen && "rotate-180")} />
          </button>
        </div>

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
              "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
              canSend
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "cursor-not-allowed text-muted-foreground/30",
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}

function PlusItem({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] transition-colors hover:bg-secondary/60", active ? "text-primary" : "text-muted-foreground")}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
      {active ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
    </button>
  )
}
