# MyChat 控制面部署与运行 Runbook

本文是统一 Job 控制面发布的操作顺序。它描述仓库当前已经实现的能力，并明确当前零付费生产拓扑的限制；不是对尚未启用的外部基础设施的承诺。

## 当前生产事实

- `render.yaml` 只声明一个 Render Web service。`npm start` 默认使用 `MYCHAT_RUNTIME_ROLE=all`，在同一个服务内监管 Next.js Web 与 `job-worker.ts`。
- Web/Worker 进程可以通过 `MYCHAT_RUNTIME_ROLE=web|worker` 分开启动，但当前 Blueprint 没有创建第二个服务，也没有独立 Worker autoscaler。
- 队列、lease、fence、checkpoint、ledger、outbox、audit log 和 Worker heartbeat 都以 Supabase PostgreSQL 为事实源。仓库没有部署 Redis queue、Kafka 或 workflow engine。
- `/api/metrics`、`ops/prometheus/alerts.yml` 和 Grafana dashboard 已存在；仓库不负责创建托管 Prometheus、Grafana、Alertmanager 或 OpenTelemetry collector。
- GitHub Actions 的免费 keepalive workflow 每 10 分钟尝试严格检查 `/api/ready`。定时任务和 Render 免费实例本身都不构成 uptime、HA 或零冷启动保证。
- 数据库备份、PITR、跨区域故障转移和外部 provider 财务对账取决于平台能力，当前仓库没有自动配置这些服务。

## 发布不变量

一次发布只有同时满足以下条件才完成：

1. 冻结的 PR head 同时通过 `Verify`、CodeQL、Dependency review 和 Secret scan；合并后的 `main` 检查也成功。
2. 闭合 manifest 的 45 个文件、`platform_authority_v2` 和 v2 seal 的顺序、SHA-256 与生产执行结果都有不可变发布记录，没有用函数名相同或 SQL Editor 历史代替 checksum 证据。
3. 所有兼容性迁移先完成；进入 `2400` 前，generation admission 与 planned command write 已真实冻结，非终态 Job 和待交付 outbox 已收敛。
4. 数据库只接受当前代码携带的 contract v2、45-file SHA-256 和 migration count；该检查同时要求 `runtime_healthcheck_v15()`、新鲜且 release-ready 的计费 reconciliation 和零 blocker。
5. 代码只从 GitHub 合并后的 `main` 部署，线上 revision 与 merge commit 匹配；五个固定队列只能由同一 revision 的新鲜进程 heartbeat 满足 readiness v3。
6. `/api/ready` 严格成功，Worker 不处于 draining；受保护 `/api/metrics` 可读，关键 dead、expired、orphan 和 billing 指标无未解释异常。
7. 聊天、标题或媒体、Agent、取消、SSE 与恢复中和本次改动相关的真实用户边界烟测通过。

不要为了让部署变绿而直接改 `jobs`、`job_outbox`、`ledger_entries`、`job_checkpoints`、reconciliation snapshot 或审计表。恢复必须经过带 fence/CAS 的 RPC、经评审的数据修复或仓库提供的受控命令。

## 1. 发布前冻结与本地验证

记录发布分支、PR head SHA、操作者、开始时间、生产 URL、Supabase project ref 和 Render service。数据库连接使用预先配置的 libpq `PGSERVICE`；不要把数据库密码、service-role key、stream HMAC key 或 metrics token 写进命令历史、PR、日志或截图。

在干净依赖环境运行：

```bash
npm ci --ignore-scripts --legacy-peer-deps
npx playwright install chromium
npm run verify
```

`npm run verify` 包含架构门禁、闭合 migration contract、严格 TypeScript、零 warning ESLint、覆盖率门禁、生产依赖审计、完整 PostgreSQL 16 catalog 类型漂移检查、迁移/并发/恢复验证、生产构建和桌面/移动浏览器烟测。`npm run database:types:check` 与 `npm run test:migrations` 都会创建并删除本地测试数据库，后者还会真实 `SIGKILL` 一个已 claim 的客户端；只能在本地或 CI 的一次性 PostgreSQL 16 + pgvector 上运行，不能把它们指向生产集群。

若本地因环境条件不能完成某项，GitHub CI 仍必须完整通过；“本机没有工具”不能作为跳过 CI 的理由。Docker release image 是独立产物；只有 Release Image workflow 实际构建并产生 digest、SBOM 和 provenance，才能把容器产物记为成功，静态配置测试不能替代构建。

## 2. GitHub PR、checksum 与 CI

推送 `codex/*` 分支并创建 PR，禁止把未经评审的工作树直接推到 `main`。PR 描述至少包含迁移清单、兼容性断点、维护/停写方法、roll-forward 目标、烟测范围和外部基础设施限制。

等待 `Verify`、CodeQL、Dependency review 和 Secret scan 全部成功后冻结 PR head。冻结后不得再改代码；任何 push 都使旧 CI、旧 checksum 和旧迁移审阅失效。用冻结 commit 生成迁移清单并存入受控发布记录：

