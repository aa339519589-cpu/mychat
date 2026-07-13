"use client"

import { useEffect, useRef, useState } from "react"

import { CODE_TIERS, type Tier } from "@/lib/chat-data"
import {
  fetchCodeMessages,
  fetchCodeSessions,
  type CodeMessage,
  type CodeSession,
  type PlanAction,
} from "@/lib/code-data"
import { createCodeApplyActions } from "./apply"
import { executeCodeSend } from "./send"
import { type Overlay, type RepoItem } from "./shared"
import {
  useTaskRecovery,
  type RunCodeSendOptions,
} from "./use-task-recovery"
import { CodeConsoleView } from "./view"

export type CodeConsoleProps = {
  userId: string
  onExit: () => void
}

export function CodeConsole({ userId, onExit }: CodeConsoleProps) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [login, setLogin] = useState("")
  const [repos, setRepos] = useState<RepoItem[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [entered, setEntered] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CodeMessage[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [tier, setTier] = useState<Tier>("正构")
  const [auto, setAuto] = useState(false)
  const [pendingPlan, setPendingPlan] = useState<PlanAction[]>([])
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [hiddenRepos, setHiddenRepos] = useState<string[]>([])
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null)
  const [workspaceDirty, setWorkspaceDirty] = useState(false)
  const [publishPending, setPublishPending] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [ghMenu, setGhMenu] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { restoreTask, scheduleTaskRecovery, syncWorkspaceState } = useTaskRecovery({
    messages,
    runSend,
    setMessages,
    setStreaming,
    setCurrentTaskId,
    setWorkspaceDirty,
    setPublishPending,
  })
  const { applyPlan, publishWorkspacePR } = createCodeApplyActions({
    userId,
    repo,
    sessionId,
    messages,
    currentTaskId,
    runSend,
    setRepo,
    invalidateRepos: () => setRepos(null),
    setMessages,
    setPendingPlan,
    setApplying,
    setApplyError,
    setWorkspaceDirty,
    setPublishPending,
  })

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, streaming, applying])

  useEffect(() => {
    fetch("/api/github/status")
      .then(response => response.json())
      .then(data => {
        setConnected(!!data.connected)
        setLogin(data.login ?? "")
      })
      .catch(() => setConnected(false))
    try {
      const savedTier = localStorage.getItem("code_tier") as Tier | null
      if (savedTier && CODE_TIERS.some(option => option.id === savedTier)) setTier(savedTier)
      setAuto(localStorage.getItem("code_auto") === "1")
    } catch {
      // Browser storage is optional.
    }
  }, [])

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("code_hidden_repos") || "[]")
      if (Array.isArray(saved)) setHiddenRepos(saved.filter(item => typeof item === "string"))
    } catch {
      // Browser storage is optional.
    }
  }, [])

  async function runSend(text: string, options?: RunCodeSendOptions): Promise<void> {
    await executeCodeSend(text, options, {
      userId,
      repo,
      messages,
      streaming,
      currentTaskId,
      sessionId,
      tier,
      auto,
      abortRef,
      setMessages,
      setStreaming,
      setApplyError,
      setWorkspaceDirty,
      setSessionId,
      setCurrentTaskId,
      setPublishPending,
      setPendingPlan,
      applyPlan,
      syncWorkspaceState,
      scheduleTaskRecovery,
    })
  }

  function hideRepo(fullName: string) {
    setHiddenRepos(previous => {
      const next = [...new Set([...previous, fullName])]
      try {
        localStorage.setItem("code_hidden_repos", JSON.stringify(next))
      } catch {
        // Browser storage is optional.
      }
      return next
    })
  }

  function resetHiddenRepos() {
    setHiddenRepos([])
    try {
      localStorage.removeItem("code_hidden_repos")
    } catch {
      // Browser storage is optional.
    }
  }

  async function loadRepos() {
    if (repos) return
    try {
      const response = await fetch("/api/github/repos")
      const data = await response.json()
      setRepos(data.repos ?? [])
    } catch {
      setRepos([])
    }
  }

  function clearConversation() {
    setSessionId(null)
    setMessages([])
    setPendingPlan([])
    setApplyError(null)
    setCurrentTaskId(null)
    setWorkspaceDirty(false)
    setPublishPending(false)
  }

  async function enterRepo(fullName: string | null) {
    setRepo(fullName)
    setEntered(true)
    clearConversation()
    if (!fullName) return

    const sessions = await fetchCodeSessions(fullName)
    let restoredMessages: CodeMessage[] = []
    if (sessions.length) {
      restoredMessages = await fetchCodeMessages(sessions[0].id)
      setSessionId(sessions[0].id)
      setMessages(restoredMessages)
    }
    await restoreTask(fullName, restoredMessages, sessions[0]?.id ?? null)
  }

  function startNewSession() {
    clearConversation()
    setOverlay(null)
  }

  function toggleAuto() {
    setAuto(previous => {
      const next = !previous
      try {
        localStorage.setItem("code_auto", next ? "1" : "0")
      } catch {
        // Browser storage is optional.
      }
      return next
    })
  }

  function changeTier(nextTier: Tier) {
    setTier(nextTier)
    try {
      localStorage.setItem("code_tier", nextTier)
    } catch {
      // Browser storage is optional.
    }
    setOverlay(null)
  }

  async function disconnect() {
    await fetch("/api/auth/github/disconnect", { method: "POST" }).catch(() => {})
    setConnected(false)
    setLogin("")
    setEntered(false)
    setRepo(null)
    setRepos(null)
    setGhMenu(false)
  }

  async function stopAgent() {
    if (currentTaskId) {
      await fetch(`/api/agent/tasks/${currentTaskId}/cancel`, { method: "POST" }).catch(() => {})
    }
    abortRef.current?.abort()
  }

  function runCommand(command: string) {
    setInput("")
    if (command === "/new") startNewSession()
    else setOverlay(command.slice(1) as Overlay)
  }

  function submit() {
    const text = input.trim()
    if (!text) return
    const command = text.split(" ")[0]
    if (["/new", "/model", "/memory", "/context", "/resume", "/tasks"].includes(command)) {
      runCommand(command)
      return
    }
    setInput("")
    void runSend(text)
  }

  async function loadSession(session: CodeSession) {
    setOverlay(null)
    setSessionId(session.id)
    setPendingPlan([])
    const restoredMessages = await fetchCodeMessages(session.id)
    setMessages(restoredMessages)
    await restoreTask(session.repo, restoredMessages, session.id)
  }

  function leaveRepo() {
    setEntered(false)
    setGhMenu(false)
  }

  const latestAssistantId = [...messages].reverse()
    .find(message => message.role === "assistant")?.id ?? ""

  return (
    <CodeConsoleView
      userId={userId}
      onExit={onExit}
      connected={connected}
      login={login}
      repos={repos}
      repo={repo}
      entered={entered}
      hiddenRepos={hiddenRepos}
      onLoadRepos={() => { void loadRepos() }}
      onEnterRepo={fullName => { void enterRepo(fullName) }}
      onHideRepo={hideRepo}
      onResetHiddenRepos={resetHiddenRepos}
      ghMenu={ghMenu}
      onOpenGhMenu={() => setGhMenu(true)}
      onCloseGhMenu={() => setGhMenu(false)}
      onDisconnect={() => { void disconnect() }}
      onLeaveRepo={leaveRepo}
      auto={auto}
      onToggleAuto={toggleAuto}
      scrollRef={scrollRef}
      messages={messages}
      streaming={streaming}
      applying={applying}
      currentTaskId={currentTaskId}
      workspaceDirty={workspaceDirty}
      publishPending={publishPending}
      applyError={applyError}
      onPublishWorkspacePR={() => { void publishWorkspacePR() }}
      pendingPlan={pendingPlan}
      onAbandonPlan={() => { setPendingPlan([]); setApplyError(null) }}
      onApplyPlan={() => { void applyPlan(pendingPlan, latestAssistantId) }}
      input={input}
      onInputChange={setInput}
      onSubmit={submit}
      onStopAgent={() => { void stopAgent() }}
      onCommand={runCommand}
      overlay={overlay}
      onCloseOverlay={() => setOverlay(null)}
      tier={tier}
      onChangeTier={changeTier}
      onLoadSession={session => { void loadSession(session) }}
    />
  )
}
