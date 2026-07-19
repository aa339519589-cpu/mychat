export type HealthTab = "today" | "trends" | "plan" | "records"

export type HealthTone = "positive" | "neutral" | "attention"

export type HealthMetric = {
  id: string
  label: string
  value: string
  unit: string
  delta: string
  detail: string
  tone: HealthTone
}

export type HealthPlanItem = {
  id: string
  time: string
  title: string
  detail: string
  kind: "movement" | "recovery" | "sleep"
  done: boolean
}

export type HealthMessage = {
  id: string
  role: "assistant" | "user"
  content: string
}

// UI fixture only. A HealthKit sync service will replace these values once the
// native companion is available; keeping the shape stable lets the workspace
// ship before that platform-specific bridge exists.
export const healthMetrics: HealthMetric[] = [
  {
    id: "sleep",
    label: "睡眠",
    value: "6 小时 14 分",
    unit: "昨晚",
    delta: "比基线少 52 分钟",
    detail: "个人 30 天基线：7 小时 06 分",
    tone: "attention",
  },
  {
    id: "resting-heart-rate",
    label: "静息心率",
    value: "67",
    unit: "BPM",
    delta: "比基线高 6",
    detail: "个人 30 天基线：61 BPM",
    tone: "attention",
  },
  {
    id: "hrv",
    label: "心率变异性",
    value: "32",
    unit: "毫秒",
    delta: "比基线低 18%",
    detail: "个人 30 天基线：39 毫秒",
    tone: "attention",
  },
  {
    id: "activity",
    label: "今日活动",
    value: "2,840",
    unit: "步",
    delta: "距离目标还差 4,160 步",
    detail: "今日目标：7,000 步",
    tone: "positive",
  },
]

export const sleepTrend = [68, 74, 71, 79, 63, 77, 62]

export const recoveryTrend = [58, 64, 61, 72, 55, 68, 49]

export const healthPlan: HealthPlanItem[] = [
  {
    id: "walk",
    time: "10:30",
    title: "走动 12 分钟",
    detail: "把久坐切成一小段轻松的活动，不追求强度。",
    kind: "movement",
    done: false,
  },
  {
    id: "pause",
    time: "14:00",
    title: "做一次能量签到",
    detail: "告诉管家你的精力和压力，下午计划会随之调整。",
    kind: "recovery",
    done: false,
  },
  {
    id: "wind-down",
    time: "22:40",
    title: "开始睡眠准备",
    detail: "比过去一周平均提前 40 分钟，给恢复留出空间。",
    kind: "sleep",
    done: false,
  },
]

export const initialHealthMessages: HealthMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content: "我会把今天的建议建立在你的个人基线上。你可以告诉我今天的精力、压力或身体感受，我会一起调整计划。",
  },
]
