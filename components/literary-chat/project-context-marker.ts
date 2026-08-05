import type { ProjectContext } from '@/lib/project-data'

/** The stream reducer only needs to know whether this turn belongs to a
 * project. Full project data is loaded authoritatively by the server. */
export function projectContextMarker(projectId?: string | null): ProjectContext | undefined {
  return projectId ? {
    id: projectId,
    instructions: '',
    files: [],
    projectMemories: [],
  } : undefined
}
