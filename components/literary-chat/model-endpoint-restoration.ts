import type { ModelEndpointSummary } from "@/lib/model-endpoints"

type ModelEndpointRestorationOptions = {
  fetchEndpoints: () => Promise<ModelEndpointSummary[]>
  restore: (endpoints: ModelEndpointSummary[]) => void
  isCancelled: () => boolean
}

/** Restore the selected model as soon as endpoint metadata is available. */
export function restoreModelEndpointsWhenAvailable({
  fetchEndpoints,
  restore,
  isCancelled,
}: ModelEndpointRestorationOptions) {
  void fetchEndpoints()
    .catch(() => [])
    .then(endpoints => {
      if (!isCancelled()) restore(endpoints)
    })
}
