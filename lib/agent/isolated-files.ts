import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { listWorkspaceFiles, workspacePath } from "./workspace"
import { redactSensitive, validatePath } from "./path-security"

export const REMOTE_WORKSPACE_ROOT = "/home/user/workspace"
export const MAX_ISOLATED_FILE_BYTES = 5 * 1024 * 1024
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const PRIVATE_CONFIGS = new Set([".npmrc", ".pypirc", ".netrc", ".yarnrc.yml"])

export type IsolatedWorkspaceFile = {
  relativePath: string
  path: string
  data: ArrayBuffer
  sha256: string
  size: number
}

export function collectIsolatedWorkspaceFiles(userId: string, taskId: string): IsolatedWorkspaceFile[] {
  const root = workspacePath(userId, taskId)
  const listed = listWorkspaceFiles(taskId, userId, undefined, 10_000)
  if (!listed.ok) throw new Error(listed.error)
  if (listed.data.truncated) throw new Error("Workspace 文件超过 10000 个，拒绝不完整同步")

  let total = 0
  const files: IsolatedWorkspaceFile[] = []
  for (const path of listed.data.files) {
    const lowerPath = path.toLowerCase()
    const fileName = lowerPath.split("/").at(-1) ?? ""
    if (PRIVATE_CONFIGS.has(fileName) || lowerPath.endsWith(".docker/config.json")) {
      throw new Error(`敏感配置不会上传到沙箱：${path}`)
    }
    const checked = validatePath(root, path)
    if (!checked.ok) continue
    const size = statSync(checked.absolute!).size
    if (size > MAX_ISOLATED_FILE_BYTES) throw new Error(`文件过大，无法进入沙箱：${path}`)
    total += size
    if (total > MAX_UPLOAD_BYTES) throw new Error("Workspace 源文件超过 50MB，无法进入沙箱")
    const data = readFileSync(checked.absolute!)
    const text = data.includes(0) ? null : data.toString("utf-8")
    if (text !== null && redactSensitive(text) !== text) {
      throw new Error(`检测到疑似密钥，文件不会上传到沙箱：${path}`)
    }
    files.push({
      relativePath: path,
      path: `${REMOTE_WORKSPACE_ROOT}/${path}`,
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      sha256: createHash("sha256").update(data).digest("hex"),
      size,
    })
  }
  return files
}
