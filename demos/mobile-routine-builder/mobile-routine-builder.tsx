"use client"

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  ArrowDown, ArrowLeft, ArrowRight, Check, ChevronRight, CircleCheck,
  ClipboardList, Gift, GitBranch, House, LockKeyhole, Pencil, Play, Plus,
  RotateCcw, Settings2, Sparkles, Sun, Trash2, X,
} from "lucide-react"
import {
  DAYS, PEOPLE, descendants, exampleRoutine, orderedTasks,
  scheduleLabel, taskState, type DemoRoutine, type DemoTask,
} from "./demo-model"
import { createDemoRoutineStore } from "./demo-store"
import styles from "./mobile-builder.module.css"

type TaskDraft = DemoTask & { isNew?: boolean }
type Notice = { text: string; previous?: DemoRoutine }

function FamilyMemberToken({ person }: { person: string }) {
  return <span className={styles.avatar} data-person={person} title={person} aria-hidden="true">{person[0]}</span>
}

function FamilyMemberTokens({ people }: { people: string[] }) {
  return <span className={styles.memberTokens}>{people.map((person) => <FamilyMemberToken key={person} person={person} />)}<span className={styles.srOnly}>Assigned to {people.join(" & ")}</span></span>
}

function TaskEditor({ draft, tasks, onSave, onCancel, onDelete }: {
  draft: TaskDraft
  tasks: DemoTask[]
  onSave: (task: TaskDraft) => void
  onCancel: () => void
  onDelete: (task: DemoTask) => void
}) {
  const [value, setValue] = useState(draft)
  const [start, setStart] = useState(draft.prerequisites.length ? "after" : "immediately")
  const [error, setError] = useState("")
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const forbidden = descendants(tasks, draft.id)
  const choices = tasks.filter((task) => task.id !== draft.id)
  const selected = tasks.filter((task) => value.prerequisites.includes(task.id))
  const affected = tasks.filter((task) => task.prerequisites.includes(draft.id))
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => { titleRef.current?.focus() }, [])

  function togglePerson(person: string) {
    setValue((current) => ({ ...current, people: current.people.includes(person) ? current.people.filter((item) => item !== person) : [...current.people, person] }))
  }

  return (
    <section className={styles.editor} aria-label={draft.isNew ? "Add task" : "Edit task"}>
      <div className={styles.editorHeading}>
        <button className={styles.iconButton} onClick={onCancel} type="button" aria-label="Cancel task editing"><ArrowLeft size={20} /></button>
        <div><p className={styles.eyebrow}>ONE STEP AT A TIME</p><h1>{draft.isNew ? "A new little step" : "Make it your own"}</h1></div>
      </div>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (!value.title.trim()) { setError("Give this task a name."); titleRef.current?.focus(); return }
        if (!value.people.length) { setError("Choose at least one person for this task."); return }
        if (start === "after" && !value.prerequisites.length) { setError("Choose a task to wait for, or select ‘When the routine starts’."); return }
        onSave({ ...value, title: value.title.trim(), prerequisites: start === "after" ? value.prerequisites : [] })
      }}>
        <fieldset className={styles.kindPicker}>
          <legend className={styles.srOnly}>Step type</legend>
          <button type="button" aria-pressed={!value.reward} onClick={() => setValue({ ...value, reward: false })}><ClipboardList size={17} />Task</button>
          <button type="button" aria-pressed={value.reward} onClick={() => setValue({ ...value, reward: true })}><Gift size={17} />Reward</button>
        </fieldset>
        <label className={styles.field} htmlFor="demo-task-title">{value.reward ? "What are we looking forward to?" : "What needs doing?"}</label>
        <input ref={titleRef} id="demo-task-title" className={styles.input} value={value.title} onChange={(event) => setValue({ ...value, title: event.target.value })} maxLength={70} required placeholder={value.reward ? "e.g. Choose tonight’s movie" : "e.g. Fill water bottle"} autoComplete="off" />

        <fieldset className={styles.fieldset}><legend>Who is it for?</legend>
          <div className={styles.peoplePicker}>{PEOPLE.map((person) => <label key={person} className={styles.personChoice} data-selected={value.people.includes(person)}><input type="checkbox" checked={value.people.includes(person)} onChange={() => togglePerson(person)} /><FamilyMemberToken person={person} />{person}</label>)}</div>
        </fieldset>

        <fieldset className={styles.fieldset}><legend>When can it start?</legend>
          <label className={styles.startChoice}><input name="start-rule" type="radio" checked={start === "immediately"} onChange={() => setStart("immediately")} /><span><strong>When the routine starts</strong><small>It can happen independently.</small></span></label>
          <label className={styles.startChoice}><input name="start-rule" type="radio" checked={start === "after"} onChange={() => setStart("after")} disabled={!choices.some((task) => !forbidden.has(task.id))} /><span><strong>After other tasks</strong><small>Choose what needs to happen first.</small></span></label>
          {start === "after" && <div className={styles.prerequisitePicker}><p>Wait until <strong>all selected tasks</strong> are finished.</p>{choices.map((task) => <label key={task.id} className={styles.prerequisiteChoice} style={{ paddingRight: 42 + (task.people.length - 1) * 17 }} data-disabled={forbidden.has(task.id)}><input type="checkbox" disabled={forbidden.has(task.id)} checked={value.prerequisites.includes(task.id)} onChange={(event) => setValue({ ...value, prerequisites: event.target.checked ? [...value.prerequisites, task.id] : value.prerequisites.filter((id) => id !== task.id) })} /><span className={styles.prerequisiteCopy}>{task.title}{forbidden.has(task.id) && <small>Already follows this task</small>}</span><FamilyMemberTokens people={task.people} /></label>)}</div>}
        </fieldset>

        <div className={styles.ruleSummary} aria-live="polite"><GitBranch size={18} /><p>{start === "immediately" ? "Ready when the routine starts. It won’t hold up other independent tasks." : selected.length ? <>Starts after {selected.length > 1 ? "all of these are complete: " : ""}<strong>{selected.map((task) => task.title).join(" + ")}</strong>.</> : "Select the tasks that need to be finished first."}</p></div>

        <label className={styles.field} htmlFor="demo-task-notes">A little extra guidance <span>Optional</span></label>
        <textarea id="demo-task-notes" className={styles.input} rows={3} maxLength={500} value={value.notes} onChange={(event) => setValue({ ...value, notes: event.target.value })} placeholder="Anything that makes this step easier…" />
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.formActions}><button type="submit" className={styles.primary}><Check size={18} />{draft.isNew ? "Add to routine" : "Save changes"}</button><button type="button" className={styles.secondary} onClick={onCancel}>Cancel</button></div>
        {!draft.isNew && (deleteConfirm ? <div className={styles.deleteConfirmation}><p>Remove “{draft.title}”?</p><small>{affected.length ? `It will also be removed from the start rules for ${affected.map((task) => task.title).join(", ")}.` : "You can undo this after removing it."}</small><div><button className={styles.dangerButton} type="button" onClick={() => onDelete(draft)}>Remove task</button><button className={styles.textButton} type="button" onClick={() => setDeleteConfirm(false)}>Keep task</button></div></div> : <button type="button" className={styles.deleteButton} onClick={() => setDeleteConfirm(true)}><Trash2 size={16} />Remove this {value.reward ? "reward" : "task"}</button>)}
      </form>
    </section>
  )
}

