/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness compiles TypeScript modules with isolated dependency mocks. */
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {randomUUID} = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const {buildSync} = require('esbuild')
const {Pool} = require('pg')

// Explicit isolated database only. Never fall back to application/production credentials.
const connectionString = process.env.CYNTCH_TEST_DATABASE_URL
function load(name) {
  const filename = path.resolve(__dirname, '../lib/' + name + '.ts')
  const compiled = buildSync({entryPoints:[filename],bundle:true,platform:'node',format:'cjs',write:false,
    external:['pg','@clerk/nextjs/server']})
  const loaded = new Module(filename,module)
  loaded.paths = module.paths
  const original = loaded.require.bind(loaded)
  loaded.require = id => id === '@clerk/nextjs/server' ? {
    clerkClient:async () => ({users:{getUser:async userId => ({
      emailAddresses:[{emailAddress:'daniel@nexusaspyre.com',verification:{status:userId === 'owner-verified' ? 'verified' : 'unverified'}}]
    })}})
  } : original(id)
  loaded._compile(compiled.outputFiles[0].text,filename)
  return loaded.exports
}

test('PostgreSQL migrations, quotas, identity, isolation and scheduler integration', {skip:!connectionString}, async t => {
  const url = new URL(connectionString)
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname), 'Tests require a local isolated database')
  assert.match(url.pathname,/^\/cyntch_billing_test_/)
  process.env.POSTGRES_URL = connectionString
  const pool = new Pool({connectionString})
  const migrationFiles = fs.readdirSync(path.resolve(__dirname,'../database')).filter(f => f.endsWith('.sql')).sort()
  for (const file of migrationFiles) await pool.query(fs.readFileSync(path.resolve(__dirname,'../database',file),'utf8'))
  await pool.query(fs.readFileSync(path.resolve(__dirname,'../database/0016_household_billing.sql'),'utf8'))
  const {withHouseholdWrite,getHouseholdEntitlement,ensurePermanentOwnerGrant} = load('entitlements')
  const {enforceFlowEntitlements} = load('flow-entitlements')
  const {automaticGenerationAllowance,TASK_AUTOMATION_ALLOWED_SQL} = load('automation-entitlements')
  const {enforceRequestLimit} = load('usage-controls')
  const hh = randomUUID(), other = randomUUID(), owner = randomUUID()
  await pool.query("insert into users(id,email) values ('free-manager','free@example.test'),('outsider','outsider@example.test'),('owner-verified','daniel@nexusaspyre.com'),('owner-unverified','daniel@nexusaspyre.com')")
  for (const [id,user] of [[hh,'free-manager'],[other,'outsider'],[owner,'owner-verified']]) {
    await pool.query("insert into households(id,name,leader_id) values ($1,'Test household',$2)",[id,user])
    await pool.query("insert into household_members(household_id,user_id,role) values ($1,$2,'manager')",[id,user])
  }
  let routine
  try {
    await t.test('billing request limits are shared and atomic across concurrent calls',async () => {
      const results = await Promise.allSettled(Array.from({length:10},()=>enforceRequestLimit('rate-'+hh,'billing')))
      assert.equal(results.filter(r=>r.status==='fulfilled').length,6)
      assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.status===429))
    })
    await t.test('concurrent template creation cannot exceed one',async () => {
      const create = () => withHouseholdWrite(hh,'free-manager',async client => {
        await enforceFlowEntitlements(client,hh,{action:'createRoutine'})
        const result = await client.query("insert into routines(household_id,name,type) values ($1,'Template','one_off') returning id",[hh])
        return result.rows[0].id
      })
      const results = await Promise.allSettled([create(),create(),create()])
      assert.equal(results.filter(r => r.status === 'fulfilled').length,1)
      routine = results.find(r => r.status === 'fulfilled').value
      assert.equal((await pool.query("select count(*)::int as n from routines where household_id=$1",[hh])).rows[0].n,1)
    })
    await t.test('combined task/reward cap is atomic at fifteen',async () => {
      for(let i=0;i<14;i++) await pool.query("insert into tasks(household_id,routine_id,title,is_reward) values ($1,$2,'Item',$3)",[hh,routine,i%2===0])
      const create = () => withHouseholdWrite(hh,'free-manager',async client => {
        await enforceFlowEntitlements(client,hh,{action:'createTask',routineId:routine})
        await client.query("insert into tasks(household_id,routine_id,title,is_reward) values ($1,$2,'Reward',true)",[hh,routine])
      })
      const results = await Promise.allSettled([create(),create()])
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
      assert.equal((await pool.query("select count(*)::int as n from tasks where routine_id=$1",[routine])).rows[0].n,15)
    })
    await t.test('free direct writes reject automation and standalone board bypass',async () => {
      const client = await pool.connect()
      try {
        for(const body of [
          {action:'createTaskBoard'},{action:'addRecurrenceRule'},{action:'updateRecurrenceRule'},
          {action:'createTask',routineId:routine,unlockRule:{kind:'fixed'}},
          {action:'updateTask',expiryRule:{kind:'after_unlock'}},
          {action:'updateTask',unlockAtOverride:new Date().toISOString()},
        ]) await assert.rejects(enforceFlowEntitlements(client,hh,body),e=>e.status===402)
        await assert.rejects(enforceFlowEntitlements(client,hh,{
          action:'createTask',routineId:routine,occurrenceId:randomUUID(),prerequisiteIds:[],
        }),e=>e.status===404)
        const endpoints = await client.query("select id from tasks where routine_id=$1 limit 2",[routine])
        await enforceFlowEntitlements(client,hh,{action:'createDependency',sourceTaskId:endpoints.rows[0].id,targetTaskId:endpoints.rows[1].id})
        await enforceFlowEntitlements(client,hh,{action:'createOccurrence',routineId:routine})
      } finally {client.release()}
    })
    await t.test('household isolation and assignee validation',async () => {
      await assert.rejects(withHouseholdWrite(hh,'outsider',async()=>{}),e=>e.status===403)
      const task = (await pool.query("select id from tasks where routine_id=$1 limit 1",[routine])).rows[0].id
      await assert.rejects(withHouseholdWrite(hh,'free-manager',client=>enforceFlowEntitlements(client,hh,{
        action:'updateTask',taskId:task,assigneeIds:['outsider'],
      })),e=>e.status===400)
    })
    await t.test('verified owner grant persists through billing holds and cancellation',async () => {
      const client = await pool.connect()
      try {
        assert.equal(await ensurePermanentOwnerGrant('owner-unverified',client),false)
        assert.equal((await getHouseholdEntitlement(client,owner)).tier,'owner')
        await client.query("insert into household_billing(household_id,subscription_status,billing_hold) values ($1,'canceled','dispute')",[owner])
        assert.equal((await getHouseholdEntitlement(client,owner)).tier,'owner')
        await client.query("update users set email='changed@example.test' where id='owner-verified'")
        assert.equal((await getHouseholdEntitlement(client,owner)).tier,'owner')
      } finally {client.release()}
    })
    await t.test('scheduler rejects free households and accepts paid then expires access',async () => {
      const client = await pool.connect()
      try {
        await client.query('begin')
        assert.equal(await automaticGenerationAllowance(client,hh),0)
        await client.query("insert into household_billing(household_id,subscription_status,paid_through) values ($1,'active',now()+interval '1 day')",[hh])
        assert.equal((await getHouseholdEntitlement(client,hh)).tier,'premium')
        assert.equal(await automaticGenerationAllowance(client,hh),10)
        assert.equal((await client.query(`select (${TASK_AUTOMATION_ALLOWED_SQL}) as allowed from tasks t where household_id=$1 limit 1`,[hh])).rows[0].allowed,true)
        await client.query("update household_billing set paid_through=now()-interval '1 second' where household_id=$1",[hh])
        assert.equal(await automaticGenerationAllowance(client,hh),0)
        assert.equal((await client.query(`select (${TASK_AUTOMATION_ALLOWED_SQL}) as allowed from tasks t where household_id=$1 limit 1`,[hh])).rows[0].allowed,false)
        await client.query('rollback')
      } finally {client.release()}
    })
  } finally {
    await pool.end()
    if(global.__houseflowPool) {await global.__houseflowPool.end(); global.__houseflowPool=undefined}
  }
})
