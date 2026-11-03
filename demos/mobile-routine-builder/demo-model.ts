export type DemoTask = {
  id: string
  title: string
  people: string[]
  prerequisites: string[]
  reward: boolean
  notes: string
}

export type DemoRoutine = {
  name: string
  days: number[]
  tasks: DemoTask[]
}

export const PEOPLE = ["Alex", "Sam", "You"]
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
export const STORAGE_KEY = "cyntch-mobile-builder-demo-v1"

export function exampleRoutine(): DemoRoutine {
  return {
    name: "School morning",
    days: [0, 1, 2, 3, 4],
    tasks: [
      { id: "dress", title: "Get dressed", people: ["Alex"], prerequisites: [], reward: false, notes: "School uniform and a fresh pair of socks." },
      { id: "breakfast", title: "Eat breakfast", people: ["Alex"], prerequisites: [], reward: false, notes: "" },
      { id: "teeth", title: "Brush teeth", people: ["Alex"], prerequisites: ["breakfast"], reward: false, notes: "" },
      { id: "bag", title: "Pack school bag", people: ["Alex"], prerequisites: ["dress"], reward: false, notes: "Remember your lunch and water bottle." },
      { id: "play", title: "10 minutes of play", people: ["Alex"], prerequisites: ["teeth", "bag"], reward: true, notes: "A little time for your favourite game." },
    ],
  }
}

export function descendants(tasks: DemoTask[], id: string): Set<string> {
  const found = new Set([id])
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      if (!found.has(task.id) && task.prerequisites.some((before) => found.has(before))) {
        found.add(task.id)
        changed = true
      }
    }
  }
  return found
}

export function orderedTasks(tasks: DemoTask[]): DemoTask[] | null {
  const remaining = [...tasks]
  const ordered: DemoTask[] = []
  while (remaining.length) {
    const next = remaining.findIndex((task) => task.prerequisites.every((id) => ordered.some((before) => before.id === id)))
    if (next < 0) return null
    ordered.push(remaining.splice(next, 1)[0])
  }
  return ordered
}

export function taskState(task: DemoTask, completed: string[]) {
  if (completed.includes(task.id)) return "completed"
  return task.prerequisites.every((id) => completed.includes(id)) ? "ready" : "waiting"
}

export function parseSavedRoutine(raw: string | null): DemoRoutine | null {
  try {
    const saved = JSON.parse(raw || "null")
    if (saved?.version !== 1) return null
    const routine = saved.routine
    if (!routine || typeof routine.name !== "string" || !routine.name.trim() || routine.name.length > 70) return null
    if (!Array.isArray(routine.days) || !routine.days.every((day: unknown) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6)) return null
    if (!Array.isArray(routine.tasks) || routine.tasks.length > 50) return null
    for (const task of routine.tasks) {
      if (typeof task.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(task.id)) return null
      if (typeof task.title !== "string" || !task.title.trim() || task.title.length > 70) return null
      if (typeof task.notes !== "string" || task.notes.length > 500 || typeof task.reward !== "boolean") return null
      if (!Array.isArray(task.people) || !task.people.length || !task.people.every((person: unknown) => typeof person === "string" && PEOPLE.includes(person))) return null
      if (!Array.isArray(task.prerequisites) || !task.prerequisites.every((id: unknown) => typeof id === "string")) return null
    }
    if (new Set(routine.tasks.map((task: DemoTask) => task.id)).size !== routine.tasks.length) return null
    if (!orderedTasks(routine.tasks)) return null
    return routine as DemoRoutine
  } catch {
    return null
  }
}

export function scheduleLabel(days: number[]): string {
  if (!days.length) return "Run when you need it"
  if (days.length === 7) return "Every day"
  if (days.length === 5 && [0, 1, 2, 3, 4].every((day) => days.includes(day))) return "Monday–Friday"
  return [...days].sort().map((day) => DAYS[day]).join(" · ")
}
