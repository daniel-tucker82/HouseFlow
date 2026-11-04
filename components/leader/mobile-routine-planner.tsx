"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowDown, ArrowLeft, Check, ChevronRight, ClipboardList, Gift, GitBranch, LockKeyhole, Pencil, Play, Plus, RotateCcw, Settings2, Sun, Trash2 } from "lucide-react"
import type { LeaderFlowEditorProps } from "./flow-editor"
import type { Routine, Task } from "@/lib/types"
import { buildMemberTokenColorMap, memberColorFor } from "@/lib/member-tokens"
import { isRenderableUserProfilePhotoUrl } from "@/lib/clerk-profile-image-url"
import { orderPlannerTasks, taskDescendants, type PlannerTaskInput } from "@/lib/routine-planner"
import { prerequisiteClosure } from "@/shared/routine-planner-graph"
import { parseRoutineRecurrenceRules, recurrenceRuleSummary, type RecurrenceRule } from "@/lib/recurrence"
import styles from "./mobile-planner.module.css"
import { useTaskSaves } from "@/components/task-save-provider"
import { overlayTaskEdits } from "@/lib/task-save-queue"

type Data = Pick<LeaderFlowEditorProps, "tasks" | "members" | "routines" | "dependencies" | "taskAssignees">
type Member = Data["members"][number]
type Draft = PlannerTaskInput
const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const

function MemberToken({ member, color }: { member: Member; color: string }) {
  if (isRenderableUserProfilePhotoUrl(member.avatar_url) && !member.token_color) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={styles.avatar} src={member.avatar_url!} title={member.name} alt="" />
  }
  return <span className={`${styles.avatar} ${color}`} title={member.name} aria-hidden="true">{member.name.split(/\s+/).filter(Boolean).slice(0, 2).map(name => name[0]).join("")}</span>
}

function MemberTokens({ people, colors }: { people: Member[]; colors: Map<string, string> }) {
  return <span className={styles.memberTokens}>
    {people.slice(0, 3).map(person => <MemberToken key={person.id} member={person} color={colors.get(person.id) ?? memberColorFor(person.id)} />)}
    {people.length > 3 && <span className={`${styles.avatar} bg-slate-200 text-slate-900`} aria-hidden="true">+{people.length - 3}</span>}
    <span className={styles.srOnly}>{people.length ? `Assigned to ${people.map(person => person.name).join(", ")}` : "Unassigned"}</span>
  </span>
}

function tokenSpace(count: number) { return count ? 30 + (Math.min(count, 4) - 1) * 17 : 0 }
function hasTimeRules(task: Task) {
  return Boolean((task.unlock_rule?.kind && task.unlock_rule.kind !== "none") || (task.expiry_rule?.kind && task.expiry_rule.kind !== "none") || task.unlock_at || task.expires_at)
}

