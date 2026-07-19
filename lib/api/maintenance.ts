import { apiErrorResponseV1 } from './errors'
import { jobMaintenanceMode } from '../jobs/maintenance'

const CONTINUOUS_CHAT_PATHS = new Set(['/api/chat', '/api/chat/title'])

/**
 * Drain blocks high-risk Agent and publication writes, but must not turn an
 * ordinary application rollout into a chat outage. Chat queues stay serviced
 * by the maintenance Worker pool and can therefore continue accepting turns.
 */
export function expensiveWriteMaintenanceResponse(request: Request): Response | null {
  if (jobMaintenanceMode() !== 'drain' || CONTINUOUS_CHAT_PATHS.has(new URL(request.url).pathname)) {
    return null
  }
  return apiErrorResponseV1(request, {
    status: 503,
    code: 'MAINTENANCE_MODE',
    message: '系统正在安全维护，暂不接受新的 Agent 或发布任务',
    retryable: true,
    headers: { 'Retry-After': '30' },
  })
}
