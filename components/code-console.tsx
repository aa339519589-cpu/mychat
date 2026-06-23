"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronLeft, Loader2, Check, X, ExternalLink, GitBranch, ArrowUp, Square, Trash2, Plus } from "lucide-react"
import { type Tier, TIERS, TIER_MAP } from "@/lib/chat-data"
import {
  type CodeMessage, type CodeEdit, type CodeStep, type CodeSession, type CodeMemory,
  fetchCodeSessions, createCodeSession, touchCodeSession,
  fetchCodeMessages, insertCodeMessage,
  fetchCodeMemories, insertCodeMemory, deleteCodeMemory,
} from "@/lib/code-data"

const MONO = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace"

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

function DiffBlock({ edit }: { edit: CodeEdit }) {
  const lines = computeDiff(edit.oldContent, edit.newContent)
  return (
    <div className="mt-2 overflow-hidden rounded-lg border" style={{ borderColor: "oklch(0.34 0.012 70)" }}>
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]" style={{ background: "oklch(0.26 0.01 70)", color: "oklch(0.72 0.02 70)" }}>
        <span className="truncate font-medium">{edit.path}</span>
        {edit.summary && <span className="truncate opacity-70">— {edit.summary}</span>}
      </div>
      <div className="max-h-[320px] overflow-auto" style={{ fontFamily: MONO, fontSize: "11px", lineHeight: "1.65" }}>
        {lines.map((ln, idx) => (
          <div key={idx} className="flex" style={{
            background: ln.type === "add" ? "oklch(0.34 0.055 85)" : ln.type === "del" ? "oklch(0.32 0.05 25)" : undefined,
            borderLeft: ln.type === "add" ? "2px solid oklch(0.62 0.10 80)" : ln.type === "del" ? "2px solid oklch(0.58 0.11 25)" : "2px solid transparent",
          }}>
            <span className="shrink-0 select-none px-2 text-center" style={{ width: 18, color: "oklch(0.55 0.02 70)" }}>
              {ln.type === "add" ? "+" : ln.type === "del" ? "-" : " "}
            </span>
            <span className="whitespace-pre-wrap break-all pr-2" style={{ color: "oklch(0.86 0.02 80)" }}>{ln.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CodeConsole({ userId, onExit }: { userId: string; onExit: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [login, setLogin] = useState<string | null>(null)
  const [repos, setRepos] = useState<RepoItem[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [pickingRepo, setPickingRepo] = useState(false)

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CodeMessage[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [tier, setTier] = useState<Tier>("正构")
  const [goalArmed, setGoalArmed] = useState(false)

  const [pendingEdits, setPendingEdits] = useState<CodeEdit[]>([])
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const [overlay, setOverlay] = useState<Overlay>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // 连接状态 + 模型偏好
  useEffect(() => {
    fetch("/api/github/status").then(r => r.json()).then(d => {
      setConnected(!!d.connected); setLogin(d.login ?? null)
    }).catch(() => setConnected(false))
    try { const t = localStorage.getItem("code_tier") as Tier | null; if (t && TIERS.some(x => x.id === t)) setTier(t) } catch {}
  }, [])

  // 选了仓库后，自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [messages, pendingEdits])

  async function loadRepos() {
    setPickingRepo(true)
    if (repos) return
    try {
      const res = await fetch("/api/github/repos")
      const data = await res.json()
      setRepos(data.repos ?? [])
    } catch { setRepos([]) }
  }

  function pickRepo(fullName: string) {
    setRepo(fullName)
    setPickingRepo(false)
    setSessionId(null)
    setMessages([])
    setPendingEdits([])
  }

  function changeTier(t: Tier) {
    setTier(t)
    try { localStorage.setItem("code_tier", t) } catch {}
    setOverlay(null)
  }

  // ── 发送 ──
  async function runSend(text: string, goal: boolean) {
    if (!repo || streaming) return
    // 尝试建会话用于历史/恢复；若 code.sql 尚未在 Supabase 执行，建表失败也不阻断对话——
    // 只是本轮不落库（无历史、无 /resume），AI 照常工作。与额度的 fail-open 同思路。
    let sid = sessionId
    if (!sid) {
      sid = await createCodeSession(userId, repo, text.slice(0, 40) || "未命名排查")
      if (sid) setSessionId(sid)
    }

    const userMsg: CodeMessage = { id: crypto.randomUUID(), role: "user", content: text }
    const aiId = crypto.randomUUID()
    const aiMsg: CodeMessage = { id: aiId, role: "assistant", content: "", steps: [], edits: [] }
    const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))
    setMessages(prev => [...prev, userMsg, aiMsg])
    setStreaming(true)
    setCommitError(null)
    if (sid) insertCodeMessage(userId, sid, userMsg)

    const collectedEdits: CodeEdit[] = []
    const collectedSteps: CodeStep[] = []
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
            if (d.step) {
              collectedSteps.push(d.step as CodeStep)
              setMessages(prev => prev.map(m => m.id === aiId ? { ...m, steps: [...collectedSteps] } : m))
            } else if (d.codeEdit) {
              const ed = d.codeEdit as CodeEdit
              collectedEdits.push(ed)
              setPendingEdits(prev => [...prev.filter(p => p.path !== ed.path), ed])
              setMessages(prev => prev.map(m => m.id === aiId ? { ...m, edits: [...collectedEdits] } : m))
            } else if (d.text) {
              fullText += d.text
              setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: fullText } : m))
            } else if (d.error) {
              hadError = true
              fullText = d.error
              setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: d.error, isError: true } : m))
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        hadError = true
        setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: e?.message ?? String(e), isError: true } : m))
      }
    } finally {
      setStreaming(false)
      if (sid) {
        touchCodeSession(sid)
        insertCodeMessage(userId, sid, {
          id: aiId, role: "assistant", content: fullText,
          steps: collectedSteps.length ? collectedSteps : undefined,
          edits: collectedEdits.length ? collectedEdits : undefined,
          isError: hadError || undefined,
        })
      }
    }
  }

  function onSubmit() {
    const text = input.trim()
    if (!text) return
    // 斜杠命令
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.split(" ")
      const arg = rest.join(" ").trim()
      if (cmd === "/model") { setInput(""); setOverlay("model"); return }
      if (cmd === "/memory") { setInput(""); setOverlay("memory"); return }
      if (cmd === "/context") { setInput(""); setOverlay("context"); return }
      if (cmd === "/resume") { setInput(""); setOverlay("resume"); return }
      if (cmd === "/goal") {
        setInput("")
        if (arg) { runSend(arg, true); return }
        setGoalArmed(true); return
      }
    }
    setInput("")
    const useGoal = goalArmed
    setGoalArmed(false)
    runSend(text, useGoal)
  }

  async function confirmCommit() {
    if (!repo || !pendingEdits.length || committing) return
    setCommitting(true)
    setCommitError(null)
    try {
      const summary = pendingEdits.map(e => e.summary).filter(Boolean).join("；") || "Claude 代码修改"
      const res = await fetch("/api/github/commit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo,
          files: pendingEdits.map(e => ({ path: e.path, content: e.newContent, sha: e.sha })),
          message: summary,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        const pr = { url: data.prUrl as string, number: data.prNumber as number }
        setMessages(prev => {
          const copy = [...prev]
          for (let i = copy.length - 1; i >= 0; i--) if (copy[i].role === "assistant") { copy[i] = { ...copy[i], pr }; break }
          return copy
        })
        setPendingEdits([])
      } else setCommitError(data.error ?? "提交失败")
    } catch { setCommitError("网络错误") } finally { setCommitting(false) }
  }

  async function loadSession(s: CodeSession) {
    setOverlay(null)
    setSessionId(s.id)
    setPendingEdits([])
    const msgs = await fetchCodeMessages(s.id)
    setMessages(msgs)
  }

  const showCmdHint = input.startsWith("/") && !input.includes(" ")
  const matchedCmds = COMMANDS.filter(c => c.cmd.startsWith(input.trim()))

  // ════════ 渲染分支 ════════
  // 1) 连接检查中
  if (connected === null) {
    return <Shell onExit={onExit}><div className="flex flex-1 items-center justify-center" style={{ color: "oklch(0.6 0.02 70)" }}><Loader2 className="size-5 animate-spin" /></div></Shell>
  }
  // 2) 未连接 GitHub
  if (!connected) {
    return (
      <Shell onExit={onExit}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <GitBranch className="size-8" style={{ color: "oklch(0.7 0.1 70)" }} />
          <p style={{ color: "oklch(0.82 0.02 80)", fontFamily: MONO }}>Code 需要连接 GitHub 才能读写你的仓库</p>
          <button
            onClick={() => { window.location.href = "/api/auth/github" }}
            className="rounded-lg px-5 py-2.5 text-sm font-medium transition-opacity hover:opacity-90"
            style={{ background: "oklch(0.7 0.1 70)", color: "oklch(0.2 0.01 70)", fontFamily: MONO }}
          >连接 GitHub</button>
        </div>
      </Shell>
    )
  }
  // 3) 已连接、未选仓库（或正在切换）
  if (!repo || pickingRepo) {
    return (
      <Shell onExit={onExit} repo={repo} login={login} onSwitchRepo={loadRepos}>
        <RepoPicker repos={repos} onLoad={loadRepos} onPick={pickRepo} onCancel={repo ? () => setPickingRepo(false) : undefined} />
      </Shell>
    )
  }

  // 4) 终端聊天
  return (
    <Shell onExit={onExit} repo={repo} login={login} onSwitchRepo={loadRepos}>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 md:px-8" style={{ fontFamily: MONO }}>
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && (
            <p className="text-[12px]" style={{ color: "oklch(0.55 0.02 70)" }}>
              描述你遇到的问题或想做的改动，我会自己浏览仓库、定位代码、给出修改建议。输入 / 查看命令。
            </p>
          )}
          {messages.map(m => <MessageView key={m.id} m={m} />)}
        </div>
      </div>

      {/* 待确认的修改条 */}
      {pendingEdits.length > 0 && (
        <div className="border-t px-4 py-3 md:px-8" style={{ borderColor: "oklch(0.3 0.012 70)", background: "oklch(0.24 0.01 70)" }}>
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <span className="text-[12px]" style={{ color: "oklch(0.75 0.02 80)", fontFamily: MONO }}>
              {pendingEdits.length} 个文件待提交
            </span>
            {commitError && <span className="text-[12px]" style={{ color: "oklch(0.6 0.13 25)" }}>{commitError}</span>}
            <div className="ml-auto flex gap-2">
              <button onClick={() => setPendingEdits([])} disabled={committing}
                className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] transition-colors"
                style={{ color: "oklch(0.65 0.02 70)", border: "1px solid oklch(0.34 0.012 70)" }}>
                <X className="size-3.5" />放弃
              </button>
              <button onClick={confirmCommit} disabled={committing}
                className="flex items-center gap-1 rounded-lg px-3.5 py-1.5 text-[12px] font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: "oklch(0.7 0.1 70)", color: "oklch(0.2 0.01 70)" }}>
                {committing ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                {committing ? "提交中…" : "确认提交并开 PR"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 命令提示 */}
      {showCmdHint && matchedCmds.length > 0 && (
        <div className="border-t px-4 md:px-8" style={{ borderColor: "oklch(0.3 0.012 70)" }}>
          <div className="mx-auto max-w-3xl py-1.5">
            {matchedCmds.map(c => (
              <button key={c.cmd} onClick={() => { setInput(c.cmd === "/goal" ? "/goal " : ""); if (c.cmd !== "/goal") { setInput(""); setOverlay(c.cmd.slice(1) as Overlay) } taRef.current?.focus() }}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-white/5">
                <span className="text-[12px] font-medium" style={{ color: "oklch(0.78 0.08 75)", fontFamily: MONO }}>{c.cmd}</span>
                <span className="text-[11px]" style={{ color: "oklch(0.55 0.02 70)" }}>{c.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="border-t px-4 py-3 md:px-8" style={{ borderColor: "oklch(0.3 0.012 70)" }}>
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          {goalArmed && (
            <span className="mb-2 shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: "oklch(0.4 0.08 75)", color: "oklch(0.92 0.02 80)" }}>目标</span>
          )}
          <span className="mb-2 shrink-0 select-none" style={{ color: "oklch(0.68 0.1 75)", fontFamily: MONO }}>›</span>
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            onChange={e => {
              setInput(e.target.value)
              const el = e.target; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"
            }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!streaming) onSubmit() } }}
            placeholder={goalArmed ? "描述目标，我会自主多轮完成……" : "描述问题，或输入 / 调用命令……"}
            className="min-h-0 flex-1 resize-none bg-transparent py-1.5 text-[14px] outline-none"
            style={{ color: "oklch(0.88 0.02 80)", fontFamily: MONO }}
          />
          {streaming ? (
            <button onClick={() => abortRef.current?.abort()} className="mb-1 flex size-8 shrink-0 items-center justify-center rounded-full" style={{ background: "oklch(0.82 0.02 80)", color: "oklch(0.2 0.01 70)" }}>
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button onClick={onSubmit} disabled={!input.trim()} className="mb-1 flex size-8 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-30"
              style={{ background: "oklch(0.7 0.1 70)", color: "oklch(0.2 0.01 70)" }}>
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* 覆盖层：/model /memory /context /resume */}
      {overlay === "model" && <ModelOverlay tier={tier} onPick={changeTier} onClose={() => setOverlay(null)} />}
      {overlay === "memory" && <MemoryOverlay repo={repo} userId={userId} onClose={() => setOverlay(null)} />}
      {overlay === "context" && <ContextOverlay messages={messages} onClose={() => setOverlay(null)} />}
      {overlay === "resume" && <ResumeOverlay repo={repo} onPick={loadSession} onClose={() => setOverlay(null)} />}
    </Shell>
  )
}

// ── 外壳：深色全屏 + 顶部极简导航条 ──
function Shell({ children, onExit, repo, login, onSwitchRepo }: {
  children: React.ReactNode
  onExit: () => void
  repo?: string | null
  login?: string | null
  onSwitchRepo?: () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: "oklch(0.205 0.008 70)" }}>
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5 md:px-8" style={{ borderColor: "oklch(0.3 0.012 70)" }}>
        <button onClick={onExit} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] transition-colors hover:bg-white/5" style={{ color: "oklch(0.6 0.02 70)", fontFamily: MONO }}>
          <ChevronLeft className="size-4" />退出
        </button>
        <span className="text-[12px] tracking-[0.25em]" style={{ color: "oklch(0.5 0.04 75)", fontFamily: MONO }}>CODE</span>
        {repo && (
          <button onClick={onSwitchRepo} className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-white/5" style={{ color: "oklch(0.68 0.04 75)", fontFamily: MONO }}>
            <GitBranch className="size-3.5" />{repo}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

// ── 单条消息：用户=双横线分隔，AI=纯文本流 + 步骤 + diff ──
function MessageView({ m }: { m: CodeMessage }) {
  if (m.role === "user") {
    return (
      <div className="pt-2">
        <div className="flex items-center gap-2">
          <span style={{ color: "oklch(0.62 0.1 75)" }}>──</span>
          <span className="whitespace-pre-wrap break-words text-[13.5px]" style={{ color: "oklch(0.9 0.03 80)" }}>{m.content}</span>
          <span className="min-w-[1rem] flex-1 border-t" style={{ borderColor: "oklch(0.3 0.04 75)" }} />
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {m.steps?.map((s, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px]" style={{ color: "oklch(0.56 0.03 75)" }}>
          <span style={{ color: "oklch(0.62 0.08 75)" }}>⏺</span>{s.label}
        </div>
      ))}
      {m.content && (
        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-[1.7]" style={{ color: m.isError ? "oklch(0.65 0.13 25)" : "oklch(0.83 0.02 80)" }}>{m.content}</p>
      )}
      {m.edits?.map((e, i) => <DiffBlock key={i} edit={e} />)}
      {m.pr && (
        <div className="mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]" style={{ background: "oklch(0.27 0.03 145)", color: "oklch(0.82 0.04 145)" }}>
          <Check className="size-3.5" />
          <span>PR #{m.pr.number} 已创建</span>
          <a href={m.pr.url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 underline-offset-2 hover:underline">
            <ExternalLink className="size-3" />查看
          </a>
        </div>
      )}
    </div>
  )
}

// ── 仓库选择 ──
function RepoPicker({ repos, onLoad, onPick, onCancel }: {
  repos: RepoItem[] | null
  onLoad: () => void
  onPick: (full: string) => void
  onCancel?: () => void
}) {
  useEffect(() => { if (repos === null) onLoad() }, [repos, onLoad])
  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[13px]" style={{ color: "oklch(0.7 0.02 80)", fontFamily: MONO }}>选择一个仓库开始</p>
          {onCancel && <button onClick={onCancel} className="text-[12px]" style={{ color: "oklch(0.55 0.02 70)" }}>取消</button>}
        </div>
        {repos === null ? (
          <div className="flex justify-center py-10" style={{ color: "oklch(0.6 0.02 70)" }}><Loader2 className="size-5 animate-spin" /></div>
        ) : repos.length === 0 ? (
          <p className="py-10 text-center text-[13px]" style={{ color: "oklch(0.55 0.02 70)" }}>没有可访问的仓库</p>
        ) : (
          <div className="space-y-1.5">
            {repos.map(r => (
              <button key={r.full_name} onClick={() => onPick(r.full_name)}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left transition-colors hover:bg-white/5"
                style={{ border: "1px solid oklch(0.3 0.012 70)" }}>
                <GitBranch className="size-4 shrink-0" style={{ color: "oklch(0.65 0.08 75)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]" style={{ color: "oklch(0.85 0.02 80)", fontFamily: MONO }}>{r.full_name}</span>
                  {r.description && <span className="block truncate text-[11px]" style={{ color: "oklch(0.55 0.02 70)" }}>{r.description}</span>}
                </span>
                {r.private && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: "oklch(0.3 0.012 70)", color: "oklch(0.6 0.02 70)" }}>私有</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 覆盖层外壳 ──
function OverlayShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex items-end justify-center sm:items-center" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: "oklch(0.15 0.008 70 / 0.6)" }} />
      <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md rounded-t-2xl sm:rounded-2xl p-4" style={{ background: "oklch(0.25 0.01 70)", border: "1px solid oklch(0.34 0.012 70)" }}>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13px] font-medium" style={{ color: "oklch(0.82 0.02 80)", fontFamily: MONO }}>{title}</span>
          <button onClick={onClose} style={{ color: "oklch(0.6 0.02 70)" }}><X className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ModelOverlay({ tier, onPick, onClose }: { tier: Tier; onPick: (t: Tier) => void; onClose: () => void }) {
  return (
    <OverlayShell title="切换模型" onClose={onClose}>
      <div className="space-y-1.5">
        {TIERS.map(t => (
          <button key={t.id} onClick={() => onPick(t.id)}
            className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left transition-colors hover:bg-white/5"
            style={{ border: tier === t.id ? "1px solid oklch(0.6 0.1 75)" : "1px solid oklch(0.3 0.012 70)" }}>
            <span className="flex-1 text-[13px]" style={{ color: "oklch(0.85 0.02 80)", fontFamily: MONO }}>{t.label}</span>
            <span className="text-[11px]" style={{ color: "oklch(0.55 0.02 70)" }}>{t.desc}</span>
            {tier === t.id && <Check className="size-4" style={{ color: "oklch(0.7 0.1 75)" }} />}
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
  async function add() {
    const c = adding.trim(); if (!c) return
    const m = await insertCodeMemory(userId, repo, c)
    if (m) setMems(prev => [...(prev ?? []), m])
    setAdding("")
  }
  async function del(id: string) { setMems(prev => (prev ?? []).filter(m => m.id !== id)); deleteCodeMemory(id) }
  return (
    <OverlayShell title={`本仓库记忆 · ${repo}`} onClose={onClose}>
      <p className="mb-2 text-[11px]" style={{ color: "oklch(0.55 0.02 70)" }}>只属于这个仓库，与系统记忆、其它仓库相互隔离。</p>
      <div className="max-h-[40vh] space-y-1.5 overflow-y-auto">
        {mems === null ? (
          <div className="flex justify-center py-4" style={{ color: "oklch(0.6 0.02 70)" }}><Loader2 className="size-4 animate-spin" /></div>
        ) : mems.length === 0 ? (
          <p className="py-3 text-center text-[12px]" style={{ color: "oklch(0.5 0.02 70)" }}>还没有记忆</p>
        ) : mems.map(m => (
          <div key={m.id} className="flex items-start gap-2 rounded-lg px-3 py-2" style={{ background: "oklch(0.22 0.01 70)" }}>
            <span className="flex-1 text-[12px] leading-relaxed" style={{ color: "oklch(0.8 0.02 80)" }}>{m.content}</span>
            <button onClick={() => del(m.id)} style={{ color: "oklch(0.5 0.02 70)" }}><Trash2 className="size-3.5" /></button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === "Enter") add() }}
          placeholder="手动添加一条记忆…" className="flex-1 rounded-lg px-3 py-2 text-[12px] outline-none"
          style={{ background: "oklch(0.22 0.01 70)", color: "oklch(0.85 0.02 80)", border: "1px solid oklch(0.32 0.012 70)" }} />
        <button onClick={add} className="rounded-lg px-3 py-2" style={{ background: "oklch(0.7 0.1 70)", color: "oklch(0.2 0.01 70)" }}><Plus className="size-4" /></button>
      </div>
    </OverlayShell>
  )
}

function ContextOverlay({ messages, onClose }: { messages: CodeMessage[]; onClose: () => void }) {
  const chars = messages.reduce((s, m) => s + m.content.length + (m.edits?.reduce((a, e) => a + e.newContent.length, 0) ?? 0), 0)
  const approxTokens = Math.round(chars / 3)
  const windowMax = 128_000
  const pct = Math.min(100, (approxTokens / windowMax) * 100)
  return (
    <OverlayShell title="上下文用量" onClose={onClose}>
      <div className="space-y-3" style={{ fontFamily: MONO }}>
        <div className="flex justify-between text-[12px]"><span style={{ color: "oklch(0.6 0.02 70)" }}>消息条数</span><span style={{ color: "oklch(0.85 0.02 80)" }}>{messages.length}</span></div>
        <div className="flex justify-between text-[12px]"><span style={{ color: "oklch(0.6 0.02 70)" }}>约 token</span><span style={{ color: "oklch(0.85 0.02 80)" }}>{approxTokens.toLocaleString()} / {windowMax.toLocaleString()}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "oklch(0.3 0.012 70)" }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "oklch(0.7 0.1 70)" }} />
        </div>
        <p className="text-[11px]" style={{ color: "oklch(0.5 0.02 70)" }}>估算值（按字符数粗略折算），仅供参考。</p>
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
        {sessions === null ? (
          <div className="flex justify-center py-4" style={{ color: "oklch(0.6 0.02 70)" }}><Loader2 className="size-4 animate-spin" /></div>
        ) : sessions.length === 0 ? (
          <p className="py-3 text-center text-[12px]" style={{ color: "oklch(0.5 0.02 70)" }}>还没有历史会话</p>
        ) : sessions.map(s => (
          <button key={s.id} onClick={() => onPick(s)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/5" style={{ border: "1px solid oklch(0.3 0.012 70)" }}>
            <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "oklch(0.83 0.02 80)", fontFamily: MONO }}>{s.title}</span>
            <span className="shrink-0 text-[11px]" style={{ color: "oklch(0.5 0.02 70)" }}>{s.date}</span>
          </button>
        ))}
      </div>
    </OverlayShell>
  )
}