```bash
export PR_HEAD_SHA='<frozen-pr-head-sha>'
export RELEASE_EVIDENCE_DIR='<controlled-release-evidence-directory>'
test -d "$RELEASE_EVIDENCE_DIR" && test -w "$RELEASE_EVIDENCE_DIR"
test "$(git rev-parse HEAD)" = "$PR_HEAD_SHA"
test -z "$(git status --porcelain)"

contract_files=(
  supabase/migrations/20260713180000_checkpoint_recovery_contract.sql
  supabase/migrations/20260713190000_agent_publication_safety.sql
  supabase/migrations/20260713200000_job_worker_heartbeats.sql
  supabase/migrations/20260713210000_job_outbox_redrive.sql
  supabase/migrations/20260713220000_job_budget_accounting.sql
  supabase/migrations/20260713230000_awaiting_job_resume.sql
  supabase/migrations/20260713240000_admission_and_reservations.sql
  supabase/migrations/20260713250000_terminal_projection_and_effect_recovery.sql
  supabase/migrations/20260713260000_stream_and_asset_lifecycle.sql
  supabase/migrations/20260713270000_tenant_relational_integrity.sql
  supabase/migrations/20260713280000_revision_scoped_worker_readiness.sql
  supabase/migrations/20260713285000_pgcrypto_digest_bridge.sql
  supabase/migrations/20260713290000_billing_reconciliation_contract.sql
  supabase/migrations/20260713300000_atomic_checkpoint_accounting.sql
  supabase/migrations/20260713310000_schema_contract_attestation.sql
  supabase/migrations/20260717010000_platform_authority_v2.sql
  supabase/migrations/20260717020000_schema_contract_attestation_v2.sql
)

export MIGRATION_MANIFEST="$RELEASE_EVIDENCE_DIR/mychat-$PR_HEAD_SHA-migrations.sha256"
for migration in "${contract_files[@]}"; do
  shasum -a 256 "$migration"
done > "$MIGRATION_MANIFEST"
shasum -a 256 -c "$MIGRATION_MANIFEST"
```

上面的 checksum manifest 覆盖本批 17 个操作文件，是本次发布证据，不是数据库 secret。将它保存在受控证据目录而不是工作树，并作为只写一次的 release artifact 绑定 PR head。每次执行某文件前都重新运行 `shasum -a 256 -c "$MIGRATION_MANIFEST"`；结果必须与冻结 PR 完全一致。

仓库中的 `supabase/migrations.manifest.json` 是另一种证据：它闭合列出包括 v1 seal 和 `platform_authority_v2` 在内的全部 45 个 SQL 文件及各自 SHA-256，contract v2 digest 为 `c0c1dd9dcf788761cae5ac5a0bcb3ddd49e13ab8c59638e2c91d53ce1c5fcacc`。`schema_contract_attestation_v2.sql` 不参与自身 digest，以避免递归哈希；它把 version 2、digest 和 count 45 作为不可变 tuple 写入数据库。运行 `node scripts/check-migration-contract.mjs` 必须成功。Verify 生成的 OCI 标签、verified-image artifact、drain artifact 和 activation checkout 都携带并逐跳核对该 tuple。

`schema_contract_attestations` 只声明“生产 schema 已按对象、数据和 runtime gate 核验后绑定到此仓库契约”，不伪装成 `supabase_migrations.schema_migrations` 执行历史。Supabase Dashboard 没有 managed migration 记录并不能证明 schema 未变，SQL Editor 历史也不能证明执行内容等于冻结文件；以 checksum、不可变 schema attestation、对象 contract 和只读数据检查共同判定。

## 3. 生产数据库：历史 contract → platform authority v2

### 本次生产起点

2026-07-14 对 production project `usibkqqksgwgvdiqwpyo` 的只读核验记录如下：线上应用 revision 为 `5068c9b79db4`，`1200→1800` contract probe 均为 true，`1900` 是首个待执行文件，非终态 Job 与待交付 outbox 均为 0。最初“可能缺少 1800→2300”的判断已由对象和数据 probe 收敛为这个起点；不要因为 Dashboard 没有 managed migration 记录而重跑已经确认的 `1800`。

这只是当时的发布证据，不是永久事实。真正变更前必须在同一生产连接再次核验；结果不一致就停止，不得把本文快照当作放行：

```sql
select current_database(), current_user, inet_server_addr(), version();

select status, count(*) from public.jobs group by status order by status;
select status, count(*) from public.job_outbox group by status order by status;

select count(*) as nonterminal_jobs
from public.jobs
where status not in ('completed','failed','cancelled');

select count(*) as active_outbox
from public.job_outbox
where status in ('pending','publishing','failed');

select count(*) as dead_outbox
from public.job_outbox
where status = 'dead';
```

本次继续执行的前置结果必须是 `nonterminal_jobs=0`、`active_outbox=0`、`dead_outbox=0`。若不为 0，先让权威 Worker 正常收敛；不要直接改状态。先做平台允许范围内的数据库备份或逻辑导出并验证恢复方式。免费计划若不提供 PITR，必须把“没有 PITR”记为本次发布的未消除风险。

### 完整 contract 顺序

