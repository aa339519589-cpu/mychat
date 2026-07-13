import assert from "node:assert/strict"
import test from "node:test"
import type { DiscoveredModel } from "../lib/model-endpoints"
import {
  discoveredModelLabel,
  discoverySummary,
  endpointHost,
  outputKindLabel,
  savedEndpointNotice,
  selectDiscoveredModel,
} from "../components/model-endpoints/form-logic"

const models: DiscoveredModel[] = [
  { id: "image-gen-v1", displayName: "Image Gen", chatCompatible: false },
  { id: "chat-v1", displayName: "chat-v1", chatCompatible: true },
  { id: "video-gen-v1", displayName: "Video Gen", chatCompatible: false },
]

test("model discovery preserves the current model and otherwise prefers chat", () => {
  assert.equal(selectDiscoveredModel(models, "video-gen-v1"), "video-gen-v1")
  assert.equal(selectDiscoveredModel(models, "missing"), "chat-v1")
  assert.equal(selectDiscoveredModel(models.filter(model => !model.chatCompatible), "missing"), "image-gen-v1")
  assert.equal(selectDiscoveredModel([], "missing"), "")
})

test("model discovery summaries and labels retain endpoint guidance", () => {
  assert.equal(discoverySummary(models), "已获取 3 个模型。名称建议：1 个对话、1 个图片、1 个视频")
  assert.equal(discoveredModelLabel(models[0]), "Image Gen · image-gen-v1 · 建议：图片")
  assert.equal(discoveredModelLabel(models[1]), "chat-v1 · 建议：对话")
  assert.equal(discoveredModelLabel({ id: "custom", displayName: "custom", chatCompatible: false }), "custom · 建议：对话（需确认）")
})

test("endpoint display helpers keep host and deferred-validation warnings exact", () => {
  assert.equal(endpointHost("https://api.example.com:8443/v1"), "api.example.com:8443")
  assert.equal(endpointHost("not a url"), "not a url")
  assert.equal(outputKindLabel("video"), "视频")
  assert.equal(savedEndpointNotice("chat"), "对话模型已通过生成验证并连接。")
  assert.equal(savedEndpointNotice("image"), "图片模型配置已保存；生成接口将在首次生成时验证，可能产生服务商费用。")
})
