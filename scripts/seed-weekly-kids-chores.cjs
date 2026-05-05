/**
 * Seed a household with a weekly kids chore routine and common rewards.
 *
 * Usage:
 *   npm run db:seed:kids-chores
 *
 * Optional env:
 *   SEED_HOUSEHOLD_ID=<uuid>       Target household. Defaults to newest household.
 *   SEED_CHILD_NAMES=Ava,Ben,Mia   Local child profiles to ensure. Defaults below.
 *   POSTGRES_URL=<connection>      Loaded from env or .env.local.
 */

const fs = require("fs")
const path = require("path")
const pg = require("pg")
const crypto = require("crypto")

const root = path.join(__dirname, "..")
const routineName = "Weekly Kids Chores"
const defaultChildNames = ["Ava", "Ben", "Mia"]
const tokenColors = ["sky", "emerald", "violet", "amber", "rose", "cyan"]

function loadEnvLocal() {
  const envPath = path.join(root, ".env.local")
  if (!fs.existsSync(envPath)) return
  const text = fs.readFileSync(envPath, "utf8")
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key]) continue
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "")
  }
}

function resolveConnectionString() {
  loadEnvLocal()
  const connectionString = process.env.POSTGRES_URL?.trim()
  if (!connectionString) {
    throw new Error("Missing POSTGRES_URL. Add it to .env.local or export it before running this seed.")
  }
  return connectionString
}

function sslOption(connectionString) {
  return /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false }
}

function recurrenceRules(today = new Date()) {
  const startDate = today.toISOString().slice(0, 10)
  return JSON.stringify([
    {
      id: "seed-weekly-kids-chores-monday",
      frequency: "weekly",
      interval: 1,
      weekday: "monday",
      time: "07:30",
      startDate,
    },
    {
      id: "seed-weekly-kids-chores-friday",
      frequency: "weekly",
      interval: 1,
      weekday: "friday",
      time: "16:00",
      startDate,
    },
    {
      id: "seed-weekly-kids-chores-saturday",
      frequency: "weekly",
      interval: 1,
      weekday: "saturday",
      time: "09:00",
      startDate,
    },
  ])
}

const choreTemplates = [
  {
    key: "ava-make-bed",
    title: "Make bed and open curtains",
    description: "Reset the bedroom for the day.",
    child: "Ava",
    x: 80,
    y: 80,
  },
  {
    key: "ben-hamper",
    title: "Put dirty clothes in hamper",
    description: "Check bedroom, bathroom, and common areas.",
    child: "Ben",
    x: 381,
    y: 96,
  },
  {
    key: "mia-dishes",
    title: "Clear dishes after meals",
    description: "Bring dishes to the kitchen and wipe your spot.",
    child: "Mia",
    x: 1008,
    y: 90,
  },
  {
    key: "ava-tidy-floor",
    title: "Tidy bedroom floor",
    description: "Toys, books, clothes, and school items back where they belong.",
    child: "Ava",
    x: 86,
    y: 262,
  },
  {
    key: "ben-school-bag",
    title: "Pack school bag and water bottle",
    description: "Check homework, lunchbox, hat, and drink bottle.",
    child: "Ben",
    x: 297,
    y: 353,
  },
  {
    key: "mia-bin",
    title: "Take out bedroom bin",
    description: "Empty the bedroom bin into the main rubbish.",
    child: "Mia",
    x: 767,
    y: 204,
  },
  {
    key: "ava-vacuum",
    title: "Vacuum or sweep one shared area",
    description: "Choose lounge, hallway, dining area, or entry.",
    child: "Ava",
    x: -4,
    y: 426,
  },
  {
    key: "ben-bathroom-sink",
    title: "Wipe bathroom sink",
    description: "Quick wipe of sink, bench, and mirror splashes.",
    child: "Ben",
    x: 313,
    y: 519,
  },
  {
    key: "mia-laundry",
    title: "Help with laundry fold-away",
    description: "Fold or put away your own clothes.",
    child: "Mia",
    x: 605,
    y: 345,
  },
]

