import assert from 'node:assert/strict'
import test from 'node:test'
import { hasScannedPdfAttachment } from '../lib/chat/attachments'
import {
  historyRetrievalModeForTier,
  latestUserPrompt,
  latestUserSourceImages,
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
  assert.equal(resolveReasoningEffort({ isDeepTierProxy: false, modelId: 'deepseek' }), null)
  assert.equal(resolveReasoningEffort({ isDeepTierProxy: false, modelId: 'grok-4.5', configuredEffort: 'medium' }), 'medium')
  assert.equal(resolveReasoningEffort({ isDeepTierProxy: true, modelId: 'proxy', configuredEffort: 'none' }), 'low')
  assert.equal(historyRetrievalModeForTier('鸿篇'), 'deep')
  assert.equal(historyRetrievalModeForTier('绝句'), 'light')
  assert.equal(historyRetrievalModeForTier('正构'), 'balanced')
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