export function MobileRoutinePlanner({ initial, onCanvas }: { initial: LeaderFlowEditorProps; onCanvas: (routineId: string | null) => void }) {
  const router = useRouter()
  const taskSaves = useTaskSaves()
  const [data, setData] = useState<Data>(initial)
  const [selectedId, setSelectedId] = useState(initial.selectedRoutineId ?? initial.routines[0]?.id ?? "")
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [draft, setDraft] = useState<Draft | null>(null)
  const [details, setDetails] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [practice, setPractice] = useState(false)
  const [completed, setCompleted] = useState<string[]>([])
  const [startConfirm, setStartConfirm] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const colors = useMemo(() => buildMemberTokenColorMap(data.members), [data.members])
  const routine = data.routines.find(item => item.id === selectedId)
  const household = initial.households.find(item => item.id === initial.selectedHouseholdId)
  const rules = parseRoutineRecurrenceRules(routine?.recurrence_rule)
  const routineTasks = orderPlannerTasks(data.tasks.filter(task => task.routine_id === selectedId), data.dependencies)
  const prerequisites = (id: string) => data.dependencies.filter(edge => edge.target_task_id === id).map(edge => edge.source_task_id)
  const assigned = (task: Task): Member[] => {
    const ids = data.taskAssignees.filter(row => row.task_id === task.id).map(row => row.user_id)
    if (!ids.length && task.assignee_id) ids.push(task.assignee_id)
    return data.members.filter(member => ids.includes(member.id))
  }
  const names = (ids: string[]) => ids.map(id => data.tasks.find(task => task.id === id)?.title ?? "Unavailable task").join(" + ")

  const load = useCallback(async (signal?: AbortSignal) => {
    const readRevision = taskSaves?.revision ?? 0
    const query = new URLSearchParams({ householdId: initial.selectedHouseholdId })
    const response = await fetch(`/api/leader/flow?${query}`, { signal, cache: "no-store" })
    const json = await response.json()
    if (!response.ok) throw new Error(json.error || "Could not load your routines.")
    return overlayTaskEdits(json as Data, taskSaves?.overlays(initial.selectedHouseholdId, readRevision) ?? [])
  }, [initial.selectedHouseholdId, taskSaves])

  const acceptLoadedData = useCallback((next: Data) => {
    setData(next)
    setLoaded(true)
    setLoading(false)
  }, [])

  useEffect(() => taskSaves?.onChange(save => {
    if (save.edit.householdId !== initial.selectedHouseholdId) return
    setData(previous => overlayTaskEdits(previous, [save]))
  }), [taskSaves, initial.selectedHouseholdId])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).then(next => {
      if (!controller.signal.aborted) acceptLoadedData(next)
    }).catch(reason => { if (!controller.signal.aborted) { setError(reason.message); setLoading(false) } })
    return () => controller.abort()
  }, [load, acceptLoadedData])

  useEffect(() => {
    if (!draft && !details && !creating) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener("beforeunload", preventLoss)
    return () => window.removeEventListener("beforeunload", preventLoss)
  }, [draft, details, creating])

  async function post(action: string, payload: Record<string, unknown> = {}) {
    await taskSaves?.waitForSaves(initial.selectedHouseholdId)
    const response = await fetch("/api/leader/flow", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, action, householdId: initial.selectedHouseholdId, timezone: household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone }),
    })
    const json = await response.json()
    if (!response.ok) throw new Error(json.error || "Your changes could not be saved. Please try again.")
    return json
  }

  async function run(operation: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(""); setNotice("")
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : "Something went wrong. Please try again."); panelRef.current?.scrollTo({ top: 0 }) }
    finally { setBusy(false) }
  }

  function showCanvas() {
    if ((draft || details || creating) && !window.confirm("Open the canvas? Any unsaved edits in this form will be discarded.")) return
    onCanvas(selectedId || null)
  }

  function selectRoutine(id: string) {
    setSelectedId(id); setPractice(false); setCompleted([]); setNotice(""); setStartConfirm(false)
    const query = new URLSearchParams({ household: initial.selectedHouseholdId, view: "list" })
    if (id) query.set("routine", id)
    router.replace(`/leader/dashboard?${query}`, { scroll: false })
  }

  function edit(task?: Task, after?: Task) {
    setNotice(""); setError("")
    setDraft({ taskId: task?.id ?? crypto.randomUUID(), routineId: selectedId, isNew: !task,
      title: task?.title ?? "", notes: task?.description ?? "", isReward: task?.is_reward ?? false,
      assigneeIds: task ? assigned(task).map(member => member.id) : after ? assigned(after).map(member => member.id) : [],
      prerequisiteIds: task ? prerequisites(task.id) : after ? [after.id] : [],
    })
    panelRef.current?.scrollTo({ top: 0 })
  }

  async function saveTask(value: Draft) {
    if (!value.isNew) {
      try {
        if (!taskSaves) throw new Error("Autosave is not ready. Please try again.")
        taskSaves.enqueue({ ...value, action: "updateTask", householdId: initial.selectedHouseholdId }, 0)
        setDraft(null); setCompleted([]); setError(""); setNotice("")
      } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to keep this edit. Please try again.") }
      return
    }
    await run(async () => {
      const json = await post(value.isNew ? "createTask" : "updateTask", value)
      setData(previous => ({ ...previous,
        tasks: [...previous.tasks.filter(task => task.id !== value.taskId), json.task],
        taskAssignees: [...previous.taskAssignees.filter(row => row.task_id !== value.taskId), ...value.assigneeIds.map(id => ({ task_id: value.taskId, user_id: id }))],
        dependencies: [...previous.dependencies.filter(edge => edge.target_task_id !== value.taskId), ...value.prerequisiteIds.map(id => ({ source_task_id: id, target_task_id: value.taskId }))],
      }))
      setDraft(null); setCompleted([]); setNotice("Task saved to your household."); router.refresh()
    })
  }

  async function deleteTask(value: Draft) {
    await run(async () => {
      await post("deleteTask", { taskId: value.taskId })
      setData(previous => ({ ...previous, tasks: previous.tasks.filter(task => task.id !== value.taskId),
        dependencies: previous.dependencies.filter(edge => edge.source_task_id !== value.taskId && edge.target_task_id !== value.taskId),
        taskAssignees: previous.taskAssignees.filter(row => row.task_id !== value.taskId),
      }))
      setDraft(null); setCompleted([]); setNotice("Task removed from this routine. Existing task boards keep their copies."); router.refresh()
    })
  }

  function updateRoutine(updated: Routine) {
    setData(previous => ({ ...previous, routines: previous.routines.map(item => item.id === updated.id ? updated : item) }))
    setNotice("Routine settings saved."); router.refresh()
  }

  // Include prerequisites from other routines in practice so their role is visible.
  const practiceIds = prerequisiteClosure(routineTasks.map(task => task.id), data.dependencies)
  const practiceTasks = orderPlannerTasks(data.tasks.filter(task => practiceIds.has(task.id)), data.dependencies)

  function taskCard(task: Task) {
    const people = assigned(task)
    const before = prerequisites(task.id)
    const waiting = before.filter(id => !completed.includes(id))
    const done = completed.includes(task.id)
    const state = !practice ? "editing" : done ? "completed" : waiting.length ? "waiting" : "ready"
    const Icon = practice && done ? Check : practice && waiting.length ? LockKeyhole : task.is_reward ? Gift : ClipboardList
    return <article key={task.id} className={styles.taskCard} data-reward={task.is_reward} data-state={state}>
      <button type="button" className={styles.taskMain} disabled={busy || (practice && state !== "ready")} onClick={() => practice ? setCompleted(previous => [...previous, task.id]) : edit(task)} aria-label={`${practice ? state === "ready" ? "Practice completing" : state : "Edit"}: ${task.title}. ${people.length ? people.map(person => person.name).join(", ") : "Unassigned"}`}>
        <span className={styles.taskIcon}><Icon size={20} /></span>
        <span className={styles.taskCopy}><span className={styles.taskTitle} style={{ paddingRight: tokenSpace(people.length) }}>{task.title}</span>
          <span className={styles.taskRule}>{practice ? done ? "Completed in this practice run" : waiting.length ? `Waiting for ${names(waiting)}` : "Ready · tap to complete" : before.length ? `After ${before.length > 1 ? "all: " : ""}${names(before)}` : hasTimeRules(task) ? "Starts when its time conditions are met" : "Ready when the routine starts"}</span>
          {task.routine_id !== selectedId && <span className={styles.taskNotes}>From {data.routines.find(item => item.id === task.routine_id)?.name ?? "another routine"}</span>}
          {!practice && hasTimeRules(task) && before.length > 0 && <span className={styles.taskNotes}>Time conditions also apply{task.unlock_combiner === "or" ? " (either condition can unlock it)" : ""}.</span>}
          {practice && state === "ready" && task.description && <span className={styles.taskNotes}>{task.description}</span>}
        </span><MemberTokens people={people} colors={colors} />{!practice && <ChevronRight size={17} className={styles.chevron} />}
      </button>
      {!practice && <div className={styles.taskFooter}><button type="button" disabled={busy} onClick={() => edit(undefined, task)} aria-label={`Add a task after ${task.title}`}><Plus size={14} />Add next</button><span>{task.is_reward ? "Reward" : before.length > 1 ? "All must be complete" : before.length ? "Follows one task" : "Independent step"}</span></div>}
    </article>
  }

  return <div ref={panelRef} className={styles.page}>
    <div className={styles.shell}>
      {!draft && !details && !creating && <div className={styles.viewTools}><a href={`/member/dashboard?household=${encodeURIComponent(initial.selectedHouseholdId)}`}>Family board</a><button type="button" className={styles.textButton} disabled={busy} onClick={showCanvas}>Canvas view</button></div>}
      {error && <div className={styles.error} role="alert">{error}<button className={styles.textButton} disabled={busy} onClick={() => void run(async () => acceptLoadedData(await load()))}>Refresh routines</button></div>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {draft ? <PlannerTaskEditor key={draft.taskId} draft={draft} data={data} colors={colors} busy={busy} assigned={assigned} onSave={saveTask} onDelete={deleteTask} onCancel={() => setDraft(null)} onCanvas={showCanvas} /> : details && routine ? <RoutineDetails routine={routine} busy={busy} timezone={household?.timezone ?? "UTC"} onClose={() => setDetails(false)} onCanvas={showCanvas} onAction={(action, payload) => run(async () => { const json = await post(action, { ...payload, routineId: routine.id }); updateRoutine(json.routine) })} /> : <>
        <div className={styles.selectors}>
          <label>Household<select value={initial.selectedHouseholdId} disabled={busy || creating} onChange={event => router.push(`/leader/dashboard?household=${encodeURIComponent(event.target.value)}`)}>{initial.households.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Routine<select value={selectedId} disabled={busy || !loaded || creating} onChange={event => selectRoutine(event.target.value)}><option value="">Choose a routine</option>{data.routines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        {creating ? <form className={styles.newRoutine} onSubmit={event => { event.preventDefault(); if (!newName.trim()) return; void run(async () => { const json = await post("createRoutine", { name: newName.trim() }); setData(previous => ({ ...previous, routines: [...previous.routines, json.routine] })); selectRoutine(json.routine.id); setCreating(false); setNewName(""); setNotice("Routine created. Add its first task below."); router.refresh() }) }}><label className={styles.field} htmlFor="new-routine-name">Routine name</label><input className={styles.input} id="new-routine-name" required autoFocus maxLength={250} value={newName} disabled={busy} onChange={event => setNewName(event.target.value)} /><div className={styles.formActions}><button className={styles.primary} disabled={busy || !newName.trim()}>{busy ? "Creating…" : "Create routine"}</button><button type="button" className={styles.secondary} disabled={busy} onClick={() => setCreating(false)}>Cancel</button></div></form> : <button type="button" className={styles.textButton} disabled={busy || !loaded} onClick={() => setCreating(true)}><Plus size={15} />New routine</button>}
        {!loaded ? <p role="status" className={styles.intro}>{loading ? "Loading your household routines…" : "Refresh to load the complete routine before editing."}</p> : routine && !creating && <>
          <header className={styles.routineHeading}><span className={styles.sunIcon}><Sun size={24} /></span><div className={styles.headingCopy}><p className={styles.eyebrow}>YOUR ROUTINE, ONE STEP AT A TIME</p><h1>{routine.name}</h1><p className={styles.schedule}>{rules.length ? `${rules.length} automatic schedule${rules.length === 1 ? "" : "s"}` : "Run when you need it"} · {routineTasks.length} steps</p></div><button type="button" className={styles.iconButton} aria-label="Routine settings" onClick={() => setDetails(true)}><Settings2 size={19} /></button></header>
          <div className={styles.modes} aria-label="Routine view"><button type="button" aria-pressed={!practice} onClick={() => setPractice(false)}><Pencil size={16} />Build routine</button><button type="button" aria-pressed={practice} onClick={() => { setPractice(true); setCompleted([]) }}><Play size={16} />Try it out</button></div>
          {practice ? <><p className={styles.intro}>A practice run of your task order.<br /><span>These taps do not complete real household tasks. Time and expiry rules apply when you start a live routine.</span></p><div className={styles.previewToolbar}><span>{completed.length} / {practiceTasks.length} complete</span><button type="button" className={styles.textButton} onClick={() => setCompleted([])}><RotateCcw size={14} />Start again</button></div><div className={styles.taskList}>{practiceTasks.map(taskCard)}</div></> : <>
            <p className={styles.intro}>Build your routine one step at a time.<br /><span>Changes are saved to your household. Existing task boards keep their original steps.</span></p>
            {routineTasks.length === 0 && <div className={styles.empty}><h2>A fresh start.</h2><p>What’s the first little step in this routine?</p></div>}
            {[false, true].map(follows => { const group = routineTasks.filter(task => Boolean(prerequisites(task.id).length) === follows); return group.length > 0 && <section key={String(follows)} className={styles.taskSection}><div className={styles.sectionHeading}><h2>{follows ? <ArrowDown size={17} /> : <span className={styles.sectionMarker} />}{follows ? "What follows" : "Start independently"}</h2></div><div className={styles.taskList}>{group.map(taskCard)}</div></section> })}
            <button className={styles.addButton} type="button" disabled={busy} onClick={() => edit()}><Plus size={18} />Add a task or reward</button>
            {startConfirm ? <div className={styles.ruleSummary}><div><p>Start “{routine.name}” now? This creates a live task board for your household.</p><div className={styles.formActions}><button type="button" className={styles.primary} disabled={busy} onClick={() => void run(async () => { await post("createOccurrence", { routineId: routine.id, scheduledFor: new Date().toISOString() }); router.push(`/member/dashboard?household=${encodeURIComponent(initial.selectedHouseholdId)}`) })}>{busy ? "Starting…" : "Start routine now"}</button><button type="button" className={styles.secondary} disabled={busy} onClick={() => setStartConfirm(false)}>Cancel</button></div></div></div> : <button type="button" className={styles.startRoutine} disabled={busy || !routineTasks.length} onClick={() => setStartConfirm(true)}><Play size={16} />Start routine</button>}
          </>}
        </>}
        {!loading && !routine && !creating && <p className={styles.intro}>Choose a routine above, or create one to get started.</p>}
      </>}
    </div>
  </div>
}

function PlannerTaskEditor({ draft, data, colors, busy, assigned, onSave, onDelete, onCancel, onCanvas }: {
  draft: Draft; data: Data; colors: Map<string, string>; busy: boolean; assigned: (task: Task) => Member[];
  onSave: (value: Draft) => Promise<void>; onDelete: (value: Draft) => Promise<void>; onCancel: () => void; onCanvas: () => void;
}) {
  const [value, setValue] = useState(draft)
  const [after, setAfter] = useState(draft.prerequisiteIds.length > 0)
  const [remove, setRemove] = useState(false)
  const [error, setError] = useState("")
  const [search, setSearch] = useState("")
  const forbidden = taskDescendants(data.dependencies, draft.taskId)
  const choices = data.tasks.filter(task => task.id !== draft.taskId && (task.routine_id === draft.routineId || draft.prerequisiteIds.includes(task.id))).sort((a, b) => Number(b.routine_id === draft.routineId) - Number(a.routine_id === draft.routineId))
  const selected = choices.filter(task => value.prerequisiteIds.includes(task.id))
  const existing = data.tasks.find(task => task.id === draft.taskId)
  const timed = existing && hasTimeRules(existing)
  const affected = data.dependencies.filter(edge => edge.source_task_id === draft.taskId).map(edge => data.tasks.find(task => task.id === edge.target_task_id)?.title).filter(Boolean)
  return <section className={styles.editor} aria-label={draft.isNew ? "Add task" : "Edit task"}>
    <div className={styles.editorHeading}><button type="button" className={styles.iconButton} disabled={busy} onClick={onCancel} aria-label="Cancel task editing"><ArrowLeft size={20} /></button><div><p className={styles.eyebrow}>ONE STEP AT A TIME</p><h1>{draft.isNew ? "A new little step" : "Make it your own"}</h1></div></div>
    <form onSubmit={event => { event.preventDefault(); if (!value.title.trim()) return setError("Give this task a name."); if (after && !value.prerequisiteIds.length) return setError("Select at least one prerequisite task."); setError(""); void onSave({ ...value, title: value.title.trim(), prerequisiteIds: after ? value.prerequisiteIds : [] }) }}>
      <fieldset disabled={busy} className={styles.editorFields}>
        <div className={styles.kindPicker}><button type="button" aria-pressed={!value.isReward} onClick={() => setValue({ ...value, isReward: false })}><ClipboardList size={17} />Task</button><button type="button" aria-pressed={value.isReward} onClick={() => setValue({ ...value, isReward: true })}><Gift size={17} />Reward</button></div>
        <label className={styles.field} htmlFor="planner-task-title">{value.isReward ? "What are we looking forward to?" : "What needs doing?"}</label><input autoFocus id="planner-task-title" className={styles.input} maxLength={250} required value={value.title} onChange={event => setValue({ ...value, title: event.target.value })} />
        <fieldset className={styles.fieldset}><legend>Who is it for?</legend><div className={styles.peoplePicker}>{data.members.map(member => <label key={member.id} className={styles.personChoice} data-selected={value.assigneeIds.includes(member.id)}><input type="checkbox" checked={value.assigneeIds.includes(member.id)} onChange={() => setValue({ ...value, assigneeIds: value.assigneeIds.includes(member.id) ? value.assigneeIds.filter(id => id !== member.id) : [...value.assigneeIds, member.id] })} /><MemberToken member={member} color={colors.get(member.id) ?? memberColorFor(member.id)} />{member.name}</label>)}</div><p className={styles.helper}>{value.assigneeIds.length ? "Everyone selected is assigned to this task." : "Unassigned. Choose people to show this task on their family board."}</p></fieldset>
        <fieldset className={styles.fieldset}><legend>When can it start?</legend><label className={styles.startChoice}><input type="radio" name="planner-start" checked={!after} onChange={() => setAfter(false)} /><span><strong>{timed ? "No prerequisite tasks" : "When the routine starts"}</strong><small>{timed ? "Existing time conditions still apply." : "It can happen independently."}</small></span></label><label className={styles.startChoice}><input type="radio" name="planner-start" checked={after} disabled={!choices.some(task => !forbidden.has(task.id))} onChange={() => setAfter(true)} /><span><strong>After other tasks</strong><small>Choose what needs to happen first.</small></span></label>
          {after && <div className={styles.prerequisitePicker}><p>Wait until <strong>all selected tasks</strong> are finished.</p>{choices.length > 6 && <input className={styles.input} type="search" aria-label="Find prerequisite tasks" placeholder="Find a task…" value={search} onChange={event => setSearch(event.target.value)} />}{choices.filter(task => task.title.toLowerCase().includes(search.toLowerCase()) || value.prerequisiteIds.includes(task.id)).map(task => { const people = assigned(task); return <label key={task.id} className={styles.prerequisiteChoice} style={{ paddingRight: 12 + tokenSpace(people.length) }} data-disabled={forbidden.has(task.id)}><input type="checkbox" disabled={forbidden.has(task.id)} checked={value.prerequisiteIds.includes(task.id)} onChange={event => setValue({ ...value, prerequisiteIds: event.target.checked ? [...value.prerequisiteIds, task.id] : value.prerequisiteIds.filter(id => id !== task.id) })} /><span className={styles.prerequisiteCopy}>{task.title}{task.routine_id !== draft.routineId && <small>{data.routines.find(item => item.id === task.routine_id)?.name ?? "Another routine"}</small>}{forbidden.has(task.id) && <small>Already follows this task</small>}</span><MemberTokens people={people} colors={colors} /></label> })}</div>}
        </fieldset>
        <div className={styles.ruleSummary}><GitBranch size={18} /><p>{after ? selected.length ? `Starts after all of these are complete: ${selected.map(task => task.title).join(" + ")}.` : "Select the tasks that need to be finished first." : timed ? "No prerequisite tasks. Existing time conditions still apply." : "Ready when the routine starts."}</p></div>
        {timed && <p className={styles.helper}>This task also has time or expiry rules. These are preserved when you save. {existing?.unlock_combiner === "or" && "Its time condition can unlock it independently of the prerequisites. "}Use the canvas settings to change them.</p>}
        <label className={styles.field} htmlFor="planner-task-notes">A little extra guidance <span>Optional</span></label><textarea id="planner-task-notes" className={styles.input} rows={3} maxLength={10000} value={value.notes} onChange={event => setValue({ ...value, notes: event.target.value })} />
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.formActions}><button className={styles.primary} type="submit"><Check size={18} />{busy ? "Saving…" : draft.isNew ? "Add to routine" : "Save changes"}</button><button className={styles.secondary} type="button" onClick={onCancel}>Cancel</button></div>
        {!draft.isNew && (remove ? <div className={styles.deleteConfirmation}><p>Remove “{draft.title}” from this routine?</p><small>{affected.length ? `It will also be removed from the prerequisites for ${affected.join(", ")}. ` : ""}Existing task boards keep their copies. This cannot be undone.</small><div><button type="button" className={styles.dangerButton} onClick={() => void onDelete(value)}>Remove task</button><button type="button" className={styles.textButton} onClick={() => setRemove(false)}>Keep task</button></div></div> : <button type="button" className={styles.deleteButton} onClick={() => setRemove(true)}><Trash2 size={16} />Remove this task</button>)}
        <button type="button" className={styles.textButton} onClick={onCanvas}>Open canvas for advanced settings</button>
      </fieldset>
    </form>
  </section>
}

function RoutineDetails({ routine, busy, timezone, onClose, onCanvas, onAction }: { routine: Routine; busy: boolean; timezone: string; onClose: () => void; onCanvas: () => void; onAction: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(routine.name)
  const rules = parseRoutineRecurrenceRules(routine.recurrence_rule)
  return <section className={styles.editor}><div className={styles.editorHeading}><button className={styles.iconButton} type="button" disabled={busy} onClick={onClose} aria-label="Back to routine"><ArrowLeft size={20} /></button><h1>Routine details</h1></div>
    <form onSubmit={event => { event.preventDefault(); void onAction("renameRoutine", { name: name.trim() }) }}><label className={styles.field} htmlFor="planner-routine-name">Routine name</label><input className={styles.input} id="planner-routine-name" maxLength={250} required disabled={busy} value={name} onChange={event => setName(event.target.value)} /><button className={styles.startRoutine} disabled={busy || !name.trim()}>Save name</button></form>
    <h2 className={styles.scheduleHeading}>Automatic schedules</h2><p className={styles.helper}>Each schedule creates a task board. Times use {timezone}. You can also start this routine manually.</p>
    {rules.map(rule => <ScheduleEditor key={`${rule.id}:${JSON.stringify(rule)}`} rule={rule} busy={busy} onCanvas={onCanvas} onSave={patch => onAction("updateRecurrenceRule", { recurrenceRuleId: rule.id, rule: patch })} onDelete={() => onAction("deleteRecurrenceRule", { recurrenceRuleId: rule.id })} />)}
    <button type="button" className={styles.addButton} disabled={busy} onClick={() => void onAction("addRecurrenceRule", {})}><Plus size={16} />Add weekly schedule</button>
    <button type="button" className={styles.startRoutine} disabled={busy} onClick={onClose}>Back to routine</button>
  </section>
}

function ScheduleEditor({ rule, busy, onCanvas, onSave, onDelete }: { rule: RecurrenceRule; busy: boolean; onCanvas: () => void; onSave: (rule: RecurrenceRule) => Promise<void>; onDelete: () => Promise<void> }) {
  const [value, setValue] = useState(rule)
  const [remove, setRemove] = useState(false)
  return <form className={styles.scheduleCard} onSubmit={event => { event.preventDefault(); void onSave(value) }}><p>{recurrenceRuleSummary(rule)}</p>{rule.frequency === "daily" || rule.frequency === "weekly" ? <fieldset disabled={busy} className={styles.editorFields}><div className={styles.selectors}><label>Repeat<select value={value.frequency} onChange={event => setValue({ ...value, frequency: event.target.value as "daily" | "weekly", weekday: value.weekday ?? "monday" })}><option value="weekly">Weekly</option><option value="daily">Daily</option></select></label><label>Every ({value.frequency === "weekly" ? "weeks" : "days"})<input className={styles.input} type="number" min={1} max={365} required value={value.interval} onChange={event => setValue({ ...value, interval: Number(event.target.value) })} /></label>{value.frequency === "weekly" && <label>Day<select value={value.weekday ?? "monday"} onChange={event => setValue({ ...value, weekday: event.target.value as RecurrenceRule["weekday"] })}>{weekdays.map(day => <option value={day} key={day}>{day[0].toUpperCase() + day.slice(1)}</option>)}</select></label>}<label>Time<input className={styles.input} type="time" required value={value.time} onChange={event => setValue({ ...value, time: event.target.value })} /></label><label>Start date<input className={styles.input} type="date" value={value.startDate ?? ""} onChange={event => setValue({ ...value, startDate: event.target.value })} /></label></div><button type="submit" className={styles.textButton}>Save schedule</button></fieldset> : <button type="button" className={styles.textButton} disabled={busy} onClick={onCanvas}>Edit advanced schedule in canvas</button>}
    {remove ? <div><p>Remove this automatic schedule?</p><button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void onDelete()}>Remove schedule</button><button type="button" className={styles.textButton} disabled={busy} onClick={() => setRemove(false)}>Keep schedule</button></div> : <button type="button" className={styles.textButton} disabled={busy} onClick={() => setRemove(true)}>Remove schedule</button>}
  </form>
}