| 顺序 | 迁移 | 作用与发布属性 |
| ---: | --- | --- |
| 1 | `20260713180000_checkpoint_recovery_contract.sql` | checkpoint 恢复权威；本次只验证既有证据，不重跑 |
| 2 | `20260713190000_agent_publication_safety.sql` | initial repository 发布的数据库敏感路径/内容防线 |
| 3 | `20260713200000_job_worker_heartbeats.sql` | 数据库权威 heartbeat 与 readiness v1 |
| 4 | `20260713210000_job_outbox_redrive.sql` | 带 lock fence、幂等键和 audit receipt 的 dead-letter redrive |
| 5 | `20260713220000_job_budget_accounting.sql` | 严格预算和跨 attempt 记账，升级到 runtime v7 |
| 6 | `20260713230000_awaiting_job_resume.sql` | checkpoint CAS、归属校验、幂等恢复，升级到 runtime v8 |
| 7 | `20260713240000_admission_and_reservations.sql` | 原子 quota/balance reservation；同时收回浏览器 Agent enqueue 权限，是现网 `5068c9b` 的兼容性断点 |
| 8 | `20260713250000_terminal_projection_and_effect_recovery.sql` | 统一终态投影与明确 replay-safe effect 的失败后重试 |
| 9 | `20260713260000_stream_and_asset_lifecycle.sql` | SSE lease、HMAC admission、payload/tenant 资源上限与生命周期，升级到 runtime v11 |
| 10 | `20260713270000_tenant_relational_integrity.sql` | 35 个 tenant composite FK 的 expand-only 验证；无总事务，保留全部 legacy FK，只能 roll forward |
| 11 | `20260713280000_revision_scoped_worker_readiness.sql` | readiness v2 只接受相同 revision 的队列容量，升级到 runtime v12 |
| 12 | `20260713285000_pgcrypto_digest_bridge.sql` | 为 Supabase `extensions.digest` 安装仅 `service_role` 可执行的兼容桥，保持固定 `public` search path 的账务函数可解析 |
| 13 | `20260713290000_billing_reconciliation_contract.sql` | 不可变 price quote、balance movement/journal、billing v2 cutover 和权威 reconciliation，升级到 runtime v13 |
| 14 | `20260713300000_atomic_checkpoint_accounting.sql` | fenced checkpoint CAS 与不可变 accounting delta 同事务提交，禁用 legacy checkpoint 执行路径，升级到 runtime v14 |
| 15 | `20260713310000_schema_contract_attestation.sql` | 把全部 43 个既有迁移的闭合 manifest tuple 追加封印；仅 service role 可执行精确契约检查 |
| 16 | `20260717010000_platform_authority_v2.sql` | 单一 Agent 价格预算、进程 heartbeat/readiness v3、O(1) SSE admission、服务端原子 chat turn/regeneration、仅真实消费者进入 outbox，升级到 runtime v15 |
| 17 | `20260717020000_schema_contract_attestation_v2.sql` | 封印 contract v2 / 45-file tuple；保留 v1 verifier 供滚动兼容 |

### 兼容扩展：1900 → 2300

`1900→2300` 先在仍运行稳定 revision 时逐文件执行。每个文件都是显式事务；任一文件失败就停止，确认本文件已回滚后再处理。`2200` 若发现不合法历史预算，使用单独评审的数据修复；`2300` 清理既有 `awaiting_input` lease 是预期收敛。

```bash
psql -X -v ON_ERROR_STOP=1 -c \
  'select current_database(), current_user, inet_server_addr(), version();'
shasum -a 256 -c "$MIGRATION_MANIFEST"

for migration in \
  supabase/migrations/20260713190000_agent_publication_safety.sql \
  supabase/migrations/20260713200000_job_worker_heartbeats.sql \
  supabase/migrations/20260713210000_job_outbox_redrive.sql \
  supabase/migrations/20260713220000_job_budget_accounting.sql \
  supabase/migrations/20260713230000_awaiting_job_resume.sql
do
  psql -X -v ON_ERROR_STOP=1 -f "$migration" || break
done
```

完成后以 service role 验证 `select public.runtime_healthcheck_v8();` 为 true，并重跑 Job/outbox 计数。此时尚未完成发布。

### `2400` 前维护与 planned write freeze

`2400` 会将 `enqueue_agent_task_job` 和 `enqueue_agent_operation` 从 authenticated 改为 service-role-only；线上 `5068c9b` 仍以用户 client 调用这些 RPC。因此 `2400` 不是可与该 revision 长期共存的纯 expand，执行后不得再把 `5068c9b` 当成可用回滚目标。

进入 `2400` 前必须同时完成：

1. 关闭 generation admission，并用真实 POST 验证在解析大 body/provider 调用前返回维护 503。
2. 对 Agent、title、code apply/publish、resume 等 planned command 建立平台侧 write freeze；状态读取和取消可保留。
3. 等待所有非终态 Job、pending/publishing/failed outbox 和 dead outbox 都为 0，并保存查询结果。
4. 再次验证冻结 PR SHA 和全部迁移 checksum。

`5068c9b` 不实现新的 `MYCHAT_MAINTENANCE_MODE=drain`。仅在 Render 中设置该变量不构成旧 revision 已 drain 的证据；`GENERATION_MAINTENANCE_MODE` 也最多只能在经实测生效时证明 generation 被关闭。首选先部署一个与旧数据库兼容、覆盖全部 planned command 的维护桥接版本。若没有桥接版本，必须使用经过批准的平台入口停写或完整停机窗口；不能用“当前队列碰巧为 0”代替写冻结。

冻结成立后执行事务性 `2400→2600`：

```bash
for migration in \
  supabase/migrations/20260713240000_admission_and_reservations.sql \
  supabase/migrations/20260713250000_terminal_projection_and_effect_recovery.sql \
  supabase/migrations/20260713260000_stream_and_asset_lifecycle.sql
do
  psql -X -v ON_ERROR_STOP=1 -f "$migration" || break
done
```

任何失败都保持停写。确认事务回滚和真实 schema 后修复并重跑；不要临时恢复旧 Agent 写权限、放宽 payload bucket、删除 reservation 或降低 runtime health contract。

### `2700` 的 autocommit 规则

`2700` 明确没有总事务。它先对同名 invalid index fail closed，再 `CREATE UNIQUE INDEX CONCURRENTLY`，最后逐个增加并验证 composite FK。本次是 expand-only：全部 legacy FK 保留，不执行 contract drop。首选在一个固定数据库连接中使用：

```bash
psql -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260713270000_tenant_relational_integrity.sql
```

不能把完整文件一次粘贴进 SQL Editor；多个语句可能被放入隐式事务，`CREATE INDEX CONCURRENTLY` 会失败。若只能使用 SQL Editor，必须由两人核对后：

