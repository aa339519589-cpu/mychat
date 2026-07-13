import assert from "node:assert/strict"
import test from "node:test"
import { parseChangedFiles } from "../lib/agent/snapshot/diff"

test("snapshot diff parsing classifies created, modified, deleted, and renamed paths", () => {
  const diff = [
    "diff --git a/created.txt b/created.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/created.txt",
    "@@ -0,0 +1 @@",
    "+created",
    "diff --git a/modified.txt b/modified.txt",
    "--- a/modified.txt",
    "+++ b/modified.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/deleted.txt b/deleted.txt",
    "deleted file mode 100644",
    "--- a/deleted.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-deleted",
    "diff --git a/old-name.txt b/new-name.txt",
    "similarity index 100%",
    "rename from old-name.txt",
    "rename to new-name.txt",
  ].join("\n")

  assert.deepEqual(parseChangedFiles(diff), {
    changedFiles: ["created.txt", "modified.txt", "deleted.txt", "new-name.txt"],
    createdFiles: ["created.txt"],
    modifiedFiles: ["modified.txt", "new-name.txt"],
    deletedFiles: ["deleted.txt"],
  })
})
