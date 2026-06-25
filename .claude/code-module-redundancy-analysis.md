# Code 模块冗余度分析

## 总览

| 类别 | 当前行数 | 可减至 | 减少 |
|------|----------|--------|------|
| lib/agent/ | 4,997 | ~3,200 | -1,800 |
| app/api/agent/ + code/ | 1,832 | ~1,100 | -730 |
| components/ (code部分) | 1,643 | ~900 | -740 |
| lib/code-data.ts | 132 | 100 | -32 |
| lib/github.ts | 197 | 150 | -47 |
| lib/sandbox.ts | 90 | 60 | -30 |
| supabase/ (agent部分) | 158 | 100 | -58 |
| **合计** | **~9,049** | **~5,610** | **~3,440 (38%)** |

---

## 逐文件冗余明细

### 1. `lib/agent/git-publish.ts` (614 → 300，减 314 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `HIGH_RISK_PATTERNS` + `MEDIUM_RISK_PATTERNS` | 25 | 与 `risk.ts` 完全重复，且是第三份副本 |
| `checkRiskFiles()` | 12 | 逻辑与 `risk.ts:classifyFileRisk` 相同 |
| `isForbiddenBranch()` | 6 | 与 `risk.ts:classifyPublishRisk` 的分支检查重复 |
| `ensureWorkspaceGitIdentity()` | 14 | 每个函数里重复调用 git config，应提取为一次 |
| `getWorkspaceGitStatus()` | 30 | 与 `workspace.ts:getChangedFiles` + `getWorkspaceDiff` 功能重叠 |
| `commitWorkspaceChanges()` 二次风险检查 | 20 | 先 checkRiskFiles 再 git add 后再 checkRiskFiles，同一逻辑跑两遍 |
| 5 个公开函数各自的 `existsSync(root)` + `git rev-parse` 样板 | 50 | 每个函数前 10 行一模一样 |
| `console.warn` 而非 `log.warn` | 1 | 不一致 |

### 2. `lib/agent/data.ts` (589 → 350，减 239 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| 5 个 `mapXxx()` 函数 (17-98行) | 82 | 全部是 `row.xxx → {xxx}` 的字段重命名，可用一个泛型 `mapRow<T>(row, mapping)` 替代 |
| `addStep` + `addToolCall` 的 seq 计算逻辑 | 20 | 完全相同的 "查最大 seq → +1" 模式重复两次 |
| `addArtifact` + `addStep` + `addToolCall` 的 touch updated_at | 9 | 三个函数各写了一遍 `supabase.from("agent_tasks").update({updated_at})` |
| `addConfirmRecord()` | 6 | 就是 `addStep(kind:"confirm")` 的薄封装，没增加价值 |
| `getLatestSnapshotArtifact()` | 6 | 就是 `getArtifactsByKind("summary")` + filter，可直接内联 |
| `getSnapshotArtifact()` | 10 | 仅一处调用（snapshot.ts），可移入 snapshot.ts |
| `cancelTask()` `resumeTask()` | 30 | 各是 `updateTaskStatus` 的一行调用，单独函数意义不大 |

### 3. `lib/agent/snapshot.ts` (582 → 350，减 232 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `parseChangedFiles()` | 50 | 与 `patch.ts:parsePatchFiles` 功能高度重叠 |
| `cleanupWorkspace()` | 30 | 与 `git-workspace.ts:cleanupWorkspace` 同名冲突 |
| snapshot artifact 的序列化/反序列化 | 60 | JSON 读写包装过度，可直接用 Supabase JSONB |
| 每次 snapshot 的 git 命令样板 | 30 | `git stash` + `git stash pop` 等重复模式 |

### 4. `lib/agent/error-parser.ts` (301 → 180，减 121 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `firstMatch()` 函数 | 6 | 定义了但从未被调用 |
| `parseTypeScriptErrors` `parseESLintErrors` `parseNextBuildErrors` `parseRuntimeStack` `parseGenericErrors` | 200 | 5 个解析器结构完全相同：遍历正则 → 构造 ParsedError → 返回数组。可抽象为一个 `parseWithPattern(text, pattern, mapper)` |
| `tsCauseHint()` | 15 | 只覆盖了 9 个 TS 错误码，投入产出比低 |

### 5. `lib/agent/permissions.ts` (245 → 120，减 125 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `confirmAgentOperation()` 和 `rejectAgentOperation()` | 170 | 两个函数 85% 相同：查 pending → 验证 ID → 读 meta → 更新 meta → 写 step → 写 artifact。差异仅在于 status 字段和 step label。可合并为一个 `resolveConfirmation(taskId, confirmed, reason?)` |
| `clearConfirmation()` | 18 | 与上面两个函数的 meta 更新逻辑重复 |

### 6. `lib/agent/risk.ts` (253 → 130，减 123 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `CRITICAL_PATH_PATTERNS` | 17 | 与 `path-security.ts:FORBIDDEN_NAMES` 和 `git-publish.ts:HIGH_RISK_PATTERNS` 重复 |
| `HIGH_PATH_PATTERNS` | 13 | 与 `git-publish.ts:MEDIUM_RISK_PATTERNS` 重复 |
| `DANGEROUS_COMMANDS` | 11 | 与 `command-security.ts` 的命令黑名单重复 |
| `classifyAgentRisk()` switch | 35 | 14 个 case 大部分直接委托给 classifyFileRisk/classifyDeleteRisk/classifyPublishRisk，switch 本身就是样板 |