1. 将文件开头每条 `CREATE UNIQUE INDEX CONCURRENTLY` 单独选中、单独执行并记录结果。
2. 查询所有目标索引的 `indisready=true` 且 `indisvalid=true`。
3. 再将临时 procedure 定义、全部 `CALL`、constraint validation 和 reset 作为同一个剩余批次执行；不得自行追加 legacy FK drop。
4. 批次失败时保持停写，检查已经存在的索引/constraint/legacy FK，不宣称整个文件已回滚。

并发建索引被取消、lock timeout 或实例中断时，PostgreSQL 可能留下同名 invalid index；`IF NOT EXISTS` 会跳过它，盲目重跑无法恢复。每次失败和成功后都执行：

```sql
select index_schema, index_name, indisready, indisvalid
from (
  select n.nspname as index_schema, c.relname as index_name,
         i.indisready, i.indisvalid
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (array[
      'projects_tenant_id_uidx',
      'project_files_tenant_id_uidx',
      'project_memories_tenant_id_uidx',
      'conversations_tenant_id_uidx',
      'messages_tenant_id_uidx',
      'messages_tenant_conversation_id_uidx',
      'code_sessions_tenant_id_uidx',
      'code_messages_tenant_id_uidx',
      'conversation_chunks_tenant_id_uidx',
      'artifacts_tenant_id_uidx',
      'chat_generations_tenant_id_uidx',
      'agent_tasks_tenant_id_uidx',
      'agent_task_steps_tenant_id_uidx',
      'agent_task_steps_tenant_task_id_uidx',
      'agent_tool_calls_tenant_id_uidx',
      'agent_workspaces_tenant_id_uidx',
      'agent_artifacts_tenant_id_uidx',
      'agent_confirmation_gates_tenant_id_uidx',
      'jobs_principal_id_uidx',
      'ledger_entries_principal_id_uidx'
    ])
) indexes
order by index_name;
```

发现 invalid index 时停止，由单独评审的恢复变更对准确名称执行 `DROP INDEX CONCURRENTLY`，再重新创建；不要删除 valid index 或绕过 FK validation。最终必须有 35 个预期 composite FK 全部 `convalidated=true`，且 `runtime_healthcheck_v12()` 在 `2800` 后才能为 true。

### `2800→3100`、reconciliation、原子 checkpoint 与 schema seal

严格按顺序执行 `2800`、`2850`、`2900`、`3000`，确认 v14 与 reconciliation 后再执行 `3100`。五者完成前保持停写；`2850` 修复 Supabase 扩展 schema 与固定函数 search path 的解析差异，`2900` 是 billing contract cutover，`3000` 将运行时 checkpoint 切换到原子记账路径，`3100` 将核验后的 schema 绑定到仓库 manifest，都不是普通 metrics 增量：

```bash
psql -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260713280000_revision_scoped_worker_readiness.sql
psql -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260713285000_pgcrypto_digest_bridge.sql
psql -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260713290000_billing_reconciliation_contract.sql
psql -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260713300000_atomic_checkpoint_accounting.sql
```

随后用 service role 显式刷新并读取权威 snapshot：

```sql
select public.refresh_billing_reconciliation_v1();
select public.runtime_healthcheck_v14();
select public.read_billing_reconciliation_v1();
```

必须同时看到：runtime v14 为 true；`checkpoint_job_with_accounting(...)` 仅 service role 可执行，legacy `checkpoint_job(...)` 调用明确失败；`healthy=true`、`releaseReady=true`、`releaseBlockers=0`、`totalMismatches=0`、`activeLegacyJobs=0`；所有细分 mismatch 为 0；`generatedAt` 距当前小于 10 分钟。`healthy=true` 但 `releaseReady=false` 表示仍有 pre-cutover legacy Job，仍然禁止发布。不得直接改 snapshot；修复源记录或让 legacy Job 通过权威 Worker 收敛，再重新 refresh。

以上结果全部成立后，重新核对冻结 checksum，验证生成的 manifest，并执行 seal：

```bash
shasum -a 256 -c "$MIGRATION_MANIFEST"
node scripts/check-migration-contract.mjs
psql -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260713310000_schema_contract_attestation.sql
```

用 service role 验证精确 tuple；第一列必须为 true，后三列必须为 false：

```sql
select
  public.verify_schema_contract_v1(
    1,
    'e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d',
    43
  ) as exact_contract,
  public.verify_schema_contract_v1(
    2,
    'e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d',
    43
  ) as wrong_version,
  public.verify_schema_contract_v1(
    1,
    repeat('0', 64),
    43
  ) as wrong_digest,
  public.verify_schema_contract_v1(
    1,
    'e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d',
    44
  ) as wrong_count;

select
  has_function_privilege(
    'service_role',
    'public.verify_schema_contract_v1(integer,text,integer)',
    'EXECUTE'
  ) as service_can_verify,
  has_function_privilege(
    'anon',
    'public.verify_schema_contract_v1(integer,text,integer)',
    'EXECUTE'
  ) as anon_can_verify,
  has_function_privilege(
    'authenticated',
    'public.verify_schema_contract_v1(integer,text,integer)',
    'EXECUTE'
  ) as authenticated_can_verify,
  has_table_privilege(
    'service_role',
    'public.schema_contract_attestations',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) as service_has_direct_table_access;
```

权限结果必须依次为 true、false、false、false。不要给 service role 表级读取权限；应用只通过 SECURITY DEFINER 的精确验证 RPC 读取布尔结果。这里的 v1 检查是升级到 platform v2 前的兼容阶段，不是新应用的最终 readiness contract。