function RoutineSettings({ routine, onSave, onCancel }: { routine: DemoRoutine; onSave: (name: string, days: number[]) => void; onCancel: () => void }) {
  const [name, setName] = useState(routine.name)
  const [days, setDays] = useState(routine.days)
  return <section className={styles.editor} aria-label="Routine settings"><div className={styles.editorHeading}><button className={styles.iconButton} onClick={onCancel} type="button" aria-label="Cancel routine settings"><ArrowLeft size={20} /></button><div><p className={styles.eyebrow}>YOUR FAMILY’S RHYTHM</p><h1>Routine details</h1></div></div><form onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSave(name.trim(), days) }}><label htmlFor="demo-routine-name" className={styles.field}>Routine name</label><input id="demo-routine-name" className={styles.input} value={name} maxLength={70} required onChange={(event) => setName(event.target.value)} /><fieldset className={styles.fieldset}><legend>Which days?</legend><p className={styles.helper}>Leave all days off to run it whenever you need it.</p><div className={styles.dayPicker}>{DAYS.map((day, index) => <button key={day} type="button" aria-pressed={days.includes(index)} onClick={() => setDays(days.includes(index) ? days.filter((value) => value !== index) : [...days, index])}>{day}</button>)}</div></fieldset><div className={styles.ruleSummary}><Sun size={19} /><p>{scheduleLabel(days)}<small>This demo previews one run of your routine.</small></p></div><div className={styles.formActions}><button type="submit" className={styles.primary}>Save details<Check size={18} /></button><button type="button" className={styles.secondary} onClick={onCancel}>Cancel</button></div></form></section>
}