### 7. `lib/agent/verify.ts` (261 → 160，减 101 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `runCommand()` | 24 | 与 `sandbox.ts:runInSandbox` 功能重复（都是 execSync 包装），且用同步 `execSync` 阻塞事件循环 |
| `generateFixPrompt()` | 37 | 纯字符串拼接，可移入 `fix-loop.ts` |
| 每个 step 的 artifact 写入 | 40 | lint/typecheck/test/build 四个步骤的 artifact 写入模式完全一样 |

### 8. `lib/agent/fix-loop.ts` (242 → 140，减 102 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `onFixNeeded` 回调分支 | 50 | fix-loop 本身不执行修复，只编排 snapshot→验证→回滚。`onFixNeeded` 回调让调用方做实际修复，这意味着 fix-loop 只是一个 orchestrator，却占了 242 行 |
| 每轮的 artifact 写入 | 30 | 与 verify.ts 的 artifact 写入重复 |
| `buildFixPrompt()` | 6 | 只是 `generateFixPrompt` 的薄封装 |

### 9. `lib/agent/command-security.ts` (110 → 0，减 110 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| 整个文件 | 110 | 命令白名单/黑名单在 `risk.ts:DANGEROUS_COMMANDS` 和 `sandbox.ts:ALLOWED_COMMANDS` 中已有副本。三份规则各自维护 |

### 10. `lib/agent/path-security.ts` (231 → 130，减 101 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `FORBIDDEN_NAMES` `PREFIXES` `SUFFIXES` | 40 | 与 `risk.ts:CRITICAL_PATH_PATTERNS` 重复 |
| `redactSensitive()` | 25 | 功能简单，可内联 |
| `checkDeleteThreshold()` | 20 | 逻辑过于简单（只检查数量>30），不够实用 |

### 11. `lib/agent/project-detect.ts` (125 → 80，减 45 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `runPrefix` 计算逻辑 | 20 | 4 种包管理器的命令前缀各写了 if-else，可用 lookup table |
| `installCommand` 计算 | 10 | 同样的 if-else |
| `notes` 数组 | 15 | 收集了 notes 但调用方从未展示 |

### 12. `lib/agent/types.ts` (163 → 80，减 83 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| `AgentTaskStatus` | 17 | 15 个状态值，代码只用 5-6 个 |
| `CreateTaskInput` 等 input 类型 | 30 | 部分字段从未使用（如 `tags`, `priority`） |

### 13. `app/api/code/chat/route.ts` (576 → 300，减 276 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| 内联工具定义 (lines 231-244) | 40 | 应移到 `lib/tools/code-tools.ts` |
| 内联 executeTool switch (lines 266-552) | 286 | 13 个工具各一个 if 分支，每个分支做参数校验+emit step+调用+返回结果。可抽象为 `createToolHandler(name, schema, handler)` |
| `console.warn` 10+ 处 | 10 | 不一致 |

### 14. `app/api/agent/` 12 个 workspace 子路由 (1068 → 600，减 468 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| 每个路由的 `resolveAuth()` + `getTaskDetail()` + workspace 状态校验 | 360 | 12 个文件各 ~30 行相同样板 |
| `file/route.ts` `snapshot/route.ts` `git/route.ts` 各自的 `getContext()` | 60 | 三个文件各自定义了一个功能完全相同的 context 获取函数 |

### 15. `components/code-console.tsx` (962 → 550，减 412 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| 内联 LCS diff 算法 `computeDiff()` `DiffBody` | 50 | 应移到 `lib/diff.ts` |
| 6 个覆盖层组件内联 | 200 | ModelOverlay, MemoryOverlay, ContextOverlay, ResumeOverlay, Shell, RepoPicker |
| SSE 流式解析逻辑 | 80 | 与 literary-chat.tsx 的 runAiStream 重复 |

### 16. `components/agent-tasks-panel.tsx` (681 → 400，减 281 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| TaskDetailView 内联 | 150 | 应拆为独立组件 |
| StepList / ArtifactList 内联 | 80 | 应拆为独立组件 |

### 17. `supabase/agent-tasks.sql` (158 → 100，减 58 行)

| 冗余 | 行数 | 说明 |
|------|------|------|
| agent_tool_calls 表 | 30 | 代码中从未写入（recorder.ts 的 completeToolCall 被 catch 吞掉了所有错误，且 code/chat 路由没有使用 recorder 来记录工具调用） |
| agent_task_steps 表 | 25 | 写入频繁但从未被读取/展示 |
| RLS 策略 | 20 | 与 schema.sql 命名不一致 |

---

## 总结

| 冗余类型 | 行数 | 占比 |
|----------|------|------|
| 纯死代码（从未调用） | ~200 | 2% |
| 重复逻辑（多份副本） | ~800 | 9% |
| 过度工程（可大幅简化） | ~1,600 | 18% |
| 样板代码（可抽象消除） | ~840 | 9% |
| **合计可消除** | **~3,440** | **38%** |

**核心规律**：Code 模块的冗余遵循一个清晰的模式——每次加新功能时复制粘贴了前一个功能的代码，但没做抽象。安全规则 3 份、命令检查 3 份、路由守卫 12 份、mapRow 5 份、错误解析器 5 份——全是复制粘贴的产物。

**最大单块收益**：
1. 合并安全规则（risk + command-security + path-security + git-publish 的规则） → `lib/agent/security-rules.ts` (~120行)
2. 抽象路由守卫（12 个 workspace 子路由的样板） → `lib/agent/workspace-guard.ts` (~40行)
3. 抽象工具执行器（code/chat 的 13 个 if-else） → 注册表模式 (~80行)
4. 拆分 code-console.tsx 覆盖层 → 6 个独立文件
