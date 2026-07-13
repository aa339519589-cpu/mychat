import type { Sandbox } from "e2b"
import {
  collectIsolatedWorkspaceFiles,
  REMOTE_WORKSPACE_ROOT,
} from "./isolated-files"
import {
  createIsolatedSyncManifest,
  MAX_ISOLATED_MANIFEST_BYTES,
  MAX_ISOLATED_SYNC_FILES,
  parseIsolatedSyncManifest,
  planIsolatedWorkspaceHydration,
  serializeIsolatedSyncManifest,
  validateIsolatedSyncPath,
  type IsolatedSyncManifest,
} from "./isolated-sync"

const PRIVATE_SYNC_ROOT = "/root/.mychat-agent-sync"
const PRIVATE_MANIFEST_PATH = `${PRIVATE_SYNC_ROOT}/manifest.json`
const PRIVATE_MANIFEST_NEXT_PATH = `${PRIVATE_SYNC_ROOT}/manifest.next`
const PRIVATE_GIT_DIR = `${PRIVATE_SYNC_ROOT}/git`
const ROOT_OPTIONS = { user: "root", requestTimeoutMs: 60_000 } as const
const BATCH_SIZE = 100
const MAX_CHANGED_PATH_OUTPUT = 1024 * 1024
const PROTECTED_DIRECTORIES = [
  ".git", ".next", ".turbo", "__pycache__", "bower_components", "build",
  "coverage", "dist", "node_modules", "vendor", ".cache",
]

const gitPathspec = [
  ".",
  ...PROTECTED_DIRECTORIES.flatMap(directory => [
    `':(exclude)${directory}'`,
    `':(glob,exclude)${directory}/**'`,
    `':(glob,exclude)**/${directory}/**'`,
  ]),
].join(" ")

export type IsolatedHydration = {
  initial: boolean
  manifest: IsolatedSyncManifest
  manifestText: string
}

async function strictInfo(
  sandbox: Sandbox,
  path: string,
  expectedType: "file" | "dir",
  root = false,
) {
  const info = await sandbox.files.getInfo(path, root ? ROOT_OPTIONS : { requestTimeoutMs: 60_000 })
  if (info.symlinkTarget || info.type !== expectedType) {
    throw new Error(`沙箱同步对象类型非法：${path}`)
  }
  return info
}

async function ensureWorkspaceRoot(sandbox: Sandbox): Promise<void> {
  if (!await sandbox.files.exists(REMOTE_WORKSPACE_ROOT, { requestTimeoutMs: 30_000 })) {
    await sandbox.files.makeDir(REMOTE_WORKSPACE_ROOT, { requestTimeoutMs: 30_000 })
  }
  await strictInfo(sandbox, REMOTE_WORKSPACE_ROOT, "dir")
}

async function initializePrivateState(sandbox: Sandbox): Promise<void> {
  await ensureWorkspaceRoot(sandbox)
  for (const directory of [".git", "node_modules"]) {
    const path = `${REMOTE_WORKSPACE_ROOT}/${directory}`
    if (!await sandbox.files.exists(path, { requestTimeoutMs: 30_000 })) continue
    const info = await sandbox.files.getInfo(path, { requestTimeoutMs: 30_000 })
    if (info.symlinkTarget || info.type !== "dir") {
      throw new Error(`首次同步发现不安全的保留目录：${directory}`)
    }
  }
  await sandbox.commands.run(
    `find ${REMOTE_WORKSPACE_ROOT} -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .git -exec rm -rf -- {} +`,
    { timeoutMs: 120_000, requestTimeoutMs: 150_000 },
  )
  await sandbox.commands.run(
    `rm -rf -- ${PRIVATE_SYNC_ROOT} && install -d -m 700 -- ${PRIVATE_SYNC_ROOT}`,
    { user: "root", timeoutMs: 60_000, requestTimeoutMs: 90_000 },
  )
  await strictInfo(sandbox, PRIVATE_SYNC_ROOT, "dir", true)
}

async function assertPrivateState(sandbox: Sandbox): Promise<void> {
  if (!await sandbox.files.exists(PRIVATE_SYNC_ROOT, ROOT_OPTIONS)) {
    throw new Error("沙箱私有同步目录缺失，拒绝降级为全量覆盖")
  }
  await strictInfo(sandbox, PRIVATE_SYNC_ROOT, "dir", true)
}

