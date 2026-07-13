# MyChat

MyChat 是一个基于 Next.js 16、Supabase、DeepSeek/MiMo、E2B 和 GitHub 的对话与代码代理应用。后端负责认证、配额、模型流式调用、历史检索、任务状态机、隔离执行、工作区快照以及 Pull Request 发布。

## 本地启动

要求 Node.js 20+，然后执行：

```bash
npm install
npm run dev
```

提交前运行完整验证：

```bash
npm run verify
```

## 环境变量

必需：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
DEEPSEEK_API_KEY=
MIMO_API_KEY=
```

按功能启用：

```dotenv
# 联网检索
TAVILY_API_KEY=

# GitHub OAuth 与 PR 发布
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
AGENT_PUBLIC_URL=https://your-domain.example
AGENT_CREDENTIAL_KEY=至少32字节的随机密钥（同时用于加密自定义模型 Key）

# 生产代码代理必须使用隔离执行
E2B_API_KEY=
E2B_TEMPLATE=

# 可选：语义历史检索；未配置时自动使用关键词检索
OPENAI_API_KEY=
EMBEDDING_BASE_URL=
EMBEDDING_MODEL=
EMBEDDING_DIMENSIONS=

# 深度聊天反代
DEEP_TIER_BASE_URL=https://your-stable-proxy.example/v1
DEEP_TIER_API_KEY=
DEEP_TIER_MODEL=grok-4
DEEP_TIER_AUTH_TYPE=bearer

# 可选：图片/视频使用独立稳定端点；缺失时回退上面的 DEEP_TIER_* 配置
DEEP_TIER_IMAGE_BASE_URL=https://your-stable-media-proxy.example/v1
DEEP_TIER_IMAGE_API_KEY=
DEEP_TIER_IMAGE_AUTH_TYPE=bearer
DEEP_TIER_IMAGE_MODEL=grok-imagine-image-quality

DEEP_TIER_VIDEO_BASE_URL=https://your-stable-media-proxy.example/v1
DEEP_TIER_VIDEO_API_KEY=
DEEP_TIER_VIDEO_AUTH_TYPE=bearer
DEEP_TIER_VIDEO_MODEL=grok-imagine-video-1.5

```

生产环境不要把临时 ngrok 隧道作为模型或媒体服务地址。出现 `ERR_NGROK_3200` 表示隧道已经离线，不是图片提示词或模型 ID 错误；应重启并固定隧道，或把 Render/Vercel 中的 `DEEP_TIER_IMAGE_BASE_URL`（以及视频对应变量）切换为长期可用的 HTTPS 端点。媒体专用变量与深度聊天反代相互独立，可避免一个临时隧道同时拖垮聊天、图片和视频。


`ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION=true` 只允许在非生产开发环境临时启用本机命令执行。生产环境即使设置该值也不会生效；代码代理执行命令必须配置 `E2B_API_KEY`。

## 自定义模型

设置页的「模型」可以连接 OpenAI-compatible 服务。填写 Base URL 和 API Key 后，应用会读取标准 `/models` 并提供下拉选择；模型名称只用于给出「对话 / 图片 / 视频」用途建议，用户可以明确覆盖，因此 `canvas-v2` 等非典型名称也能作为媒体模型。对话模型保存前会执行真实流式 `/chat/completions` 探测；媒体模型会重新验证模型列表、地址和鉴权，实际生成时再调用对应媒体接口。聊天请求只发送端点 ID，API Key 使用 `AGENT_CREDENTIAL_KEY` 加密后存储，不会返回浏览器。

图片模型使用 `POST /images/generations`，兼容 `data[].b64_json`、图片 URL 和完成型 SSE；视频模型使用 OpenAI-style `POST /videos`、`GET /videos/{id}` 和 `GET /videos/{id}/content`。媒体 URL 会由服务端按网络策略下载、校验并转换为不超过 12 MiB 的数据，再作为独立媒体事件显示；跨域下载不会携带端点 Key。图片保持原比例，视频读取真实宽高比、使用原生 controls，并在桌面和窄屏下 `object-contain`。普通聊天响应里的结构化 `image_url`、`output_image` 和 `video_url` 内容也会被识别。厂商自定义的非 OpenAI 视频任务协议不在自动兼容范围内。

兼容范围是运行 MyChat 的服务器能够访问、并实现 OpenAI-compatible `/models` 与 `/chat/completions` 的服务。携带 API Key 的公网服务在生产环境必须使用 HTTPS，避免凭据被明文传输。`192.168.x.x`、`10.x.x.x` 和 localhost 等私网地址在同一局域网内本地运行 MyChat 时可用，Render/Vercel 等公网云服务无法访问用户家中的私网地址。自托管生产如需访问私网模型，使用精确白名单：

```dotenv
MODEL_ENDPOINT_PRIVATE_ALLOWLIST=192.168.1.20:8080
```

不要在公网托管环境放开任意私网地址。没有 `/models` 的服务仍可在「高级设置」填写模型 ID：对话模型会执行真实聊天探测；图片和视频模型会保存连接配置，并在首次生成时验证媒体接口。媒体服务没有可用模型列表且鉴权设为「自动」时，有 Key 默认使用 Bearer、无 Key 默认使用无鉴权；使用 `x-api-key` 或 `api-key` 的服务应在高级设置明确选择。模型列表可见不代表账号已获得媒体生成权限，上游返回的权限错误会在生成时原样脱敏展示。

## 数据库

已有数据库按文件名顺序应用 [`supabase/migrations`](supabase/migrations) 中尚未执行的迁移。此次后端重构必须应用：

```text
supabase/migrations/20260710000000_backend_integrity_hardening.sql
supabase/migrations/20260711000000_custom_model_endpoints.sql
```

它增加原子配额、邀请码兑换、任务租约和元数据合并函数，同时收紧 RLS 与 profile 列权限。代码部署前必须先备份数据库并在预发布环境执行迁移。

全新数据库先执行 `supabase/schema.sql` 和 `supabase/agent-tasks.sql`，再按文件名顺序执行所有迁移。`supabase` 根目录下的其他零散 SQL 是旧版手工脚本，不应与完整基线重复执行。

## 架构与部署

- [后台架构说明](BACKEND_ARCHITECTURE.md)
- [部署指南](DEPLOYMENT_GUIDE.md)
- [验收清单](TEST_CHECKLIST.md)

安全约束：所有用户数据必须同时经过服务端归属过滤和 Supabase RLS；客户端不能直接修改余额与配额；外部网页内容一律视为不可信；工作区文件操作不得越过 workspace 根目录或穿过符号链接；GitHub 会话与当前 Supabase 用户绑定。
