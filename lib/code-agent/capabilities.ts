import { agentExecutionBackend, type AgentExecutionEnvironment } from '@/lib/agent/execution-policy'

export function codeCapabilities(environment: AgentExecutionEnvironment = process.env) {
  const backend = agentExecutionBackend(environment)
  return {
    schemaVersion: 1,
    execution: {
      backend,
      location: backend === 'isolated' ? 'cloud' : backend === 'local' ? 'local_test' : 'unavailable',
      configured: backend !== 'disabled',
      verified: false,
      reason: backend === 'disabled' ? '未配置隔离云执行环境' : '配置已存在；尚未验证当前云环境和 worker 的实际执行',
    },
    modes: ['plan', 'code'],
    planReadOnly: true,
    durableQueue: true,
  }
}