const rewardTemplates = [
  {
    key: "ava-screen-time",
    title: "Reward: 30 minutes screen time",
    description: "Unlocked when the weekly chore list is done.",
    child: "Ava",
    x: 220,
    y: 650,
  },
  {
    key: "ben-family-choice",
    title: "Reward: choose family movie or game",
    description: "Pick one family movie, board game, or shared activity.",
    child: "Ben",
    x: 500,
    y: 650,
  },
  {
    key: "mia-pocket-money",
    title: "Reward: pocket money / treat token",
    description: "A small allowance, treat, or token agreed by the household.",
    child: "Mia",
    x: 780,
    y: 650,
  },
]

const dependencyPairs = [
  ["ava-make-bed", "ava-tidy-floor"],
  ["ava-tidy-floor", "ava-vacuum"],
  ["ava-vacuum", "ava-screen-time"],
  ["ben-school-bag", "ben-bathroom-sink"],
  ["ben-hamper", "ben-family-choice"],
  ["ben-bathroom-sink", "ben-family-choice"],
  ["mia-dishes", "mia-pocket-money"],
  ["mia-bin", "mia-pocket-money"],
  ["mia-laundry", "mia-pocket-money"],
]

async function resolveHousehold(client) {
  const requestedId = process.env.SEED_HOUSEHOLD_ID?.trim()
  if (requestedId) {
    const result = await client.query(
      `select id, name, leader_id from households where id = $1::uuid limit 1`,
      [requestedId],
    )
    if ((result.rowCount ?? 0) === 0) throw new Error(`Household not found: ${requestedId}`)
    return result.rows[0]
  }

  const result = await client.query(
    `select id, name, leader_id from households order by created_at desc limit 1`,
  )
  if ((result.rowCount ?? 0) === 0) {
    throw new Error("No household found. Create a household first or set SEED_HOUSEHOLD_ID.")
  }
  return result.rows[0]
}

async function ensureChildMembers(client, householdId) {
  const names = (process.env.SEED_CHILD_NAMES ?? defaultChildNames.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)

  const members = []
  for (const [index, name] of names.entries()) {
    const existing = await client.query(
      `select hm.user_id as id, u.full_name as name
       from household_members hm
       join users u on u.id = hm.user_id
       where hm.household_id = $1::uuid
         and lower(coalesce(u.full_name, '')) = lower($2)
       limit 1`,
      [householdId, name],
    )
    if ((existing.rowCount ?? 0) > 0) {
      members.push(existing.rows[0])
      continue
    }

    const memberUserId = `local_member_seed_${crypto.randomUUID()}`
    await client.query(
      `insert into users (id, full_name, email, avatar_url)
       values ($1, $2, null, null)`,
      [memberUserId, name],
    )
    await client.query(
      `insert into household_members (household_id, user_id, role, token_color)
       values ($1::uuid, $2, 'member'::app_role, $3)
       on conflict (household_id, user_id) do nothing`,
      [householdId, memberUserId, tokenColors[index % tokenColors.length]],
    )
    members.push({ id: memberUserId, name })
  }

  return members
}

async function seedRoutine(client, household) {
  const existingRoutine = await client.query(
    `select id from routines where household_id = $1::uuid and name = $2 limit 1`,
    [household.id, routineName],
  )
  if ((existingRoutine.rowCount ?? 0) > 0) {
    return { routineId: existingRoutine.rows[0].id, created: false }
  }

  const routine = await client.query(
    `insert into routines (
       household_id,
       name,
       type,
       recurrence_rule,
       complete_older_occurrences_on_new,
       created_by
     )
     values ($1::uuid, $2, 'recurring', $3, true, $4)
     returning id`,
    [household.id, routineName, recurrenceRules(), household.leader_id],
  )

  return { routineId: routine.rows[0].id, created: true }
}

