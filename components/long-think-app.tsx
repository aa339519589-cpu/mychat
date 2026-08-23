"use client"

import Link from "next/link"
import { ArrowLeft, BrainCircuit } from "lucide-react"
import { LongThinkSetup } from "@/components/long-think-setup"
import { LongThinkRunning } from "@/components/long-think-running"
import { LongThinkTaskList } from "@/components/long-think-task-list"
import { useLongThinkJob } from "@/components/use-long-think"

function Header() {
  return <header className="flex items-center gap-3 py-3">
    <Link href="/" aria-label="返回 MyChat" className="fluid-press flex size-10 items-center justify-center rounded-full border border-border/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground"><ArrowLeft className="size-4" /></Link>
    <div><div className="flex items-center gap-2"><BrainCircuit className="size-4" /><h1 className="font-heading text-xl font-semibold tracking-[-0.02em]">Long Think</h1></div><p className="mt-0.5 text-xs text-muted-foreground">多个任务后台并行，持续续接，闭环后交付答案</p></div>
  </header>
}

export function LongThinkApp() {
  const { activeJobId, job, jobs, endpoints, selectJob, refreshJobs, refreshEndpoints } = useLongThinkJob()
  const newTask = () => selectJob("")
  const started = (jobId: string) => {
    selectJob(jobId)
    void refreshJobs().catch(() => undefined)
  }

  return <main className="min-h-dvh bg-background text-foreground"><div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
    <Header />
    {activeJobId
      ? <LongThinkRunning jobId={activeJobId} job={job} onNew={newTask} />
      : <LongThinkSetup endpoints={endpoints} onStarted={started} onEndpointCreated={() => { void refreshEndpoints().catch(() => undefined) }} />}
    <LongThinkTaskList jobs={jobs} selectedId={activeJobId} onSelect={selectJob} onNew={newTask} />
  </div></main>
}
