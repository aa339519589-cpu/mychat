import { isAuthSessionMissingError } from '@supabase/supabase-js'

/** Missing cookies are anonymous traffic; every other Auth error is dependency failure. */
export function isAuthDependencyUnavailable(error: unknown): boolean {
  return error != null && !isAuthSessionMissingError(error)
}
