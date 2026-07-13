# MyChat 部署指南

## 1. 发布前验证

```bash
npm ci --legacy-peer-deps
npx playwright install chromium
npm run verify
```

`verify` 会依次运行架构门禁、严格 TypeScript、ESLint、带已执行模块覆盖率阈值的单元/集成测试、生产构建和桌面/移动端浏览器冒烟测试，任一步失败都不应部署。

## 2. 数据库迁移

1. 备份 Supabase 数据库。
2. 在预发布项目按文件名顺序执行尚未应用的 `supabase/migrations/*.sql`。
3. 尚未安装基础运行时的环境先按顺序执行 `20260712_chat_generations.sql` 与 `20260713030000_runtime_scaling.sql`。
4. `20260713040000_generation_leases.sql` 会加入 generation lease/fencing、canonical assistant 占位约束、跨实例取消、stale 清理和严格 primitive readiness。它会改变协调 RPC 签名，不能与升级前 runner 混合接收生成流量；生产必须按第 4 节先开启生成维护闸门并排空旧实例，再执行此迁移。
5. 新代码在维护闸门内完成部署且 `/api/ready` 正常后，执行 contract 迁移 `20260713050000_generation_lease_contract.sql`，收回 `chat_generations` 直写权限并隐藏 lease owner/version；再次确认 `/api/ready`。不要在升级前实例仍存活时提前执行 contract。该迁移同时收回浏览器对 messages/conversations 的直接删除权限；新版 History Delete API 会在数据库删除事务内先写持久媒体清理回执，提交后清理对象，失败回执由后续媒体/删除请求重试。
6. 运行下面的只读检查：

```sql
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'redeem_invitation_code', 'record_quota_usage',
    'merge_agent_task_meta', 'merge_agent_run_state',
    'claim_agent_run', 'renew_agent_run', 'release_agent_run',
    'consume_api_rate_limit',
    'claim_chat_generation', 'renew_chat_generation_lease',
    'write_chat_generation_progress', 'finalize_chat_generation',
    'cancel_chat_generation', 'fail_stale_chat_generation',
    'runtime_healthcheck_v2'
  );

select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'chat_generations'
  and column_name in ('lease_owner', 'lease_expires_at', 'lease_version');

select policyname, tablename
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

select
  has_table_privilege('authenticated', 'public.chat_generations', 'INSERT') as can_insert,
  has_table_privilege('authenticated', 'public.chat_generations', 'UPDATE') as can_update,
  has_table_privilege('authenticated', 'public.chat_generations', 'DELETE') as can_delete,
  has_column_privilege('authenticated', 'public.chat_generations', 'status', 'UPDATE') as can_update_status,
  has_column_privilege('authenticated', 'public.chat_generations', 'content', 'UPDATE') as can_update_content,
  has_column_privilege('authenticated', 'public.chat_generations', 'sequence', 'UPDATE') as can_update_sequence,
  has_column_privilege('authenticated', 'public.chat_generations', 'lease_owner', 'SELECT') as can_read_lease_owner,
  has_column_privilege('authenticated', 'public.chat_generations', 'lease_version', 'SELECT') as can_read_lease_version,
  has_function_privilege(
    'authenticated',
    'public.claim_chat_generation(uuid,uuid,uuid,uuid,uuid,integer)',
    'EXECUTE'
  ) as browser_can_claim,
  has_function_privilege(
    'service_role',
    'public.claim_chat_generation(uuid,uuid,uuid,uuid,uuid,integer)',
    'EXECUTE'
  ) as service_can_claim;
-- contract 后除 service_can_claim 为 true 外，其余列都必须为 false
```

迁移包含权限收紧，不要只部署代码而跳过 SQL。应用用户仍可更新个人偏好，但不能直接写入余额或配额字段。

## 3. 生产配置

- 设置 Supabase 和模型 API 密钥。
- 运行时统一使用 Node.js 24 或更高版本；`pdfjs-dist` 等生产依赖不支持 Node.js 20。
- 必须设置仅服务端使用的 `SUPABASE_SERVICE_ROLE_KEY`；它用于共享限流、generation 协调读写和 readiness，绝不能使用 `NEXT_PUBLIC_` 前缀。
- 设置至少 32 字符的 `AGENT_CREDENTIAL_KEY`；自定义模型 API Key 依赖它加密，缺失时端点可以探测但不能保存。
- 启用代码代理时必须设置 `E2B_API_KEY`；没有隔离执行环境时命令执行与验证接口返回 503。
- 启用 GitHub 时设置 OAuth client、`AGENT_PUBLIC_URL` 与强随机 `AGENT_CREDENTIAL_KEY`。
- `AGENT_PUBLIC_URL` 必须与 GitHub OAuth callback 配置的公开域名一致。
- 不要在生产设置或依赖 `ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION`。
- 多实例共享限流、数据库配额、生成 claim/lease/finalize、持久化取消和代码任务租约均为数据库原子操作；生产缺少服务角色或 RPC 时相关接口会 fail-closed 返回 503。
- `GENERATION_MAINTENANCE_MODE=true` 会在读取请求体和调用模型前令 `/api/chat` 返回带 `Retry-After` 的 503；它只用于 generation schema 发布窗口，完成 contract 验证前不得关闭。
- 公网部署只应连接服务器可达的公网 HTTPS 模型端点。自托管且确需局域网模型时，用 `MODEL_ENDPOINT_PRIVATE_ALLOWLIST` 精确列出 `host:port`；不要配置宽泛私网访问。
- 图片和视频可以通过 `DEEP_TIER_IMAGE_*`、`DEEP_TIER_VIDEO_*` 使用独立端点；未配置时才回退 `DEEP_TIER_*`。生产媒体服务应使用长期可用的域名，不要依赖临时 ngrok 隧道。

