"use client"

import { useState } from "react"
import { Check, ChevronRight, Gift, LockKeyhole, RotateCcw, Sparkles, Sun } from "lucide-react"
import { cn } from "@/lib/utils"

const examples = [
  {
    name: "Morning",
    title: "A little routine. A smoother morning.",
    tasks: ["Make the bed", "Get dressed", "Pack the school bag"],
    reward: "Time for a favourite game",
    member: "Alex",
    initial: "A",
  },
  {
    name: "After school",
    title: "Home again. Everyone knows what’s next.",
    tasks: ["Unpack the school bag", "Finish homework", "Feed the dog"],
    reward: "A little screen time",
    member: "Sam",
    initial: "S",
  },
  {
    name: "Evening",
    title: "Wind down with one less thing to remember.",
    tasks: ["Clear the dinner table", "Put toys away", "Brush teeth"],
    reward: "Choose tonight’s story",
    member: "Alex",
    initial: "A",
  },
]

export function RoutineDemo() {
  const [active, setActive] = useState(0)
  const [completed, setCompleted] = useState<string[]>([examples[0].tasks[0]])
  const example = examples[active]
  const allDone = completed.length === example.tasks.length
  return (
    <div className="routine-demo">
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Sun className="size-4 text-primary" /> Our household
        </span>
        <span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Interactive example
        </span>
      </div>
      <div className="p-5 sm:p-7">
        <div className="mb-6 flex gap-1 rounded-xl bg-muted p-1" aria-label="Example routine">
          {examples.map((item, index) => (
            <button
              key={item.name}
              type="button"
              aria-pressed={active === index}
              onClick={() => {
                setActive(index)
                setCompleted([])
              }}
              className={cn(
                "flex-1 rounded-lg px-2 py-2.5 text-xs font-medium transition-colors",
                active === index
                  ? "bg-card text-primary shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.name}
            </button>
          ))}
        </div>
        <div className="mb-6 flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#f3d3bc] text-lg font-semibold text-[#754c34]">
            {example.initial}
          </span>
          <div>
            <p className="text-sm font-semibold">{example.member}’s routine</p>
            <p className="mt-1 text-xs text-muted-foreground">{example.title}</p>
          </div>
        </div>
        <div className="mb-5">
          <div className="mb-2 flex justify-between text-xs">
            <span className="text-muted-foreground">A little progress goes a long way</span>
            <span className="font-semibold text-primary" aria-live="polite">
              {completed.length} / 3 done
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${(completed.length / 3) * 100}%` }}
            />
          </div>
        </div>
        <div className="space-y-2.5">
          {example.tasks.map((task) => {
            const done = completed.includes(task)
            return (
              <button
                key={task}
                type="button"
                aria-pressed={done}
                onClick={() =>
                  setCompleted((previous) =>
                    done ? previous.filter((value) => value !== task) : [...previous, task],
                  )
                }
                className={cn(
                  "flex min-h-14 w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors",
                  done ? "border-primary/15 bg-primary/5" : "border-border bg-white hover:border-primary/40",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border",
                    done ? "border-primary bg-primary text-white" : "border-border",
                  )}
                >
                  {done && <Check className="size-3.5" />}
                </span>
                <span className={cn("flex-1", done && "text-muted-foreground line-through")}>{task}</span>
                {!done && <ChevronRight className="size-3.5 text-muted-foreground" />}
              </button>
            )
          })}
          <div
            className={cn(
              "mt-4 flex items-center gap-3 rounded-xl border border-dashed p-4 transition-colors",
              allDone ? "border-primary/40 bg-[#e6f0d7]" : "border-[#dfcfb4] bg-[#faf3e7]",
            )}
          >
            <Gift className="size-5 shrink-0 text-[#8a642b]" />
            <div className="flex-1">
              <p className="text-xs font-semibold text-[#8a642b]">
                {allDone ? "You earned it!" : "Something to look forward to"}
              </p>
              <p className="mt-1 text-sm font-medium">{example.reward}</p>
            </div>
            {allDone ? (
              <Sparkles className="size-4 text-primary" />
            ) : (
              <LockKeyhole className="size-4 text-[#8a642b]" />
            )}
          </div>
        </div>
        <div className="mt-5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>Try checking off a task above.</span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md p-1 hover:text-primary"
            onClick={() => setCompleted([])}
          >
            <RotateCcw className="size-3" /> Reset
          </button>
        </div>
      </div>
    </div>
  )
}
