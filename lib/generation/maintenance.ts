type Environment = Record<string, string | undefined>

export function generationMaintenanceEnabled(environment: Environment = process.env): boolean {
  return environment.GENERATION_MAINTENANCE_MODE?.trim().toLowerCase() === 'true'
}

export function generationMaintenanceResponse(environment: Environment = process.env): Response | null {
  if (!generationMaintenanceEnabled(environment)) return null
  return Response.json(
    { error: '生成服务正在进行安全升级，请稍后重试' },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': '120',
      },
    },
  )
}
