"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, BookOpen, CalendarDays, Menu, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import type { DailyArticle, DailyBriefResponse } from "@/lib/article-data"

type ArticleHubProps = {
  userName: string
  onClose: () => void
  onOpenSidebar: () => void
  mobile: boolean
}

const EDITORIAL_COVERS = [
  "/article-covers/forest-study.webp",
  "/article-covers/gentle-technology.webp",
  "/article-covers/observatory.webp",
  "/article-covers/lake-walk.webp",
  "/article-covers/night-desk.webp",
  "/article-covers/blank-canvas.webp",
  "/article-covers/sleep-sanctuary.webp",
  "/article-covers/learning-path.webp",
  "/article-covers/craft-table.webp",
  "/article-covers/morning-kitchen.webp",
]

function greeting(date = new Date()) {
  const hour = date.getHours()
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

function displayDate(value: string) {
  const date = new Date(`${value}T12:00:00`)
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date)
}

export function ArticleHub({ userName, onClose, onOpenSidebar, mobile }: ArticleHubProps) {
  const [brief, setBrief] = useState<DailyBriefResponse | null>(null)
  const [selected, setSelected] = useState<DailyArticle | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/articles", { cache: "no-store" })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || "Your daily brief could not be loaded.")
      setBrief(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your daily brief could not be loaded.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  if (selected) return <ArticleReader article={selected} onBack={() => setSelected(null)} />

  return (
    <main className="article-shell relative min-w-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto min-h-full w-full max-w-[76rem] px-5 pb-16 pt-[max(1rem,env(safe-area-inset-top))] sm:px-8 lg:px-12">
        <header className="flex items-start gap-4 border-b border-border/70 pb-7 pt-1 sm:pb-9">
          <button
            onClick={mobile ? onOpenSidebar : onClose}
            aria-label={mobile ? "Open navigation" : "Return to chat"}
            title={mobile ? "Open navigation" : "Return to chat"}
            className="mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {mobile ? <Menu className="size-5" /> : <ArrowLeft className="size-5" />}
          </button>
          <div className="min-w-0 flex-1">
            <p className="article-kicker mb-2 text-[11px] font-semibold uppercase text-primary">My Chat Journal</p>
            <h1 className="article-display break-words text-4xl font-medium leading-[1.05] sm:text-[3.25rem]">
              {greeting()}, {userName}
            </h1>
          </div>
        </header>

        <section className="flex flex-col gap-3 py-7 sm:flex-row sm:items-end sm:justify-between sm:py-9" aria-labelledby="daily-brief-title">
          <div>
            <div className="mb-3 flex items-center gap-2 text-muted-foreground">
              <CalendarDays className="size-4 text-primary" />
              <time className="text-xs font-medium" dateTime={brief?.date}>{brief ? displayDate(brief.date) : displayDate(new Date().toISOString().slice(0, 10))}</time>
            </div>
            <h2 id="daily-brief-title" className="article-display text-3xl font-semibold sm:text-4xl">Your Daily Brief</h2>
          </div>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">Three considered reads, selected around the questions and ideas shaping your days.</p>
        </section>

        {loading ? <ArticleLoading /> : error ? <ArticleError message={error} onRetry={load} /> : (
          <div className="article-grid grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-12 lg:gap-5">
            {brief?.articles.map((article, index) => (
              <ArticleCard key={article.id} article={article} index={index} onOpen={() => setSelected(article)} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

function ArticleCard({ article, index, onOpen }: { article: DailyArticle; index: number; onOpen: () => void }) {
  const layout = index === 0
    ? "lg:col-span-7 lg:row-span-2"
    : index === 1 ? "lg:col-span-5" : "lg:col-span-5"
  return (
    <button
      onClick={onOpen}
      className={cn("group relative min-h-[22rem] overflow-hidden rounded-lg border border-border/70 bg-card text-left focus-visible:ring-2 focus-visible:ring-primary lg:min-h-[18rem]", layout, index === 0 && "lg:min-h-[37rem]")}
      aria-label={`Read ${article.title}`}
    >
      <ArticleCover article={article} />
      <span className="absolute inset-0 bg-[linear-gradient(to_top,rgba(12,12,11,.9)_0%,rgba(12,12,11,.16)_65%,rgba(12,12,11,.04)_100%)]" />
      <span className="absolute inset-x-0 bottom-0 block p-5 text-white sm:p-7">
        <span className="article-kicker mb-3 block text-[10px] font-semibold uppercase text-white/70">{article.category} · {article.readMinutes} min read</span>
        <span className={cn("article-display block text-[1.9rem] font-semibold leading-[1.06]", index === 0 && "sm:text-[2.8rem]")}>{article.title}</span>
        <span className="mt-3 line-clamp-2 block max-w-xl text-sm leading-6 text-white/75 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">{article.dek}</span>
      </span>
    </button>
  )
}

function ArticleCover({ article, className }: { article: DailyArticle; className?: string }) {
  const dayIndex = Number(article.briefDate.replace(/-/g, "")) || 0
  const coverUrl = article.coverImageUrl || EDITORIAL_COVERS[(dayIndex + article.position * 3 + article.coverVariant) % EDITORIAL_COVERS.length]
  const style = { backgroundImage: `url(${coverUrl})` }
  return (
    <div className={cn("article-cover absolute inset-0 bg-cover bg-center transition-transform duration-700 group-hover:scale-[1.025]", `article-cover-${article.coverVariant}`, className)} style={style} aria-hidden="true" />
  )
}

function ArticleReader({ article, onBack }: { article: DailyArticle; onBack: () => void }) {
  const paragraphs = useMemo(() => article.body.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean), [article.body])
  return (
    <article className="article-shell min-w-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="relative h-[48vh] min-h-[23rem] max-h-[42rem] overflow-hidden">
        <ArticleCover article={article} />
        <div className="absolute inset-0 bg-[linear-gradient(to_top,rgba(14,14,13,.92),rgba(14,14,13,.05)_75%)]" />
        <button onClick={onBack} className="absolute left-5 top-[max(1rem,env(safe-area-inset-top))] z-10 inline-flex size-11 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-md transition-colors hover:bg-black/55" aria-label="Back to daily brief" title="Back to daily brief">
          <ArrowLeft className="size-5" />
        </button>
        <header className="absolute inset-x-0 bottom-0 z-10 mx-auto w-full max-w-[58rem] px-5 pb-8 text-white sm:px-8 sm:pb-11">
          <p className="article-kicker mb-3 text-[10px] font-semibold uppercase text-white/70">{article.category} · {article.readMinutes} min read</p>
          <h1 className="article-display text-[2.4rem] font-semibold leading-[1.03] sm:text-[4rem]">{article.title}</h1>
        </header>
      </div>
      <div className="mx-auto max-w-[46rem] px-5 pb-24 pt-10 sm:px-8 sm:pt-14">
        <p className="article-display border-b border-border pb-9 text-2xl leading-[1.35] text-foreground/85 sm:text-[1.8rem]">{article.dek}</p>
        <div className="article-body pt-9 text-[1.08rem] leading-[1.85] text-foreground/90 sm:text-[1.18rem] sm:leading-[1.9]">
          {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
        <footer className="mt-14 flex items-center gap-3 border-t border-border pt-6 text-xs text-muted-foreground"><BookOpen className="size-4" /> End of article</footer>
      </div>
    </article>
  )
}

function ArticleLoading() {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2" role="status" aria-live="polite"><p className="col-span-full py-16 text-center text-sm text-muted-foreground">Preparing today&apos;s reading…</p>{[1, 2, 3].map(item => <div key={item} className="h-72 animate-pulse rounded-lg bg-secondary/70" />)}</div>
}

function ArticleError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="flex min-h-72 flex-col items-center justify-center border-y border-border px-6 text-center"><p className="max-w-lg text-sm leading-6 text-muted-foreground">{message}</p><button onClick={onRetry} className="mt-5 inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm transition-colors hover:bg-secondary"><RefreshCw className="size-4" /> Try again</button></div>
}
