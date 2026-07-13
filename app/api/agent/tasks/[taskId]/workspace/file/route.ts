import { legacyWorkspaceMutationDisabled } from '@/lib/agent/legacy-workspace-route'
export async function POST() { return legacyWorkspaceMutationDisabled() }
export async function PATCH() { return legacyWorkspaceMutationDisabled() }
export async function DELETE() { return legacyWorkspaceMutationDisabled() }