function TaskCard({ task, tasks, preview, completed, justUnlocked, onEdit, onNext, onComplete }: {
  task: DemoTask; tasks: DemoTask[]; preview: boolean; completed: string[]; justUnlocked: boolean
  onEdit: () => void; onNext: () => void; onComplete: () => void
}) {
  const state = taskState(task, completed)
  const missing = task.prerequisites.filter((id) => !completed.includes(id))
  const names = (ids: string[]) => ids.map((id) => tasks.find((item) => item.id === id)?.title).filter(Boolean).join(" + ")
  const Icon = preview ? state === "completed" ? Check : state === "waiting" ? LockKeyhole : task.reward ? Gift : CircleCheck : task.reward ? Gift : ClipboardList
  return <article className={styles.taskCard} data-reward={task.reward} data-state={preview ? state : "editing"} data-unlocked={justUnlocked}>
    <button type="button" className={styles.taskMain} onClick={preview ? onComplete : onEdit} disabled={preview && state !== "ready"} aria-label={`${preview ? state === "completed" ? "Completed" : state === "waiting" ? "Waiting" : "Complete" : "Edit"}: ${task.title}, assigned to ${task.people.join(" & ")}`}>
      <span className={styles.taskIcon}><Icon size={20} /></span>
      <span className={styles.taskCopy}><span className={styles.taskTitle} style={{ paddingRight: 30 + (task.people.length - 1) * 17 }}>{task.title}</span><span className={styles.taskRule}>{!preview && task.reward && "Reward · "}{preview ? state === "completed" ? "Completed in this practice run" : state === "ready" ? task.reward ? "Reward unlocked · enjoy!" : "Ready · tap to complete" : `Waiting for ${names(missing)}` : task.prerequisites.length ? `After ${task.prerequisites.length > 1 ? "all: " : ""}${names(task.prerequisites)}` : "Ready when the routine starts"}</span>{preview && task.notes && state === "ready" && <span className={styles.taskNotes}>{task.notes}</span>}</span>
      <FamilyMemberTokens people={task.people} />
      {!preview && <ChevronRight size={17} className={styles.chevron} />}
    </button>
    {!preview && <div className={styles.taskFooter}><button type="button" onClick={onNext} disabled={tasks.length >= 50} aria-label={`Add a task after ${task.title}`}><Plus size={14} />Add next</button><span>{task.prerequisites.length > 1 ? "All must be complete" : task.prerequisites.length ? "Follows one task" : "Independent step"}</span></div>}
  </article>
}