`3000` 只对 Worker 已收到并形成累计 usage 报告的用量提供 fenced ledger durability，以及 checkpoint/ledger 原子性，不提供 provider exactly-once。每次 usage callback 会在模型循环继续或返回前落账；但 provider 已完成、进程在 usage 解析或 callback 提交前死亡时仍没有权威数值，usage 已提交而响应 checkpoint 尚未形成时也可能按相同 Idempotency-Key 重发请求。这些窗口仍需 provider response receipt、账单导入和差异补录；外部能力当前未实现，必须作为发布残余风险记录，不能用 v14 健康结果掩盖。

随后在仍保持 drain 时执行 platform authority 与 v2 seal。`platform_authority_v2` 是显式事务：失败必须整体回滚；它保留旧 RPC 供滚动兼容，但新应用在 v2 seal 完成前会因精确 contract 不匹配而 fail closed。

```bash
shasum -a 256 -c "$MIGRATION_MANIFEST"
psql -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260717010000_platform_authority_v2.sql
psql -X -v ON_ERROR_STOP=1 -c 'select public.runtime_healthcheck_v15();'
psql -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260717020000_schema_contract_attestation_v2.sql
```

用 service role 验证精确 v2 tuple 为 true，并确认错误 version/digest/count 都为 false：

```sql
select
  public.verify_schema_contract_v2(
    2,
    'c0c1dd9dcf788761cae5ac5a0bcb3ddd49e13ab8c59638e2c91d53ce1c5fcacc',
    45
  ) as exact_contract,
  public.verify_schema_contract_v2(
    1,
    'c0c1dd9dcf788761cae5ac5a0bcb3ddd49e13ab8c59638e2c91d53ce1c5fcacc',
    45
  ) as wrong_version,
  public.verify_schema_contract_v2(2, repeat('0', 64), 45) as wrong_digest,
  public.verify_schema_contract_v2(
    2,
    'c0c1dd9dcf788761cae5ac5a0bcb3ddd49e13ab8c59638e2c91d53ce1c5fcacc',
    44
  ) as wrong_count;

select
  has_function_privilege(
    'service_role',
    'public.verify_schema_contract_v2(integer,text,integer)',
    'EXECUTE'
  ) as service_can_verify,
  has_function_privilege(
    'anon',
    'public.verify_schema_contract_v2(integer,text,integer)',
    'EXECUTE'
  ) as anon_can_verify,
  has_function_privilege(
    'authenticated',
    'public.verify_schema_contract_v2(integer,text,integer)',
    'EXECUTE'
  ) as authenticated_can_verify;
```

第一组结果必须依次为 `true,false,false,false`，权限结果必须依次为 `true,false,false`。另外确认 lifecycle outbox 没有非 published 的 `jobs.*` 行、SSE counter 与 live lease 一致、Agent 激活价格存在，并对 chat turn/regeneration 执行成功、并发 CAS 拒绝和失败回滚探针；不要只检查函数是否存在。

新代码部署前没有当前 merge revision 的 Worker heartbeat，readiness v3 为 false 是预期现象，不代表可以跳过它。只有第二次、解除 drain 的部署才能用 merge revision 验证：

```sql
select public.read_job_worker_readiness_v3(
  array['chat','media','title','agent','outbox'],
  20,
  '<merge-sha-first-12-lowercase>'
);
```

### 迁移失败的统一处理

1. 立即停止后续 SQL、merge 和解除停写，保留完整错误、文件名、checksum、时间和操作者。
2. `1900→2600`、`2800→3100`、platform v2 或 v2 seal 失败时先证明该文件事务回滚；`2700` 按部分完成处理。
3. 不手工伪造函数、constraint、snapshot 或 migration history 来越过 gate。
4. `2400` 之后只允许 roll forward 到兼容新 contract 的应用；不要恢复 `5068c9b` 接收 planned writes。
5. 修复必须经过新 PR/CI 和新 checksum；从失败点恢复后重新运行精确 schema contract、reconciliation、约束、Job/outbox 全部检查。

## 4. Render 配置与第一次 drain 部署

合并前确认 Render service 的自动部署保持关闭；`render.yaml` 使用 `autoDeployTrigger: off`，Release Image workflow 在 Verify 与 Security 成功后通过 Render API 指定精确 Git commit，并先把既有 revision 和目标 revision 部署为 drain。不得在 Dashboard 临时改回自动部署。`sync: false` 只声明变量槽位，必须在 Render secret store 中真实设置：

- `STREAM_ADMISSION_HASH_KEY`：独立的至少 32 随机字节 HMAC key，不复用 Supabase、metrics 或 credential key；
- `METRICS_BEARER_TOKEN`：高熵独立 token，只提供给受控 scraper/操作者；
- Supabase service role、E2B 和 Agent credential 等既有 server-only secrets。

不要读取或截图 secret 明文。通过 `/api/ready` 的 `checks.stream.configured=true` 证明 stream key 生效，通过未授权 metrics=404、授权 metrics=200 证明 metrics token 生效。

在合并前把新 revision 的有效环境设为：

```dotenv
MYCHAT_RUNTIME_ROLE=all
MYCHAT_MAINTENANCE_MODE=drain
```

`MYCHAT_MAINTENANCE_MODE` 的 steady-state 是 `off`，但 Release Image workflow 在创建目标 revision deploy 前必须通过 API 写成 `drain` 并读回确认；任何一步无法证明精确 commit 或 drain 都必须停止，不能让第一次新代码部署直接开放 admission。

