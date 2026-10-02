import { handleMemoryItem } from '@/lib/api/memory-management'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ memoryId: string }> }

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { memoryId } = await context.params
  return handleMemoryItem(request, memoryId)
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { memoryId } = await context.params
  return handleMemoryItem(request, memoryId)
}
