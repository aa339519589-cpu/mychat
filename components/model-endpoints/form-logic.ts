import {
  modelOutputKind,
  type DiscoveredModel,
  type ModelOutputKind,
} from "@/lib/model-endpoints"

export type EndpointFormPhase = "idle" | "discovering" | "testing" | "error" | "success"

export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function outputKindLabel(outputKind: ModelOutputKind): string {
  if (outputKind === "image") return "图片"
  if (outputKind === "video") return "视频"
  return "对话"
}

export function selectDiscoveredModel(models: DiscoveredModel[], currentModel: string): string {
  return models.find(model => model.id === currentModel)?.id
    ?? models.find(model => model.chatCompatible)?.id
    ?? models[0]?.id
    ?? ""
}

export function discoverySummary(models: DiscoveredModel[]): string {
  const chatCount = models.filter(model => model.chatCompatible).length
  const imageCount = models.filter(model => modelOutputKind(model.id) === "image").length
  const videoCount = models.filter(model => modelOutputKind(model.id) === "video").length
  return `已获取 ${models.length} 个模型。名称建议：${chatCount} 个对话、${imageCount} 个图片、${videoCount} 个视频`
}

export function discoveredModelLabel(model: DiscoveredModel): string {
  const identity = model.displayName !== model.id ? `${model.displayName} · ${model.id}` : model.displayName
  const kind = modelOutputKind(model.id)
  if (kind === "image") return `${identity} · 建议：图片`
  if (kind === "video") return `${identity} · 建议：视频`
  return `${identity} · 建议：对话${model.chatCompatible ? "" : "（需确认）"}`
}

export function savedEndpointNotice(outputKind: ModelOutputKind): string {
  if (outputKind === "chat") return "对话模型已通过生成验证并连接。"
  return `${outputKindLabel(outputKind)}模型配置已保存；生成接口将在首次生成时验证，可能产生服务商费用。`
}