数据库 schema contract 和 reconciliation 已通过、PR checks 仍对应冻结 head 后才合并。记录 merge commit SHA。Release workflow 的 preflight 会为免费实例冷启动提供有界重试，但每次响应仍必须通过完整 readiness；网络超时不能被解释为健康。Render 第一次从 `main` 部署该 commit 时保持 drain：新 Web 可提供状态/取消读取，新 Worker 只发布 draining heartbeat 并刷新 billing reconciliation，不 claim 新工作。确认 Render event 的 commit 与 `/api/ready` revision 一致，响应显式包含 `checks.worker.draining=true`。此时严格生产检查脚本应失败；这是维护态，不是发布完成。

当前 Blueprint 只有一个 Web service，`npm start` 默认在同一实例监管 Web 与 Worker。不要设为 `worker`，否则没有 HTTP；不要设为 `web` 后又没有独立 Worker。真正拆分时，Web/Worker 必须运行相同 commit、连接同一数据库，且五个队列仍由相同 revision heartbeat 覆盖。

## 5. 解除 drain 的第二次部署

第一次部署的精确 schema contract、reconciliation、secret 和 revision 检查都通过后，将 `MYCHAT_MAINTENANCE_MODE=off`，用同一 merge commit 再触发一次 Render 部署。必须记录第二次 deploy ID；仅修改环境却没有完成新部署不算解除 drain。

第二次部署后等待旧 draining heartbeat 退出、新 revision 的五个 queue heartbeat 全部新鲜。`read_job_worker_readiness_v3(..., merge-revision)` 必须返回 `ready=true`、`missingQueues=[]`、每个队列 `ready=true` 且逐队列容量符合配置。旧 revision heartbeat 可以留作 stale observability，但不能计入容量。

## 6. 生产 `/ready`、reconciliation 与 `/metrics` 验证

用完整 merge SHA 校验严格 readiness：

```bash
export MYCHAT_HEALTH_URL=https://mychat-nm6x.onrender.com/api/ready
export EXPECTED_REVISION='<merge-commit-sha>'
node scripts/check-production-health.mjs "$MYCHAT_HEALTH_URL"
```

脚本只接受 HTTPS 的精确 `/api/ready` 路径，要求 revision 匹配，并验证 `auth`、`database`、`distributedRateLimit`、`queue`、`worker`、`stream`、`observability` 和 `sandbox` 全部 configured/ready；draining Worker 会失败。随后再次执行精确 schema contract v2、readiness v3 和 billing reconciliation 三组 SQL，不能只依赖 HTTP 聚合结果。

验证 metrics 的隐藏、授权读取、五队列和 billing release gate：

```bash
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  https://mychat-nm6x.onrender.com/api/metrics)" = 404

metrics_file="$(mktemp)"
trap 'rm -f "$metrics_file"' EXIT
test "$(curl -sS -o "$metrics_file" -w '%{http_code}' \
  -H "Authorization: Bearer $METRICS_BEARER_TOKEN" \
  https://mychat-nm6x.onrender.com/api/metrics)" = 200

rg '^mychat_authoritative_worker_fleet_ready 1$' "$metrics_file"
for queue in chat media title agent outbox; do
  rg "^mychat_authoritative_worker_queue_ready\\{queue=\"${queue}\"\\} 1$" "$metrics_file"
done

rg '^mychat_authoritative_billing_healthy 1$' "$metrics_file"
rg '^mychat_authoritative_billing_release_ready 1$' "$metrics_file"
rg '^mychat_authoritative_billing_release_blockers 0$' "$metrics_file"
rg '^mychat_authoritative_billing_mismatches_total 0$' "$metrics_file"
rg '^mychat_authoritative_billing_active_legacy_jobs 0$' "$metrics_file"
awk '$1 == "mychat_authoritative_billing_snapshot_age_seconds" { fresh = ($2 ~ /^[0-9]+([.][0-9]+)?$/ && $2 < 600) } END { exit fresh ? 0 : 1 }' "$metrics_file"
```

还要确认 `job_lease_expired`、`outbox_dead`、`outbox_expired_leases`、`asset_cleanup{condition="dead|orphan"}` 和 overdue payload 指标为 0。snapshot age 持续超过两倍 scrape interval 时，其他平坦曲线不能证明健康。metrics token 只放在操作者环境或 secret store，不使用 `set -x`，不把完整 exporter 输出贴到公开 issue。详细阻断条件见 [Job 可观测性](observability.md)。

最后通过真实用户边界完成最小烟测：

- 入队一条聊天并通过 SSE 到唯一终态，刷新页面后结果一致；
- 取消一条在途 Job，确认取消/完成竞争只有一个终态；
- 触发一条标题 Job；只有在已有免费测试 provider 时补充媒体烟测，并确认对应 queue 被消费；
- 运行一个 E2B Agent 只读或测试仓库任务；
- 若涉及发布，在专用测试仓库走确认、commit、push、PR，不用生产仓库做破坏性烟测；
- 构造 `awaiting_input` Agent 流程，以 checkpoint version 和稳定幂等键恢复；重复相同请求必须 replay，不能生成第二执行分支。

## 7. Outbox dead-letter 受控 redrive

Redrive 不是“看到 dead 就重试”。先确认根因已经消除，并检查外部副作用是否可能已经成功但 ack 丢失。尤其是 `assets.cleanup`，先核对 Storage 对象和 asset receipt；无法证明安全时保持 dead 并升级处理。

用只读查询取得当前 fence：

```sql
select
  id, job_id, topic, status, lock_version, attempts,
  replay_count, max_redrives, last_error, updated_at
from public.job_outbox
where id = '<outbox-uuid>';
```

