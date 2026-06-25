# MyChat 后台架构审查报告

**审查日期**: 2026-06-24  
**审查范围**: `/Users/paopaopaopao/mychat` 全部源代码（含 lib/、app/api/、components/、supabase/）  
**审查方法**: 主审查 + 4 个并行 Agent（数据层、LLM/Agent 层、API/安全层、前端层）交叉验证

---

## 一、总体评估

### 架构健康度: 4.5/10（下调自初次评估的 5.5，因 Agent 交叉审查发现了额外的严重问题）

**一句话总结**: 这是一个快速迭代的产品原型，核心功能运作良好，但架构债已经在拖慢开发速度。代码里到处是"能用但不优雅"的补丁，架构上没有清晰的模块边界。

### 优势
1. **LLM 层抽象较好** — `runAgentLoop` / `runTurn` / `stream` 三层分离清晰，chat 和 code 两个路由共用同一个 agent loop，避免了核心循环的分叉
2. **工具注册表模式** (`lib/tools/index.ts`) — 新增工具只需加文件和注册，route 层无需改动
3. **RLS 安全模型一致** — 所有 Supabase 表都开启了行级安全，数据隔离靠数据库层面保证
4. **Guard 层收敛** — `lib/api/guard.ts` 把鉴权+限流+额度三条闸门收敛到一处，路由层只需两行调用

### 核心问题
1. **三个 God Component** — `literary-chat.tsx` 937 行、`app-sidebar.tsx` 1312 行、`code-console.tsx` 977 行，三个文件承载了整个前端的所有逻辑
2. **数据层 God Module** — `db.ts` 405 行，6 个域的所有 CRUD 堆在一个文件里
3. **Chat/Code 双轨割裂** — 两套独立的表、类型、数据访问层，但模式几乎相同，明显是复制粘贴后分叉；SSE 流式解析、Markdown 渲染均重复实现
4. **DSML 解析是整个系统最大的补丁** — `sanitize.ts` 237 行的正则地狱，只为处理 DeepSeek 模型把工具调用标记泄漏到正文的问题
5. **Schema 迁移混乱** — profiles 表有重复的旧额度列、code_messages 的列名在 schema.sql 和 code.sql 之间不一致（`plan` vs `meta`）、images JSONB 有两种格式
6. **严重安全漏洞** — `/api/code/sandbox` 无鉴权无限制可执行命令；进程内 execSync 暴露所有环境变量（含 API Key）；仅 2 个 API 端点有限流保护

---

## 二、严重问题 (Critical/High)

### [CRITICAL] 1. `literary-chat.tsx` — 937 行 God Component

**文件**: `components/literary-chat.tsx` (937 行)

**问题描述**:
这个组件同时管理以下所有关注点：
- 用户认证状态 (user, authChecked)
- 对话列表 CRUD (conversations, activeId, draftIdRef)
- 记忆 CRUD (memories, memoryEnabled)
- 项目管理 (projects, projectCtxRef)
- AI 流式响应 (runAiStream — 150 行)
- 标题自动生成 (generateTitle)
- 艺术品面板 (openArtifactId)
- 代码板块切换 (codeOpen)
- 模式选择 (activeTier, webSearch, deepResearch)
- 侧栏折叠状态 (sidebarCollapsed, drawerOpen)
- 回复引用 (replyTo)
- 顶部菜单 (headerMenuAnchor, headerRenaming)
- 文件上传 (AttachedFile)
- 桌面/移动双布局渲染

没有任何自定义 hook 被提取出来。没有任何状态管理库（Context、Zustand、Jotai 等）。所有状态都是 `useState` + prop drilling。

**风险**: 
- 任何改动都可能影响不相关的功能
- 无法单独测试任何逻辑
- 新人需要理解全部 937 行才能改一个功能
- 性能问题：大量 setState 导致不必要的重渲染

**建议**: 
拆分为多个自定义 hook：`useAuth` → `useConversations` → `useMemories` → `useProjects` → `useAiStream` → `useArtifact`。每个 hook 只暴露必要的 state 和 actions。

