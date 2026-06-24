// Build / Test / Fix Loop：最多 N 轮自动修复，失败优先回滚

import type { SupabaseClient } from "@supabase/supabase-js"
import { runVerification, generateFixPrompt, type VerifyResult, type VerifyStep } from "./verify"
import { detectProjectCommands } from "./project-detect"
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "./snapshot"
import { addStep, addArtifact, updateTaskStatus } from "./data"
import { getChangedFiles, getWorkspaceDiff } from "./workspace"
import { redactSensitive } from "./path-security"

export type FixRound = {
  round: number
  snapshotId: string
  beforeErrors: number
  afterErrors: number
  fixApplied: boolean
  fixDescription: string
  verification: VerifyResult
}

export type FixLoopResult = {
  ok: boolean
  rounds: FixRound[]
  finalVerification: VerifyResult
  totalRounds: number
  rolledBack: boolean
  rollbackReason?: string
  summary: string
}

// ───────────── 生成修复 prompt（给 Code Agent 用）─────────────

export function buildFixPrompt(verification: VerifyResult): string | null {
  const failedSteps = verification.steps.filter(s => !s.passed && !s.skipped)
  if (failedSteps.length === 0) return null

  const detected = { framework: "unknown" as const, packageManager: "unknown" as const } // minimal
  return generateFixPrompt(failedSteps, detected as any)
}

// ───────────── 主 loop ─────────────

