"use client"

import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Download, Expand, RefreshCw, X } from "lucide-react"
import type { GeneratedMedia as GeneratedMediaType } from "@/lib/generated-media"
import { isPrivateNetworkGeneratedMediaUrl, isSafeGeneratedMediaUrl } from "@/lib/generated-media"
import { cn } from "@/lib/utils"

export type GeneratedMediaProps = {
  media: GeneratedMediaType
  className?: string
  messageId?: string
}

function MediaError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex min-h-28 w-full flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
        <span>{message}</span>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/40"
        >
          <RefreshCw className="size-3.5" />
          重试
        </button>
      )}
    </div>
  )
}

function ImageLightbox({
  url,
  alt,
  assetKey,
  onClose,
}: {
  url: string
  alt: string
  assetKey: string
  onClose: () => void
}) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    console.info("[image-preview] opening", { assetKey, urlKind: url.startsWith("data:") ? "data" : "http", urlLen: url.length })
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [assetKey, onClose, url])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      className="fixed inset-0 z-[100] flex flex-col bg-black/92"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <span className="truncate text-sm text-white/80">{alt}</span>
        <div className="flex items-center gap-1">
          <a
            href={url}
            download
            className="inline-flex size-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="下载图片"
            title="下载"
          >
            <Download className="size-4" />
          </a>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="关闭预览"
          >
            <X className="size-5" />
          </button>
        </div>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-3"
        onClick={onClose}
      >
        {failed ? (
          <MediaError
            message="全屏预览加载失败。请检查图片地址是否仍有效，或返回聊天后重试。"
            onRetry={() => { setFailed(false); setLoaded(false) }}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={alt}
            onClick={e => e.stopPropagation()}
            onLoad={() => {
              setLoaded(true)
              console.info("[image-preview] resolved", { assetKey, loaded: true, urlLen: url.length })
            }}
            onError={event => {
              setFailed(true)
              console.error("[image-preview] load failed", {
                assetKey,
                src: event.currentTarget.currentSrc?.slice(0, 120),
                naturalWidth: event.currentTarget.naturalWidth,
                naturalHeight: event.currentTarget.naturalHeight,
              })
            }}
            className={cn(
              "max-h-[min(92dvh,100%)] max-w-full object-contain transition-opacity",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        )}
      </div>
    </div>
  )
}

export function GeneratedMedia({ media, className, messageId }: GeneratedMediaProps) {
  const [loadFailed, setLoadFailed] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [videoAspectRatio, setVideoAspectRatio] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const url = media.url.trim()
  const safe = isSafeGeneratedMediaUrl(media.type, url)
  const assetKey = `${messageId ?? "msg"}:${media.type}:${url.slice(0, 64)}`
  const alt = media.alt?.trim() || (media.type === "image" ? "模型生成的图片" : "模型生成的视频")

  useEffect(() => {
    setLoadFailed(false)
    setVideoAspectRatio(null)
    console.info("[image-card] rendering", {
      messageId,
      type: media.type,
      safe,
      urlKind: url.startsWith("data:") ? "data" : url.startsWith("http") ? "http" : "other",
      urlLen: url.length,
    })
    const video = videoRef.current
    if (media.type !== "video" || !video) return
    const updateAspectRatio = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoAspectRatio(`${video.videoWidth} / ${video.videoHeight}`)
      }
    }
    updateAspectRatio()
    video.addEventListener("loadedmetadata", updateAspectRatio)
    return () => video.removeEventListener("loadedmetadata", updateAspectRatio)
  }, [media.type, url, messageId, safe, reloadKey])

  if (!safe) {
    return (
      <figure
        className={cn(
          "my-3 w-full min-w-0 max-w-full overflow-hidden rounded-[8px] border border-destructive/30 bg-muted/15",
          className,
        )}
      >
        <MediaError message={isPrivateNetworkGeneratedMediaUrl(url)
          ? "已阻止直接访问本机或内网媒体链接。请让模型服务返回公开 HTTPS 链接或媒体数据。"
          : "无法显示媒体：链接格式不安全或不受支持。"} />
      </figure>
    )
  }

  const failureMessage = media.type === "image"
    ? "图片加载失败，请检查链接是否仍然有效。"
    : "视频加载失败，格式可能不受支持或链接已失效。"

  return (
    <>
      <figure
        className={cn(
          "my-3 w-full min-w-0 max-w-full overflow-hidden rounded-[8px] border border-border/30 bg-muted/15",
          className,
        )}
      >
        {loadFailed ? (
          <MediaError
            message={failureMessage}
            onRetry={() => { setLoadFailed(false); setReloadKey(k => k + 1) }}
          />
        ) : media.type === "image" ? (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            aria-label="放大预览图片"
            className="flex min-h-24 w-full min-w-0 cursor-zoom-in items-center justify-center overflow-hidden bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:bg-black/25"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={reloadKey}
              src={url}
              alt={alt}
              onError={event => {
                setLoadFailed(true)
                console.error("[image] failed to load", {
                  messageId,
                  assetKey,
                  src: event.currentTarget.currentSrc?.slice(0, 120),
                  naturalWidth: event.currentTarget.naturalWidth,
                  naturalHeight: event.currentTarget.naturalHeight,
                })
              }}
              className="block h-auto max-h-[min(72vh,48rem)] w-auto max-w-full object-contain"
            />
          </button>
        ) : (
          <div className="flex min-h-24 w-full min-w-0 max-w-full items-center justify-center overflow-hidden bg-black">
            <video
              key={reloadKey}
              ref={videoRef}
              controls
              playsInline
              preload="metadata"
              onError={() => setLoadFailed(true)}
              aria-label={alt}
              style={{ aspectRatio: videoAspectRatio ?? "16 / 9" }}
              className={cn(
                "block h-auto max-h-[min(72vh,48rem)] max-w-full object-contain",
                videoAspectRatio ? "w-auto" : "w-full",
              )}
            >
              <source
                src={url}
                type={media.mimeType?.startsWith("video/") ? media.mimeType : undefined}
              />
            </video>
          </div>
        )}
        <div className="flex h-10 items-center justify-end gap-1 border-t border-border/30 px-2">
          {media.type === "image" && (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              aria-label="全屏预览图片"
              title="全屏预览"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Expand aria-hidden="true" className="size-4" />
            </button>
          )}
          <a
            href={url}
            download
            aria-label={`下载${media.type === "image" ? "图片" : "视频"}`}
            title="下载"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download aria-hidden="true" className="size-4" />
          </a>
        </div>
      </figure>
      {previewOpen && media.type === "image" && (
        <ImageLightbox
          url={url}
          alt={alt}
          assetKey={assetKey}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  )
}