---

### [CRITICAL] 2. DSML 解析系统 — 237 行正则地狱

**文件**: `lib/llm/sanitize.ts` (237 行) + `lib/llm/turn.ts:108-112` (DSML fallback 解析) + `lib/llm/agent-loop.ts:59-84` (leakedRetry 逻辑)

**问题描述**:
DeepSeek v4-pro 存在已知缺陷：工具调用标记（DSML 格式，如 `<｜tool▁calls▁begin｜>` `<｜DSML｜invoke name="web_search">` 等）作为文本 token 泄漏到 content 通道中，而非标准的 `tool_calls` 字段。

整个系统为此打了三层补丁：

1. **sanitize.ts 流式过滤器** (`makeContentFilter`): 在 SSE 流输出时实时剥离 DSML 标记，包括全角/半角竖线、双引号/单引号/无引号属性、裸 XML 退化格式
2. **sanitize.ts DSML 解析器** (`parseDsmlToolCalls`): 如果标准 tool_calls 为空，从 rawContent 中用 6 种正则模式解析出工具调用
3. **agent-loop.ts 泄漏重试** (`leakedRetry`): 如果检测到泄漏但没有工具调用，关闭工具让模型重述一轮纯文本，然后继续

`sanitize.ts` 包含：
- 5 组成对标记规则（PAIR_RULES）
- 5 个独立标记正则（STANDALONE_RES）
- 5 个孤立标签正则（ORPHAN_RES）
- 6 种 invoke 模式匹配
- 5 种 parameter 模式匹配
- 裸 XML 退化格式兜底（匹配 13 个已知工具名）

**风险**:
- DSML 格式是 DeepSeek 未文档化的内部行为，随时可能变化
- 正则维护成本极高——任何新的标记变体都需要新增正则
- 如果 DeepSeek 修复了这个问题，整个 sanitize.ts 和 leakedRetry 逻辑变成死代码
- parseDsmlToolCalls 的性能：6 个 invoke 正则 × 5 个 parameter 正则 = 每次调用 30 次正则扫描

**建议**:
1. 优先向 DeepSeek 反馈此问题，推动上游修复
2. 如果上游短期内不修复，将 DSML 解析逻辑独立为一个 npm 包，加完整测试
3. 增加监控：统计 DSML 泄漏频率，一旦上游修复可以快速移除

---

### [HIGH] 3. `db.ts` — 405 行 God Module

**文件**: `lib/db.ts`

**问题描述**:
一个文件包含 6 个数据域的完整 CRUD 操作：
- 用户档案（fetchProfile, ensureProfile, setMemoryEnabled, fetchQuota）
- 记忆（fetchMemories, insertMemory, updateMemory, deleteMemoryRow）
- 对话（fetchConversations, insertConversation, updateConversationTitle, deleteConversationRow, setConversationStarred/Pinned/Project, touchConversation）
- 消息（fetchMessages, insertMessage, deleteMessageRow）
- 项目（fetchProjects, insertProject, updateProject, deleteProjectRow）
- 项目资料（fetchProjectFiles, insertProjectFile, deleteProjectFileRow）
- 项目记忆（fetchProjectMemories, insertProjectMemory, updateProjectMemory, deleteProjectMemoryRow）
- 项目上下文（fetchProjectContext）

所有函数都是同样的模式：`createClient()` → 调用 Supabase → 映射字段 → 错误 console.error。重复度极高。

**建议**: 按数据域拆分为 `lib/data/memories.ts`, `lib/data/conversations.ts`, `lib/data/projects.ts` 等，每个文件只暴露 CRUD 函数。

---

### [HIGH] 4. Chat/Code 双轨完全割裂

**问题描述**:
Chat 模块和 Code 模块有几乎相同的结构，但完全独立实现：

