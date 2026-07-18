"use client"

import { useEffect, useRef, useState } from "react"
import { errorMessage } from "@/lib/unknown-value"
import { prepareFile, type AttachedFile } from "@/lib/file-extract"
import type { Tier } from "@/lib/chat-data"

type AttachmentStateOptions = { setPlusOpen: (open: boolean) => void }

function useAttachmentState({ setPlusOpen }: AttachmentStateOptions) {
  const [images, setImages] = useState<string[]>([])
  const [files, setFiles] = useState<AttachedFile[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState("")

  function addImageFile(file: File) {
    const reader = new FileReader()
    reader.onload = event => { const result = event.target?.result as string; if (result) setImages(previous => [...previous, result]) }
    reader.readAsDataURL(file)
  }

  async function handleAddFiles(fileList: FileList | null) {
    if (!fileList?.length) return
    setPlusOpen(false)
    setFileError("")
    const selected = Array.from(fileList)
    selected.filter(file => file.type.startsWith("image/")).forEach(addImageFile)
    const documents = selected.filter(file => !file.type.startsWith("image/"))
    if (!documents.length) return
    setFileLoading(true)
    try {
      for (const file of documents) {
        try { const prepared = await prepareFile(file); setFiles(previous => [...previous, prepared]) }
        catch (error) { setFileError(errorMessage(error, "文件解析失败")) }
      }
    } finally { setFileLoading(false) }
  }

  return { images, setImages, files, setFiles, fileLoading, fileError, setFileError, handleAddFiles }
}

export function useComposerState({ activeTier, onTierChange, onSend, disabled, isLoading, setPlusOpen }: {
  activeTier: string
  onTierChange: (tier: Tier) => void
  onSend: (text: string, images?: string[], files?: AttachedFile[]) => void
  disabled: boolean
  isLoading: boolean
  setPlusOpen: (open: boolean) => void
}) {
  const [value, setValue] = useState("")
  const [sendPending, setSendPending] = useState(false)
  const textAreaRef = useRef<HTMLTextAreaElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const attachments = useAttachmentState({ setPlusOpen })
  const { setImages, setFiles, setFileError } = attachments

  useEffect(() => {
    try { localStorage.removeItem("chat_custom_models") } catch {}
    if (!activeTier.startsWith("custom:")) return
    onTierChange("绝句")
    try { localStorage.setItem("chat_active_tier", "绝句") } catch {}
  }, [activeTier, onTierChange])

  useEffect(() => {
    if (!sendPending || !isLoading) return
    setValue(""); setImages([]); setFiles([]); setFileError("")
    if (textAreaRef.current) textAreaRef.current.style.height = "auto"
    setSendPending(false)
  }, [sendPending, isLoading, setFileError, setFiles, setImages])

  useEffect(() => {
    if (!sendPending || isLoading) return
    const timer = window.setTimeout(() => setSendPending(false), 700)
    return () => window.clearTimeout(timer)
  }, [sendPending, isLoading])

  function resize() {
    if (!textAreaRef.current) return
    textAreaRef.current.style.height = "auto"
    textAreaRef.current.style.height = Math.min(textAreaRef.current.scrollHeight, 180) + "px"
  }

  function submit() {
    const text = value.trim()
    if (disabled || sendPending || (!text && !attachments.images.length && !attachments.files.length)) return
    setSendPending(true)
    try { onSend(text, attachments.images.length ? attachments.images : undefined, attachments.files.length ? attachments.files : undefined) }
    catch (error) { setSendPending(false); throw error }
  }

  return { value, setValue, sendPending, textAreaRef, addInputRef, plusMenuRef, resize, submit, ...attachments }
}