GitHub cookie 现在绑定 Supabase 用户。升级前创建的旧 cookie 不包含绑定信息，用户需要断开并重新连接 GitHub，这是预期的安全迁移行为。

## 4. 发布顺序

1. 数据库备份。
2. 在预发布环境依次验证 `040000` expand → 新应用 → `050000` contract，并完成验收清单。
3. 先部署只包含 `GENERATION_MAINTENANCE_MODE` 闸门的兼容桥接版本，保持变量未设置或为 `false`；确认该 revision 已完全 live。Render Free 不提供平台 Maintenance Mode，因此不能跳过这个应用级桥接版本。
4. 把 `GENERATION_MAINTENANCE_MODE` 设为 `true` 并重新部署桥接版本。确认任意 `POST /api/chat` 在解析 body 前返回 503，再等待平台完成旧实例的 SIGTERM/强制退出周期；这是一次有意的短 generation maintenance window，不是零停机发布。
5. 保持闸门开启，生产执行 `20260713040000_generation_leases.sql`；确认 `runtime_healthcheck_v2()` 返回 true，service role 可执行 claim，而 authenticated 不可执行协调 RPC。
6. 部署完整新应用。保持闸门开启，等待桥接实例彻底退出，并确认 `/api/health`、`/api/health?ready=1` 和 `/api/ready` 均为 200。
7. 生产执行 `20260713050000_generation_lease_contract.sql`，再次确认 `runtime_healthcheck_v2()` 与 `/api/ready`，并验证 authenticated 的 generation 表 INSERT/UPDATE/DELETE、lease owner/version SELECT 和全部协调 RPC EXECUTE 权限均为 false。
8. 将 Render Health Check Path 设为 `/api/ready`。只有以上检查全部成功后，才把 `GENERATION_MAINTENANCE_MODE` 改为 `false` 并部署；此时滚动重叠的两代实例都已使用 lease 协议。
9. 检查普通聊天、取消、断线恢复和代码任务各一条。分别验证图片与视频端点；不要只用 `/models` 或聊天接口判断媒体能力。
10. 观察模型错误率、429/503、数据库协调 RPC 错误、SSE admission 拒绝、E2B 启动失败和 GitHub 401/422。

若 expand 迁移失败，保持闸门开启；事务回滚后修复并重试。若完整应用在 expand 后部署失败，只能回到仍开启闸门的桥接版本继续修复，不能重新开放升级前 runner。contract 失败时同样保持闸门与新应用，修复权限迁移后再开放流量。

## 5. 媒体端点故障排查

出现 `ERR_NGROK_3200` 时，上游返回的 404 表示 ngrok 隧道离线；这与图片提示词、模型 ID、鉴权头或 MyChat 路由无关。处理顺序：

1. 在提供反代的主机上确认服务进程仍监听原端口，并重启 ngrok 隧道。
2. 若 ngrok 生成了新域名，在 Render/Vercel 中更新对应 Base URL；图片优先更新 `DEEP_TIER_IMAGE_BASE_URL`，视频优先更新 `DEEP_TIER_VIDEO_BASE_URL`。
3. 长期生产应把媒体反代迁移到固定 HTTPS 域名。保留 `DEEP_TIER_BASE_URL` 给深度聊天，不必让聊天与媒体共用一个临时隧道。
4. 重新部署后直接调用目标 `/v1/images/generations` 或视频创建接口做冒烟测试，再从 MyChat 前端复测。

不要把 API Key 写入仓库、日志或截图。Render Blueprint 中 `sync: false` 的变量仍需在控制台填入真实值。

## 6. 运行时边界

- `/api/chat`：最大 48 MB，最多 500 条消息，并限制文本、图片和上下文总量。
- `/api/chat/title`：归属校验后的单轮无工具标题任务，不进入可重放 Agent 流程。
- `/api/health`：默认仅报告进程存活；`?ready=1` 额外验证服务角色、数据库连接和运行时迁移。
- `/api/ready`：严格 readiness；任一生产运行时数据库原语（包括 generation lease/finalization）缺失都会返回 503，并作为 Render 健康探针。
- `/api/code/chat`：最大 4 MB，服务端持有任务租约，限制代理轮次、续跑次数和空转次数。
- 工作区写入、补丁、执行、快照、恢复和发布都校验任务归属。
- 发布只允许受控的 commit → push → PR 流程；高风险路径需要确认，危险路径会直接阻断。
- URL 抓取拒绝 localhost、私网地址和带凭据 URL，并设置超时。
