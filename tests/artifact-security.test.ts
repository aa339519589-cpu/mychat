import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  artifactContentSecurityPolicy,
  createArtifactToken,
  parseArtifactFrameMessage,
  sanitizeArtifactHtml,
} from '../lib/artifact-security'

test('artifact security tokens are random CSP-compatible capabilities', () => {
  const tokens = new Set(Array.from({ length: 32 }, () => createArtifactToken()))
  assert.equal(tokens.size, 32)
  for (const token of tokens) assert.match(token, /^[a-f0-9]{48}$/)
  assert.throws(() => artifactContentSecurityPolicy('predictable'), /Invalid artifact security token/)
})

test('artifact CSP permits only nonce bootstrap code and local inert resources', () => {
  const token = 'a'.repeat(48)
  const policy = artifactContentSecurityPolicy(token)
  for (const directive of [
    "default-src 'none'",
    `script-src 'nonce-${token}'`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) assert.ok(policy.includes(directive), directive)
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/)
  assert.doesNotMatch(policy, /https?:|wss?:/)
})

test('artifact HTML sanitizer strips execution, navigation, forms, and remote resources', () => {
  const clean = sanitizeArtifactHtml(`<style>#report{color:red}</style>
    <main id="report"><h1 onclick="alert(1)">Safe title</h1>
    <img src="https://evil.test/pixel" onerror="alert(1)">
    <img src="data:image/png;base64,AAAA">
    <a href="https://evil.test/leave">leave</a><a href="#section">local</a>
    <form action="https://evil.test/post"><input name="secret"></form>
    <iframe srcdoc="<script>alert(1)</script>"></iframe>
    <meta http-equiv="refresh" content="0;url=https://evil.test">
    <script>fetch('https://evil.test')</script>
    <p style="color:red;background:url(https://evil.test/x)">Styled</p>
  </main>`)

  assert.match(clean, /Safe title/)
  assert.match(clean, /<style>#report\{color:red\}<\/style>/)
  assert.match(clean, /id="report"/)
  assert.match(clean, /src="data:image\/png;base64,AAAA"/)
  assert.match(clean, /href="#section"/)
  assert.doesNotMatch(clean, /script|iframe|<form|<meta|onclick|onerror|srcdoc/i)
  assert.doesNotMatch(clean, /https:\/\/evil\.test|style=/)
})

test('artifact frame protocol accepts only bounded frame messages', () => {
  assert.deepEqual(parseArtifactFrameMessage({ type: 'ready' }), { type: 'ready' })
  assert.deepEqual(parseArtifactFrameMessage({ type: 'height', value: 512 }), {
    type: 'height', value: 512,
  })
  for (const invalid of [
    null,
    { type: 'height', value: Number.NaN },
    { type: 'height', value: -1 },
    { type: 'height', value: 10_001 },
    { type: 'preview', html: '<p>forged</p>' },
  ]) assert.equal(parseArtifactFrameMessage(invalid), null)
})

test('artifact frame uses a transferable channel and never replaces the controlled document', () => {
  const frame = readFileSync(new URL('../components/artifact-frame.tsx', import.meta.url), 'utf8')
  const mermaid = readFileSync(new URL('../components/mermaid-chart.tsx', import.meta.url), 'utf8')

  assert.match(frame, /new MessageChannel\(\)/)
  assert.match(frame, /message\.token!==TOKEN/)
  assert.match(frame, /event\.source!==parent/)
  assert.match(frame, /event\.ports\.length!==1/)
  assert.match(frame, /portRef\.current\?\.postMessage/)
  assert.match(frame, /sandbox="allow-scripts"/)
  assert.match(frame, /referrerPolicy="no-referrer"/)
  assert.doesNotMatch(frame, /document\.write|document\.open/)
  assert.doesNotMatch(frame, /parent\.postMessage/)
  assert.match(mermaid, /securityLevel:\s*"strict"/)
})
