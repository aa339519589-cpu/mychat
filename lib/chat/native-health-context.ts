import { RequestError } from '@/lib/api/request'

export function validatedHealthContext(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > 16_000 || value.includes('\u0000')) {
    throw new RequestError(400, '健康连接器数据格式无效')
  }
  return value.trim() || undefined
}