async function readManifestText(sandbox: Sandbox): Promise<string> {
  await assertPrivateState(sandbox)
  if (!await sandbox.files.exists(PRIVATE_MANIFEST_PATH, ROOT_OPTIONS)) {
    throw new Error("沙箱私有同步 manifest 缺失")
  }
  const info = await strictInfo(sandbox, PRIVATE_MANIFEST_PATH, "file", true)
  if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_ISOLATED_MANIFEST_BYTES) {
    throw new Error("沙箱私有同步 manifest 大小非法")
  }
  const bytes = await sandbox.files.read(PRIVATE_MANIFEST_PATH, { ...ROOT_OPTIONS, format: "bytes" })
  if (bytes.byteLength !== info.size) throw new Error("沙箱私有同步 manifest 读取长度不一致")
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("沙箱私有同步 manifest 不是合法 UTF-8")
  }
}

async function writeManifest(sandbox: Sandbox, manifest: IsolatedSyncManifest): Promise<string> {
  await assertPrivateState(sandbox)
  const text = serializeIsolatedSyncManifest(manifest)
  if (await sandbox.files.exists(PRIVATE_MANIFEST_NEXT_PATH, ROOT_OPTIONS)) {
    await sandbox.files.remove(PRIVATE_MANIFEST_NEXT_PATH, ROOT_OPTIONS)
  }
  await sandbox.files.write(PRIVATE_MANIFEST_NEXT_PATH, text, ROOT_OPTIONS)
  const nextInfo = await strictInfo(sandbox, PRIVATE_MANIFEST_NEXT_PATH, "file", true)
  if (nextInfo.size !== Buffer.byteLength(text, "utf8")) {
    throw new Error("沙箱私有同步 manifest 写入长度不一致")
  }
  if (await sandbox.files.exists(PRIVATE_MANIFEST_PATH, ROOT_OPTIONS)) {
    await strictInfo(sandbox, PRIVATE_MANIFEST_PATH, "file", true)
    await sandbox.files.remove(PRIVATE_MANIFEST_PATH, ROOT_OPTIONS)
  }
  await sandbox.files.rename(PRIVATE_MANIFEST_NEXT_PATH, PRIVATE_MANIFEST_PATH, ROOT_OPTIONS)
  await sandbox.commands.run(
    `chmod 700 -- ${PRIVATE_SYNC_ROOT} && chmod 600 -- ${PRIVATE_MANIFEST_PATH}`,
    { user: "root", timeoutMs: 30_000, requestTimeoutMs: 60_000 },
  )
  return text
}

