"use client"

import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Download, ExternalLink } from "lucide-react"
import type { GeneratedMedia } from "@/lib/generated-media"
import { isPrivateNetworkGeneratedMediaUrl, isSafeGeneratedMediaUrl } from "@/lib/generated-media"
import { cn } from "@/lib/utils"

export type GeneratedMediaProps = {
  media: GeneratedMedia
  className?: string
}

function MediaError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex min-h-28 w-full items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground"
    >
      <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      <span>{message}</span>
    </div>
  )
}

function MediaActions({ media, url }: { media: GeneratedMedia; url: string }) {
  const label = media.type === "image" ? "图片" : "视频"

  return (
    <div className="flex h-10 items-center justify-end gap-1 border-t border-border/30 px-2">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`在新标签页打开${label}`}
        title={`在新标签页打开${label}`}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExternalLink aria-hidden="true" className="size-4" />
      </a>
      <a
        href={url}
        download
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`下载${label}`}
        title={`下载${label}`}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Download aria-hidden="true" className="size-4" />
      </a>
    </div>
  )
}

export function GeneratedMedia({ media, className }: GeneratedMediaProps) {
  const [loadFailed, setLoadFailed] = useState(false)
  const [videoAspectRatio, setVideoAspectRatio] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const url = media.url.trim()
  const safe = isSafeGeneratedMediaUrl(media.type, url)

  useEffect(() => {
    setLoadFailed(false)
    setVideoAspectRatio(null)
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
  }, [media.type, url])

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
    <figure
      className={cn(
        "my-3 w-full min-w-0 max-w-full overflow-hidden rounded-[8px] border border-border/30 bg-muted/15",
        className,
      )}
    >
      {loadFailed ? (
        <MediaError message={failureMessage} />
      ) : media.type === "image" ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="在新标签页打开图片"
          className="flex min-h-24 w-full min-w-0 items-center justify-center overflow-hidden bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:bg-black/25"
        >
          <img
            src={url}
            alt={media.alt?.trim() || "模型生成的图片"}
            onError={() => setLoadFailed(true)}
            className="block h-auto max-h-[min(72vh,48rem)] w-auto max-w-full object-contain"
          />
        </a>
      ) : (
        <div className="flex min-h-24 w-full min-w-0 max-w-full items-center justify-center overflow-hidden bg-black">
          <video
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            onError={() => setLoadFailed(true)}
            aria-label={media.alt?.trim() || "模型生成的视频"}
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
      <MediaActions media={media} url={url} />
    </figure>
  )
}
