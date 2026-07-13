import { execSync } from "child_process"

export type ChangedFileGroups = {
  changedFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  deletedFiles: string[]
}

export function parseChangedFiles(diff: string): ChangedFileGroups {
  const changedFiles: string[] = []
  const createdFiles: string[] = []
  const modifiedFiles: string[] = []
  const deletedFiles: string[] = []

  const lines = diff.split("\n")
  let currentPath = ""
  let mode = "modify"

  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/)
    if (diffMatch) {
      currentPath = diffMatch[2]
      mode = diffMatch[1] !== diffMatch[2] ? "rename" : "modify"
      continue
    }
    if (line.startsWith("new file mode")) {
      mode = "add"
      continue
    }
    if (line.startsWith("deleted file mode")) {
      mode = "delete"
      continue
    }
    if (line === "--- /dev/null" && mode !== "delete") {
      mode = "add"
      continue
    }
    if (line === "+++ /dev/null") {
      mode = "delete"
      continue
    }

    if (line.startsWith("@@") && currentPath) {
      changedFiles.push(currentPath)
      if (mode === "add") createdFiles.push(currentPath)
      else if (mode === "delete") deletedFiles.push(currentPath)
      else modifiedFiles.push(currentPath)
      currentPath = ""
      mode = "modify"
    }
  }

  if (currentPath) {
    changedFiles.push(currentPath)
    if (mode === "add") createdFiles.push(currentPath)
    else if (mode === "delete") deletedFiles.push(currentPath)
    else modifiedFiles.push(currentPath)
  }

  return { changedFiles, createdFiles, modifiedFiles, deletedFiles }
}

export function hasWorkspaceChanges(root: string): boolean {
  try {
    const output = execSync("git status --porcelain", {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      encoding: "utf-8",
    })
    return output.trim().length > 0
  } catch {
    return false
  }
}
