# MyChat 部署指南

## 1. 发布前验证

```bash
npm ci
npm run verify
```

`verify` 会依次运行严格 TypeScript 检查、测试和生产构建，任一步失败都不应部署。

## 2. 数据库迁移

1. 备份 Supabase 数据库。
2. 在预发布项目按文件名顺序执行尚未应用的 `supabase/migrations/*.sql`。
3. 本次版本必须依次执行 `20260710000000_backend_integrity_hardening.sql` 和 `20260711000000_custom_model_endpoints.sql`。
4. 运行下面的只读检查：

```sql
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'redeem_invitation_code', 'record_quota_usage',
    'merge_agent_task_meta', 'merge_agent_run_state',
    'claim_agent_run', 'renew_agent_run', 'release_agent_run'
  );

select policyname, tablename
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

迁移包含权限收紧，不要只部署代码而跳过 SQL。应用用户仍可更新个人偏好，但不能直接写入余额或配额字段。

## 3. 生产配置

- 设置 Supabase 和模型 API 密钥。
- 设置至少 32 字符的 `AGENT_CREDENTIAL_KEY`；自定义模型 API Key 依赖它加密，缺失时端点可以探测但不能保存。
- 启用代码代理时必须设置 `E2B_API_KEY`；没有隔离执行环境时命令执行与验证接口返回 503。
- 启用 GitHub 时设置 OAuth client、`AGENT_PUBLIC_URL` 与强随机 `AGENT_CREDENTIAL_KEY`。
- `AGENT_PUBLIC_URL` 必须与 GitHub OAuth callback 配置的公开域名一致。
- 不要在生产设置或依赖 `ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION`。
- 多实例部署应把当前进程内 API 限流替换为 Redis/网关级共享限流；数据库配额和代码任务租约已经是跨实例原子的。
- 公网部署只应连接服务器可达的公网 HTTPS 模型端点。自托管且确需局域网模型时，用 `MODEL_ENDPOINT_PRIVATE_ALLOWLIST` 精确列出 `host:port`；不要配置宽泛私网访问。

GitHub cookie 现在绑定 Supabase 用户。升级前创建的旧 cookie 不包含绑定信息，用户需要断开并重新连接 GitHub，这是预期的安全迁移行为。

## 4. 发布顺序

1. 数据库备份。
2. 在预发布环境执行迁移并完成验收清单。
3. 执行生产迁移。
4. 部署应用代码。
5. 检查 `/api/github/status`、普通聊天和代码任务各一条。
6. 观察模型错误率、429、数据库 RPC 错误、E2B 启动失败和 GitHub 401/422。

若迁移失败，停止代码发布并从数据库备份恢复。若代码发布失败但迁移成功，回滚应用版本；新增 RPC 与列保持向后兼容，旧应用可以继续运行。

## 5. 运行时边界

- `/api/chat`：最大 48 MB，最多 500 条消息，并限制文本、图片和上下文总量。
- `/api/code/chat`：最大 4 MB，服务端持有任务租约，限制代理轮次、续跑次数和空转次数。
- 工作区写入、补丁、执行、快照、恢复和发布都校验任务归属。
- 发布只允许受控的 commit → push → PR 流程；高风险路径需要确认，危险路径会直接阻断。
- URL 抓取拒绝 localhost、私网地址和带凭据 URL，并设置超时。
