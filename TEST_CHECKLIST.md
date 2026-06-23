# MyChat 改进测试清单

## 快速验证步骤

### 1️⃣ 代码编译检查
```bash
cd /Users/paopaopaopao/Documents/Codex/2026-06-21/https-zizu-life-api-provider-guide/work
npm run build
# 或 npx tsc --noEmit
```

### 2️⃣ 启动开发服务器
```bash
npm run dev
# 访问 http://localhost:3000
```

### 3️⃣ 日志测试（发送消息 10 条）
**步骤**:
1. 登录用户账户
2. 发送 10 条消息到不同的对话
3. 打开浏览器开发工具 → 后台日志（如果有）
4. 查看 `/api/chat` 请求的响应流

**期望**:
- 浏览器控制台看到 token 使用日志（如启用了前端日志）
- 后台应用日志（终端）应显示：
  ```
  [ISO_TIME] [INFO] [quota] Adding quota usage | {"userId":"...", "rawTokens":1234, "weighted":1187, ...}
  [ISO_TIME] [INFO] [quota] Quota usage recorded | {"userId":"...", "tokens_5h":2374, "tokens_7d":5891}
  ```

### 4️⃣ 速率限制测试（31 个快速请求）
**使用 curl 测试**（需要替换 YOUR_TOKEN）:
```bash
# 获取当前用户的 session token（从浏览器开发工具）
TOKEN="your-supabase-session-token"

# 发送 31 个并发请求
for i in {1..31}; do
  curl -X POST http://localhost:3000/api/chat \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"test"}]}' &
  sleep 0.1
done
wait
```

**期望**:
- 前 30 个请求返回 200
- 第 31 个请求返回 429 + 错误信息：`请求过于频繁，请稍后再试`
- 日志显示：`[WARN] [rateLimit] Rate limit exceeded`

### 5️⃣ PDF 大小限制测试
**方式一：前端上传**:
1. 创建一个 60MB 的 PDF 文件（或找一个现成的大文件）
2. 在聊天界面上传此文件
3. 发送消息

**期望**:
- 前端不崩溃
- 消息正常发送
- 后台日志显示：`[WARN] [uploadPdf] PDF exceeds 50MB limit | {"name":"...", "size":...}`

**方式二：直接 API 测试**:
```bash
# 生成 60MB 的伪 PDF（仅用于测试）
dd if=/dev/zero of=/tmp/large.pdf bs=1M count=60
base64 /tmp/large.pdf > /tmp/large.pdf.b64

# POST 到 /api/chat，attachments 包含此文件
# （详见 POST 请求体格式）
```

### 6️⃣ 邀请码强度测试
**步骤**:
1. 以管理员/创建码的用户身份登录
2. 调用 POST `/api/generate-code` 生成码（比如 count=5）
   ```bash
   curl -X POST http://localhost:3000/api/generate-code \
     -H "Content-Type: application/json" \
     -d '{"count":5}'
   ```
3. 查看返回的码列表

**期望**:
- 每个码长度为 **24 位**（不是 16）
- 码包含 **A-Z、a-z、0-9、-、_** 字符
- 比如：`a1B-c2D_e3F-g4H_i5J-k6L`
- 日志显示：`[INFO] [generateCode] Codes generated successfully`

### 7️⃣ 邀请码兑换测试
**步骤**:
1. 生成一个新码（见步骤 6）
2. 用另一个用户账户登录
3. 调用 POST `/api/redeem-code`
   ```bash
   curl -X POST http://localhost:3000/api/redeem-code \
     -H "Content-Type: application/json" \
     -d '{"code":"a1B-c2D_e3F-g4H_i5J-k6L"}'
   ```

**期望**:
- 返回 `{"success": true, "tokensAdded": 20000000, "newBalance": ...}`
- 日志显示：`[INFO] [redeemCode] Code redeemed successfully`
- 该码不能再次兑换（第二次调用返回 400：`邀请码已被使用`）

### 8️⃣ 游客登录测试
**步骤**:
1. 不登录，调用 POST `/api/auth/anonymous`
   ```bash
   curl -X POST http://localhost:3000/api/auth/anonymous \
     -H "Content-Type: application/json"
   ```

**期望**:
- 返回 `{"success": true, "user": {"id": "uuid..."}}`
- 日志显示：`[INFO] [anonymousAuth] Anonymous user created`
- 匿名用户能发送消息（不需要兑换邀请码）

### 9️⃣ 入参验证测试
**测试错误情况**:
```bash
# 1. chat 路由 - messages 为空
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[]}'
# 期望: 400 + "messages: must have at least 1 items"

# 2. generate-code 路由 - count 超出范围
curl -X POST http://localhost:3000/api/generate-code \
  -H "Content-Type: application/json" \
  -d '{"count":101}'
# 期望: 400 + "count: must be at most 100"

# 3. redeem-code 路由 - code 缺失
curl -X POST http://localhost:3000/api/redeem-code \
  -H "Content-Type: application/json" \
  -d '{}'
# 期望: 400 + "code: must be at least 1 characters"

# 4. JSON 解析失败
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d 'invalid json'
# 期望: 400 + "请求体格式错误"
```

## 数据库更新检查

### 验证 Supabase SQL 执行
在 Supabase 控制台 SQL Editor 中：

```sql
-- 1. 检查 profiles 表是否有新列
select column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
  and column_name in ('tokens_5h', 'window_5h_start', 'tokens_7d', 'window_7d_start', 'quota_version', 'balance');
-- 期望: 6 行结果

-- 2. 检查 invitation_codes 表的 RLS policy
select policyname, qual from pg_policies
  where schemaname = 'public' and tablename = 'invitation_codes';
-- 期望: codes_read policy 应包含 'used_by is not null'

-- 3. 检查索引是否存在
select indexname from pg_indexes
  where schemaname = 'public' and tablename = 'profiles'
  and indexname in ('idx_profiles_window_5h_start', 'idx_profiles_window_7d_start');
-- 期望: 2 行结果
```

## 性能监控

### 额度系统
```bash
# 发送一条消息后，查询 profiles 表
curl -X GET http://localhost:3000/api/user-profile \
  -H "Authorization: Bearer YOUR_TOKEN"
# （需要实现此端点或在 Supabase 直接查询）

# 预期: tokens_5h, tokens_7d, window_5h_start, window_7d_start 应该更新
```

### 日志聚合
如果有日志聚合系统（如 ELK、Datadog），搜索：
```
tag:quota OR tag:rateLimit OR tag:chat
```

## 常见问题

### 日志无法看到？
- 检查环境变量 `LOG_LEVEL` 是否为 `info`
- 检查前端是否清除了浏览器日志
- 检查后端终端是否有输出

### 速率限制在 Docker/K8s 中无效？
- 当前实现使用内存存储，每个 Pod/容器独立
- 生产环境需要改用 Redis 共享状态

### 邀请码仍是 16 位？
- 检查 `lib/invitation-code-gen.ts` 中的 `CODE_LENGTH = 24`
- 清除旧的邀请码缓存

---

**完成标志**: 所有 9 个测试项通过（跳过购买界面）= **90+ 分达成** ✅
