import DOMPurify, { type UponSanitizeAttributeHook } from 'isomorphic-dompurify'

const TOKEN = /^[a-f0-9]{48}$/
const LOCAL_FRAGMENT = /^#[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const LOCAL_PAINT = /^url\(\s*#[A-Za-z][A-Za-z0-9_.:-]{0,127}\s*\)$/i
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i
const URL_ATTRIBUTES = new Set([
  'action', 'background', 'cite', 'data', 'formaction', 'href', 'longdesc',
  'poster', 'src', 'srcset', 'xlink:href',
])
const PAINT_ATTRIBUTES = new Set([
  'clip-path', 'color-profile', 'cursor', 'fill', 'filter', 'marker',
  'marker-end', 'marker-mid', 'marker-start', 'mask', 'stroke',
])

const enforceLocalResources: UponSanitizeAttributeHook = (_node, attribute) => {
  const name = attribute.attrName.toLowerCase()
  const value = attribute.attrValue.trim()
  if (name.startsWith('on') || name === 'srcdoc' || name === 'nonce') {
    attribute.keepAttr = false
    return
  }
  if (name === 'style' && /(?:@import|expression\s*\(|url\s*\(|-moz-binding)/i.test(value)) {
    attribute.keepAttr = false
    return
  }
  if (URL_ATTRIBUTES.has(name)) {
    attribute.keepAttr = (name === 'href' || name === 'xlink:href')
      ? LOCAL_FRAGMENT.test(value)
      : name === 'src' && DATA_IMAGE.test(value)
    return
  }
  if (PAINT_ATTRIBUTES.has(name) && /url\s*\(/i.test(value)) {
    attribute.keepAttr = LOCAL_PAINT.test(value)
  }
}

DOMPurify.addHook('uponSanitizeAttribute', enforceLocalResources)

const ARTIFACT_FORBIDDEN_TAGS = [
  'applet', 'base', 'embed', 'form', 'frame', 'frameset', 'iframe', 'link',
  'meta', 'object', 'script',
]

const SVG_TAGS = [
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline',
  'polygon', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient',
  'stop', 'clipPath', 'mask', 'pattern', 'marker', 'title', 'desc',
]

const SVG_ATTRIBUTES = [
  'xmlns', 'viewBox', 'preserveAspectRatio', 'id', 'class', 'role', 'aria-label',
  'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width',
  'height', 'd', 'points', 'pathLength', 'transform', 'opacity', 'fill',
  'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'vector-effect', 'clip-path', 'clip-rule', 'mask', 'marker-start',
  'marker-mid', 'marker-end', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'offset', 'stop-color', 'stop-opacity', 'patternUnits', 'patternContentUnits',
  'patternTransform', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY',
  'orient', 'font-family', 'font-size', 'font-style', 'font-weight',
  'text-anchor', 'dominant-baseline', 'letter-spacing',
]

export function createArtifactToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function artifactContentSecurityPolicy(token: string): string {
  if (!TOKEN.test(token)) throw new TypeError('Invalid artifact security token')
  return [
    "default-src 'none'",
    `script-src 'nonce-${token}'`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

export function sanitizeArtifactHtml(input: string): string {
  return DOMPurify.sanitize(input, {
    USE_PROFILES: { html: true, svg: true, svgFilters: false, mathMl: false },
    ADD_TAGS: ['style'],
    FORCE_BODY: true,
    FORBID_TAGS: ARTIFACT_FORBIDDEN_TAGS,
    FORBID_ATTR: ['http-equiv', 'integrity'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    SANITIZE_DOM: true,
  })
}

export function sanitizeArtifactSvg(input: string): string {
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: SVG_TAGS,
    ALLOWED_ATTR: SVG_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    SANITIZE_DOM: true,
  })
}

export type ArtifactFrameMessage =
  | { type: 'ready' }
  | { type: 'height'; value: number }

export function parseArtifactFrameMessage(value: unknown): ArtifactFrameMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as { type?: unknown; value?: unknown }
  if (message.type === 'ready') return { type: 'ready' }
  if (message.type === 'height'
    && typeof message.value === 'number'
    && Number.isFinite(message.value)
    && message.value >= 0
    && message.value <= 10_000) {
    return { type: 'height', value: message.value }
  }
  return null
}
