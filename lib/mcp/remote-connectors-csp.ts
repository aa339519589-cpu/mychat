import { isRecord } from './remote-connectors-shared'

function validCspHostname(hostname: string): boolean {
  if (!hostname.includes('*')) return true
  if (!/^\*\.[a-z0-9.-]+$/i.test(hostname)) return false
  return hostname.slice(2).split('.').every(part =>
    Boolean(part) && !part.startsWith('-') && !part.endsWith('-'))
}

function safeCspOrigin(item: unknown, field: 'connect' | 'resource'): string | null {
  if (typeof item !== 'string' || item.length > 512) return null
  const candidate = item.trim()
  if (!candidate || /[\u0000-\u0020\u007f'";]/.test(candidate)) return null
  let parsed: URL
  try { parsed = new URL(candidate) } catch { return null }
  const allowedProtocols = field === 'connect' ? ['https:', 'wss:'] : ['https:']
  if (!allowedProtocols.includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || !validCspHostname(parsed.hostname)) return null
  return `${parsed.protocol}//${parsed.host}`
}

function safeCspDomains(value: unknown, field: 'connect' | 'resource'): string[] {
  if (!Array.isArray(value)) return []
  const origins = value.slice(0, 32).map(item => safeCspOrigin(item, field))
  return [...new Set(origins.filter((origin): origin is string => origin !== null))]
}

export function uiResourceMetadata(value: unknown) {
  const root = isRecord(value) ? value : {}
  const ui = isRecord(root.ui) ? root.ui : {}
  const csp = isRecord(ui.csp) ? ui.csp : {}
  return {
    connectDomains: safeCspDomains(csp.connectDomains, 'connect'),
    resourceDomains: safeCspDomains(csp.resourceDomains, 'resource'),
    frameDomains: safeCspDomains(csp.frameDomains, 'resource'),
    baseUriDomains: safeCspDomains(csp.baseUriDomains, 'resource'),
    ...(typeof ui.prefersBorder === 'boolean' ? { prefersBorder: ui.prefersBorder } : {}),
  }
}
