# MyChat

**Build and ship real software from your phone.**<br>
**只用手机完成真实软件开发与上线，不需要电脑。**

[Live demo](https://mychat-nm6x.onrender.com/) · [OpenAI Build Week submission notes](docs/BUILD_WEEK_SUBMISSION.md) · [Architecture](docs/architecture.md)

MyChat is a mobile-first AI workspace for conversation and real software delivery. Its standout feature, **Code**, turns a phone into the command center for an end-to-end development loop backed by GitHub and an isolated cloud sandbox.

## The standout feature: Code

> **Your phone is the command center. The cloud sandbox is the computer.**

Most coding agents still assume that a developer is sitting at a laptop with an editor and terminal open. MyChat Code removes that dependency. From a mobile browser, a user can:

1. connect GitHub and open an existing repository, or describe a new project;
2. ask the agent to inspect the codebase, plan a change, edit files, and run commands and tests in an E2B sandbox;
3. follow durable, reconnectable progress from a phone, including after a mobile network interruption;
4. review security-sensitive actions and the final publication step; and
5. commit and push the result, open a Pull Request, and deploy supported projects without opening a laptop.

This is not a remote desktop or a miniature mobile IDE. The user expresses intent and makes the important decisions; the cloud runtime performs the heavy development work against a real repository.

## Judge quick start

1. Open the [live demo](https://mychat-nm6x.onrender.com/) on a phone or desktop browser.
2. Choose **“以游客身份继续”** (Continue as guest) to enter without creating an account.
3. Open **“代码”** (Code) from the sidebar.
4. Connect a GitHub account, select a disposable test repository or start a new project, then describe the outcome you want.
5. Watch the task progress, inspect the proposed publication action, and confirm only when ready.

Code requires GitHub authorization because its output is a real repository change. No sample dataset is required. The primary interface is designed for current iOS/Android browsers, with desktop Chrome, Safari, Firefox, and Edge also supported.

## Built with Codex and GPT-5.6

Codex running GPT-5.6 Sol was used as the implementation and review partner for the Build Week work. It accelerated architecture tracing, cross-layer implementation, PostgreSQL migrations, failure-mode analysis, test generation, CI hardening, and release verification.

The human decisions remained the product direction and trust boundaries: making the phone the control surface, keeping GitHub as the publication source of truth, isolating execution in E2B, requiring confirmation before consequential publication, and choosing which reliability trade-offs were acceptable on a single free deployment service.

MyChat's runtime models are configurable and are separate from the Build Week development workflow. GPT-5.6 was used through Codex to build and harden the project.

## OpenAI Build Week scope

MyChat existed before the event and was meaningfully extended during Build Week. The separation is intentionally explicit:

| Scope | Before July 13, 2026 | Built or substantially hardened during Build Week |
| --- | --- | --- |
| Product | Working chat experience, model routing, history, an early mobile Code workflow, and GitHub integration | Mobile Code flow prepared for reliable real-world delivery, clearer publication state, and production judge access |
| Agent runtime | Request-scoped agent execution and basic workspace operations | Database-authoritative jobs, leases, fencing, cancellation, checkpoint recovery, idempotent tool effects, and outbox redrive |
| Mobile reliability | Responsive interface | Durable event history, reconnectable SSE, revision-scoped worker readiness, and recovery after transient mobile/network disconnects |
| Security | Authentication, RLS, path boundaries, and basic GitHub controls | E2B-only production execution, encrypted credentials, private media validation, confirmation gates, CodeQL, secret scanning, dependency review, and release evidence |
| Operations | Single-service deployment | Health/readiness contracts, observability, container verification, migration gates, drain/promotion controls, and schema attestation |

The pre-event baseline is commit [`c1f22de`](https://github.com/aa339519589-cpu/mychat/commit/c1f22de9da5f7806e39517933e12850de1ed70eb). The main Build Week implementation is visible in [PR #25](https://github.com/aa339519589-cpu/mychat/pull/25), [PR #26](https://github.com/aa339519589-cpu/mychat/pull/26), [PR #27](https://github.com/aa339519589-cpu/mychat/pull/27), [PR #36](https://github.com/aa339519589-cpu/mychat/pull/36), and the subsequent release commits. A baseline-to-current comparison contains more than 47,000 insertions across hundreds of files.

## Local setup

Requirements: Node.js 24+, a Supabase project, and the provider credentials for the features you want to run. Production Code execution also requires E2B and GitHub OAuth.

```bash
npm install --legacy-peer-deps
cp .env.example .env.local
npm run dev
```

Run the complete validation suite before publishing:

```bash
npm run verify
```

The latest release evidence recorded in [PR #36](https://github.com/aa339519589-cpu/mychat/pull/36) and [PR #38](https://github.com/aa339519589-cpu/mychat/pull/38) includes 583 automated tests, 6 Playwright end-to-end tests, PostgreSQL 16 migration checks, production builds, coverage gates, and an npm audit with zero known vulnerabilities.

Architecture, deployment, and acceptance-test documents are linked in the Chinese technical documentation below. The project is released under the [MIT License](LICENSE).

See [`.env.example`](.env.example), [the deployment guide](DEPLOYMENT_GUIDE.md), and [the test checklist](TEST_CHECKLIST.md) for the full setup.

The authoritative Codex interaction evidence is the `/feedback` Session ID supplied in the Devpost form; private session transcripts are not committed to this public repository.

---

## 中文技术文档

MyChat 是一个基于 Next.js 16、Supabase、DeepSeek/MiMo、E2B 和 GitHub 的对话与代码代理应用。后端负责认证、配额、模型流式调用、历史检索、任务状态机、隔离执行、工作区快照以及 Pull Request 发布。

## 本地启动

要求 Node.js 24+，然后执行：

```bash
npm install --legacy-peer-deps
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

图片模型使用 `POST /images/generations`，兼容 `data[].b64_json`、图片 URL 和完成型 SSE；视频模型使用 OpenAI-style `POST /videos`、`GET /videos/{id}` 和 `GET /videos/{id}/content`。上游媒体只在服务端下载，经过 SSRF、DNS、重定向、MIME 和 10 MiB 流式大小校验后上传到 `generated-media/{user}/{conversation}/{generation}/`；跨域下载不会携带端点 Key，只有数据库终态确认的持久 HTTPS URL 才会发给浏览器并进入历史记录。图片保持原比例，视频读取真实宽高比、使用原生 controls，并在桌面和窄屏下 `object-contain`。普通聊天响应里的结构化 `image_url`、`output_image` 和 `video_url` 内容也会被识别。厂商自定义的非 OpenAI 视频任务协议不在自动兼容范围内。

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
supabase/migrations/20260712_chat_generations.sql
supabase/migrations/20260713030000_runtime_scaling.sql
supabase/migrations/20260713040000_generation_leases.sql
supabase/migrations/20260713050000_generation_lease_contract.sql
```

它增加原子配额、邀请码兑换、任务租约、共享限流、generation claim/lease/fencing、跨实例生成取消、媒体终态引用和元数据合并函数，同时收紧 RLS 与 profile 列权限。Generation 协调 RPC 仅允许 service role；claim 会校验 canonical assistant 占位的 user、conversation 与 role，contract 阶段还会隐藏 lease owner/version 并收回浏览器对会话和消息的直接删除权限。新版历史删除 API 会校验用户与媒体对象作用域，在数据库删除事务内写入持久清理回执，再清理对象存储并重试失败任务。生产升级使用 expand-contract：先部署并开启兼容维护闸门、排空旧 runner，再执行 `040000`；新版本健康后执行 `050000` 收回 generation 表直写权限。全新数据库仍按文件名一次执行。生产还必须配置仅服务端可见的 `SUPABASE_SERVICE_ROLE_KEY`，生成媒体会在服务端上传对象存储后才写入权威终态。

全新数据库先执行 `supabase/schema.sql` 和 `supabase/agent-tasks.sql`，再按文件名顺序执行所有迁移。`supabase` 根目录下的其他零散 SQL 是旧版手工脚本，不应与完整基线重复执行。

## 架构与部署

- [整体架构与自动化边界](docs/architecture.md)
- [后台架构说明](BACKEND_ARCHITECTURE.md)
- [部署指南](DEPLOYMENT_GUIDE.md)
- [验收清单](TEST_CHECKLIST.md)

安全约束：所有用户数据必须同时经过服务端归属过滤和 Supabase RLS；客户端不能直接修改余额与配额；外部网页内容一律视为不可信；工作区文件操作不得越过 workspace 根目录或穿过符号链接；GitHub 会话与当前 Supabase 用户绑定。