| 关注点 | Chat 模块 | Code 模块 |
|--------|-----------|-----------|
| 会话表 | `conversations` | `code_sessions` |
| 消息表 | `messages` | `code_messages` |
| 记忆表 | `memories` | `code_memories` |
| 类型定义 | `chat-data.ts` | `code-data.ts` |
| 数据访问 | `db.ts` (含在 God Module 中) | `code-data.ts` (独立文件，但模式不同) |
| API 路由 | `/api/chat/route.ts` (165行) | `/api/code/chat/route.ts` (577行) |
| 前端组件 | `literary-chat.tsx` | `code-console.tsx` |
| 工具定义 | `lib/tools/` 注册表 | 路由内 `tools` 数组硬编码 |
| 模型选择 | 通过 TIER_MAP | 硬编码 DEEPSEEK |

**关键差异**:
- Code 路由的工具是硬编码在路由文件里的 (231-244行)，而 Chat 路由使用 `activeTools()` + `toOpenAITools()` 注册表
- Code 路由有完整的 workspace 管理系统，Chat 路由完全没有
- Code 路由自己处理 GitHub token（读 cookie），不走 guard 层

**风险**: 
- 两边行为漂移——修了 Chat 的 bug 但 Code 里同样的逻辑没修
- Code 路由的 577 行包含了太多关注点：鉴权、workspace 创建、工具定义、工具执行、流式响应

**建议**: 
- 统一工具定义为注册表模式（Code 路由不要硬编码）
- 提取共享的流式响应处理逻辑
- Code 路由拆分：路由 → workspace 管理 → 工具执行 各司其职

---

### [HIGH] 5. Profiles 表 Schema 混乱

**文件**: `supabase/schema.sql:86-108`

**问题描述**:
`profiles` 表同时存在两套额度列：
```sql
-- 新列（代码实际使用）
tokens_5h bigint, window_5h_start timestamptz,
tokens_7d bigint, window_7d_start timestamptz,
balance bigint

-- 旧列（注释说"兼容过渡期"）
pool_5h_used bigint, pool_5h_reset_at timestamptz,
pool_week_used bigint, pool_week_reset_at timestamptz
```

`quota.ts` 的代码只读写新列，旧列完全没有被引用。这是一次改名后没清理干净的迁移残留。

**建议**: 
1. 确认旧列确实无代码使用
2. 写一个 migration 将旧列数据迁移到新列（如果有）
3. DROP 旧列

---

### [HIGH] 6. Images JSONB 格式不统一

**文件**: `lib/db.ts:240-244`

**问题描述**:
`messages.images` 列在数据库中可能存储两种格式：
- 旧格式: `["url1", "url2"]` (string[])
- 新格式: `{refs: ["url1", "url2"], image_summary: "..."}` (object)

`fetchMessages` 中的类型守卫代码：
```typescript
const images = Array.isArray(stored)
  ? stored.filter(...)           // 旧格式
  : Array.isArray((stored as any)?.refs)
    ? (stored as any).refs...    // 新格式
    : undefined
```

这是没有 migration 的在线格式演进。

**建议**: 写一个 migration 将所有旧格式数据转为新格式，然后简化代码中的类型守卫。

---

### [CRITICAL] 7. `schema.sql` 与独立 `.sql` 文件存在数据不一致（Agent 审查发现）

**文件**: `supabase/schema.sql` vs `supabase/code.sql` vs `supabase/project_memories.sql`

**问题描述**:
Agent 逐文件对比发现了 3 处确凿的 schema 冲突：

**(a) `code_messages` 列名分歧 — 硬断裂**
- `schema.sql:199`: code_messages 使用 `plan jsonb`
- `code.sql:39`: code_messages 使用 `meta jsonb`
- `code-data.ts:104-108`: 代码实际读写的是 `meta` 字段，不是 `plan`
- **后果**: 如果有人直接跑 schema.sql 建表，Code 板块的消息持久化全部静默失败