async function seedTasks(client, household, routineId, members) {
  const existingTasks = await client.query(
    `select count(*)::int as count
     from tasks
     where household_id = $1::uuid
       and routine_id = $2::uuid
       and routine_occurrence_id is null`,
    [household.id, routineId],
  )
  if (existingTasks.rows[0]?.count > 0) {
    await ensureRewardAssignees(client, household.id, routineId, members)
    return { chores: [], rewards: [], skipped: true }
  }

  const chores = []
  const taskIdByKey = new Map()
  const memberByName = new Map(members.map((member) => [String(member.name).toLowerCase(), member]))
  for (const task of choreTemplates) {
    const assignee = memberByName.get(task.child.toLowerCase()) ?? null
    const inserted = await client.query(
      `insert into tasks (
         household_id,
         routine_id,
         title,
         description,
         is_reward,
         status,
         position_x,
         position_y,
         unlock_combiner,
         created_by
       )
       values ($1::uuid, $2::uuid, $3, $4, false, 'locked', $5, $6, 'and', $7)
       returning id`,
      [household.id, routineId, task.title, task.description, task.x, task.y, household.leader_id],
    )
    const taskId = inserted.rows[0].id
    chores.push(taskId)
    taskIdByKey.set(task.key, taskId)
    if (assignee?.id) {
      await client.query(
        `insert into task_assignees (task_id, user_id)
         values ($1::uuid, $2)
         on conflict (task_id, user_id) do nothing`,
        [taskId, assignee.id],
      )
    }
  }

  const rewards = []
  for (const reward of rewardTemplates) {
    const inserted = await client.query(
      `insert into tasks (
         household_id,
         routine_id,
         title,
         description,
         is_reward,
         status,
         position_x,
         position_y,
         unlock_combiner,
         created_by
       )
       values ($1::uuid, $2::uuid, $3, $4, true, 'locked', $5, $6, 'and', $7)
       returning id`,
      [household.id, routineId, reward.title, reward.description, reward.x, reward.y, household.leader_id],
    )
    const rewardId = inserted.rows[0].id
    rewards.push(rewardId)
    taskIdByKey.set(reward.key, rewardId)
    const assignee = memberByName.get(reward.child.toLowerCase()) ?? null
    if (assignee?.id) {
      await client.query(
        `insert into task_assignees (task_id, user_id)
         values ($1::uuid, $2)
         on conflict (task_id, user_id) do nothing`,
        [rewardId, assignee.id],
      )
    }
  }

  for (const [sourceKey, targetKey] of dependencyPairs) {
    const sourceId = taskIdByKey.get(sourceKey)
    const targetId = taskIdByKey.get(targetKey)
    if (!sourceId || !targetId) continue
    await client.query(
      `insert into task_dependencies (source_task_id, target_task_id)
       values ($1::uuid, $2::uuid)
       on conflict (source_task_id, target_task_id) do nothing`,
      [sourceId, targetId],
    )
  }

  return { chores, rewards, skipped: false }
}

