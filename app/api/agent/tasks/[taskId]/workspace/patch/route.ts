import { legacyWorkspaceMutationDisabled } from '@/lib/agent/legacy-workspace-route'
export async function POST() { return legacyWorkspaceMutationDisabled() }
