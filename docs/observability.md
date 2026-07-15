# Job 可观测性、SLO 与错误预算

`/api/metrics` 是受保护的 Prometheus scrape 端点。请求必须携带
`Authorization: Bearer $METRICS_BEARER_TOKEN`；令牌缺失或不匹配统一返回
`404`，避免暴露监控面的存在。通过认证后，Web 进程调用数据库权威 RPC 读取
Job、Worker fleet、SSE 和生命周期快照。Web 不导出自己的进程本地 Job
counter/histogram，因为它们不能代表独立 Worker。数据库、任一 RPC、返回结构任一不可用时端点返回 `503`，
不会用“看起来健康”的本地数据掩盖控制面故障。

数据库 RPC 只有 `service_role` 可执行。响应中的 `job_type`、`status`、
`objective` 和 `condition` 都是闭集标签；响应和 exporter 均不包含 user、job、
request、provider、URL、object key 等高基数字段。

## 指标语义

数据库权威指标使用 `mychat_authoritative_` 前缀，均为 scrape 时重新计算的
gauge：

- `queue_depth` / `queue_oldest_age_seconds`：当前 `queued` 作业数量和最老年龄。
- `jobs_terminal_window{status=...}`：最近一小时的权威终态数量。
- `jobs_terminal_total{status=...}`：由数据库终态 trigger 维护并从历史作业精确
  backfill 的跨进程单调 counter；scrape 不会全表扫描历史作业。
- `job_lease_expired`：处于活动态但数据库 lease 已过期的作业。
- `job_retry_waiting`：已经执行过至少一次、当前等待重试的作业。
- `job_poison_window`：窗口内耗尽尝试或不可安全恢复的失败作业。
- `outbox_pending|ready|expired_leases|retrying|dead` 及
  `outbox_oldest_ready_age_seconds`：跨进程 outbox 的交付状态。
- `asset_cleanup{condition="pending|dead|orphan"}`：私有媒体清理收敛状态。
  `pending` 只包含 `deleting`，或终态作业上泄漏的 `reserved/uploaded` asset；
  活跃媒体作业正常上传中的 receipt 不会触发告警。`orphan` 是终态作业下超过
  15 分钟仍未收敛、且没有可交付 cleanup 消息的非 canonical asset。
- `slo_window_good|eligible|ratio{objective=...,job_type=...}`：最近一小时的
  SLO 分子、分母和比率。无合格样本时 ratio 为 `NaN`，不视为 0%。
- `worker_fleet_ready|active_workers|total_capacity|stale_workers|draining_workers`：
  数据库权威 worker fleet 状态；不是 Web 进程内计数。
- `worker_fleet_freshest_heartbeat_age_seconds` / `oldest_active_heartbeat_age_seconds`：
  整体 heartbeat 新鲜度边界；无样本输出 `NaN`。
- `worker_queue_ready|active_workers|total_capacity|freshest_heartbeat_age_seconds{queue=...}`：
  固定 `chat|media|title|agent|outbox` 队列的消费者覆盖，标签不接受运行时扩张。
- `billing_healthy` / `billing_mismatches_total`：最新一次数据库权威计费对账是否
  满足全部账务不变量。细分 gauge 覆盖 v2 Job 缺 reservation、终态 hold、
  quote/hash、`hold = debit - credit + release`、ledger receipt、profile
  anchor+journal 和 price activation。
- `billing_release_ready` / `billing_release_blockers`：在账务 healthy 之外，进一步
  要求 `billing_active_legacy_jobs=0`。因此 `healthy=1`、`release_ready=0` 是合法但
  仍然阻断发布的 cutover 状态，不能解释为告警误报。
- `billing_snapshot_age_seconds`：snapshot 超过 600 秒时，即使旧值为 healthy 和
  release ready 也禁止发布和新付费准入；必须先恢复权威 refresh。

进程内 counter/histogram 只用于 Worker 内部测量和测试，不从 Web exporter
输出。接入 OTLP 后应由 Worker 主动推送，进程重启归零的过程指标不能作为权威
告警或 SLO 分母。

## SLO 与分母

初始生产目标如下：

| Objective | 合格事件 | 目标 | 一小时错误预算 |
| --- | --- | ---: | ---: |
| `enqueue_started_2s` | `started_at <= created_at + 2s` | 99.0% | 1.0% |
| `cancel_terminal_3s` | `terminal_at <= cancel_requested_at + 3s` | 99.9% | 0.1% |

尚未超过截止时间的在途请求不进入分母：入队不足 2 秒且尚未开始的作业、取消
不足 3 秒且尚未终态的作业都不会制造提前失败。超过截止时间或已经产生结果后
立即进入分母。取消终态必须晚于或等于取消请求，时钟倒退不会被记为成功。

发布前至少积累 100 个 eligible 样本再把一小时比例用作阻断条件；低流量时以
单个 breach 事件和队列/lease 指标辅助判断。月度错误预算应由 Prometheus 的
历史样本累计 `sum(good) / sum(eligible)`，不要平均 ratio。

## Dashboard 查询

下面查询均可直接用作面板：