**(b) `project_memories` 缺少 `updated_at` 列**
- `schema.sql:210-216`: 仅 5 列，**没有 `updated_at`**
- `project_memories.sql:4-11`: 有 `updated_at timestamptz DEFAULT now()`
- `db.ts:355,377`: 代码读写 `updated_at` 字段
- **后果**: 若表由 schema.sql 创建，updateProjectMemory 的写入会静默失败

**(c) RLS 策略命名不一致**
- `schema.sql`: 使用 `code_sessions_select`、`code_messages_select`
- `code.sql`: 使用 `code_sessions_select_own`、`code_messages_select_own`
- schema.sql 的 code_messages 缺少 delete 策略；code.sql 有

**建议**: 
1. 立即修正 schema.sql:199 将 `plan jsonb` 改为 `meta jsonb`
2. 补充 `project_memories` 的 `updated_at` 列
3. 统一 RLS 策略命名
4. 根本上：淘汰独立 .sql 文件，仅保留 `schema.sql` + `migrations/`。独立文件保留仅用于文档参考

---

### [CRITICAL] 8. `/api/code/sandbox` 完全无鉴权、无限流 — 可被匿名滥用（Agent 审查发现）

**文件**: `app/api/code/sandbox/route.ts:4-15`

**问题描述**:
该端点直接接收 `command` 和 `files` 参数，调用服务端 `execSync` 执行命令。**没有任何 `resolveAuth()` 调用，没有 `enforceLimits()`，没有 cookie 校验**。任何知道 URL 的人都可以发送任意命令。

同时 `lib/sandbox.ts` 的 `execSync` 在服务器进程内执行，可以访问 `process.env`（包含 `DEEPSEEK_API_KEY`、`GITHUB_CLIENT_SECRET`、`SUPABASE_SERVICE_ROLE_KEY` 等）。攻击者通过 `node -e "console.log(process.env)"` 即可泄露所有密钥。

**建议**:
1. 立即添加鉴权和限流，或直接移除此端点（Code Chat 路由已有内联工具执行）
2. 将 `node -e` 从白名单移除或严格限制
3. 执行前过滤环境变量，只传必要的最小集合

---

### [CRITICAL] 9. `app-sidebar.tsx` (1312行) 和 `code-console.tsx` (977行) — 另外两个 God Component

**文件**: `components/app-sidebar.tsx` (1312行), `components/code-console.tsx` (977行)

**问题描述**:
Agent 审查发现，除了 `literary-chat.tsx` 的 937 行，还有两个同样严重的 God Component：

- **app-sidebar.tsx**: 1312 行，包含设置页（记忆管理+额度展示）、项目列表页、项目详情页（记忆/指令/资料三段卡片）、会话行、弹层菜单、邀请码兑换购买页面——全部内联在一个文件中
- **code-console.tsx**: 977 行，包含 GitHub 连接、仓库选择、消息发送、Agent 任务创建、SSE 流式响应、Workspace PR 发布、Plan 确认执行、6 个覆盖层子组件、甚至**内联实现了 LCS diff 算法**（`computeDiff`、`DiffBody`）

**建议**: 
- `app-sidebar.tsx` → 拆分为 `SettingsScreen`, `MemoryScreen`, `QuotaScreen`, `ProjectsScreen`, `ProjectDetailScreen`, `ConversationRow`, `PopoverMenu` 等 10+ 个独立文件
- `code-console.tsx` → `computeDiff`/`DiffBody` 提取到 `@/lib/diff`；`Shell`, `RepoPicker`, `ModelOverlay`, `MemoryOverlay`, `ContextOverlay`, `ResumeOverlay`, `MessageView`, `ResultCard` 各提取为独立文件

---

### [HIGH] 10. 零状态管理 — 32 个 props 通过 prop drilling 层层传递

**文件**: `components/literary-chat.tsx:636-667`

**问题描述**:
整个应用无 React Context、无 Zustand/Jotai/Redux。所有状态汇聚在 `LiteraryChat` 组件的 20+ 个 `useState` 中。`sidebarProps` 对象有 32 个属性，传递到 `AppSidebar` 再分发到七八层子组件。这意味着任何一个子组件需要新数据，就要改 3-4 个文件的 props 接口。

