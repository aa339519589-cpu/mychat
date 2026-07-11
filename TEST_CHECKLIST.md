# MyChat 发布验收清单

## 自动验证

```bash
npm run verify
git diff --check
```

- [ ] TypeScript 严格检查通过。
- [ ] 所有测试通过且没有 skipped/failed。
- [ ] Next.js 生产构建通过。
- [ ] `git diff --check` 无空白错误。

## 数据库

- [ ] 已备份目标数据库。
- [ ] 所有迁移按文件名顺序执行成功。
- [ ] 原子 RPC（配额、邀请码、任务租约、meta/run state 合并）存在。
- [ ] 普通认证用户不能直接修改 `profiles.balance`、token 窗口或版本字段。
- [ ] A 用户无法读取或修改 B 用户的消息、项目文件、代码消息、artifact 和 agent 子记录。
- [ ] 同一个邀请码并发兑换时只有一个请求成功。
- [ ] 同一个用户的并发 token 记账不会丢失更新。

## 普通聊天

- [ ] 登录用户和匿名用户都能完成一次流式对话。
- [ ] 匿名登录超过每 IP 每小时上限会返回 429 和 `Retry-After`。
- [ ] 超大/畸形 JSON、空消息、非法 role、过多图片分别返回 400 或 413。
- [ ] DeepSeek thinking + tool call 可连续完成，不出现缺失 `reasoning_content` 的 400。
- [ ] 模型中途失败仍记录已经消耗的 token。
- [ ] 联网结果中的“忽略系统提示”等文字只作为资料，不会改变代理指令。
- [ ] 未闭合的 tool/artifact 标记不会泄漏到最终回复。

## 自定义模型

- [ ] Base URL 带根路径、`/v1`、`/models` 或 `/chat/completions` 时都能规范化，不会重复拼接 `/v1`。
- [ ] 正确 Key 能自动获取模型；401、404、超时和非 JSON 响应显示不同的可恢复错误。
- [ ] 模型名称分类只作为用途建议；无 `image` / `video` 关键词的模型可手动指定用途并按对应接口调用。
- [ ] 选择模型后会执行真实流式聊天验证，未生成文本时不能保存。
- [ ] 图片模型可选择并请求 `/images/generations`；`b64_json`、URL 和完成型 SSE 都显示为图片。
- [ ] 视频模型按 `/videos` 创建任务、轮询状态并读取 `/content`；失败、超时和无权限显示明确错误。
- [ ] 生成图片保持原比例，视频完整显示且有 controls；桌面与 390px 视口均无横向溢出或裁切。
- [ ] 结构化 `image_url` / `output_image` / `video_url` 不会退化为 `[object Object]`，危险协议不会渲染。
- [ ] 媒体 URL 在服务端下载后显示；跨域下载不携带端点 Key，重定向和浏览器私网 URL 会被阻止。
- [ ] 保存后的 API Key 不会出现在端点列表、聊天请求、DOM、日志或错误信息中。
- [ ] 超长模型 ID 不会挤压输入框、发送按钮或移动端视口；生成状态固定为「正在生成……」。
- [ ] 公网生产阻止未列入 `MODEL_ENDPOINT_PRIVATE_ALLOWLIST` 的私网地址；同局域网本地开发可连接私网模型。
- [ ] IPv4-mapped IPv6、链路本地地址、云元数据地址和 DNS rebinding 均无法绕过端点网络策略。

## 代码代理与工作区

- [ ] 生产未设置 `E2B_API_KEY` 时执行和验证接口安全返回 503/blocked，不在宿主机运行命令。
- [ ] 配置 E2B 后能执行 typecheck/test，输出会截断并脱敏。
- [ ] `../`、绝对路径、符号链接跳转、私有配置文件写入均被拒绝。
- [ ] 首次文件修改前的空快照可恢复，删除/新增/修改文件都能正确回滚。
- [ ] 同一任务并发启动只有一个请求取得运行租约。
- [ ] 取消后的任务不会被 heartbeat 改回 running。
- [ ] 高风险发布先进入待确认；拒绝后不能发布；确认后只消费一次确认。
- [ ] commit message/PR 标题中的引号、换行和 shell 字符不会被执行。
- [ ] push 成功而 PR 创建失败后可安全重试，并复用已有分支/PR。

## GitHub 与前端渲染

- [ ] OAuth callback 使用当前公开域名，登录后 `/api/github/status` 返回绑定账号。
- [ ] 切换 Supabase 用户后旧 GitHub cookie 不可继续使用。
- [ ] 仓库列表、clone、push 和 PR 创建均设置超时并正确处理 401/422。
- [ ] artifact iframe 不拥有 same-origin、表单或弹窗权限。
- [ ] SVG artifact 通过隔离图片展示，不直接注入页面 DOM。

## 上线后观察

- [ ] 429 比率符合预期，没有匿名登录洪峰。
- [ ] `record_quota_usage` 和任务租约 RPC 无错误。
- [ ] E2B 创建/连接/同步无持续失败。
- [ ] DeepSeek/MiMo 超时和工具循环次数没有异常升高。
- [ ] GitHub OAuth 失败率在旧用户重新授权后恢复正常。