async function seedInitialOccurrence(client, household, routineId) {
  const existing = await client.query(
    `select id
     from routine_occurrences
     where household_id = $1::uuid
       and routine_id = $2::uuid
       and status = 'active'
     order by created_at desc
     limit 1`,
    [household.id, routineId],
  )
  if ((existing.rowCount ?? 0) > 0) return { occurrenceId: existing.rows[0].id, created: false }

  const occurrence = await client.query(
    `insert into routine_occurrences (routine_id, household_id, kind, title, scheduled_for, status, created_by)
     values ($1::uuid, $2::uuid, 'routine', 'This week', now(), 'active', $3)
     returning id`,
    [routineId, household.id, household.leader_id],
  )
  const occurrenceId = occurrence.rows[0].id

  const templates = await client.query(
    `select id, household_id, routine_id, assignee_id, title, description, is_reward, position_x, position_y,
            scheduled_time, unlock_rule, unlock_at, unlock_combiner, expiry_rule, expires_at
     from tasks
     where household_id = $1::uuid
       and routine_id = $2::uuid
       and routine_occurrence_id is null
     order by created_at asc`,
    [household.id, routineId],
  )

  const idMap = new Map()
  for (const template of templates.rows) {
    const inserted = await client.query(
      `insert into tasks (
         household_id, routine_id, routine_occurrence_id, assignee_id, title, description, is_reward, status,
         position_x, position_y, scheduled_time, unlock_rule, unlock_at, unlock_combiner, expiry_rule, expires_at,
         created_by
       )
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'locked', $8, $9, $10, $11::jsonb,
               $12::timestamptz, $13, $14::jsonb, $15::timestamptz, $16)
       returning id`,
      [
        template.household_id,
        template.routine_id,
        occurrenceId,
        template.assignee_id,
        template.title,
        template.description,
        template.is_reward,
        template.position_x,
        template.position_y,
        template.scheduled_time,
        template.unlock_rule ? JSON.stringify(template.unlock_rule) : null,
        template.unlock_at,
        template.unlock_combiner ?? "and",
        template.expiry_rule ? JSON.stringify(template.expiry_rule) : null,
        template.expires_at,
        household.leader_id,
      ],
    )
    idMap.set(template.id, inserted.rows[0].id)
  }

  const templateIds = templates.rows.map((template) => template.id)
  const deps = templateIds.length
    ? await client.query(
        `select source_task_id, target_task_id
         from task_dependencies
         where source_task_id = any($1::uuid[])
           and target_task_id = any($1::uuid[])`,
        [templateIds],
      )
    : { rows: [] }
  for (const dep of deps.rows) {
    const sourceId = idMap.get(dep.source_task_id)
    const targetId = idMap.get(dep.target_task_id)
    if (!sourceId || !targetId) continue
    await client.query(
      `insert into task_dependencies (source_task_id, target_task_id)
       values ($1::uuid, $2::uuid)
       on conflict (source_task_id, target_task_id) do nothing`,
      [sourceId, targetId],
    )
  }

  const assignees = templateIds.length
    ? await client.query(
        `select task_id, user_id from task_assignees where task_id = any($1::uuid[])`,
        [templateIds],
      )
    : { rows: [] }
  for (const assignee of assignees.rows) {
    const newTaskId = idMap.get(assignee.task_id)
    if (!newTaskId) continue
    await client.query(
      `insert into task_assignees (task_id, user_id)
       values ($1::uuid, $2)
       on conflict (task_id, user_id) do nothing`,
      [newTaskId, assignee.user_id],
    )
  }

  await client.query(
    `insert into occurrence_tasks (occurrence_id, task_id, status)
     select $1::uuid,
            t.id,
            case
              when exists (select 1 from task_dependencies td where td.target_task_id = t.id)
                then 'locked'::task_status
              else 'unlocked'::task_status
            end
     from tasks t
     where t.routine_occurrence_id = $1::uuid
     on conflict (occurrence_id, task_id) do nothing`,
    [occurrenceId],
  )

  return { occurrenceId, created: true }
}

async function ensureRewardAssignees(client, householdId, routineId, members) {
  const rewards = await client.query(
    `select t.id
     from tasks t
     where t.household_id = $1::uuid
       and t.routine_id = $2::uuid
       and t.is_reward = true
       and (
         t.routine_occurrence_id is null
         or exists (
           select 1
           from routine_occurrences ro
           where ro.id = t.routine_occurrence_id
             and ro.routine_id = $2::uuid
             and ro.household_id = $1::uuid
         )
       )`,
    [householdId, routineId],
  )

  for (const [index, reward] of rewards.rows.entries()) {
    await client.query(`delete from task_assignees where task_id = $1::uuid`, [reward.id])
    const assignee = members[index % members.length]
    if (!assignee?.id) continue
    await client.query(
      `insert into task_assignees (task_id, user_id)
       values ($1::uuid, $2)
       on conflict (task_id, user_id) do nothing`,
      [reward.id, assignee.id],
    )
  }
}

async function main() {
  const connectionString = resolveConnectionString()
  const client = new pg.Client({
    connectionString,
    ssl: sslOption(connectionString),
  })

  await client.connect()
  try {
    await client.query("BEGIN")
    const household = await resolveHousehold(client)
    const members = await ensureChildMembers(client, household.id)
    const routine = await seedRoutine(client, household)
    const tasks = await seedTasks(client, household, routine.routineId, members)
    const occurrence = await seedInitialOccurrence(client, household, routine.routineId)
    await client.query("COMMIT")

    process.stdout.write(
      [
        `Seeded household: ${household.name} (${household.id})`,
        `Child profiles ensured: ${members.map((member) => member.name).join(", ")}`,
        `Routine: ${routineName} (${routine.created ? "created" : "already existed"})`,
        tasks.skipped
          ? "Tasks: skipped because the routine already has template tasks"
          : `Tasks: ${tasks.chores.length} chores + ${tasks.rewards.length} rewards`,
        `Occurrence: ${occurrence.occurrenceId} (${occurrence.created ? "created" : "already existed"})`,
      ].join("\n") + "\n",
    )
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exit(1)
})