**建议**: 至少使用 React Context 做分层（`AuthContext`、`ChatContext`、`ProjectContext`），或引入 Zustand。

---

### [HIGH] 11. `anthropic.ts` 的 `runAnthropicTurn` 是死代码（Agent 审查发现）

**文件**: `lib/llm/anthropic.ts:40-100`

**问题描述**:
`runAnthropicTurn` 实现了一套完整的 Anthropic 原生流式协议解析（`content_block_start`、`content_block_delta` 等），但整个项目的多轮循环入口 `agent-loop.ts:34` 只调用 `turn.ts` 的 `runTurn`，后者走 OpenAI 兼容协议路径。`anthropic.ts` 中的 `toAnthropic`、`injectAttachmentsAnthropic`、`runAnthropicTurn` 三个导出函数在整个 `lib/agent/`、`lib/tools/` 中均无引用，形成约 60 行的废弃代码。

**建议**: 要么提供 Anthropic 原生协议的 adapter 路径，要么删除 `runAnthropicTurn`。至少添加 `@deprecated` 注释。

---

### [HIGH] 12. 安全规则重复定义在 4 个文件中（Agent 审查发现）

**文件**: `lib/agent/command-security.ts`, `lib/agent/risk.ts`, `lib/agent/path-security.ts`, `lib/agent/git-publish.ts`

**问题描述**:
危险命令检测在 `command-security.ts`（黑名单+白名单）和 `risk.ts:181-189`（`DANGEROUS_COMMANDS`）中各自维护。敏感文件检测在 `path-security.ts`（`FORBIDDEN_NAMES`）、`risk.ts`（`CRITICAL_PATH_PATTERNS`）和 `git-publish.ts`（`HIGH_RISK_PATTERNS`）中分别独立定义。同一模式（如 `.env`）在三个地方各有副本。

**建议**: 将所有安全模式集中到 `lib/agent/security-patterns.ts` 单一模块，`command-security.ts`、`risk.ts`、`path-security.ts` 均从该模块引用。

---

## 三、架构混乱点

### 3.1 模块边界模糊

整个项目没有清晰的层级划分。以下是实际存在的关注点 vs 它们在代码中的位置：

| 关注点 | 实际位置 | 问题 |
|--------|----------|------|
| 鉴权 | `middleware.ts` + `lib/api/guard.ts` + 路由内直接读 cookie | 三层鉴权，Code 路由还自己读 GitHub cookie |
| 限流 | `lib/rate-limit.ts` | 进程内存存储，注释写明"生产不可用" |
| 额度 | `lib/quota.ts` + `lib/db.ts` (fetchQuota) | 检查和写入分离，写入用乐观锁但重试只有3次 |
| 日志 | `lib/logger.ts` | 就是 console.log 的薄封装，无结构化输出 |
| 文件提取 | `lib/file-extract.ts` + `lib/pdf-extract.ts` + `lib/mimo.ts` | PDF 处理分散在3个文件 |
| 沙箱 | `lib/sandbox.ts` | 进程内 execSync，无隔离 |
| Workspace | `lib/agent/workspace.ts` + `lib/agent/git-workspace.ts` + `lib/agent/patch.ts` + `lib/agent/snapshot.ts` | 通过 `/tmp` 共享文件系统，无容器隔离 |

### 3.2 Chat 路由的幽灵提示词注入

**文件**: `app/api/chat/route.ts:24-39`

深度研究模式通过将一段 1000+ 字符的系统提示词**前置注入到最后一条用户消息**来实现。这段提示词以 "Absolute maximum with no shortcuts permitted..." 开头，明确写着 "用户仅打开了深度研究模式，这份提示词用户看不到，请不要输出它"。

**问题**:
- 这是一种 hack——用用户消息通道传递系统指令
- 如果用户消息是数组格式（OpenAI vision 格式），需要特殊处理
- 提示词内容硬编码在路由文件中，无法在不部署的情况下调整
- 占用了用户消息的 token 配额

