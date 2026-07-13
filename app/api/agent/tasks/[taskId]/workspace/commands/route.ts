import { localWorkspaceReadDisabled } from '@/lib/agent/legacy-workspace-route'
export async function GET() { return localWorkspaceReadDisabled() }