async function assertSafeRemoteParents(sandbox: Sandbox, relativePath: string): Promise<void> {
  const segments = validateIsolatedSyncPath(relativePath).split("/")
  let current = REMOTE_WORKSPACE_ROOT
  await strictInfo(sandbox, current, "dir")
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`
    if (!await sandbox.files.exists(current, { requestTimeoutMs: 30_000 })) return
    await strictInfo(sandbox, current, "dir")
  }
}

async function assertWritableRemoteTarget(sandbox: Sandbox, relativePath: string): Promise<void> {
  await assertSafeRemoteParents(sandbox, relativePath)
  const target = `${REMOTE_WORKSPACE_ROOT}/${relativePath}`
  if (!await sandbox.files.exists(target, { requestTimeoutMs: 30_000 })) return
  await strictInfo(sandbox, target, "file")
}

async function applyHydration(
  sandbox: Sandbox,
  files: ReturnType<typeof collectIsolatedWorkspaceFiles>,
  uploads: string[],
  deletes: string[],
): Promise<void> {
  const byPath = new Map(files.map(file => [file.relativePath, file]))
  for (const path of deletes) {
    await assertSafeRemoteParents(sandbox, path)
    const target = `${REMOTE_WORKSPACE_ROOT}/${path}`
    if (!await sandbox.files.exists(target, { requestTimeoutMs: 30_000 })) {
      throw new Error(`待删除的沙箱文件与 manifest 不一致：${path}`)
    }
    await strictInfo(sandbox, target, "file")
  }
  for (const path of uploads) await assertWritableRemoteTarget(sandbox, path)

  for (const path of deletes) {
    await sandbox.files.remove(`${REMOTE_WORKSPACE_ROOT}/${path}`, { requestTimeoutMs: 60_000 })
  }
  for (let index = 0; index < uploads.length; index += BATCH_SIZE) {
    const batch = uploads.slice(index, index + BATCH_SIZE).map(path => {
      const file = byPath.get(path)
      if (!file) throw new Error(`本地同步计划缺少文件：${path}`)
      return { path: file.path, data: file.data }
    })
    await sandbox.files.write(batch, { requestTimeoutMs: 120_000 })
  }
  for (const path of uploads) {
    const expected = byPath.get(path)
    if (!expected) throw new Error(`本地同步计划缺少文件：${path}`)
    const info = await strictInfo(sandbox, `${REMOTE_WORKSPACE_ROOT}/${path}`, "file")
    if (info.size !== expected.size) throw new Error(`沙箱上传长度不一致：${path}`)
  }
}

async function baselinePrivateIndex(sandbox: Sandbox): Promise<void> {
  await sandbox.commands.run([
    `git --git-dir=${PRIVATE_GIT_DIR} --work-tree=${REMOTE_WORKSPACE_ROOT} init -q`,
    `git --git-dir=${PRIVATE_GIT_DIR} config user.name "mychat-agent"`,
    `git --git-dir=${PRIVATE_GIT_DIR} config user.email "mychat-agent@users.noreply.github.com"`,
    `git --git-dir=${PRIVATE_GIT_DIR} --work-tree=${REMOTE_WORKSPACE_ROOT} add -f -A -- ${gitPathspec}`,
    `git --git-dir=${PRIVATE_GIT_DIR} commit -qm "workspace baseline" --allow-empty`,
  ].join(" && "), { user: "root", timeoutMs: 120_000, requestTimeoutMs: 150_000 })
}

export async function hydrateIsolatedWorkspace(
  sandbox: Sandbox,
  userId: string,
  taskId: string,
  initialized: boolean,
): Promise<IsolatedHydration> {
  const files = collectIsolatedWorkspaceFiles(userId, taskId)
  const local = createIsolatedSyncManifest(files.map(file => ({
    path: file.relativePath,
    sha256: file.sha256,
    size: file.size,
  })))

  let remote: IsolatedSyncManifest | null = null
  if (initialized) {
    remote = parseIsolatedSyncManifest(await readManifestText(sandbox))
    await ensureWorkspaceRoot(sandbox)
  } else {
    await initializePrivateState(sandbox)
  }

  const plan = planIsolatedWorkspaceHydration(local, remote)
  await applyHydration(sandbox, files, plan.uploads, plan.deletes)
  const manifestText = plan.initial || plan.uploads.length || plan.deletes.length
    ? await writeManifest(sandbox, plan.manifest)
    : serializeIsolatedSyncManifest(plan.manifest)
  await baselinePrivateIndex(sandbox)
  return { initial: plan.initial, manifest: plan.manifest, manifestText }
}

export async function assertIsolatedManifestUnchanged(
  sandbox: Sandbox,
  expectedText: string,
): Promise<void> {
  const actual = await readManifestText(sandbox)
  parseIsolatedSyncManifest(actual)
  if (actual !== expectedText) throw new Error("命令篡改了沙箱私有同步 manifest")
}

export async function changedIsolatedWorkspacePaths(sandbox: Sandbox): Promise<string[]> {
  const result = await sandbox.commands.run([
    `git --git-dir=${PRIVATE_GIT_DIR} --work-tree=${REMOTE_WORKSPACE_ROOT} diff HEAD --name-only -z -- ${gitPathspec}`,
    `git --git-dir=${PRIVATE_GIT_DIR} --work-tree=${REMOTE_WORKSPACE_ROOT} ls-files --others -z -- ${gitPathspec}`,
  ].join(" && "), { user: "root", timeoutMs: 30_000, requestTimeoutMs: 60_000 })
  if (result.stdout.length > MAX_CHANGED_PATH_OUTPUT) throw new Error("沙箱变更路径输出超过上限")
  const paths = [...new Set(result.stdout.split("\0").filter(Boolean).map(validateIsolatedSyncPath))].sort()
  if (paths.length > MAX_ISOLATED_SYNC_FILES) throw new Error("沙箱变更文件数超过同步上限")
  return paths
}

export async function persistCurrentIsolatedManifest(
  sandbox: Sandbox,
  userId: string,
  taskId: string,
): Promise<string> {
  const files = collectIsolatedWorkspaceFiles(userId, taskId)
  const manifest = createIsolatedSyncManifest(files.map(file => ({
    path: file.relativePath,
    sha256: file.sha256,
    size: file.size,
  })))
  return writeManifest(sandbox, manifest)
}