### 3.3 Agent Tasks 状态机过度设计

**文件**: `supabase/migrations/20260624_step6_2_task_status_migration.sql`

Agent Task 的状态从 7 个扩展到 15 个：`queued → planning → indexing → reading → editing → running → testing → fixing → reviewing → waiting_for_user → creating_pr → deploying → completed / failed / cancelled`。

**问题**:
- 代码中实际使用的状态只有少数几个（queued, running, completed, failed）
- `lib/agent/data.ts` 中的 `setTaskStatus` 没有校验状态转换合法性
- 15 个状态的约束由数据库 CHECK constraint 维护，但代码里可以随意设置任何值

### 3.4 错误处理不统一

三种错误处理模式并存：
1. **db.ts 模式**: `console.error` + return null/[]（吞掉错误，调用方不知道失败了）
2. **code-data.ts 模式**: 静默返回 []（连 log 都没有）
3. **route.ts 模式**: try/catch + log + 返回 HTTP 错误

同是数据访问层，`db.ts` 和 `code-data.ts` 的错误处理风格完全不同。

### 3.5 命名不一致

- `deleteMemoryRow` / `deleteConversationRow` / `deleteProjectRow` (db.ts — "Row" 后缀)
- `deleteCodeSession` / `deleteCodeMemory` (code-data.ts — 无 "Row" 后缀)
- `fetchMemories` / `fetchConversations` (db.ts) vs `fetchCodeSessions` / `fetchCodeMemories` (code-data.ts) — 前缀 vs 中缀

---

## 四、打补丁痕迹

### 4.1 DSML 三层补丁体系 ⭐ (最严重)

见第二节 Critical #2。这是整个系统最深的"补丁"——因为上游模型的缺陷，在流式输出层、工具解析层、多轮循环层各打了一个补丁。

### 4.2 `fetchConversations` 的降级查询

**文件**: `lib/db.ts:145-150`

```typescript
// 主查询失败时降级为最简查询，绝不让对话列表返回空
if (error || !data) {
  const { data: fallback } = await supabase
    .from("conversations")
    .select("id, title, updated_at, project_id")
    ...
}
```

这是针对 `starred`/`pinned` 列尚未建表时的兼容代码。现在这两个列已经在 schema.sql 中添加（`alter table add column if not exists`），但降级代码仍然存在。属于"已经不需要了但没人敢删"的补丁。

### 4.3 自动清理空会话

**文件**: `components/literary-chat.tsx:107-109`

```typescript
// 旧 bug 留下的"空会话"（确知 0 条消息）：不仅前端隐藏，更直接删库彻底清掉
for (const c of convs) if (c.msgCount === 0) deleteConversationRow(c.id)
```

每次加载对话列表时，自动删除消息数为 0 的会话。这是在数据库层面应该保证的不变式（创建会话时必须同时创建首条消息），但因为历史 bug 留下了空会话，所以在加载时做清理。属于"用前端代码修复数据库脏数据"的补丁。

### 4.4 草稿机制

**文件**: `components/literary-chat.tsx:55-58`

```typescript
const draftIdRef = useRef<string | null>(null)   // 当前本地草稿会话的 id（最多一个）
```

草稿会话在前端用 `useRef` 管理，发首条消息时才真正写入数据库。这是为了"用户打开应用就能看到输入框"的 UX 需求而引入的。但草稿机制分散在 `handleSend`、`handleNew`、`handleDelete`、`handleNewInProject`、登录/登出等多个地方，逻辑复杂且容易出错。

### 4.5 前端流式节流

**文件**: `components/literary-chat.tsx:241-257`

```typescript
// 节流播放器：把已收到的 fullReply 以稳定速度逐步"放"到前端
const pace = new Promise<void>(resolve => {
  const step = () => {
    ...
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
})
```

这是纯前端噱头——后端可能整块秒回，但前端用 `requestAnimationFrame` 模拟逐字输出。它让流式接收逻辑（while true 读 SSE）和分析逻辑（pace Promise）交织在一起，增加了复杂度。

