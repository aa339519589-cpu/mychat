export type JobMaintenanceEnvironment = {
  MYCHAT_MAINTENANCE_MODE?: string
  GENERATION_MAINTENANCE_MODE?: string
}

export type JobMaintenanceMode = 'off' | 'drain'

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

/**
 * One maintenance switch covers admission and execution. The legacy
 * GENERATION_MAINTENANCE_MODE flag remains an alias for safe rolling upgrades.
 */
export function jobMaintenanceMode(
  environment: JobMaintenanceEnvironment = {
    MYCHAT_MAINTENANCE_MODE: process.env.MYCHAT_MAINTENANCE_MODE,
    GENERATION_MAINTENANCE_MODE: process.env.GENERATION_MAINTENANCE_MODE,
  },
): JobMaintenanceMode {
  const configured = normalized(environment.MYCHAT_MAINTENANCE_MODE)
  if (configured && !['off', 'false', '0', 'drain', 'true', '1'].includes(configured)) {
    throw new Error('MYCHAT_MAINTENANCE_MODE must be off or drain')
  }
  const legacy = normalized(environment.GENERATION_MAINTENANCE_MODE)
  if (legacy && !['off', 'false', '0', 'drain', 'true', '1'].includes(legacy)) {
    throw new Error('GENERATION_MAINTENANCE_MODE must be false or true')
  }
  return ['drain', 'true', '1'].includes(configured)
    || ['drain', 'true', '1'].includes(legacy)
    ? 'drain'
    : 'off'
}