export async function runFixLoop(
  taskId: string,
  userId: string,
  supabase: SupabaseClient,
  options: {
    maxRounds?: number
    steps?: ("lint" | "typecheck" | "test" | "build")[]
    onFixNeeded?: (round: number, prompt: string, prevResult: VerifyResult) => Promise<{ patch?: string; description: string } | null>
  } = {},
): Promise<FixLoopResult> {
  const maxRounds = Math.min(options.maxRounds ?? 2, 3)
  const rounds: FixRound[] = []
  let rolledBack = false
  let rollbackReason: string | undefined

  await updateTaskStatus(supabase, userId, taskId, "testing")

  // Round 0：初始验证
  await addStep(supabase, userId, taskId, {
    kind: "info",
    label: "初始验证",
    detail: `最多 ${maxRounds} 轮修复`,
  })

  const initial = await runVerification(taskId, userId, supabase, { steps: options.steps })
  await addArtifact(supabase, userId, {
    taskId,
    kind: "build_report",
    title: `初始验证：${initial.ok ? "✓ 通过" : "✗ 失败"}`,
    content: initial.summary.slice(0, 10000),
    meta: {
      passed: initial.ok,
      failedStep: initial.failedStep,
      totalDuration: initial.totalDurationMs,
      errors: initial.steps.flatMap(s => s.parsedErrors?.errors ?? []).length,
    },
  })

  if (initial.ok) {
    await updateTaskStatus(supabase, userId, taskId, "completed")
    return {
      ok: true,
      rounds,
      finalVerification: initial,
      totalRounds: 0,
      rolledBack: false,
      summary: "初始验证通过，无需修复",
    }
  }

  await updateTaskStatus(supabase, userId, taskId, "fixing")

  let currentResult = initial

  for (let round = 0; round < maxRounds; round++) {
    const roundNum = round + 1

    // Step 1：snapshot before fix
    const snap = await createWorkspaceSnapshot(taskId, userId, `auto: before fix round ${roundNum}`, supabase)
    if (!snap.ok) {
      await updateTaskStatus(supabase, userId, taskId, "failed", { error: `Fix loop: snapshot 失败 at round ${roundNum}` })
      return {
        ok: false, rounds, finalVerification: currentResult, totalRounds: roundNum,
        rolledBack: false, summary: `Snapshot 失败 at round ${roundNum}，停止修复`,
      }
    }

    const snapshotId = snap.snapshot.snapshotId
    const beforeErrors = currentResult.steps.reduce((n, s) => n + s.parsedErrors.totalErrors, 0)

    await addStep(supabase, userId, taskId, {
      kind: "info",
      label: `修复第 ${roundNum}/${maxRounds} 轮`,
      detail: `snapshot: ${snapshotId.slice(0, 8)}, errors: ${beforeErrors}`,
    })

    // Step 2：生成 fix prompt & 让调用方修复
    const prompt = buildFixPrompt(currentResult)
    if (!prompt) {
      await updateTaskStatus(supabase, userId, taskId, "waiting_for_user")
      return {
        ok: false, rounds, finalVerification: currentResult, totalRounds: roundNum,
        rolledBack: false, summary: `无法生成修复 prompt（第 ${roundNum} 轮），需要用户介入`,
      }
    }

    let fixDesc = "（修复未执行）"
    let fixApplied = false

    if (options.onFixNeeded) {
      const fixResult = await options.onFixNeeded(roundNum, prompt, currentResult)
      if (fixResult) {
        fixDesc = fixResult.description
        fixApplied = true
      } else {
        await updateTaskStatus(supabase, userId, taskId, "waiting_for_user")
        return {
          ok: false, rounds, finalVerification: currentResult, totalRounds: roundNum,
          rolledBack: false, summary: `第 ${roundNum} 轮：未获得修复方案，等待用户介入`,
        }
      }
    } else {
      // 没有修复回调：只生成 prompt artifact，让前端/用户手动修复
      await addArtifact(supabase, userId, {
        taskId,
        kind: "build_report",
        title: `修复建议 (round ${roundNum})`,
        content: prompt.slice(0, 10000),
        meta: { round: roundNum, snapshotId, beforeErrors },
      })

      await updateTaskStatus(supabase, userId, taskId, "waiting_for_user")
      return {
        ok: false, rounds, finalVerification: currentResult, totalRounds: roundNum,
        rolledBack: false, summary: `已生成修复建议（第 ${roundNum} 轮），请用户手动修复后重试`,
      }
    }

    // Step 3：再验证
    const afterVerification = await runVerification(taskId, userId, supabase, { steps: options.steps })
    const afterErrors = afterVerification.steps.reduce((n, s) => n + s.parsedErrors.totalErrors, 0)

    const fixRound: FixRound = {
      round: roundNum,
      snapshotId,
      beforeErrors,
      afterErrors,
      fixApplied,
      fixDescription: fixDesc,
      verification: afterVerification,
    }
    rounds.push(fixRound)

    // 写入 artifact
    await addArtifact(supabase, userId, {
      taskId,
      kind: "build_report",
      title: `修复轮次 ${roundNum}：${afterVerification.ok ? "✓" : "✗"}`,
      content: [
        `Before: ${beforeErrors} errors`,
        `After: ${afterErrors} errors`,
        `Fix: ${fixDesc}`,
        `Snapshot: ${snapshotId}`,
        "",
        afterVerification.summary,
      ].join("\n"),
      meta: { round: roundNum, snapshotId, beforeErrors, afterErrors, passed: afterVerification.ok },
    })

    // Step 4：判断结果
    if (afterVerification.ok) {
      await updateTaskStatus(supabase, userId, taskId, "completed")
      return {
        ok: true, rounds, finalVerification: afterVerification, totalRounds: roundNum,
        rolledBack: false, summary: `第 ${roundNum} 轮修复后验证通过`,
      }
    }

    // 错误扩大 → 回滚
    if (afterErrors > beforeErrors) {
      rollbackReason = `错误增加（${beforeErrors} → ${afterErrors}），回滚到 snapshot ${snapshotId.slice(0, 8)}`

      await addStep(supabase, userId, taskId, {
        kind: "error",
        label: rollbackReason,
      })

      const restore = await restoreWorkspaceSnapshot(taskId, userId, snapshotId, supabase)
      rolledBack = true

      if (!restore.ok) {
        await updateTaskStatus(supabase, userId, taskId, "failed", { error: `回滚失败：${restore.error}` })
        return {
          ok: false, rounds, finalVerification: currentResult, totalRounds: roundNum,
          rolledBack: true, rollbackReason: `回滚尝试失败：${restore.error}`,
          summary: `错误扩大且回滚失败：${restore.error}`,
        }
      }

      // 回滚成功，但问题仍在
      await updateTaskStatus(supabase, userId, taskId, "waiting_for_user")
      return {
        ok: false, rounds, finalVerification: currentResult, totalRounds: roundNum,
        rolledBack: true, rollbackReason,
        summary: rollbackReason!,
      }
    }

    // 错误没扩大但也没修好 → 继续下一轮
    currentResult = afterVerification
  }

  // 用完所有轮次
  await updateTaskStatus(supabase, userId, taskId, "waiting_for_user")
  return {
    ok: false, rounds, finalVerification: currentResult, totalRounds: maxRounds,
    rolledBack, rollbackReason,
    summary: `${maxRounds} 轮修复后仍未通过，请用户介入`,
  }
}