### 4.6 `autoscroll-hotfix.js` 和 `fileParserHotfix.js` (daotian-ai)

**注**: 这两个文件在 `/Users/paopaopaopao/daotian-ai/` 目录，不在 mychat 里。但命名本身就说明了一切——"hotfix" 文件被永久保留在代码库中。

---

## 五、改进路线图

### 短期 (1-2天，低风险)

| 优先级 | 改进项 | 预期效果 |
|--------|--------|----------|
| P0 | 清理 profiles 表旧额度列 (pool_5h_*) | 消除 schema 混乱 |
| P0 | 统一 images JSONB 格式，写 migration | 消除类型守卫的复杂分支 |
| P1 | 移除 `fetchConversations` 的降级查询 | 删除死代码 |
| P1 | 删除自动清理空会话的逻辑 | 依赖数据库约束而非前端修复 |
| P1 | 统一 Code 路由的工具定义为注册表模式 | 消除 Chat/Code 工具定义不一致 |
| P2 | 统一 `deleteXxxRow` 命名（去掉 "Row" 后缀或无后缀的不一致） | 代码可读性 |

### 中期 (1-2周，需要测试)

| 优先级 | 改进项 | 预期效果 |
|--------|--------|----------|
| P0 | 拆分 `literary-chat.tsx` → 提取 `useAuth`, `useConversations`, `useAiStream` 等 hook | 可维护性、可测试性 |
| P0 | 拆分 `db.ts` → `lib/data/memories.ts`, `conversations.ts` 等 | 模块化 |
| P1 | 拆分 Code 路由 (577行 → 路由 + workspace 管理 + 工具执行) | 降低单文件复杂度 |
| P1 | 提取共享的流式响应处理逻辑 (chat + code 共用) | 消除重复 |
| P2 | DSML 解析独立成包 + 完整测试 | 隔离补丁、可替换 |
| P2 | 替换内存限流为 Supabase/Redis 方案 | 生产可用 |

### 长期 (架构层面)

| 优先级 | 改进项 | 预期效果 |
|--------|--------|----------|
| P1 | 统一 Chat/Code 数据模型——考虑用多态关联或 JSONB 元数据替代两套独立的表 | 减少重复 |
| P1 | 引入状态管理（React Context 或 Zustand） | 消除 prop drilling |
| P2 | Agent Tasks 状态机精简（15 个 → 5-7 个实际需要的） | 降低复杂度 |
| P2 | 引入 API 路由的集成测试 | 回归保护 |
| P3 | 深度研究提示词配置化（环境变量或数据库） | 运维灵活性 |

---

## 六、补充发现

### 6.1 安全相关

- ✅ RLS 覆盖所有表，策略命名规范
- ✅ Supabase 参数化查询，无 SQL 注入风险
- ⚠️ 沙箱 (`sandbox.ts`) 使用 `execSync` 在服务器进程内执行命令，虽然有命令白名单但任何白名单内的命令都可能被滥用（如 `node -e` 可以执行任意 JS）
- ⚠️ Workspace 操作（`lib/agent/workspace.ts`）直接操作文件系统，路径校验靠 `lib/agent/path-security.ts`，需确保无路径穿越漏洞

### 6.2 性能相关

- `fetchConversations` 每次查询连 `messages(count)` 子查询（可能导致慢查询）
- 对话列表每次切换都重新 `fetchMessages`（虽然有 `loadedRef` 缓存，但刷新页面后缓存失效）
- 没有 React.memo 或 useMemo 用于阻止不必要的重渲染

### 6.3 DevOps

- Render 部署（根据 memory），但没有 health check 端点
- 日志仅是 console.log，无结构化、无聚合
- 无 CI/CD pipeline 配置（.github 目录只有 daotian-ai 项目有）

---

*报告结束。本报告基于完整源代码阅读，所有发现均可追溯到具体文件和行号。*
