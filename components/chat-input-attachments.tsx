"use client"

import Image from "next/image"
import { FileText, Loader2, X } from "lucide-react"
import type { AttachedFile } from "@/lib/file-extract"

export function AttachmentPreview({ images, files, fileLoading, fileError, onRemoveImage, onRemoveFile }: {
  images: string[]
  files: AttachedFile[]
  fileLoading: boolean
  fileError: string
  onRemoveImage: (index: number) => void
  onRemoveFile: (index: number) => void
}) {
  return (
    <>
      {images.length > 0 && <div className="mb-2 flex flex-wrap gap-2 px-1">{images.map((image, index) => <div key={index} className="relative"><Image src={image} alt="" width={64} height={64} unoptimized className="size-16 rounded-xl border border-border/50 object-cover" /><button onClick={() => onRemoveImage(index)} aria-label="移除图片" className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow"><X className="size-3" /></button></div>)}</div>}
      {(files.length > 0 || fileLoading) && <div className="mb-2 flex flex-wrap gap-2 px-1">{files.map((file, index) => <div key={index} className="flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/50 px-2.5 py-1.5"><FileText className="size-3.5 shrink-0 text-muted-foreground" /><span className="max-w-[140px] truncate text-xs text-muted-foreground">{file.name}</span><button onClick={() => onRemoveFile(index)} aria-label="移除文件" className="rounded-full p-0.5 hover:bg-muted"><X className="size-3 text-muted-foreground" /></button></div>)}{fileLoading && <div className="flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/50 px-2.5 py-1.5"><Loader2 className="size-3.5 animate-spin text-muted-foreground" /><span className="text-xs text-muted-foreground">解析中……</span></div>}</div>}
      {fileError && <p className="mb-2 px-2 text-xs text-destructive">{fileError}</p>}
    </>
  )
}
