import { apiErrorResponseV1 } from './errors'
import { jobMaintenanceMode } from '../jobs/maintenance'

/** Reject new expensive commands while existing workers drain safely. */
export function expensiveWriteMaintenanceResponse(request: Request): Response | null {
  if (jobMaintenanceMode() !== 'drain') return null
  return apiErrorResponseV1(request, {
    status: 503,
    code: 'MAINTENANCE_MODE',
    message: '系统正在安全维护，暂不接受新的生成或发布任务',
    retryable: true,
    headers: { 'Retry-After': '30' },
  })
}
