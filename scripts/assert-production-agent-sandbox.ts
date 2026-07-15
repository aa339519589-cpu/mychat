import { assertProductionAgentSandbox } from '../lib/agent/execution-policy'
import { assertProductionMetricsBearerToken } from '../lib/observability/metrics-auth'

assertProductionAgentSandbox()
assertProductionMetricsBearerToken()
