import { resolveAuth } from '@/lib/api/guard'
import { getOpenRouterCatalog } from '@/lib/openrouter-catalog'

export async function GET(request: Request) {
  try {
    const [models, auth] = await Promise.all([
      getOpenRouterCatalog(),
      resolveAuth(request),
    ])
    const owner = auth.isOwner === true
    return Response.json({
      schemaVersion: 1,
      configured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
      owner,
      models: models.map(model => owner && model.access === 'premium'
        ? { ...model, ownerUnlocked: true }
        : model),
    }, {
      headers: {
        'Cache-Control': 'private, max-age=60, stale-while-revalidate=240',
      },
    })
  } catch (error) {
    return Response.json({
      schemaVersion: 1,
      configured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
      owner: false,
      models: [],
      error: error instanceof Error ? error.message : '模型目录暂时不可用',
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '10' },
    })
  }
}