只有 `status='dead'` 且 `replay_count < max_redrives` 才可申请重放。记录查询结果、根因、外部系统核对证据和批准者。然后在受控操作者环境设置 Supabase URL 与 `SUPABASE_SERVICE_ROLE_KEY`，执行：

```bash
npm run outbox:redrive -- \
  --id <outbox-uuid> \
  --lock-version <current-lock-version> \
  --key <stable-redrive-key> \
  --actor <operator-id> \
  --reason <root-cause-and-recovery> \
  --delay <seconds>
```

- `--lock-version` 是显式预期 fence；如果返回 `stale_lock`，重新查询并重新判断，不能盲目改数字。
- `--key` 是本次人工意图的稳定幂等键，长度 16–200。响应丢失时必须用完全相同的 key 和参数重试；只有新的、再次批准的 redrive round 才生成新 key。
- `--actor` 必须能映射到操作者，`--reason` 要写明根因与恢复依据，不能使用 `manual fix` 之类不可审计文本。
- `--delay` 可省略，范围 0–86400 秒。
- 命令返回 `redriven=false` 时退出码为 2；RPC 或配置错误退出码为 1。两者都不是成功。

RPC 只允许 service role，要求 dead 状态和匹配 lock version，增加 `lock_version` 与 `replay_count`，并在同一事务写 `audit_log(action='outbox.redriven')`。禁止用 SQL 直接把 status 改为 pending、清空 `last_error` 或重置 `replay_count`。

确认结果：

```sql
select status, lock_version, replay_count, available_at, last_error
from public.job_outbox
where id = '<outbox-uuid>';

select actor_id, request_id, metadata, created_at
from public.audit_log
where resource_type = 'job_outbox'
  and resource_id = '<outbox-uuid>'
  and action = 'outbox.redriven'
order by created_at desc;
```

观察消息最终 `published`，并确认相应 asset cleanup/dead/orphan 指标回到 0。达到 `redrive_limit` 后必须修复设计或走单独评审，不能通过直接改表突破上限。

## 8. `AGENT_CREDENTIAL_KEY` 轮换

GitHub credential 和自定义模型 endpoint API key 使用当前 `AGENT_CREDENTIAL_KEY` 加密；解密会依次尝试当前 key 与可选的 `AGENT_CREDENTIAL_KEY_PREVIOUS`。新写入永远只使用当前 key。仓库没有自动批量重加密任务，因此轮换必须包含用户重连/重新保存和清点。

安全轮换顺序：

1. 生成新的至少 32 字符高熵 secret，保存在平台 secret store，不写入仓库。
2. 同一次 Render 配置变更中设置 `AGENT_CREDENTIAL_KEY=<new>`、`AGENT_CREDENTIAL_KEY_PREVIOUS=<old>`，部署并通过 `/api/ready`。
3. 验证既有 GitHub connection 和自定义 endpoint 仍可解密使用；失败时不要删除旧 key。
4. 让所有 GitHub connection 重新 OAuth 连接，让所有带 API key 的 endpoint 由拥有者重新输入并保存，从而使用 new key reseal。仅仅读取旧记录不会自动重加密。
5. 清点 `github_connections` 和 `endpoints` 的拥有者，完成逐项烟测并保留结果。不要在查询或日志中输出 ciphertext 或明文 key。
6. 确认没有仍依赖旧 key 的记录后，删除 `AGENT_CREDENTIAL_KEY_PREVIOUS`，再次部署并烟测。

若在双 key 窗口需要回滚，设置 current=old、previous=new，使窗口内已经用 new 写入的记录仍可读；完成调查后再决定统一 reseal 方向。不要简单恢复 old 并清掉 previous，否则轮换期间新保存的凭据会立即不可解密。

## 9. 故障演练

演练只在本地或隔离的 staging 进行，除非有明确的生产变更批准。每次记录 Job ID、worker ID、旧/新 lease version、时间戳、相关 metrics、数据库事件和最终状态。

### 真实 SIGKILL

最低门禁由 `npm run test:migrations` 自动完成：脚本在 PostgreSQL 16 中让一个真实 `psql` 进程 claim 并提交 lease，然后在它阻塞时发送 `kill -9`。测试等待 15 秒真实 lease 过期，要求替代客户端以 `lease_version=2` 接管，并验证死客户端的 version 1 无法追加事件。这是进程级非优雅死亡，不是把时间字段直接改成过去。

发布前还应在 role-separated staging 对真实 Node Worker 做一次：

1. 入队一个无破坏性、可安全恢复的测试 Job，并等它被 victim Worker claim。
2. 记录 checkpoint、effect receipts 和 lease version。
3. 用进程管理器确认准确 PID 后执行 `kill -9 <victim-worker-pid>`；不要用宽泛 `pkill`。
4. 等待 lease 自然过期，让另一个 staging Worker 竞争接管。
5. 验证新 fence 增长、旧 fence 写入被拒绝、Job 只产生一个合法终态，ledger/outbox 不重复。
6. 若 checkpoint 非 resumable 或 effect 状态含歧义，预期结果应是 fail closed，而不是强行成功恢复。

在当前 `all` 拓扑中，Worker 异常退出会使 supervisor 同时终止 Web 并由平台重启整个服务；这证明共置故障域仍存在。只有 `web|worker` 分离的 staging 才能验证独立故障恢复。

### 网络故障注入

仓库当前没有自动部署 chaos proxy，也没有云侧网络故障注入 API。网络演练因此是 staging 操作项，不能写成 CI 已覆盖。推荐使用免费的开源 TCP proxy/容器网络，在 victim Worker 与 Supabase 或测试 provider 之间建立可单独切断的链路；代理本身不随仓库部署。

