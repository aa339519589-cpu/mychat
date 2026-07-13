import dns from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { ModelEndpointError } from './contracts'
import { normalizeOpenAIBaseUrl } from './policy'

export type ResolvedAddress = { address: string; family: 4 | 6 }
export type ModelEndpointAddressKind = 'public' | 'private' | 'blocked'

const ALWAYS_BLOCKED_ADDRESSES = new BlockList()
ALWAYS_BLOCKED_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4')
ALWAYS_BLOCKED_ADDRESSES.addSubnet('fe80::', 10, 'ipv6')
ALWAYS_BLOCKED_ADDRESSES.addAddress('100.100.100.200', 'ipv4')
ALWAYS_BLOCKED_ADDRESSES.addAddress('168.63.129.16', 'ipv4')
ALWAYS_BLOCKED_ADDRESSES.addAddress('fd00:ec2::254', 'ipv6')

const PRIVATE_ADDRESSES = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['ff00::', 8],
] as const) PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv6')

const WELL_KNOWN_NAT64 = new BlockList()
WELL_KNOWN_NAT64.addSubnet('64:ff9b::', 96, 'ipv6')
const IPV4_COMPATIBLE = new BlockList()
IPV4_COMPATIBLE.addSubnet('::', 96, 'ipv6')
const IPV4_TRANSLATABLE = new BlockList()
IPV4_TRANSLATABLE.addSubnet('::ffff:0:0:0', 96, 'ipv6')
const SIX_TO_FOUR = new BlockList()
SIX_TO_FOUR.addSubnet('2002::', 16, 'ipv6')
const FAIL_CLOSED_TRANSITION = new BlockList()
FAIL_CLOSED_TRANSITION.addSubnet('2001::', 32, 'ipv6')

function expandedIpv6Hextets(rawAddress: string): number[] | null {
  let address = rawAddress.toLowerCase().replace(/^\[|\]$/g, '')
  const lastColon = address.lastIndexOf(':')
  const dottedTail = lastColon >= 0 ? address.slice(lastColon + 1) : ''
  if (dottedTail.includes('.')) {
    const octets = dottedTail.split('.').map(Number)
    if (octets.length !== 4
      || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`
  }

  const halves = address.split('::')
  if (halves.length > 2) return null
  const parseHalf = (half: string): number[] | null => {
    if (!half) return []
    const values = half.split(':').map(part => Number.parseInt(part, 16))
    return values.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)
      ? null
      : values
  }
  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] ?? '')
  if (!left || !right) return null
  if (halves.length === 1) return left.length === 8 ? left : null
  const omitted = 8 - left.length - right.length
  if (omitted < 1) return null
  return [...left, ...new Array(omitted).fill(0), ...right]
}

function embeddedIpv4(address: string, highHextetIndex: number): string | null {
  const hextets = expandedIpv6Hextets(address)
  if (!hextets || hextets.length !== 8) return null
  const high = hextets[highHextetIndex]
  const low = hextets[highHextetIndex + 1]
  if (high === undefined || low === undefined) return null
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}

export function classifyModelEndpointAddress(rawAddress: string): ModelEndpointAddressKind {
  const address = rawAddress.toLowerCase().replace(/^\[|\]$/g, '')
  const version = isIP(address)
  if (!version) return 'blocked'
  const family = version === 4 ? 'ipv4' : 'ipv6'
  if (version === 6) {
    if (FAIL_CLOSED_TRANSITION.check(address, 'ipv6')) return 'blocked'
    const embedded = WELL_KNOWN_NAT64.check(address, 'ipv6')
      || IPV4_COMPATIBLE.check(address, 'ipv6')
      || IPV4_TRANSLATABLE.check(address, 'ipv6')
      ? embeddedIpv4(address, 6)
      : SIX_TO_FOUR.check(address, 'ipv6')
        ? embeddedIpv4(address, 1)
        : null
    if (embedded) return classifyModelEndpointAddress(embedded)
  }
  if (ALWAYS_BLOCKED_ADDRESSES.check(address, family)) return 'blocked'
  return PRIVATE_ADDRESSES.check(address, family) ? 'private' : 'public'
}

function privateEndpointAllowed(url: URL): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  const allowed = (process.env.MODEL_ENDPOINT_PRIVATE_ALLOWLIST ?? '')
    .split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const hostPort = `${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  return allowed.includes(host) || allowed.includes(hostPort)
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

async function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) throw abortReason(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function resolveModelEndpoint(url: URL, signal?: AbortSignal): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const version = isIP(host)
  let addresses: ResolvedAddress[]

  if (version) {
    addresses = [{ address: host, family: version as 4 | 6 }]
  } else {
    try {
      const resolved = await awaitWithAbort(dns.lookup(host, { all: true, verbatim: true }), signal)
      addresses = resolved
        .filter((item): item is ResolvedAddress => item.family === 4 || item.family === 6)
        .filter((item, index, all) =>
          all.findIndex(candidate => candidate.address === item.address) === index)
        .sort((left, right) => left.family - right.family)
    } catch {
      if (signal?.aborted) throw abortReason(signal)
      throw new ModelEndpointError('无法解析服务地址，请检查域名', 'network', 'dns_failed', 502)
    }
  }

  if (!addresses.length) {
    throw new ModelEndpointError('服务地址没有可用 IP', 'network', 'dns_failed', 502)
  }
  const kinds = addresses.map(item => classifyModelEndpointAddress(item.address))
  if (kinds.includes('blocked')) {
    throw new ModelEndpointError('不允许访问链路本地或云元数据地址', 'network', 'blocked_address', 403)
  }
  if (!privateEndpointAllowed(url) && kinds.includes('private')) {
    throw new ModelEndpointError(
      '该地址属于私有网络，生产环境已阻止；请在同一局域网运行 MyChat，或使用受保护的公网 HTTPS 地址',
      'network',
      'private_url',
      403,
    )
  }
  return addresses[0]
}

export function sameAddress(expected: ResolvedAddress, actual: string | undefined): boolean {
  if (!actual) return false
  const actualVersion = isIP(actual)
  if (!actualVersion) return false
  const exact = new BlockList()
  exact.addAddress(expected.address, expected.family === 4 ? 'ipv4' : 'ipv6')
  return exact.check(actual, actualVersion === 4 ? 'ipv4' : 'ipv6')
}

export async function validateModelEndpointNetwork(baseUrl: string): Promise<string> {
  const normalized = normalizeOpenAIBaseUrl(baseUrl)
  await resolveModelEndpoint(new URL(normalized))
  return normalized
}
