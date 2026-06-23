"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, Loader2, Check, X, ExternalLink, GitBranch, CornerDownLeft, Trash2, Plus, FilePlus2, FileEdit, Rocket, FolderGit2, ChevronDown, Square } from "lucide-react"
import { cn } from "@/lib/utils"
import { type Tier, TIERS, TIER_MAP } from "@/lib/chat-data"
import {
  type CodeMessage, type CodeStep, type CodeSession, type CodeMemory, type PlanAction, type ApplyResult,
  fetchCodeSessions, createCodeSession, touchCodeSession,
  fetchCodeMessages, insertCodeMessage,
  fetchCodeMemories, insertCodeMemory, deleteCodeMemory,
} from "@/lib/code-data"

const MONO = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace"
const ORANGE = "oklch(0.68 0.19 45)"   // Claude 橙：终端唯一强调色

type RepoItem = { name: string; full_name: string; private: boolean; description: string }
type Overlay = null | "model" | "memory" | "resume" | "context"

const COMMANDS = [
  { cmd: "/model", desc: "切换模型（快速 / 均衡 / 深度）" },
  { cmd: "/memory", desc: "查看 / 编辑本仓库的记忆" },
  { cmd: "/context", desc: "查看当前上下文用量" },
  { cmd: "/resume", desc: "恢复本仓库的历史排查" },
  { cmd: "/goal", desc: "设定目标，让它自主多轮完成" },
]

// ── 行级 diff（LCS）──
type DiffLine = { type: "same" | "add" | "del"; text: string }
function computeDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n"), b = newText.split("\n")
  if (a.length > 600 || b.length > 600) {
    return [...a.map(t => ({ type: "del" as const, text: t })), ...b.map(t => ({ type: "add" as const, text: t }))]
  }
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  const out: DiffLine[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { out.unshift({ type: "same", text: a[i - 1] }); i--; j-- }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { out.unshift({ type: "add", text: b[j - 1] }); j-- }
    else { out.unshift({ type: "del", text: a[i - 1] }); i-- }
  }
  return out
}

function DiffBody({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const lines = computeDiff(oldContent, newContent)
  return (
    <div className="max-h-[300px] overflow-auto" style={{ fontFamily: MONO, fontSize: "11px", lineHeight: "1.65" }}>
      {lines.map((ln, idx) => (
        <div key={idx} className="flex" style={{
          background: ln.type === "add" ? "color-mix(in oklab, #3fb950 16%, transparent)" : ln.type === "del" ? "color-mix(in oklab, #f85149 14%, transparent)" : undefined,
          borderLeft: ln.type === "add" ? "2px solid #3fb950" : ln.type === "del" ? "2px solid #f85149" : "2px solid transparent",
        }}>
          <span className="shrink-0 select-none px-2 text-center text-muted-foreground/60" style={{ width: 18 }}>
            {ln.type === "add" ? "+" : ln.type === "del" ? "-" : " "}
          </span>
          <span className="whitespace-pre-wrap break-all pr-2 text-foreground/85">{ln.text || " "}</span>
        </div>
      ))}
    </div>
  )
}

// GPT 同款呼吸圆球
function ThinkingBall() {
  return <span className="code-breathe inline-block size-3 rounded-full align-middle" style={{ background: ORANGE }} />
}

// 单个计划动作的展示（含 diff）
function PlanActionView({ a, login }: { a: PlanAction; login: string }) {
  if (a.kind === "create_repo")
    return <Row icon={<FolderGit2 className="size-3.5" />} label={`新建仓库 ${login}/${a.name}${a.private ? "（私有）" : ""}`} />
  if (a.kind === "delete_file")
    return <Row icon={<Trash2 className="size-3.5" />} label={`删除 ${a.path}`} />
  if (a.kind === "enable_pages")
    return <Row icon={<Rocket className="size-3.5" />} label="开启 GitHub Pages 上线" />
  // write_file
  const isNew = !a.oldContent
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 bg-secondary/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        {isNew ? <FilePlus2 className="size-3.5" /> : <FileEdit className="size-3.5" />}
        <span className="truncate font-medium text-foreground/80">{a.path}</span>
        <span className="opacity-70">{isNew ? "新建" : "修改"}</span>
      </div>
      <DiffBody oldContent={a.oldContent} newContent={a.newContent} />
    </div>
  )
}

