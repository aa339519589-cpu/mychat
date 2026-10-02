import { handleMemoryCollection } from '@/lib/api/memory-management'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(request: Request): Promise<Response> {
  return handleMemoryCollection(request)
}

export function POST(request: Request): Promise<Response> {
  return handleMemoryCollection(request)
}

export function DELETE(request: Request): Promise<Response> {
  return handleMemoryCollection(request)
}
