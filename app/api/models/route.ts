import { resolveAuth } from '@/lib/api/guard'
import { getOpenRouterCatalog } from '@/lib/openrouter-catalog'
import { createAdminClient } from '@/lib/supabase/admin'

const SHARED_TRIAL_LIMIT = 3

async function resolveTrialRemaining(userId: string | null, owner: boolean): Promise<number | null> {
  if (owner) return null
  if (!userId) return SHARED_TRIAL_LIMIT
  const admin = createAdminClient()
  if (!admin) return null
  const { count, error } = await admin
    .from('medium_model_trial_calls')
    .select('generation_id', { count: 'exact', head: true })
    .eq('principal_id', userId)
  if (error) return null
  return Math.max(0, SHARED_TRIAL_LIMIT - Math.max(0, count ?? 0))
}

export async function GET(request: Request) {
  try {
    const [models, auth] = await Promise.all([
      getOpenRouterCatalog(),
      resolveAuth(request),
    ])
    const owner = auth.isOwner === true
    const trialRemaining = await resolveTrialRemaining(auth.userId, owner)
    return Response.json({
      schemaVersion: 1,
      configured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
      owner,
      trialLimit: SHARED_TRIAL_LIMIT,
      trialRemaining,
      models: models.map(model => {
        const baseModel = model.access === 'quota'
        return {
          ...model,
          ...(model.access === 'premium' && owner ? { ownerUnlocked: true } : {}),
          ...(!baseModel && owner ? { trialUnlimited: true } : {}),
          ...(!baseModel && !owner && trialRemaining !== null
            ? {
                trialLimit: SHARED_TRIAL_LIMIT,
                trialRemaining,
                trialSelectable: trialRemaining > 0,
              }
            : {}),
        }
      }),
    }, {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    return Response.json({
      schemaVersion: 1,
      configured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
      owner: false,
      trialLimit: SHARED_TRIAL_LIMIT,
      trialRemaining: null,
      models: [],
      error: error instanceof Error ? error.message : '模型目录暂时不可用',
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '10' },
    })
  }
}