```promql
sum by (job_type) (mychat_authoritative_queue_depth)
max by (job_type) (mychat_authoritative_queue_oldest_age_seconds)
sum by (job_type, status) (mychat_authoritative_jobs_terminal_window)
sum by (job_type, status) (rate(mychat_authoritative_jobs_terminal_total[5m]))
sum by (job_type) (mychat_authoritative_job_lease_expired)
mychat_authoritative_outbox_dead
mychat_authoritative_asset_cleanup
mychat_authoritative_worker_fleet_ready
mychat_authoritative_worker_queue_freshest_heartbeat_age_seconds
mychat_authoritative_billing_snapshot_age_seconds
mychat_authoritative_billing_healthy
mychat_authoritative_billing_release_ready
mychat_authoritative_billing_release_blockers
```

整体 SLO 比率必须从分子/分母求和：

```promql
sum by (objective) (mychat_authoritative_slo_window_good)
/
clamp_min(sum by (objective) (mychat_authoritative_slo_window_eligible), 1)
```

一小时 burn rate（1 表示按当前速率恰好耗尽预算）：

```promql
# enqueue_started_2s，目标 99%
(1 - (
  sum(mychat_authoritative_slo_window_good{objective="enqueue_started_2s"})
  /
  clamp_min(sum(mychat_authoritative_slo_window_eligible{objective="enqueue_started_2s"}), 1)
)) / 0.01

# cancel_terminal_3s，目标 99.9%
(1 - (
  sum(mychat_authoritative_slo_window_good{objective="cancel_terminal_3s"})
  /
  clamp_min(sum(mychat_authoritative_slo_window_eligible{objective="cancel_terminal_3s"}), 1)
)) / 0.001
```

## 告警策略

- `up{job="mychat"} == 0` 或 metrics 连续两次 `503`：立即 page；先确认数据库和
  service-role RPC，而不是重启所有 worker。
- `queue_oldest_age_seconds > 30` 持续 5 分钟：page；按 `job_type` 检查对应
  bulkhead 的 worker 数、provider 延迟和 principal fairness。
- `job_lease_expired > 0` 持续 2 分钟：page；一次短暂非零可由进程退出并被
  reclaim，持续非零表示恢复循环失效。
- `outbox_expired_leases > 0` 持续 2 分钟或 `outbox_dead > 0`：page；dead-letter
  必须人工判断是否重放，禁止直接改表绕过 lock version。
- `asset_cleanup{condition="dead"} > 0` 或 `orphan > 0`：page；优先核对私有
  Storage 对象与 receipt，再通过受控补偿流程重投。
- `billing_snapshot_age_seconds > 600`、`billing_mismatches_total > 0`、
  `billing_release_ready < 1` 或 `billing_release_blockers > 0`：停止发布。账务 mismatch
  或陈旧 snapshot 立即 page；只有 active legacy Job 的 release blocker 进入受控 drain，
  但同样不得解除维护。不得通过改 snapshot 解除；必须修复源记录或让 legacy Job
  权威收敛后重新执行 reconciliation，直到 `healthy=1`、`release_ready=1` 且全部
  blocker 为 0。
- eligible 样本不少于 100 时，burn rate `> 2` 持续 15 分钟报警，`> 6`
  持续 5 分钟 page 并停止扩大发布；恢复到 `< 1` 后继续观察一个完整窗口。

任何 dashboard 都应同时显示 snapshot age。该值持续超过两倍 scrape interval
说明监控数据已经陈旧，即使其他曲线仍平坦也不能判定健康。

仓库提供可直接加载的规则文件 `ops/prometheus/alerts.yml` 和 Grafana dashboard
`ops/grafana/job-control-plane-dashboard.json`。告警覆盖 scrape/snapshot、worker
freshness、queue oldest age、终态失败、取消 SLO、lease recovery、outbox dead 和
billing reconciliation；
生产监控应从这两份受测试的资产部署，避免在控制台维护不可审计的副本。

## 故障演练与验收

每次控制面或 worker 发布至少执行以下演练，并保存查询前后截图/时间戳：

1. worker 在 claim 后退出：`lease_expired` 短暂上升，随后同一作业被新 fence
   reclaim 并回到 0；旧 worker 的写入必须被拒绝。
2. outbox publisher 在外部副作用后、ack 前退出：过期 lock 被重新 claim，
   `lock_version` 增长，旧 ack 被拒绝，dedupe key 保证副作用不重复。
3. Storage 删除连续失败：`outbox_retrying` 上升；耗尽后进入 dead，asset 显示
   dead/orphan，恢复后经受控重放最终为 0。
4. provider 卡住时请求取消：`cancel_terminal_3s` eligible 增长且应记为 good；
   worker 不得在收到取消后继续提交可逆副作用。
5. 暂停数据库连接：已认证 metrics scrape 必须返回 `503`，恢复后 snapshot age
   回落且数据库 gauge 与表内抽样一致。
6. 使用无令牌、错误令牌、authenticated JWT 调用监控面：HTTP 均为 `404`，
   authenticated/anon 直接调用 RPC 必须得到 `insufficient_privilege`。

演练失败、dead-letter 未清零、orphan 未收敛、计费对账非零或一小时 burn rate 大于 1 时，
发布不满足完成条件。
