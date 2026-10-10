import { agentExecutionBackend, type AgentExecutionEnvironment } from '@/lib/agent/execution-policy'

export function codeCapabilities(environment: AgentExecutionEnvironment = process.env) {
  const backend = agentExecutionBackend(environment)
  const configured = backend === 'isolated'
  return {
    schemaVersion: 1,
    execution: {
      backend: configured ? 'isolated' : 'disabled',
      location: configured ? 'cloud' : 'unavailable',
      configured,
      verified: false,
      reason: configured ? '云执行配置已存在；尚未验证当前沙箱和 worker 的实际执行' : '云端执行不可用：未配置隔离云执行环境',
    },
    durableQueue: true,
  }
}
