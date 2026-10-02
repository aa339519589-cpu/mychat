"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import { ChevronDown, ChevronRight, Globe, Image as ImageIcon, X } from "lucide-react"

import type { SearchImage, SearchNote, SearchResult } from "@/lib/search-notes"
import { MessageMarkdown } from "./markdown-content"
import { SearchResultCard } from "./search-result-card"

export function SearchActivity({ searches }: { searches: SearchNote[] }) {
  const [open, setOpen] = useState(false)
  const results = uniqueResults(searches)
  const imageCount = searches.reduce((count, search) => count + search.images.length, 0)
  if (!results.length && !imageCount) return null
  return (
    <div className="mb-2.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="fluid-press flex min-h-10 items-center gap-1.5 rounded-lg px-1.5 text-xs font-[500] text-muted-foreground/75 transition-colors hover:bg-muted/25 hover:text-muted-foreground md:text-[12px]">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Globe className="size-3.5" />
        <span>{results.length ? `搜索了 ${results.length} 个网页` : "图片搜索"}{imageCount ? ` · 找到 ${imageCount} 张图片` : ""}</span>
      </button>
      {open && <div className="mt-2 grid gap-2 rounded-xl border border-border/30 bg-muted/15 p-2 sm:grid-cols-2">
        {results.map(result => <SearchResultCard key={result.url} result={result} />)}
      </div>}
    </div>
  )
}

export function SearchEnhancedMarkdown({ text, searches }: { text: string; searches: SearchNote[] }) {
  const [openedImage, setOpenedImage] = useState<SearchImage | null>(null)
  const { results, images } = searchContext(searches)
  return (
    <>
      <MessageMarkdown text={text} searchResults={results} searchImages={images} onOpenSearchImage={setOpenedImage} />
      <SearchImageStrip images={[...images.values()]} onOpen={setOpenedImage} />
      <SearchImageLightbox image={openedImage} onClose={() => setOpenedImage(null)} />
    </>
  )
}

function uniqueResults(searches: SearchNote[]): SearchResult[] {
  const unique = new Map<string, SearchResult>()
  for (const search of searches) for (const result of search.results) {
    if (!unique.has(result.url)) unique.set(result.url, result)
  }
  return [...unique.values()]
}

function searchContext(searches: SearchNote[]) {
  const results = new Map<string, SearchResult>()
  const images = new Map<string, SearchImage>()
  for (const search of searches) {
    for (const result of search.results) if (!results.has(result.url)) results.set(result.url, result)
    for (const image of search.images) if (!images.has(image.url)) images.set(image.url, image)
  }
  return { results, images: new Map([...images].slice(0, 12)) }
}

function SearchImageStrip({ images, onOpen }: { images: SearchImage[]; onOpen: (image: SearchImage) => void }) {
  if (!images.length) return null
  return (
    <section className="my-4 min-w-0" aria-label="搜索到的图片">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><ImageIcon className="size-3.5" />相关图片</div>
      <div className="fluid-scroll flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
        {images.map(image => (
          <button key={image.url} type="button" onClick={() => onOpen(image)}
            aria-label={`查看大图：${image.description || "搜索结果图片"}`}
            className="group relative w-[min(72vw,17rem)] shrink-0 snap-start overflow-hidden rounded-xl border border-border/35 bg-muted/20 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <Image src={image.url} alt={image.description || "搜索结果图片"} width={544} height={360} unoptimized className="h-40 w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
            {image.description && <span className="block truncate px-3 py-2 text-xs text-muted-foreground">{image.description}</span>}
          </button>
        ))}
      </div>
    </section>
  )
}

function SearchImageLightbox({ image, onClose }: { image: SearchImage | null; onClose: () => void }) {
  useEffect(() => {
    if (!image) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose() }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [image, onClose])
  if (!image) return null
  return (
    <div role="dialog" aria-modal="true" aria-label="图片大图" onClick={onClose} className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
      <button type="button" aria-label="关闭大图" onClick={onClose} className="fluid-press absolute right-4 top-4 flex size-11 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"><X className="size-5" /></button>
      <figure onClick={event => event.stopPropagation()} className="flex max-h-full max-w-full flex-col items-center gap-3">
        <Image src={image.url} alt={image.description || "搜索结果图片"} width={1800} height={1400} unoptimized className="max-h-[82dvh] max-w-[94vw] rounded-lg object-contain" />
        {image.description && <figcaption className="max-w-[90vw] text-center text-sm text-white/85">{image.description}</figcaption>}
      </figure>
    </div>
  )
}
