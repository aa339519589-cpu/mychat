"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, BookOpen, CalendarDays, Menu, RefreshCw, X } from "lucide-react"
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

const HISTORY_ARTICLE_KEY = "mychatArticleId"

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

  // Browser / iOS swipe back closes article detail without leaving the app shell.
  useEffect(() => {
    const onPopState = () => {
      setSelected(current => (current ? null : current))
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  function openArticle(article: DailyArticle) {
    setSelected(article)
    try {
      const prev = (window.history.state && typeof window.history.state === "object")
        ? window.history.state as Record<string, unknown>
        : {}
      window.history.pushState(
        { ...prev, mychatArticles: true, [HISTORY_ARTICLE_KEY]: article.id },
        "",
        window.location.pathname + window.location.search,
      )
    } catch {
      // history API unavailable — local state still works
    }
  }

  function closeArticle() {
    const state = window.history.state as Record<string, unknown> | null
    if (state && state[HISTORY_ARTICLE_KEY]) {
      window.history.back()
      return
    }
    setSelected(null)
  }

  function exitArticlesModule() {
    setSelected(null)
    try {
      const state = window.history.state as Record<string, unknown> | null
      if (state?.[HISTORY_ARTICLE_KEY] || state?.mychatArticles) {
        window.history.replaceState({}, "", window.location.pathname + window.location.search)
      }
    } catch {
      // ignore
    }
    onClose()
  }

  if (selected) {
    return (
      <ArticleReader
        article={selected}
        mobile={mobile}
        onBack={closeArticle}
        onCloseModule={exitArticlesModule}
        onOpenSidebar={onOpenSidebar}
      />
    )
  }

  return (
    <main className="article-shell relative min-w-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto min-h-full w-full max-w-[76rem] px-5 pb-16 pt-[max(1rem,env(safe-area-inset-top))] sm:px-8 lg:px-12">
        <header className="flex items-start gap-4 border-b border-border/70 pb-7 pt-1 sm:pb-9">
          <button
            type="button"
            onClick={mobile ? onOpenSidebar : onClose}
            aria-label={mobile ? "Open navigation" : "Return to chat"}
            title={mobile ? "Open navigation" : "Return to chat"}
            className="mt-1 inline-flex size-11 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
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
              <ArticleCard key={article.id} article={article} index={index} onOpen={() => openArticle(article)} />
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
      type="button"
      onClick={onOpen}
      className={cn("group relative min-h-[22rem] overflow-hidden rounded-lg border border-border/70 bg-card text-left focus-visible:ring-2 focus-visible:ring-primary lg:min-h-[18rem]", layout, index === 0 && "lg:min-h-[37rem]")}
      aria-label={`Read ${article.title}`}
    >
      <ArticleCover article={article} tone="card" />
      {/* List cards: bottom scrim only — keep most of the photo visible */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[58%] bg-[linear-gradient(to_top,rgba(12,12,11,.72)_0%,rgba(12,12,11,.32)_42%,rgba(12,12,11,.08)_72%,transparent_100%)]"
      />
      <span className="absolute inset-x-0 bottom-0 z-[1] block p-5 text-white sm:p-7">
        <span className="article-kicker mb-3 block text-[10px] font-semibold uppercase text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,.55)]">{article.category} · {article.readMinutes} min read</span>
        <span className={cn("article-display block text-[1.9rem] font-semibold leading-[1.06] [text-shadow:0_2px_10px_rgba(0,0,0,.45)]", index === 0 && "sm:text-[2.8rem]")}>{article.title}</span>
        <span className="mt-3 line-clamp-2 block max-w-xl text-sm leading-6 text-white/90 opacity-100 [text-shadow:0_1px_4px_rgba(0,0,0,.45)] transition-opacity lg:opacity-0 lg:group-hover:opacity-100">{article.dek}</span>
      </span>
    </button>
  )
}

function ArticleCover({
  article,
  className,
  tone = "card",
}: {
  article: DailyArticle
  className?: string
  tone?: "card" | "reader"
}) {
  const dayIndex = Number(article.briefDate.replace(/-/g, "")) || 0
  const coverUrl = article.coverImageUrl || EDITORIAL_COVERS[(dayIndex + article.position * 3 + article.coverVariant) % EDITORIAL_COVERS.length]
  // Reader keeps the photo bright; list is slightly lifted but still natural.
  const filter = tone === "reader"
    ? "brightness(1.12) saturate(1.04) contrast(1.02)"
    : "brightness(1.16) saturate(1.03) contrast(1.0)"
  const style = { backgroundImage: `url(${coverUrl})`, filter }
  return (
    <div
      className={cn(
        "article-cover absolute inset-0 bg-cover bg-center transition-transform duration-700 group-hover:scale-[1.025]",
        tone === "reader" && "article-cover--reader",
        // Keep variant class only as color fallback when image fails; image wins via inline backgroundImage.
        `article-cover-${article.coverVariant}`,
        className,
      )}
      style={style}
      aria-hidden="true"
    />
  )
}

function ArticleReader({
  article,
  mobile,
  onBack,
  onCloseModule,
  onOpenSidebar,
}: {
  article: DailyArticle
  mobile: boolean
  onBack: () => void
  onCloseModule: () => void
  onOpenSidebar: () => void
}) {
  const paragraphs = useMemo(() => article.body.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean), [article.body])

  return (
    <article className="article-shell relative min-w-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="relative h-[48vh] min-h-[23rem] max-h-[42rem] overflow-hidden">
        <ArticleCover article={article} tone="reader" />
        {/* Detail hero: local title scrim only — do not wash the whole photo */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[42%] bg-[linear-gradient(to_top,rgba(10,10,10,.78)_0%,rgba(10,10,10,.38)_48%,rgba(10,10,10,.08)_78%,transparent_100%)]"
        />

        {/* Always-visible top chrome above cover, texture, and scrim */}
        <div className="absolute inset-x-0 top-0 z-40 flex items-center justify-between gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex size-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-white/35 bg-white/92 text-neutral-900 shadow-[0_4px_18px_rgba(0,0,0,.28)] transition-colors hover:bg-white active:scale-[0.98]"
            aria-label="Back to daily brief"
            title="Back to daily brief"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div className="flex items-center gap-2">
            {mobile ? (
              <button
                type="button"
                onClick={onOpenSidebar}
                className="inline-flex size-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-white/35 bg-black/40 text-white shadow-[0_4px_18px_rgba(0,0,0,.28)] backdrop-blur-md transition-colors hover:bg-black/55"
                aria-label="Open navigation"
                title="Open navigation"
              >
                <Menu className="size-5" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onCloseModule}
              className="inline-flex size-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-white/35 bg-black/40 text-white shadow-[0_4px_18px_rgba(0,0,0,.28)] backdrop-blur-md transition-colors hover:bg-black/55"
              aria-label="Exit articles and return to chat"
              title="Exit articles"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <header className="absolute inset-x-0 bottom-0 z-[2] mx-auto w-full max-w-[58rem] px-5 pb-8 text-white sm:px-8 sm:pb-11">
          <p className="article-kicker mb-3 text-[10px] font-semibold uppercase text-white/90 [text-shadow:0_1px_3px_rgba(0,0,0,.65)]">
            {article.category} · {article.readMinutes} min read
          </p>
          <h1 className="article-display text-[2.4rem] font-semibold leading-[1.03] [text-shadow:0_2px_14px_rgba(0,0,0,.5)] sm:text-[4rem]">
            {article.title}
          </h1>
        </header>
      </div>

      <div className="mx-auto max-w-[46rem] px-5 pb-24 pt-10 sm:px-8 sm:pt-14">
        <p className="article-display border-b border-border pb-9 text-2xl leading-[1.35] text-foreground/85 sm:text-[1.8rem]">{article.dek}</p>
        <div className="article-body pt-9 text-[1.08rem] leading-[1.85] text-foreground/90 sm:text-[1.18rem] sm:leading-[1.9]">
          {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
        <footer className="mt-14 flex flex-col gap-4 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-3"><BookOpen className="size-4" /> End of article</span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-secondary"
            >
              Back to list
            </button>
            <button
              type="button"
              onClick={onCloseModule}
              className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-secondary/60 px-4 py-2 text-sm text-foreground transition-colors hover:bg-secondary"
            >
              Back to chat
            </button>
          </div>
        </footer>
      </div>
    </article>
  )
}

function ArticleLoading() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2" role="status" aria-live="polite">
      <p className="col-span-full py-16 text-center text-sm text-muted-foreground">Preparing today&apos;s reading…</p>
      {[1, 2, 3].map(item => <div key={item} className="h-72 animate-pulse rounded-lg bg-secondary/70" />)}
    </div>
  )
}

function ArticleError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center border-y border-border px-6 text-center">
      <p className="max-w-lg text-sm leading-6 text-muted-foreground">{message}</p>
      <button type="button" onClick={onRetry} className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-full border border-border px-4 py-2 text-sm transition-colors hover:bg-secondary">
        <RefreshCw className="size-4" /> Try again
      </button>
    </div>
  )
}
