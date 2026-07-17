"use client"

import { useEffect, useId, useState, type ReactNode } from "react"
import { Check, ExternalLink, FileEdit, FilePlus2, FolderGit2, Rocket, Trash2, ChevronDown } from "lucide-react"
import ReactMarkdown from "react-markdown"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"

import type { ApplyResult, CodeMessage, PlanAction } from "@/lib/code-data"
import { isSafeExternalHttpUrl } from "@/lib/external-url"
import { normalizeMathDelimiters } from "@/lib/math"
import { stripToolMarkup } from "@/lib/llm/sanitize"
import { cn } from "@/lib/utils"
import { ACCENT, CONTROL_FOCUS, MONO } from "./shared"
import { computeDiff } from "./diff"

function DiffBody({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  return (
    <div className="max-h-[300px] overflow-auto overscroll-x-contain" style={{ fontFamily: MONO, fontSize: "11px", lineHeight: "1.65" }}>
      {computeDiff(oldContent, newContent).map((line, index) => (
        <div key={index} className="flex min-w-0" style={{
          background: line.type === "add" ? "color-mix(in oklab, #3fb950 16%, transparent)" : line.type === "del" ? "color-mix(in oklab, #f85149 14%, transparent)" : undefined,
          borderLeft: line.type === "add" ? "2px solid #3fb950" : line.type === "del" ? "2px solid #f85149" : "2px solid transparent",
        }}>
          <span className="shrink-0 select-none px-2 text-center text-muted-foreground/60" style={{ width: 18 }}>
            {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-all pr-2 text-foreground/85">{line.text || " "}</span>
        </div>
      ))}
    </div>
  )
}

export function ThinkingTimer() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSeconds(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const formatted = seconds < 60
    ? `${seconds}秒`
    : `${Math.floor(seconds / 60)}分钟${seconds % 60 ? `${seconds % 60}秒` : ""}`
  return <span className="text-[12px] text-muted-foreground" style={{ fontFamily: MONO }}>（已用时 {formatted}）</span>
}

function SafeExternalLink({
  href,
  children,
  className,
  style,
}: {
  href: unknown
  children: ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  if (!isSafeExternalHttpUrl(href)) return <span className="break-all">{children}</span>
  return <a href={href} target="_blank" rel="noopener noreferrer"
    className={cn(className, CONTROL_FOCUS)} style={style}>{children}</a>
}

function Row({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[11px] text-foreground/85">
      <span className="shrink-0" style={{ color: ACCENT }}>{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  )
}

function PlanActionView({ action, login }: { action: PlanAction; login: string }) {
  if (action.kind === "create_repo") {
    return <Row icon={<FolderGit2 className="size-3.5" />} label={`新建仓库 ${login}/${action.name}${action.private ? "（私有）" : ""}`} />
  }
  if (action.kind === "delete_file") {
    return <Row icon={<Trash2 className="size-3.5" />} label={`删除 ${action.path}`} />
  }
  if (action.kind === "enable_pages") {
    return <Row icon={<Rocket className="size-3.5" />} label="开启 GitHub Pages 上线" />
  }

  const isNew = !action.oldContent
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border">
      <div className="flex min-w-0 items-center gap-2 bg-secondary/60 px-3 py-1.5 text-[10px] text-muted-foreground">
        {isNew ? <FilePlus2 className="size-3.5 shrink-0" /> : <FileEdit className="size-3.5 shrink-0" />}
        <span className="truncate font-medium text-foreground/80">{action.path}</span>
        <span className="shrink-0 opacity-70">{isNew ? "新建" : "修改"}</span>
      </div>
      <DiffBody oldContent={action.oldContent} newContent={action.newContent} />
    </div>
  )
}

export function MessageView({ message, login }: { message: CodeMessage; login: string }) {
  const [stepsOpen, setStepsOpen] = useState(false)
  const stepsId = useId()
  if (message.role === "user") {
    return (
      <div className="border-y py-1" style={{ borderColor: ACCENT }}>
        <span className="whitespace-pre-wrap break-words text-[13.5px] leading-5 text-foreground">{message.content}</span>
      </div>
    )
  }

  const steps = message.steps ?? []
  const readCount = steps.filter(step => step.kind === "read" || step.kind === "list").length
  const notableSteps = steps.filter(step => step.kind !== "read" && step.kind !== "list")
  return (
    <div className="space-y-1.5">
      {message.content && !message.isError && (
        <div className="min-w-0 text-[13.5px] leading-[1.7] text-foreground/90 [overflow-wrap:anywhere]" style={{ fontFamily: MONO }}>
          <ReactMarkdown
            remarkPlugins={[remarkMath, remarkGfm]}
            rehypePlugins={[rehypeKatex]}
            components={{
              p: ({ children }) => <p className="mb-2 break-words [overflow-wrap:anywhere]">{children}</p>,
              a: ({ children, href }) => <SafeExternalLink href={href} className="break-all rounded-sm underline underline-offset-4" style={{ color: ACCENT }}>{children}</SafeExternalLink>,
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              em: ({ children }) => <em className="italic">{children}</em>,
              code: ({ className, children, ...props }) => !className
                ? <code className="break-all rounded bg-secondary/60 px-1 py-0.5 text-[11px]" {...props}>{children}</code>
                : <code className="block whitespace-pre-wrap rounded bg-secondary/40 px-3 py-2 text-[11px] leading-relaxed [overflow-wrap:anywhere]" {...props}>{children}</code>,
              pre: ({ children }) => <pre className="mb-2 max-w-full overflow-x-auto overscroll-x-contain rounded border border-border/30 bg-secondary/40 p-3 text-[11px]">{children}</pre>,
              ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5">{children}</ul>,
              ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
              li: ({ children }) => <li className="mb-0.5">{children}</li>,
              blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 pl-3 italic opacity-80" style={{ borderColor: ACCENT }}>{children}</blockquote>,
              table: ({ children }) => <div className="mb-3 overflow-x-auto rounded-lg border border-border/50"><table className="min-w-full border-collapse text-[11px]">{children}</table></div>,
              thead: ({ children }) => <thead className="border-b border-border/50 bg-secondary/30">{children}</thead>,
              th: ({ children }) => <th className="border-r border-border/30 px-3 py-2 text-left font-semibold last:border-r-0">{children}</th>,
              tbody: ({ children }) => <tbody className="[&_tr:nth-child(even)]:bg-secondary/20">{children}</tbody>,
              td: ({ children }) => <td className="border-r border-border/20 px-3 py-1.5 last:border-r-0">{children}</td>,
              h1: ({ children }) => <h1 className="mb-2 mt-3 text-[14px] font-bold">{children}</h1>,
              h2: ({ children }) => <h2 className="mb-1.5 mt-2.5 text-[13px] font-semibold">{children}</h2>,
              h3: ({ children }) => <h3 className="mb-1 mt-2 text-[13.5px] font-semibold">{children}</h3>,
              hr: () => <hr className="my-3 border-border/40" />,
            }}
          >
            {normalizeMathDelimiters(stripToolMarkup(message.content))}
          </ReactMarkdown>
        </div>
      )}
      {message.content && message.isError && (
        <p role="alert" className="whitespace-pre-wrap break-words text-[13.5px] leading-[1.7] text-destructive">{message.content}</p>
      )}
      {steps.length > 0 && (
        <div className="mt-1">
          <button type="button" onClick={() => setStepsOpen(value => !value)} aria-expanded={stepsOpen} aria-controls={stepsId}
            className={cn("flex min-h-11 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-[10px] text-muted-foreground/70 transition-colors hover:bg-secondary/40 hover:text-muted-foreground", CONTROL_FOCUS)} style={{ fontFamily: MONO }}>
            <ChevronDown className={cn("size-3 shrink-0 transition-transform", stepsOpen && "rotate-180")} aria-hidden="true" />
            {readCount > 0 && <span className="shrink-0">已读 {readCount} 文件{notableSteps.length > 0 && " · "}</span>}
            {notableSteps.map((step, index) => <span key={index} className="truncate">{step.label}{index < notableSteps.length - 1 && " · "}</span>)}
          </button>
          {stepsOpen && (
            <div id={stepsId} className="mt-1 min-w-0 space-y-0.5 pl-5">
              {steps.map((step, index) => (
                <div key={index} className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/60">
                  <span className="shrink-0" style={{ color: step.kind === "edit" || step.kind === "repo" || step.kind === "deploy" ? ACCENT : "var(--muted-foreground)", opacity: 0.5 }}>·</span>
                  <span className="truncate">{step.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {message.plan?.map((action, index) => <PlanActionView key={index} action={action} login={login} />)}
      {message.result && <ResultCard result={message.result} />}
    </div>
  )
}

type SafeResultUrls = {
  pullRequestUrl: string | null
  repoUrl: string | null
  pagesUrl: string | null
}

function safeResultUrls(result: ApplyResult): SafeResultUrls {
  return {
    pullRequestUrl: isSafeExternalHttpUrl(result.pullRequestUrl) ? result.pullRequestUrl : null,
    repoUrl: isSafeExternalHttpUrl(result.repoUrl) ? result.repoUrl : null,
    pagesUrl: isSafeExternalHttpUrl(result.pagesUrl) ? result.pagesUrl : null,
  }
}

function WorkspaceResultCard({ result, urls }: { result: ApplyResult; urls: SafeResultUrls }) {
  const title = result.pagesStatus === "ready"
    ? "网页已经发布"
    : result.merged ? "Pull Request 已合并" : "已创建 Pull Request"
  return (
    <div className="mt-1 min-w-0 space-y-1.5 rounded-lg border px-3 py-2.5 text-[11px]" style={{ borderColor: "#3fb950", background: "color-mix(in oklab, #3fb950 8%, transparent)" }}>
      <div className="flex items-center gap-2 font-medium text-foreground"><Check className="size-3.5 shrink-0" style={{ color: "#3fb950" }} aria-hidden="true" /><span className="min-w-0 break-all">{title}</span></div>
      {urls.pullRequestUrl && <SafeExternalLink href={urls.pullRequestUrl} className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-md font-medium underline-offset-2 hover:underline" style={{ color: "#3fb950" }}><ExternalLink className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">查看 Pull Request #{result.pullRequestNumber ?? "?"}</span></SafeExternalLink>}
      {result.branch && <p className="truncate text-muted-foreground/70">分支：{result.branch}</p>}
      {result.commitSha && <p className="truncate text-muted-foreground/70" style={{ fontFamily: MONO }}>commit：{result.commitSha.slice(0, 7)}</p>}
      {urls.pagesUrl && result.pagesStatus === "ready" && <SafeExternalLink href={urls.pagesUrl} className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-md font-medium underline-offset-2 hover:underline" style={{ color: "#3fb950" }}><Rocket className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">打开网页</span></SafeExternalLink>}
      {urls.pagesUrl && result.pagesStatus === "pending" && <p className="text-muted-foreground">网页仍在部署</p>}
      {result.pagesStatus === "failed" && <p role="alert" className="text-destructive">网页部署失败：{result.pagesError}</p>}
      {result.message && <p className="break-all italic text-muted-foreground/60">{result.message}</p>}
    </div>
  )
}

function DirectPushResultCard({ result, urls }: { result: ApplyResult; urls: SafeResultUrls }) {
  const pagesReady = !result.pagesStatus || result.pagesStatus === "ready"
  return (
    <div className="mt-1 min-w-0 space-y-1 rounded-lg border px-3 py-2.5 text-[11px]" style={{ borderColor: ACCENT, background: `color-mix(in oklab, ${ACCENT} 8%, transparent)` }}>
      <div className="flex min-w-0 items-center gap-2 font-medium text-foreground"><Check className="size-3.5 shrink-0" style={{ color: ACCENT }} aria-hidden="true" /><span className="min-w-0 break-all">{result.created ? "新仓库已创建并推送" : "代码已提交并推送"}</span></div>
      {urls.repoUrl && <SafeExternalLink href={urls.repoUrl} className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-md text-muted-foreground underline-offset-2 hover:underline"><ExternalLink className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">在 GitHub 查看仓库</span></SafeExternalLink>}
      {urls.pagesUrl && pagesReady && <SafeExternalLink href={urls.pagesUrl} className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-md underline-offset-2 hover:underline" style={{ color: ACCENT }}><Rocket className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">打开网页</span></SafeExternalLink>}
      {urls.pagesUrl && result.pagesStatus === "pending" && <p className="text-muted-foreground">Pages 仍在部署</p>}
      {result.pagesStatus === "failed" && <p role="alert" className="text-destructive">Pages 上线失败：{result.pagesError}</p>}
      {result.message && <p className="break-all italic text-muted-foreground/60">{result.message}</p>}
    </div>
  )
}

function ResultCard({ result }: { result: ApplyResult }) {
  const urls = safeResultUrls(result)
  return result.mode === "workspace_pr"
    ? <WorkspaceResultCard result={result} urls={urls} />
    : <DirectPushResultCard result={result} urls={urls} />
}
