import Image from "next/image"

import type { SearchResult } from "@/lib/search-notes"

export function SearchResultCard({ result }: { result: SearchResult }) {
  const source = new URL(result.url).hostname.replace(/^www\./, "")
  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="my-2 inline-grid w-full max-w-[38rem] grid-cols-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border/45 bg-card/70 text-left no-underline shadow-sm transition-colors hover:border-border hover:bg-muted/25"
    >
      {result.thumbnail_url && (
        <Image
          src={result.thumbnail_url}
          alt=""
          width={144}
          height={112}
          unoptimized
          className="h-full min-h-20 w-28 object-cover sm:w-36"
        />
      )}
      <span className="flex min-w-0 flex-col justify-center gap-1.5 px-3 py-2.5 sm:px-4">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          {result.favicon_url && (
            <Image src={result.favicon_url} alt="" width={14} height={14} unoptimized className="size-3.5 shrink-0 rounded-sm" />
          )}
          <span className="truncate">{source}</span>
          {result.published_at && <span className="shrink-0">· {result.published_at}</span>}
        </span>
        <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-foreground">
          {result.title || result.url}
        </span>
        {result.snippet && (
          <span className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
            {result.snippet}
          </span>
        )}
      </span>
    </a>
  )
}