export function MobileRoutineBuilder() {
  const [routineStore] = useState(() => createDemoRoutineStore(() => localStorage))
  const { routine, loaded, storageIssue } = useSyncExternalStore(routineStore.subscribe, routineStore.getSnapshot, routineStore.getServerSnapshot)
  const setRoutine = routineStore.save
  const [mode, setMode] = useState<"build" | "preview">("build")
  const [draft, setDraft] = useState<TaskDraft | null>(null)
  const [settings, setSettings] = useState(false)
  const [completed, setCompleted] = useState<string[]>([])
  const [justUnlocked, setJustUnlocked] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [resetConfirm, setResetConfirm] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const lastTrigger = useRef<HTMLElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const restoreFocus = useRef(false)

  function returnToBuilder() {
    restoreFocus.current = true
    setDraft(null); setSettings(false)
  }

  useLayoutEffect(() => {
    if (draft || settings || !restoreFocus.current) return
    restoreFocus.current = false
    if (lastTrigger.current?.isConnected) lastTrigger.current.focus()
    else headingRef.current?.focus()
  }, [draft, settings])

  function editTask(task: TaskDraft) {
    lastTrigger.current = document.activeElement as HTMLElement
    setNotice(null); setDraft(task); setResetConfirm(false)
    window.scrollTo({ top: 0, behavior: "instant" })
  }

  function addTask(after?: DemoTask) {
    if (routine.tasks.length >= 50) { setNotice({ text: "This demo supports up to 50 steps in a routine." }); return }
    editTask({ id: crypto.randomUUID(), title: "", people: after?.people || ["Alex"], prerequisites: after ? [after.id] : [], reward: false, notes: "", isNew: true })
  }

  function updateRoutine(next: DemoRoutine, text: string, undo = false) {
    setNotice({ text, ...(undo ? { previous: routine } : {}) })
    setRoutine(next); setCompleted([]); setJustUnlocked([]); setAnnouncement(text)
  }

  function saveTask(task: TaskDraft) {
    const { isNew, ...saved } = task
    const tasks = orderedTasks(isNew ? [...routine.tasks, saved] : routine.tasks.map((item) => item.id === task.id ? saved : item))
    if (!tasks) { setAnnouncement("Those start rules would create a loop. Please choose different tasks."); return }
    updateRoutine({ ...routine, tasks }, `${saved.title} ${isNew ? "added" : "updated"}.`)
    returnToBuilder()
  }

  function completeTask(task: DemoTask) {
    if (taskState(task, completed) !== "ready") return
    const next = [...completed, task.id]
    const unlocked = routine.tasks.filter((item) => taskState(item, completed) === "waiting" && taskState(item, next) === "ready")
    const message = `${task.title} done.${unlocked.length ? ` ${unlocked.map((item) => item.title).join(" and ")} ${unlocked.length > 1 ? "are" : "is"} now ready.` : next.length === routine.tasks.length ? " Your routine is complete!" : ""}`
    setCompleted(next); setJustUnlocked(unlocked.map((item) => item.id)); setAnnouncement(message)
  }

  const starters = routine.tasks.filter((task) => !task.prerequisites.length)
  const followers = routine.tasks.filter((task) => task.prerequisites.length)
  const readyCount = routine.tasks.filter((task) => taskState(task, completed) === "ready").length
  const allDone = routine.tasks.length > 0 && completed.length === routine.tasks.length

  function renderCard(task: DemoTask) {
    return <TaskCard key={task.id} task={task} tasks={routine.tasks} preview={mode === "preview"} completed={completed} justUnlocked={justUnlocked.includes(task.id)} onEdit={() => editTask(task)} onNext={() => addTask(task)} onComplete={() => completeTask(task)} />
  }

  return <div className={styles.page}>
    <div className={styles.demoBar}><span className={styles.demoDot} />Local demo<span className={styles.demoBarNote}>Sample data · explore freely</span></div>
    <header className={styles.brandHeader}><span className={styles.brand}><span><House size={22} strokeWidth={1.7} /></span>cyntch.</span><span className={styles.headerLabel}>THE ROUTINE STUDIO</span></header>
    <main className={styles.shell}>
      {draft ? <TaskEditor key={draft.id} draft={draft} tasks={routine.tasks} onSave={saveTask} onCancel={returnToBuilder} onDelete={(task) => { updateRoutine({ ...routine, tasks: routine.tasks.filter((item) => item.id !== task.id).map((item) => ({ ...item, prerequisites: item.prerequisites.filter((id) => id !== task.id) })) }, `${task.title} removed.`, true); returnToBuilder() }} /> : settings ? <RoutineSettings routine={routine} onCancel={returnToBuilder} onSave={(name, days) => { updateRoutine({ ...routine, name, days }, "Routine details updated."); returnToBuilder() }} /> : <>
        <div className={styles.routineHeading}><span className={styles.sunIcon}><Sun size={25} strokeWidth={1.6} /></span><div className={styles.headingCopy}><p className={styles.eyebrow}>A LITTLE STRUCTURE. MORE BREATHING ROOM.</p><h1 ref={headingRef} tabIndex={-1}>{routine.name}</h1><p className={styles.schedule}>{scheduleLabel(routine.days)}<span>·</span>{routine.tasks.length} steps</p></div><button type="button" className={styles.iconButton} aria-label="Edit routine details" onClick={() => { lastTrigger.current = document.activeElement as HTMLElement; setSettings(true); setNotice(null); window.scrollTo({ top: 0, behavior: "instant" }) }}><Settings2 size={20} /></button></div>
        <div className={styles.modes} role="group" aria-label="Routine view"><button type="button" aria-pressed={mode === "build"} onClick={() => { setMode("build"); setNotice(null) }}><Pencil size={16} />Build routine</button><button type="button" aria-pressed={mode === "preview"} onClick={() => { setMode("preview"); setNotice(null) }}><Play size={16} />Try it out</button></div>
        {notice && <div className={styles.notice} role="status"><Check size={17} /><span>{notice.text}</span>{notice.previous && <button type="button" onClick={() => { setRoutine(notice.previous!); setNotice({ text: "Change undone." }); setCompleted([]); setAnnouncement("Change undone.") }}>Undo</button>}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={16} /></button></div>}

        {mode === "build" ? <>
          <p className={styles.intro}>Build your routine one step at a time.<br /><span>Tap a task to change who, what, or when.</span></p>
          {!routine.tasks.length && <div className={styles.empty}><Sparkles size={32} /><h2>A fresh start.</h2><p>What’s the first little step in your routine?</p><button type="button" className={styles.primary} onClick={() => addTask()}><Plus size={18} />Add your first task</button></div>}
          {starters.length > 0 && <section className={styles.taskSection}><div className={styles.sectionHeading}><h2><span className={styles.sectionMarker} />Start independently</h2><span>Any order</span></div><div className={styles.taskList}>{starters.map(renderCard)}</div></section>}
          {followers.length > 0 && <section className={styles.taskSection}><div className={styles.sectionHeading}><h2><ArrowDown size={17} />What follows</h2><span>Each has its own rule</span></div><div className={styles.taskList}>{followers.map(renderCard)}</div></section>}
          {routine.tasks.length > 0 && <button className={styles.addButton} type="button" onClick={() => addTask()} disabled={routine.tasks.length >= 50}><Plus size={19} />Add a task or reward</button>}
          <div className={styles.explanation}><GitBranch size={18} /><p>One branch can move ahead while another is still waiting. <button type="button" onClick={() => setMode("preview")}>See it in action <ArrowRight size={13} /></button></p></div>
        </> : <>
          <div className={styles.previewIntro}><span className={styles.previewIcon}><Play size={18} /></span><div><h2>A little practice run</h2><p>Tap a ready task and watch what unlocks next. Your real household won’t be affected.</p></div></div>
          <div className={styles.progressHeading}><span><strong>{completed.length}</strong> / {routine.tasks.length} complete</span><button type="button" onClick={() => { setCompleted([]); setJustUnlocked([]); setAnnouncement("Practice run restarted.") }}><RotateCcw size={14} />Start again</button></div>
          <div className={styles.progressTrack} role="progressbar" aria-label="Practice run completion" aria-valuemin={0} aria-valuemax={routine.tasks.length || 1} aria-valuenow={completed.length}><div style={{ width: `${routine.tasks.length ? completed.length / routine.tasks.length * 100 : 0}%` }} /></div>
          {allDone ? <div className={styles.success} role="status"><Sparkles size={26} /><h2>A little less reminding.<br />A morning well done.</h2><p>Every step is complete. That’s how your routine will flow.</p></div> : <div className={styles.readySummary} aria-live="polite">{routine.tasks.length ? `${readyCount} ${readyCount === 1 ? "step is" : "steps are"} ready to go` : "Add a task in Build routine to try it out."}</div>}
          <div className={styles.taskList}>{routine.tasks.map(renderCard)}</div>
        </>}

        <footer className={styles.footer}><p>{storageIssue ? "Browser storage unavailable · changes last until you leave" : loaded ? "Your demo is saved in this browser" : "Loading your demo…"}</p>{resetConfirm ? <div className={styles.resetPanel}><p>Replace your edits with the sample routine?</p><div><button className={styles.textButton} type="button" onClick={() => { updateRoutine(exampleRoutine(), "Sample routine restored.", true); setResetConfirm(false); setMode("build") }}>Restore sample</button><button className={styles.textButton} type="button" onClick={() => setResetConfirm(false)}>Keep my edits</button></div></div> : <div className={styles.footerActions}><button type="button" onClick={() => setResetConfirm(true)}><RotateCcw size={13} />Reset example</button><button type="button" onClick={() => { updateRoutine({ name: "My new routine", days: [], tasks: [] }, "A blank routine, ready for your ideas.", true); setMode("build") }}><Plus size={14} />Start from scratch</button></div>}</footer>
      </>}
      <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
    </main>
  </div>
}
