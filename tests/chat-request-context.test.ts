import assert from 'node:assert/strict'
import test from 'node:test'
import { hasScannedPdfAttachment } from '../lib/chat/attachments'
import {
  DEEP_RESEARCH_PREFIX,
  historyRetrievalModeForTier,
  latestUserPrompt,
  latestUserSourceImages,
  prependDeepResearchInstruction,
  resolveReasoningEffort,
} from '../lib/chat/request-context'
import type { RawMsg } from '../lib/llm/types'

test('latestUserPrompt reads multimodal text and falls back past empty user turns', () => {
  const messages: RawMsg[] = [
    { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
  ]
  assert.equal(latestUserPrompt(messages), 'first\nsecond')
})

test('latestUserSourceImages accepts safe images from the latest user turn only', () => {
  const messages: RawMsg[] = [
    { role: 'user', content: 'old', images: ['https://example.com/old.png'] },
    { role: 'assistant', content: 'answer' },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'https://example.com/content.png' } },
        { type: 'image_url', image_url: { url: 'http://unsafe.example/image.png' } },
      ],
      images: [' data:image/png;base64,AAAA ', 'ftp://example.com/no.png'],
    },
  ]
  assert.deepEqual(latestUserSourceImages(messages), [
    'data:image/png;base64,AAAA',
    'https://example.com/content.png',
  ])
})

test('reasoning effort and history modes encode product policy', () => {
  assert.equal(resolveReasoningEffort({ isDeepTierProxy: false, deepResearch: false, modelId: 'deepseek' }), null)
  assert.equal(resolveReasoningEffort({ isDeepTierProxy: false, deepResearch: false, modelId: 'grok-4.5', configuredEffort: 'medium' }), 'medium')
  assert.equal(resolveReasoningEffort({ isDeepTierProxy: true, deepResearch: false, modelId: 'proxy', configuredEffort: 'none' }), 'low')
  assert.equal(resolveReasoningEffort({ isDeepTierProxy: true, deepResearch: true, modelId: 'proxy', configuredEffort: 'low' }), 'high')
  assert.equal(historyRetrievalModeForTier('鸿篇'), 'deep')
  assert.equal(historyRetrievalModeForTier('绝句'), 'light')
  assert.equal(historyRetrievalModeForTier('正构'), 'balanced')
})

test('deep research prefix is added to the latest user model message', () => {
  const messages = [
    { role: 'user', content: 'older' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: [{ type: 'text', text: 'current' }] },
  ]
  prependDeepResearchInstruction(messages)
  assert.equal(messages[0].content, 'older')
  const latestContent = messages[2].content
  assert.ok(Array.isArray(latestContent))
  assert.equal(latestContent[0]?.text, DEEP_RESEARCH_PREFIX + 'current')
})

test('scanned attachment detection is independent from OCR transport', () => {
  assert.equal(hasScannedPdfAttachment(undefined), false)
  assert.equal(hasScannedPdfAttachment([{
    name: 'plain.pdf',
    dataUrl: '',
    isPdf: true,
    text: 'selectable',
  }]), false)
  assert.equal(hasScannedPdfAttachment([{
    name: 'scan.pdf',
    dataUrl: '',
    isPdf: true,
    pageImages: ['data:image/png;base64,AAAA'],
  }]), true)
})