function Row({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[12px] text-foreground/85">
      <span style={{ color: ORANGE }}>{icon}</span>{label}
    </div>
  )
}

export function CodeConsole({ userId, onExit }: { userId: string; onExit: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [login, setLogin] = useState<string>("")
  const [repos, setRepos] = useState<RepoItem[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [entered, setEntered] = useState(false)   // 进入聊天（选了仓库 或 新建项目模式）

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CodeMessage[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [tier, setTier] = useState<Tier>("正构")
  const [goalArmed, setGoalArmed] = useState(false)
  const [auto, setAuto] = useState(false)         // 自动模式（不确认直接执行）

  const [pendingPlan, setPendingPlan] = useState<PlanAction[]>([])
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  const [overlay, setOverlay] = useState<Overlay>(null)
  const [ghMenu, setGhMenu] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetch("/api/github/status").then(r => r.json()).then(d => {
      setConnected(!!d.connected); setLogin(d.login ?? "")
    }).catch(() => setConnected(false))
    try {
      const t = localStorage.getItem("code_tier") as Tier | null; if (t && TIERS.some(x => x.id === t)) setTier(t)
      setAuto(localStorage.getItem("code_auto") === "1")
    } catch {}
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [messages, pendingPlan])

  async function loadRepos() {
    if (repos) return
    try { const res = await fetch("/api/github/repos"); const d = await res.json(); setRepos(d.repos ?? []) }
    catch { setRepos([]) }
  }

  function enterRepo(full: string | null) {
    setRepo(full); setEntered(true); setSessionId(null); setMessages([]); setPendingPlan([])
  }

  function toggleAuto() { setAuto(v => { const n = !v; try { localStorage.setItem("code_auto", n ? "1" : "0") } catch {} ; return n }) }
  function changeTier(t: Tier) { setTier(t); try { localStorage.setItem("code_tier", t) } catch {}; setOverlay(null) }

  async function disconnect() {
    await fetch("/api/auth/github/disconnect", { method: "POST" }).catch(() => {})
    setConnected(false); setLogin(""); setEntered(false); setRepo(null); setRepos(null); setGhMenu(false)
  }

  // ── 执行计划：直接推送（用户已选）──
  async function applyPlan(plan: PlanAction[], aiMsgId: string) {
    if (!plan.length) return
    setApplying(true); setApplyError(null)
    try {
      const created = plan.find(a => a.kind === "create_repo") as Extract<PlanAction, { kind: "create_repo" }> | undefined
      const summary = messages.find(m => m.id === aiMsgId)?.content?.split("\n")[0]?.slice(0, 72) || "Claude 代码改动"
      const res = await fetch("/api/code/apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, actions: plan, message: summary }),
      })
      const data = await res.json()
      if (res.ok) {
        const result = data as ApplyResult
        if (result.created && result.repo) { setRepo(result.repo); setRepos(null) }
        setMessages(prev => prev.map(m => m.id === aiMsgId ? { ...m, result } : m))
        setPendingPlan([])
        // 落库（结果）
        const sid = sessionId
        if (sid) {
          const m = messages.find(x => x.id === aiMsgId)
          if (m) insertCodeMessage(userId, sid, { ...m, plan, result })
        }
      } else setApplyError(data.error ?? "执行失败")
    } catch { setApplyError("网络错误") } finally { setApplying(false) }
  }

  // ── 发送 ──
  async function runSend(text: string, goal: boolean) {
    if (streaming) return
    let sid = sessionId
    if (!sid && repo) { sid = await createCodeSession(userId, repo, text.slice(0, 40) || "未命名"); if (sid) setSessionId(sid) }

    const userMsg: CodeMessage = { id: crypto.randomUUID(), role: "user", content: text }
    const aiId = crypto.randomUUID()
    const aiMsg: CodeMessage = { id: aiId, role: "assistant", content: "", steps: [], plan: [] }
    const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))
    setMessages(prev => [...prev, userMsg, aiMsg])
    setStreaming(true); setApplyError(null)
    if (sid) insertCodeMessage(userId, sid, userMsg)

    const steps: CodeStep[] = []
    const plan: PlanAction[] = []
    let fullText = ""
    let hadError = false

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch("/api/code/chat", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, tier, goal, messages: history }),
      })
      if (!res.ok) { const e = await res.json().catch(() => null); throw new Error(e?.error ?? `请求失败（${res.status}）`) }
      if (!res.body) throw new Error("无响应体")

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split("\n\n"); buf = parts.pop() ?? ""
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue
          try {
            const d = JSON.parse(line.slice(6))
            if (d.step) { steps.push(d.step); setMessages(prev => prev.map(m => m.id === aiId ? { ...m, steps: [...steps] } : m)) }
            else if (d.plan) { plan.push(d.plan); setMessages(prev => prev.map(m => m.id === aiId ? { ...m, plan: [...plan] } : m)) }
            else if (d.text) { fullText += d.text; setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: fullText } : m)) }
            else if (d.error) { hadError = true; fullText = d.error; setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: d.error, isError: true } : m)) }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") { hadError = true; setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: e?.message ?? String(e), isError: true } : m)) }
    } finally {
      setStreaming(false)
      if (sid) insertCodeMessage(userId, sid, { id: aiId, role: "assistant", content: fullText, steps: steps.length ? steps : undefined, plan: plan.length ? plan : undefined, isError: hadError || undefined })
      if (sid) touchCodeSession(sid)
      // 有计划：自动模式直接执行，否则挂起等确认
      if (plan.length && !hadError) {
        if (auto) applyPlan(plan, aiId)
        else setPendingPlan(plan)
      }
    }
  }

  function onSubmit() {
    const text = input.trim()
    if (!text) return
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.split(" ")
      const arg = rest.join(" ").trim()
      if (cmd === "/model") { setInput(""); setOverlay("model"); return }
      if (cmd === "/memory") { setInput(""); setOverlay("memory"); return }
      if (cmd === "/context") { setInput(""); setOverlay("context"); return }
      if (cmd === "/resume") { setInput(""); setOverlay("resume"); return }
      if (cmd === "/goal") { setInput(""); if (arg) { runSend(arg, true); return } setGoalArmed(true); return }
    }
    setInput("")
    const g = goalArmed; setGoalArmed(false)
    runSend(text, g)
  }

  async function loadSession(s: CodeSession) {
    setOverlay(null); setSessionId(s.id); setPendingPlan([])
    setMessages(await fetchCodeMessages(s.id))
  }

  const showCmdHint = input.startsWith("/") && !input.includes(" ")
  const matchedCmds = COMMANDS.filter(c => c.cmd.startsWith(input.trim()))
  const canSend = !streaming && !!input.trim()

  // ════════ 渲染分支 ════════
  if (connected === null)
    return <Shell onExit={onExit}><div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div></Shell>

  if (!connected)
    return (
      <Shell onExit={onExit}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <GitBranch className="size-8" style={{ color: ORANGE }} />
          <p className="text-foreground" style={{ fontFamily: MONO }}>连接你自己的 GitHub，就能让它读写你的仓库</p>
          <button onClick={() => { window.location.href = "/api/auth/github" }}
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: ORANGE, fontFamily: MONO }}>连接 GitHub</button>
        </div>
      </Shell>
    )

  if (!entered)
    return (
      <Shell onExit={onExit} login={login} onGhMenu={() => setGhMenu(true)} ghMenu={ghMenu} onCloseGh={() => setGhMenu(false)} onDisconnect={disconnect}>
        <RepoPicker repos={repos} onLoad={loadRepos} onPick={enterRepo} />
      </Shell>
    )

  // 终端聊天
  return (
    <Shell onExit={onExit} login={login} repo={repo} onSwitchRepo={() => { setEntered(false); setGhMenu(false) }}
      onGhMenu={() => setGhMenu(true)} ghMenu={ghMenu} onCloseGh={() => setGhMenu(false)} onDisconnect={disconnect}
      auto={auto} onToggleAuto={toggleAuto}>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 md:px-8" style={{ fontFamily: MONO }}>
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && (
            <p className="text-[12px] text-muted-foreground">
              {repo ? "描述问题或想做的改动，我会自己浏览仓库、定位、动手。" : "告诉我你想做什么（比如「做个番茄钟」），我会新建仓库、写代码、上线。"} 输入 / 看命令。
            </p>
          )}
          {messages.map(m => (
            <MessageView key={m.id} m={m} login={login} streaming={streaming && m.id === messages[messages.length - 1]?.id} />
          ))}
        </div>
      </div>

      {/* 待确认计划条（确认模式）*/}
      {pendingPlan.length > 0 && !auto && (
        <div className="border-t border-border bg-secondary/40 px-4 py-3 md:px-8">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <span className="text-[12px] text-foreground" style={{ fontFamily: MONO }}>{planSummary(pendingPlan)}</span>
            {applyError && <span className="text-[12px] text-destructive">{applyError}</span>}
            <div className="ml-auto flex gap-2">
              <button onClick={() => { setPendingPlan([]); setApplyError(null) }} disabled={applying}
                className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-secondary">
                <X className="size-3.5" />放弃
              </button>
              <button onClick={() => applyPlan(pendingPlan, [...messages].reverse().find(m => m.role === "assistant")?.id ?? "")} disabled={applying}
                className="flex items-center gap-1 rounded-lg px-3.5 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: ORANGE }}>
                {applying ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                {applying ? "执行中…" : "确认并执行"}
              </button>
            </div>
          </div>
        </div>
      )}
      {applying && auto && (
        <div className="border-t border-border bg-secondary/40 px-4 py-2.5 md:px-8">
          <div className="mx-auto flex max-w-3xl items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />自动执行中…</div>
        </div>
      )}

      {/* 命令提示 */}
      {showCmdHint && matchedCmds.length > 0 && (
        <div className="border-t border-border px-4 md:px-8">
          <div className="mx-auto max-w-3xl py-1.5">
            {matchedCmds.map(c => (
              <button key={c.cmd} onClick={() => { if (c.cmd === "/goal") { setInput("/goal "); taRef.current?.focus() } else { setInput(""); setOverlay(c.cmd.slice(1) as Overlay) } }}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-secondary/60">
                <span className="text-[12px] font-medium" style={{ color: ORANGE, fontFamily: MONO }}>{c.cmd}</span>
                <span className="text-[11px] text-muted-foreground">{c.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 输入区：上下两条线 + Enter 键 */}
      <div className="border-y border-border px-4 py-3 md:px-8">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          {goalArmed && <span className="mb-2 shrink-0 rounded px-1.5 py-0.5 text-[10px] text-white" style={{ background: ORANGE }}>目标</span>}
          <span className="mb-2 shrink-0 select-none" style={{ color: ORANGE, fontFamily: MONO }}>›</span>
          <textarea
            ref={taRef} rows={1} value={input}
            onChange={e => { setInput(e.target.value); const el = e.target; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px" }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!streaming) onSubmit() } }}
            placeholder={goalArmed ? "描述目标，我会自主多轮完成……" : (repo ? "描述问题，或输入 / 调用命令……" : "想做什么？比如「做个番茄钟」……")}
            className="min-h-0 flex-1 resize-none bg-transparent py-1.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60"
            style={{ fontFamily: MONO }}
          />
          {streaming ? (
            <button onClick={() => abortRef.current?.abort()} aria-label="停止"
              className="mb-0.5 flex h-8 items-center justify-center rounded-lg border border-border bg-secondary px-3 text-foreground transition-colors hover:bg-secondary/70">
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button onClick={onSubmit} disabled={!canSend} aria-label="发送"
              title="Enter 发送"
              className={cn("mb-0.5 flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[12px] font-medium transition-all", canSend ? "border-transparent text-white" : "border-border text-muted-foreground/40")}
              style={canSend ? { background: ORANGE } : undefined}>
              <CornerDownLeft className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {overlay === "model" && <ModelOverlay tier={tier} onPick={changeTier} onClose={() => setOverlay(null)} />}
      {overlay === "memory" && repo && <MemoryOverlay repo={repo} userId={userId} onClose={() => setOverlay(null)} />}
      {overlay === "memory" && !repo && <SimpleOverlay title="记忆" text="新项目还没有仓库，建好后再来记。" onClose={() => setOverlay(null)} />}
      {overlay === "context" && <ContextOverlay messages={messages} onClose={() => setOverlay(null)} />}
      {overlay === "resume" && repo && <ResumeOverlay repo={repo} onPick={loadSession} onClose={() => setOverlay(null)} />}
      {overlay === "resume" && !repo && <SimpleOverlay title="历史排查" text="新项目模式暂无历史。建好仓库后会自动记录。" onClose={() => setOverlay(null)} />}
    </Shell>
  )
}

function planSummary(plan: PlanAction[]): string {
  const c = plan.filter(a => a.kind === "create_repo").length
  const w = plan.filter(a => a.kind === "write_file").length
  const d = plan.filter(a => a.kind === "delete_file").length
  const p = plan.some(a => a.kind === "enable_pages")
  const parts: string[] = []
  if (c) parts.push(`新建 ${c} 个仓库`)
  if (w) parts.push(`写入 ${w} 个文件`)
  if (d) parts.push(`删除 ${d} 个文件`)
  if (p) parts.push("上线")
  return parts.join(" · ") || "改动"
}

// ── 外壳：跟随主题的全屏 + 顶部导航条 ──
function Shell({ children, onExit, repo, login, onSwitchRepo, onGhMenu, ghMenu, onCloseGh, onDisconnect, auto, onToggleAuto }: {
  children: React.ReactNode
  onExit: () => void
  repo?: string | null
  login?: string
  onSwitchRepo?: () => void
  onGhMenu?: () => void
  ghMenu?: boolean
  onCloseGh?: () => void
  onDisconnect?: () => void
  auto?: boolean
  onToggleAuto?: () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background paper-grain">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 md:px-8">
        <button onClick={onExit} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-secondary" style={{ fontFamily: MONO }}>
          <ChevronLeft className="size-4" />退出
        </button>
        <span className="text-[12px] tracking-[0.25em]" style={{ color: ORANGE, fontFamily: MONO }}>CODE</span>

        <div className="ml-auto flex items-center gap-2">
          {onToggleAuto && (
            <button onClick={onToggleAuto} title="自主模式" className="rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-secondary" style={{ fontFamily: MONO, color: auto ? ORANGE : undefined, borderColor: auto ? ORANGE : undefined }}>
              {auto ? "自动" : "确认"}
            </button>
          )}
          {repo !== undefined && repo && (
            <button onClick={onSwitchRepo} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-foreground/80 transition-colors hover:bg-secondary" style={{ fontFamily: MONO }}>
              <GitBranch className="size-3.5" style={{ color: ORANGE }} />{repo}
            </button>
          )}
          {repo !== undefined && !repo && login !== undefined && (
            <span className="rounded-md px-2 py-1 text-[12px] text-muted-foreground" style={{ fontFamily: MONO }}>新项目</span>
          )}
          {/* GitHub 账号入口 */}
          {login !== undefined && (
            <div className="relative">
              <button onClick={onGhMenu} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-secondary" style={{ fontFamily: MONO }}>
                {login ? `@${login}` : "GitHub"}<ChevronDown className="size-3" />
              </button>
              {ghMenu && (
                <>
                  <button className="fixed inset-0 z-10 cursor-default" aria-label="关闭" onClick={onCloseGh} />
                  <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
                    <a href="https://github.com/settings/applications" target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2.5 text-[12px] text-foreground transition-colors hover:bg-secondary">
                      <ExternalLink className="size-3.5" />管理授权
                    </a>
                    <button onClick={onDisconnect} className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2.5 text-[12px] text-destructive transition-colors hover:bg-destructive/10">
                      <X className="size-3.5" />断开 GitHub
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}

// ── 单条消息 ──
function MessageView({ m, login, streaming }: { m: CodeMessage; login: string; streaming: boolean }) {
  if (m.role === "user")
    return (
      <div className="pt-2">
        <div className="flex items-center gap-2">
          <span style={{ color: ORANGE }}>──</span>
          <span className="whitespace-pre-wrap break-words text-[13.5px] text-foreground">{m.content}</span>
          <span className="min-w-[1rem] flex-1 border-t border-border" />
        </div>
      </div>
    )
  return (
    <div className="space-y-1.5">
      {m.steps?.map((s, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span style={{ color: ORANGE }}>⏺</span>{s.label}
        </div>
      ))}
      {/* 思考球：流式中、还没出正文时显示 */}
      {streaming && !m.content && <div className="flex items-center gap-2 py-1"><ThinkingBall /><span className="text-[12px] text-muted-foreground">思考中</span></div>}
      {m.content && <p className={cn("whitespace-pre-wrap break-words text-[13.5px] leading-[1.7]", m.isError ? "text-destructive" : "text-foreground/90")}>{m.content}</p>}
      {m.plan?.map((a, i) => <PlanActionView key={i} a={a} login={login} />)}
      {m.result && <ResultCard r={m.result} />}
    </div>
  )
}

function ResultCard({ r }: { r: ApplyResult }) {
  return (
    <div className="mt-1 space-y-1 rounded-lg border px-3 py-2.5 text-[12px]" style={{ borderColor: ORANGE, background: "color-mix(in oklab, " + ORANGE + " 8%, transparent)" }}>
      <div className="flex items-center gap-2 font-medium text-foreground"><Check className="size-3.5" style={{ color: ORANGE }} />已提交并推送{r.created ? "（新仓库已创建）" : ""}</div>
      {r.repoUrl && <a href={r.repoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-muted-foreground underline-offset-2 hover:underline"><ExternalLink className="size-3" />在 GitHub 查看仓库</a>}
      {r.pagesUrl && <a href={r.pagesUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 underline-offset-2 hover:underline" style={{ color: ORANGE }}><Rocket className="size-3" />已上线：{r.pagesUrl}</a>}
    </div>
  )
}

// ── 仓库选择（含新建项目入口）──
function RepoPicker({ repos, onLoad, onPick }: { repos: RepoItem[] | null; onLoad: () => void; onPick: (full: string | null) => void }) {
  useEffect(() => { if (repos === null) onLoad() }, [repos, onLoad])
  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto max-w-2xl space-y-2">
        <button onClick={() => onPick(null)} className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-secondary/50" style={{ borderColor: ORANGE }}>
          <Plus className="size-4 shrink-0" style={{ color: ORANGE }} />
          <span className="text-[13px] font-medium text-foreground" style={{ fontFamily: MONO }}>从零做个新项目（我来建仓库）</span>
        </button>
        <p className="px-1 pt-2 text-[12px] text-muted-foreground" style={{ fontFamily: MONO }}>或选一个已有仓库改：</p>
        {repos === null ? (
          <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : repos.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">没有可访问的仓库</p>
        ) : repos.map(r => (
          <button key={r.full_name} onClick={() => onPick(r.full_name)} className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-2.5 text-left transition-colors hover:bg-secondary/50">
            <GitBranch className="size-4 shrink-0" style={{ color: ORANGE }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-foreground" style={{ fontFamily: MONO }}>{r.full_name}</span>
              {r.description && <span className="block truncate text-[11px] text-muted-foreground">{r.description}</span>}
            </span>
            {r.private && <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">私有</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── 覆盖层 ──
function OverlayShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  if (typeof document === "undefined") return null
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md rounded-t-2xl border border-border bg-card p-4 sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13px] font-medium text-foreground" style={{ fontFamily: MONO }}>{title}</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

function SimpleOverlay({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return <OverlayShell title={title} onClose={onClose}><p className="text-[12px] text-muted-foreground">{text}</p></OverlayShell>
}

function ModelOverlay({ tier, onPick, onClose }: { tier: Tier; onPick: (t: Tier) => void; onClose: () => void }) {
  return (
    <OverlayShell title="切换模型" onClose={onClose}>
      <div className="space-y-1.5">
        {TIERS.map(t => (
          <button key={t.id} onClick={() => onPick(t.id)} className="flex w-full items-center gap-3 rounded-lg border px-4 py-2.5 text-left transition-colors hover:bg-secondary/60"
            style={{ borderColor: tier === t.id ? ORANGE : "var(--border)" }}>
            <span className="flex-1 text-[13px] text-foreground" style={{ fontFamily: MONO }}>{t.label}</span>
            <span className="text-[11px] text-muted-foreground">{t.desc}</span>
            {tier === t.id && <Check className="size-4" style={{ color: ORANGE }} />}
          </button>
        ))}
      </div>
    </OverlayShell>
  )
}

function MemoryOverlay({ repo, userId, onClose }: { repo: string; userId: string; onClose: () => void }) {
  const [mems, setMems] = useState<CodeMemory[] | null>(null)
  const [adding, setAdding] = useState("")
  useEffect(() => { fetchCodeMemories(repo).then(setMems) }, [repo])
  async function add() { const c = adding.trim(); if (!c) return; const m = await insertCodeMemory(userId, repo, c); if (m) setMems(prev => [...(prev ?? []), m]); setAdding("") }
  async function del(id: string) { setMems(prev => (prev ?? []).filter(m => m.id !== id)); deleteCodeMemory(id) }
  return (
    <OverlayShell title={`本仓库记忆 · ${repo}`} onClose={onClose}>
      <p className="mb-2 text-[11px] text-muted-foreground">只属于这个仓库，与系统记忆、其它仓库相互隔离。</p>
      <div className="max-h-[40vh] space-y-1.5 overflow-y-auto">
        {mems === null ? <div className="flex justify-center py-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
          : mems.length === 0 ? <p className="py-3 text-center text-[12px] text-muted-foreground">还没有记忆</p>
          : mems.map(m => (
            <div key={m.id} className="flex items-start gap-2 rounded-lg bg-secondary/50 px-3 py-2">
              <span className="flex-1 text-[12px] leading-relaxed text-foreground/90">{m.content}</span>
              <button onClick={() => del(m.id)} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === "Enter") add() }} placeholder="手动添加一条记忆…"
          className="flex-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[12px] text-foreground outline-none" />
        <button onClick={add} className="rounded-lg px-3 py-2 text-white" style={{ background: ORANGE }}><Plus className="size-4" /></button>
      </div>
    </OverlayShell>
  )
}

function ContextOverlay({ messages, onClose }: { messages: CodeMessage[]; onClose: () => void }) {
  const chars = messages.reduce((s, m) => s + m.content.length + (m.plan?.reduce((a, p) => a + (p.kind === "write_file" ? p.newContent.length : 0), 0) ?? 0), 0)
  const approx = Math.round(chars / 3)
  const max = 128_000
  const pct = Math.min(100, (approx / max) * 100)
  return (
    <OverlayShell title="上下文用量" onClose={onClose}>
      <div className="space-y-3" style={{ fontFamily: MONO }}>
        <div className="flex justify-between text-[12px]"><span className="text-muted-foreground">消息条数</span><span className="text-foreground">{messages.length}</span></div>
        <div className="flex justify-between text-[12px]"><span className="text-muted-foreground">约 token</span><span className="text-foreground">{approx.toLocaleString()} / {max.toLocaleString()}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: ORANGE }} /></div>
        <p className="text-[11px] text-muted-foreground">估算值（按字符粗略折算），仅供参考。</p>
      </div>
    </OverlayShell>
  )
}

function ResumeOverlay({ repo, onPick, onClose }: { repo: string; onPick: (s: CodeSession) => void; onClose: () => void }) {
  const [sessions, setSessions] = useState<CodeSession[] | null>(null)
  useEffect(() => { fetchCodeSessions(repo).then(setSessions) }, [repo])
  return (
    <OverlayShell title={`历史排查 · ${repo}`} onClose={onClose}>
      <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
        {sessions === null ? <div className="flex justify-center py-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
          : sessions.length === 0 ? <p className="py-3 text-center text-[12px] text-muted-foreground">还没有历史会话</p>
          : sessions.map(s => (
            <button key={s.id} onClick={() => onPick(s)} className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-secondary/60">
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" style={{ fontFamily: MONO }}>{s.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{s.date}</span>
            </button>
          ))}
      </div>
    </OverlayShell>
  )
}
