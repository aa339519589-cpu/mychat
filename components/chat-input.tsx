"use client"

import { useRef, useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { ChevronDown, X, Loader2, Plus, Paperclip, FileText, Globe, ArrowUp, Square, Check, Microscope, Search, Telescope, Server, Image as ImageIcon, Video } from "lucide-react"
import { MODEL_SHEET_TIERS, TIER_MAP, type Tier } from "@/lib/chat-data"
import { prepareFile, type AttachedFile } from "@/lib/file-extract"
import type { SearchMode } from "@/lib/search-mode"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"

export function ChatInput({
  onSend, activeTier, onTierChange, mobile,
  searchMode, onSearchModeChange,
  deepResearch, onDeepResearchChange,
  historyRetrieval, onHistoryRetrievalChange,
  customEndpoints, activeEndpointId, onEndpointChange,
  isLoading, onStop,
}: {
  onSend: (text: string, images?: string[], files?: AttachedFile[]) => void
  activeTier: string
  onTierChange: (t: Tier) => void
  mobile: boolean
  searchMode: SearchMode
  onSearchModeChange: (mode: SearchMode) => void
  deepResearch: boolean
  onDeepResearchChange: (on: boolean) => void
  historyRetrieval: boolean
  onHistoryRetrievalChange: (on: boolean) => void
  customEndpoints: ModelEndpointSummary[]
  activeEndpointId: string | null
  onEndpointChange: (id: string) => void
  isLoading: boolean
  onStop: () => void
}) {
  const [value, setValue] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  const [plusOpen, setPlusOpen] = useState(false)
  const [images, setImages] = useState<string[]>([])
  const [files, setFiles] = useState<AttachedFile[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState("")
  const [sendPending, setSendPending] = useState(false)
  const addInputRef = useRef<HTMLInputElement>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)

  const [tierMenuOpen, setTierMenuOpen] = useState(false)

  useEffect(() => {
    try { localStorage.removeItem("chat_custom_models") } catch {}
    if (!activeTier.startsWith("custom:")) return
    onTierChange("绝句")
    try { localStorage.setItem("chat_active_tier", "绝句") } catch {}
  }, [])

  useEffect(() => {
    if (!tierMenuOpen) return
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setTierMenuOpen(false) }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [tierMenuOpen])

  useEffect(() => {
    if (!plusOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) setPlusOpen(false)
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

  function clearComposer() {
    setValue("")
    setImages([])
    setFiles([])
    setFileError("")
    if (ref.current) ref.current.style.height = "auto"
  }

  useEffect(() => {
    if (!sendPending) return
    if (!isLoading) return
    clearComposer()
    setSendPending(false)
  }, [sendPending, isLoading])

  useEffect(() => {
    if (!sendPending || isLoading) return
    const timer = window.setTimeout(() => setSendPending(false), 700)
    return () => window.clearTimeout(timer)
  }, [sendPending, isLoading])

  function submit() {
    if (sendPending) return
    const text = value.trim()
    if (!text && images.length === 0 && files.length === 0) return
    setSendPending(true)
    try {
      onSend(text, images.length > 0 ? images : undefined, files.length > 0 ? files : undefined)
    } catch (e) {
      setSendPending(false)
      throw e
    }
  }

  function addImageFile(file: File) {
    const reader = new FileReader()
    reader.onload = e => {
      const result = e.target?.result as string
      if (result) setImages(prev => [...prev, result])
    }
    reader.readAsDataURL(file)
  }

  async function handleAddFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setPlusOpen(false)
    setFileError("")
    const selected = Array.from(fileList)
    const imageFiles = selected.filter(file => file.type.startsWith("image/"))
    const documentFiles = selected.filter(file => !file.type.startsWith("image/"))
    imageFiles.forEach(addImageFile)
    if (documentFiles.length === 0) return
    setFileLoading(true)
    try {
      for (const file of documentFiles) {
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

  function selectTier(id: string) {
    onTierChange(id as Tier)
    if (id === "绘影" || id === "录像") {
      onSearchModeChange("off")
      onDeepResearchChange(false)
      onHistoryRetrievalChange(false)
    }
    try { localStorage.setItem("chat_active_tier", id) } catch {}
    setTierMenuOpen(false)
  }

  const activeTierName = (TIER_MAP as Record<string, { label: string } | undefined>)[activeTier]?.label ?? "模型"
  const hasActiveTools = searchMode !== "off" || deepResearch || historyRetrieval
  const canSend = !isLoading && !sendPending && (!!value.trim() || images.length > 0 || files.length > 0)
  const availableEndpoints = customEndpoints.filter(endpoint => !endpoint.needsReconnect)
  const activeEndpoint = availableEndpoints.find(endpoint => endpoint.id === activeEndpointId)
  const activeOutputKind = activeEndpoint?.outputKind
  const activeModelLabel = activeEndpoint?.name || activeEndpoint?.model || activeTierName

  return (
    <div className={cn("relative z-10 mx-auto w-full shrink-0", mobile ? "bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2" : "max-w-[56rem] px-10 pb-8 pt-2")}>
      <input ref={addInputRef} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.log,.xml,.html,.yaml,.yml,text/*,application/pdf" multiple className="hidden" onChange={e => { handleAddFiles(e.target.files); e.currentTarget.value = "" }} />

      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {images.map((img, i) => (
            <div key={i} className="relative">
              <img src={img} alt="" className="size-16 rounded-xl object-cover border border-border/50" />
              <button onClick={() => setImages(prev => prev.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow"><X className="size-3" /></button>
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
              <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="rounded-full p-0.5 hover:bg-muted transition-colors"><X className="size-3 text-muted-foreground" /></button>
            </div>
          ))}
          {fileLoading && <div className="flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/50 px-2.5 py-1.5"><Loader2 className="size-3.5 animate-spin text-muted-foreground" /><span className="text-xs text-muted-foreground">解析中……</span></div>}
        </div>
      )}
      {fileError && <p className="mb-2 px-2 text-xs text-destructive">{fileError}</p>}

      <div className="flex min-w-0 items-end gap-2 rounded-[0.78rem] border border-border/50 bg-secondary/75 py-1.5 pl-2 pr-2 text-secondary-foreground shadow-sm dark:border-white/10 dark:bg-[#151515] dark:text-white">
        <div ref={plusMenuRef} className="relative mb-0.5 shrink-0">
          {plusOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-[8rem] overflow-hidden rounded-xl border border-border/60 bg-card shadow-lg">
              <PlusItem icon={<Paperclip className="size-4" />} label="添加" onClick={() => { setPlusOpen(false); addInputRef.current?.click() }} />
              <div className="border-t border-border/40" />
              <PlusItem
                icon={<Globe className={cn("size-4", searchMode === "web" && "text-primary")} />}
                label="联网"
                onClick={() => onSearchModeChange(searchMode === "web" ? "off" : "web")}
                active={searchMode === "web"}
              />
              <PlusItem
                icon={<Search className={cn("size-4 scale-x-[-1]", historyRetrieval && "text-primary")} />}
                label="检索"
                onClick={() => onHistoryRetrievalChange(!historyRetrieval)}
                active={historyRetrieval}
              />
              <PlusItem
                icon={<Telescope className={cn("size-4", searchMode === "deep" && "text-primary")} />}
                label="深度联网"
                onClick={() => onSearchModeChange(searchMode === "deep" ? "off" : "deep")}
                active={searchMode === "deep"}
              />
              <PlusItem
                icon={<Microscope className={cn("size-4", deepResearch && "text-primary")} />}
                label="深度研究"
                onClick={() => onDeepResearchChange(!deepResearch)}
                active={deepResearch}
              />
            </div>
          )}
          <button onClick={() => setPlusOpen(v => !v)} aria-label="添加" className={cn("relative flex size-8 items-center justify-center rounded-full transition-colors", plusOpen ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-background/40 hover:text-foreground dark:hover:bg-white/10")}>
            <Plus className={cn("size-4 transition-transform", plusOpen && "rotate-45")} />
            {hasActiveTools && !plusOpen && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-card" />}
          </button>
        </div>

        <textarea ref={ref} rows={1} value={value} onChange={e => { setValue(e.target.value); resize() }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !isLoading && !sendPending) { e.preventDefault(); submit() } }} placeholder={activeTier === "绘影" ? "描述你想生成的图片……" : activeTier === "录像" ? "描述你想生成的视频……" : "说点什么……"} className={cn("block min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-[1.6] tracking-wide text-secondary-foreground outline-none placeholder:italic placeholder:text-muted-foreground dark:text-white", mobile ? "max-h-[120px]" : "max-h-[180px]")} />

        <button
          type="button"
          onClick={() => setTierMenuOpen(true)}
          aria-label="选择模型"
          className="mb-0.5 flex h-8 min-w-0 max-w-[7rem] shrink-0 items-center gap-1 rounded-[0.7rem] px-2.5 text-xs text-muted-foreground transition-colors hover:bg-background/40 hover:text-foreground dark:hover:bg-white/10 sm:max-w-[11rem]"
        >
          {activeOutputKind === "image" ? <ImageIcon className="size-3.5 shrink-0" /> : activeOutputKind === "video" ? <Video className="size-3.5 shrink-0" /> : activeOutputKind === "chat" ? <Server className="size-3.5 shrink-0" /> : null}
          <span className="min-w-0 truncate">{activeModelLabel}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>

        {isLoading ? (
          <button onClick={onStop} aria-label="停止生成" className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:opacity-80"><Square className="size-3.5 fill-current" /></button>
        ) : (
          <button onClick={submit} disabled={!canSend} aria-label="发送" className={cn("mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors", canSend ? "bg-primary text-primary-foreground hover:opacity-90" : "cursor-not-allowed text-muted-foreground/30")}><ArrowUp className="size-4" /></button>
        )}
      </div>

      {tierMenuOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 px-2 pb-2 pt-12 backdrop-blur-[2px] md:items-center md:p-4">
          <button className="absolute inset-0 cursor-default" aria-label="关闭模型选择" onClick={() => setTierMenuOpen(false)} />
          <section className="relative flex h-[min(50dvh,460px)] w-full max-w-[42rem] flex-col overflow-hidden rounded-[1.75rem] border border-border/50 bg-background/95 shadow-2xl paper-grain dark:border-white/10 dark:bg-[#20201f] md:max-h-[500px]">
            <div className="mx-auto mt-3 h-1 w-16 rounded-full bg-muted-foreground/35" />
            <div className="flex h-12 shrink-0 items-center justify-center px-4">
              <h2 className="text-[16px] font-[750] tracking-[-0.01em] text-foreground">选择模型</h2>
              <button onClick={() => setTierMenuOpen(false)} className="absolute right-3 flex size-9 items-center justify-center rounded-full border border-border/50 bg-secondary/70 text-muted-foreground shadow-sm transition-colors hover:text-foreground dark:border-white/10 dark:bg-[#151515]"><X className="size-4" /></button>
            </div>

            <div className="min-h-0 flex-1 px-4 pb-4">
              <div className="h-full overflow-hidden rounded-[1.25rem] bg-card/70 dark:bg-[#151515]"><div className="max-h-full overflow-y-auto">
                {MODEL_SHEET_TIERS.map((id, index) => {
                  const cfg = TIER_MAP[id]
                  const icon = cfg.media === "image" ? <ImageIcon className="size-4" /> : cfg.media === "video" ? <Video className="size-4" /> : undefined
                  return (
                    <ModelRow
                      key={id}
                      label={cfg.label}
                      icon={icon}
                      active={!activeEndpointId && activeTier === id}
                      divided={index > 0}
                      onClick={() => selectTier(id)}
                    />
                  )
                })}
                {availableEndpoints.map((endpoint, index) => {
                  const kind = endpoint.outputKind
                  const kindLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "对话"
                  return (
                    <ModelRow
                      key={endpoint.id}
                      label={endpoint.name || endpoint.model}
                      desc={`${kindLabel} · ${endpoint.model}`}
                      icon={kind === "image" ? <ImageIcon className="size-4" /> : kind === "video" ? <Video className="size-4" /> : <Server className="size-4" />}
                      active={activeEndpointId === endpoint.id}
                      divided={MODEL_SHEET_TIERS.length > 0 || index > 0}
                      onClick={() => { onEndpointChange(endpoint.id); setTierMenuOpen(false) }}
                    />
                  )
                })}
              </div></div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function PlusItem({ icon, label, onClick, active, disabled, title }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-[12px] transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        active ? "text-primary" : "text-muted-foreground",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
      {active ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
    </button>
  )
}

function ModelRow({ label, desc, icon, active, divided, onClick }: { label: string; desc?: string; icon?: React.ReactNode; active?: boolean; divided?: boolean; onClick: () => void }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 px-4 py-2.5", divided && "border-t border-border/40 dark:border-white/10")}>
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <button onClick={onClick} className="min-w-0 flex-1 text-left"><div className={cn("truncate text-[15px] font-[750] tracking-[-0.01em]", active ? "text-foreground" : "text-foreground/92")}>{label}</div>{desc && <div className="mt-0.5 truncate text-[11px] font-[625] text-muted-foreground">{desc}</div>}</button>
      {active && <Check className="size-5 shrink-0 text-primary" />}
    </div>
  )
}
