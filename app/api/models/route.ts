import { getOpenRouterCatalog } from '@/lib/openrouter-catalog'

export async function GET() {
  try {
    const models = await getOpenRouterCatalog()
    return Response.json({
      schemaVersion: 1,
      configured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
      models,
    }, {
      headers: {
        'Cache-Control': 'private, max-age=60, stale-while-revalidate=240',
      },
    })
  } catch (error) {
    return Response.json({
      schemaVersion: 1,
      configured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
      models: [],
      error: error instanceof Error ? error.message : '模型目录暂时不可用',
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '10' },
    })
  }
}
