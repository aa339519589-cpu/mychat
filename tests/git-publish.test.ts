import assert from "node:assert/strict"
import test from "node:test"

import { canResumeCommittedPublish } from "../lib/agent/git-publish/publish"
import {
  checkRiskFiles,
  isValidGitHubRepository,
} from "../lib/agent/git-publish/shared"

test("committed publish resumes only from the exact recorded HEAD", () => {
  const cleanStatus = { ok: true, hasChanges: false, commitSha: "head-sha" }
  assert.equal(canResumeCommittedPublish(cleanStatus, {
    commitSha: "head-sha",
    pullRequestUrl: null,
  }), true)
  assert.equal(canResumeCommittedPublish(cleanStatus, {
    commitSha: "different-sha",
    pullRequestUrl: null,
  }), false)
  assert.equal(canResumeCommittedPublish(cleanStatus, {
    commitSha: "head-sha",
    pullRequestUrl: "https://github.com/owner/repo/pull/1",
  }), false)
  assert.equal(canResumeCommittedPublish({ ...cleanStatus, hasChanges: true }, {
    commitSha: "head-sha",
    pullRequestUrl: null,
  }), false)
})

test("publish remote accepts only an owner and repository slug", () => {
  assert.equal(isValidGitHubRepository("owner/project"), true)
  assert.equal(isValidGitHubRepository("owner.name/project_name.git"), true)
  assert.equal(isValidGitHubRepository("owner/project/extra"), false)
  assert.equal(isValidGitHubRepository("owner@host/project"), false)
  assert.equal(isValidGitHubRepository("https://github.com/owner/project"), false)
})

test("publish safety adapter preserves blocked and confirmation file classes", () => {
  assert.deepEqual(checkRiskFiles([".env.production"]), {
    blocked: [".env.production"],
    warnings: [],
  })
  assert.deepEqual(checkRiskFiles([".github/workflows/deploy.yml"]), {
    blocked: [],
    warnings: [".github/workflows/deploy.yml"],
  })
})