数据库链路演练需要至少两个分离 Worker：只隔离 victim，replacement 保持可连接。步骤为：

1. 让 victim claim 一个无破坏性测试 Job，记录 lease deadline。
2. 断开 victim 到 Supabase 的链路，保持 Web 和 replacement 可连接；不要修改数据库时间或 lease 字段。
3. 20 秒后确认 victim heartbeat 变 stale；若没有其他队列覆盖，`/api/ready` 应为 503，受保护 metrics 必须反映 stale/missing queue。
4. 等待 120 秒 Job lease 自然过期，确认 victim 停止权威写入，replacement 使用新 fence 接管或按 checkpoint/effect policy fail closed。
5. 恢复网络，确认旧 Worker 不能用旧 fence 提交迟到事件、ledger 或终态。
6. 等待 heartbeat、expired lease、queue age 和 snapshot age 恢复正常。

若 staging Worker 在独立容器和一次性 user-defined network 中，可由操作者使用 `docker network disconnect`/`connect` 隔离该容器；具体 network/container 名称由 staging 决定，仓库不提供可直接复制到生产的破坏性命令。没有分离 Worker 或隔离网络时，不执行此演练，也不把“改错 URL 后启动失败”当作 claim 后网络中断测试。

provider 链路另做一次短断网：切断请求后观察 timeout、退避、取消和已知用量 ledger。对于无法证明幂等的外部副作用，正确结果是 `JOB_RETRY_UNSAFE` 或 dead-letter，而不是重复调用 provider。

### 演练通过标准

| 场景 | 必须观察到 |
| --- | --- |
| SIGKILL | 已 ack checkpoint 的 usage delta 与恢复点同时存在；lease 自然过期；新 fence 增长；旧 fence 写入失败；唯一合法终态 |
| Worker→DB 断网 | heartbeat stale；readiness/metrics fail closed；恢复后安全接管或明确不可恢复终态 |
| Provider 断网 | 有界 timeout/退避；取消可收敛；已知消耗入 ledger；不确定副作用不盲重放 |
| Outbox ack 前死亡 | lock 过期后新 lock version；旧 ack 失败；dedupe/effect receipt 阻止重复副作用 |

任一演练出现双终态、旧 fence 成功、重复外部副作用、未入账的已知用量、dead/orphan 未收敛，发布都不能标记完成。

## 10. 回滚与完成记录

本批迁移不提供生产 down migration。不要回删新表、composite FK、ledger、journal、reservation、checkpoint、outbox 或审计数据，也不要重新授予已经收回的浏览器/旧应用写权限。

兼容边界必须按已执行的最后文件判断：

| 已执行范围 | 允许的应用恢复动作 |
| --- | --- |
| 仅到 `2300` | 可回到经过验证、兼容 runtime v8 的稳定/桥接 revision，保持 planned write freeze 并调查 |
| 已执行 `2400` | 不得恢复 `5068c9b` 接收 Agent/planned writes；保持停写，roll forward 到使用 service-role command boundary 的版本 |
| 已执行 `2600` | 保留 8 MiB payload/storage contract 和生命周期触发器；不得用旧 48 MiB 写入路径重新开放流量 |
| `2700` 部分或全部执行 | 先检查 index/constraint/旧 FK 的真实状态，只能修复并向前完成 composite FK contract |
| 已执行 `2900` | 保留 billing v2、price activation、quote/hash、journal 和 reconciliation；旧 post-paid/browser quota 路径不是回滚目标 |
| 已执行 `3000` | 保留原子 checkpoint/accounting receipt 与不可变 delta；不得恢复可执行的 legacy checkpoint 写路径 |
| 已执行 platform authority v2 | 保留服务端 chat transaction、进程 heartbeat、SSE counter 和 outbox suppression；应用只能 roll forward 到 contract v2 兼容 revision |
| 已执行 v2 seal | `/api/ready` 必须携带精确 version 2 / 45-file tuple；不得删除 v1/v2 attestation 或放宽 verifier 权限 |

应用或 Render 部署失败时：

1. 保持 generation 与 planned command write freeze；如果新版本已经在 drain，绝不先设 `off`。
2. 若仍在 `2300` 前，可选择经过兼容验证的 bridge；`2400` 后统一 roll forward，不能以“旧页面能打开”为兼容证据。
3. 修复走新 PR，重新跑全部 CI、生成新 checksum，并重新核对生产 schema 差异。
4. 新代码因缺少精确 schema contract（其中包含 runtime v15）时 `/api/ready` 必须 503；补齐/修复迁移，不降低 readiness 或绕过 manifest tuple。
5. 第二次解除 drain 部署失败时，恢复 `drain` 并重新部署同一或更新的兼容 revision；确认数据库、reconciliation 和 heartbeat 后再尝试解除。

最终发布记录至少包含：冻结 PR head 与 merge SHA、全部 17 个本批 migration SHA-256、每个实际执行时间和操作者、45-file schema contract v2 的 version/digest/count 及错误 tuple 拒绝证据、`2700` autocommit/索引/约束及 legacy FK 保留证据、runtime v15、chat transaction/CAS/rollback 与 SSE counter 证据、atomic checkpoint replay/冲突证据、billing snapshot 全字段摘要、readiness v3 的 merge revision 与逐队列容量、两次 Render deploy ID、最终线上 revision、stream/metrics secret 已配置的非明文证据、`/api/ready` 与 metrics 结果、烟测 Job ID、任何 redrive/audit request ID、密钥轮换状态、演练证据和未消除的零付费限制。只有全部阻断项清零后才能宣布成功部署。
