import type { BoardSnapshot } from "./contracts"

export type RunView = "active" | "past"
export interface RunSummary {
  id: string; routine_id: string | null; title: string; kind: "routine" | "manual";
  scheduled_for: string; status: "active" | "completed" | "cancelled";
  total_tasks: number; completed_tasks: number;
}
export interface RunPage { householdId: string; view: RunView; items: RunSummary[]; nextCursor: string | null; fetchedAt: string }
export interface RunSnapshot extends BoardSnapshot { run: RunSummary }
export function runView(run: RunSummary): RunView {
  return run.status === "active" && (!run.total_tasks || run.completed_tasks < run.total_tasks) ? "active" : "past"
}
export function summarizeRun(snapshot: RunSnapshot): RunSnapshot {
  const total = snapshot.tasks.length, completed = snapshot.tasks.filter(task => task.status === "completed").length
  return { ...snapshot, run: { ...snapshot.run, total_tasks: total, completed_tasks: completed,
    status: snapshot.run.status === "cancelled" ? "cancelled" : total ? completed === total ? "completed" : "active" : snapshot.run.status } }
}
export function mergeRunPages(previous: RunPage, next: RunPage): RunPage {
  if (previous.householdId !== next.householdId || previous.view !== next.view) throw new Error("The run list changed. Refresh it before loading more.")
  return { ...next, items: [...new Map([...previous.items, ...next.items].map(run => [run.id, run])).values()] }
}
