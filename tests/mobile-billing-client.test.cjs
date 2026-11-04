/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite recovery and native SDK boundary tests with synthetic purchases. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite'), { buildSync } = require('esbuild'), Module = require('node:module')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '..')
function load(files, mocks = {}) {
  const loaded = new Module(__filename,module); loaded.require = name => mocks[name] ?? require(name)
  loaded._compile(buildSync({ stdin: { contents: files.map(file => `export * from ${JSON.stringify(path.join(root,file))}`).join(';'), resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, supported: { 'dynamic-import': false }, external: Object.keys(mocks) }).outputFiles[0].text,__filename)
  return loaded.exports
}
const { LocalStore, BillingController, BillingSdkQueue, TransportError } = load(['mobile/src/storage/local-store.ts','mobile/src/services/billing-controller.ts','mobile/src/services/billing-sdk.ts','mobile/src/storage/sync-engine.ts'])
class Database {
  constructor(file) { this.db = new DatabaseSync(file); this.tail = Promise.resolve(); this.fail = false }
  async execAsync(sql) { this.db.exec(sql) }
  async runAsync(sql,...args) { if (this.fail && sql.includes('native_billing_operations')) throw new Error('Disk unavailable'); return this.db.prepare(sql).run(...args) }
  async getFirstAsync(sql,...args) { return this.db.prepare(sql).get(...args) ?? null }
  async getAllAsync(sql,...args) { return this.db.prepare(sql).all(...args) }
  withExclusiveTransactionAsync(work) {
    const result = this.tail.then(async () => { this.db.exec('BEGIN IMMEDIATE'); try { await work(this); this.db.exec('COMMIT') } catch(error) { this.db.exec('ROLLBACK'); throw error } })
    this.tail = result.catch(() => undefined); return result
  }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'cyntch-billing-')), file = path.join(folder,'device.db')
  let db = new Database(file), local = new LocalStore(db); await local.initialize()
  const scope = { accountId: 'parent', sessionId: 'sess_parent', deviceId: randomUUID(), householdId: randomUUID() }
  const household = { id: scope.householdId, name: 'Family', role: 'manager', leaderId: 'parent', timezone: 'Australia/Sydney' }
  await local.notificationSessions.activate(scope)
  await local.reconcileHouseholds('parent',[household])
  const taskId=randomUUID(), occurrenceId=randomUUID()
  await local.cacheBoard('parent',{household,members:[{id:'parent',name:'Parent'}],fetchedAt:new Date().toISOString(),
    tasks:[{id:taskId,occurrence_id:occurrenceId,title:'Pack bag',status:'unlocked',status_version:'1',assignee_ids:['parent'],is_reward:false}]})
  const setup = { ...scope, billingCustomerId: randomUUID(), publicSdkKey: 'goog_fixture', store: 'play_store', environment: 'production',
    products: [{ interval: 'monthly', storeProductId: 'premium:month' },{ interval: 'yearly', storeProductId: 'premium:year' }] }
  const offers = setup.products.map((product,index) => ({ ...product, productId: product.storeProductId, price: index ? '$49.99' : '$5.99', amount: index ? 49.99 : 5.99, currency: 'AUD', reference: {} }))
  let status = { ...scope, tier: 'free', limits: { templates:1,items:15,activeExecutions:1,automation:false }, canManage:true,purchasesAvailable:true,
    sources:[],duplicateSubscriptions:false,verificationPending:false,purchase:null }, allowed = true, now = 1000
  const calls = [], queue = new BillingSdkQueue()
  const api = {
    billingStatus: async () => { calls.push('status'); return structuredClone(status) },
    prepareBilling: async () => { calls.push('setup'); return setup },
    billingPurchase: async action => { calls.push(structuredClone(action)); if (action.action === 'begin') status.purchase={id:action.operationId,thisSession:true,provider:action.store}; else status.purchase=null },
    verifyBilling: async () => { calls.push('verify'); status.verificationPending=true; return structuredClone(status) },
    webBillingCancellation: async () => ({...scope,provider:'stripe',url:'https://billing.stripe.com/p/session/test_fixture'}),
  }
  const session = { offers: async () => offers, purchase: async () => { calls.push('purchase'); return 'purchased' }, restore: async () => { calls.push('restore') } }
  const sdk = { store: 'play_store', run: (configuration,check,work) => queue.run(check,async () => { check(); return work(session) }),
    manage:async(provider,check)=>{check();calls.push(['manage',provider])},openWebCancellation:async(url,check)=>{check();calls.push(['open',url])} }
  const controllers = []
  const create = (identity = scope) => {
    const controller = new BillingController(local.billing,identity,api,sdk,() => allowed,randomUUID,() => now)
    controllers.push(controller); controller.selectHousehold(household); controller.setActive(true); controller.setConnectivity(true)
    return controller
  }
  t.after(async () => { controllers.forEach(controller => controller.stop()); await db.tail; db.db.close(); const resolved=path.resolve(folder); assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)); fs.rmSync(resolved,{recursive:true,force:true}) })
  const controller = create(); await controller.refresh()
  return { scope,household,setup,offers,api,sdk,session,calls,controller,create,taskId,occurrenceId,get local(){return local},get db(){return db},get status(){return status},
    setStatus: patch => { status={...status,...patch} }, setAllowed:value => { allowed=value }, advance:() => {now+=120000},
    operation:() => local.billing.read(scope.accountId,scope.householdId),
    reopen:async () => { controllers.forEach(controller => controller.stop()); await db.tail; db.db.close(); db=new Database(file); local=new LocalStore(db); await local.initialize(); return create() },
    draft:overrides => ({...scope,id:randomUUID(),kind:'purchase',store:'play_store',interval:'monthly',stage:'preflight',attempts:0,nextAttemptMs:0,...overrides}) }
}

test('purchase waits for durable local storage and never presents a sheet when disk saving fails',async t => {
  const f=await fixture(t); await f.controller.loadOffers(); await f.controller.refresh()
  f.db.fail=true
  await assert.rejects(f.controller.purchase('monthly'),/Disk unavailable/)
  assert.equal(f.calls.includes('purchase'),false); assert.equal(f.calls.some(call=>call.action==='begin'),false)
})
test('store success is recorded before verification and cannot grant local Premium',async t => {
  const f=await fixture(t); await f.controller.loadOffers(); await f.controller.refresh()
  f.session.purchase=async () => { assert.equal((await f.operation()).stage,'presenting'); f.calls.push('purchase'); return 'purchased' }
  await f.controller.purchase('monthly')
  assert.equal((await f.operation()).stage,'verify'); assert.equal(f.controller.getSnapshot().status.tier,'free')
  await f.controller.refresh(); assert.equal((await f.operation()).stage,'waiting')
  f.setStatus({tier:'premium',purchase:null,verificationPending:false}); f.advance(); await f.controller.refresh()
  assert.equal(await f.operation(),null); assert.equal(f.controller.getSnapshot().status.tier,'premium')
})
test('cancel acknowledgements can be lost and replayed after restart without opening another store sheet',async t => {
  const f=await fixture(t); await f.controller.loadOffers(); await f.controller.refresh()
  f.session.purchase=async () => 'cancelled'
  await f.controller.purchase('monthly'); const operation=await f.operation()
  const original=f.api.billingPurchase; let first=true
  f.api.billingPurchase=async action => { await original(action); if(action.action==='cancel'&&first){first=false;throw new TransportError('Acknowledgement lost',503)} }
  await f.controller.refresh(); assert.equal((await f.operation()).stage,'cancel')
  const restored=await f.reopen(); f.advance(); await restored.refresh()
  assert.equal(await f.operation(),null)
  assert.deepEqual(f.calls.filter(call=>call.action==='cancel').map(call=>call.operationId),[operation.id,operation.id])
  assert.equal(f.calls.includes('purchase'),false)
})
test('uncertain sheets and restores survive process death and resume verification without purchasing again',async t => {
  for(const kind of ['purchase','restore']) {
    const f=await fixture(t), operation=f.draft({kind,stage:'presenting'})
    await f.local.billing.begin(operation)
    const restarted=await f.reopen(); await restarted.refresh()
    assert.equal((await f.operation()).stage,'waiting'); assert.equal(f.calls.includes('verify'),true)
    assert.equal(f.calls.includes('purchase'),false); assert.equal(f.calls.includes('restore'),false)
  }
})
test('changing account or enabling kiosk during admission prevents the delayed purchase sheet and retains recovery',async t => {
  for(const reason of ['account','kiosk','household']) {
    const f=await fixture(t); await f.controller.loadOffers(); await f.controller.refresh()
    const gate=deferred(), reached=deferred(), original=f.api.billingPurchase
    f.api.billingPurchase=async action => { await original(action); if(action.action==='begin'){ reached.resolve(); await gate.promise } }
    const result=f.controller.purchase('monthly'); await reached.promise
    if(reason==='account') { f.setAllowed(false); await f.local.notificationSessions.close(f.scope) }
    if(reason==='kiosk') { f.setAllowed(false); await f.local.kiosk.begin({...f.scope,id:randomUUID(),visibleMemberIds:['parent'],editableMemberIds:['parent'],state:'locked'}) }
    if(reason==='household') f.controller.selectHousehold({...f.household,id:randomUUID(),name:'Different family'})
    gate.resolve(); await assert.rejects(result,/interrupted/)
    assert.equal(f.calls.includes('purchase'),false); assert.equal((await f.operation()).stage,'cancel')
  }
})
test('a second sign-in verifies the old session’s operation instead of cancelling it with new credentials',async t => {
  const f=await fixture(t); await f.local.billing.begin(f.draft({stage:'cancel'})); f.controller.stop()
  const identity={...f.scope,sessionId:'sess_new'}; await f.local.notificationSessions.activate(identity)
  const next=f.create(identity); await next.refresh()
  assert.equal(f.calls.includes('verify'),true); assert.equal(f.calls.some(call=>call.action==='cancel'),false)
  assert.equal((await f.operation()).sessionId,'sess_parent')
})
test('storage fences stale callbacks and kiosk/sign-out blocks new purchases but cannot lose an existing result',async t => {
  const f=await fixture(t), first=f.draft(); await f.local.billing.begin(first); await f.local.billing.clear(first)
  const second=f.draft(); await f.local.billing.begin(second)
  await f.local.billing.update(first,{stage:'verify'}); await f.local.billing.clear(first)
  assert.equal((await f.operation()).id,second.id)
  await f.local.notificationSessions.close(f.scope)
  await assert.rejects(f.local.billing.update(second,{stage:'presenting'}),/sign-in changed/)
  await f.local.billing.update(second,{stage:'verify'}); assert.equal((await f.operation()).stage,'verify')
  await f.local.billing.clear(second); await assert.rejects(f.local.billing.begin(f.draft()),/sign-in changed/)
})
test('changed prices require another deliberate purchase and slow store sheets do not hold SQLite writes',async t => {
  const f=await fixture(t); await f.controller.loadOffers(); await f.controller.refresh()
  f.session.offers=async () => f.offers.map(offer=>({...offer,amount:offer.amount+1,price:'changed'}))
  await assert.rejects(f.controller.purchase('monthly'),/price changed/); assert.equal(f.calls.includes('purchase'),false)
  f.session.offers=async () => f.offers; await f.controller.refresh(); await f.controller.loadOffers(); await f.controller.refresh()
  const gate=deferred(), reached=deferred()
  f.session.purchase=async () => { reached.resolve(); return gate.promise }
  const purchase=f.controller.purchase('monthly'); await reached.promise
  await f.local.enqueueCompletion({...f.scope,id:randomUUID(),taskId:f.taskId,occurrenceId:f.occurrenceId,memberId:'parent',completed:true,deviceTimeMs:1000})
  assert.equal((await f.local.getBoard('parent',f.household.id)).tasks[0].status,'completed')
  assert.equal((await f.local.pending('parent')).length,1)
  await assert.rejects(f.controller.purchase('yearly'),/current billing check/)
  gate.resolve('purchased'); await purchase
})
test('a failed restore retains verification and retry backoff; idle plans do not poll',async t => {
  const f=await fixture(t), initial=f.calls.length
  await new Promise(resolve=>setTimeout(resolve,25)); assert.ok(f.calls.length<=initial+1)
  f.session.restore=async () => { throw new Error('Store interrupted') }
  await assert.rejects(f.controller.restore(),/Store interrupted/)
  assert.equal((await f.operation()).stage,'verify')
  f.api.verifyBilling=async () => { throw new TransportError('Offline',503) }
  await f.controller.refresh(); const pending=await f.operation()
  assert.equal(pending.attempts,1); assert.ok(pending.nextAttemptMs>1000)
  f.controller.setConnectivity(false); assert.equal((await f.operation()).id,pending.id)
})

test('a remounted screen does not recover or discard a restore whose store sheet is still running',async t => {
  const f=await fixture(t), reached=deferred(), gate=deferred()
  t.after(()=>gate.resolve())
  f.session.restore=async()=>{reached.resolve();await gate.promise}
  const restoring=f.controller.restore();await reached.promise
  const operation=await f.operation();assert.equal(operation.stage,'presenting')
  f.controller.stop();const replacement=f.create()
  f.setStatus({verificationPending:false,purchase:null})
  const before=f.calls.filter(call=>call==='verify').length
  await replacement.refresh()
  assert.equal(f.calls.filter(call=>call==='verify').length,before)
  assert.equal((await f.operation()).stage,'presenting')
  gate.resolve();await restoring
  await replacement.refresh()
  assert.equal(f.calls.filter(call=>call==='verify').length,before+1)
  assert.equal((await f.operation()).stage,'waiting')
})

test('switching away and back while a purchase is open cannot start another action or recover the live operation',async t => {
  const f=await fixture(t), reached=deferred(), gate=deferred()
  t.after(()=>gate.resolve())
  await f.controller.loadOffers();await f.controller.refresh()
  f.session.purchase=async()=>{reached.resolve();await gate.promise;return 'purchased'}
  const purchasing=f.controller.purchase('monthly');await reached.promise
  f.controller.selectHousehold({...f.household,id:randomUUID(),name:'Another family'})
  f.controller.selectHousehold(f.household)
  await f.controller.refresh()
  await assert.rejects(f.controller.restore(),/current billing check/)
  assert.equal((await f.operation()).stage,'presenting')
  assert.equal(f.calls.includes('verify'),false)
  gate.resolve();await purchasing;await f.controller.refresh()
  assert.equal((await f.operation()).stage,'waiting')
})

test('household changes during recovery cannot display the earlier household operation',async t => {
  const f=await fixture(t), reached=deferred(), gate=deferred()
  await f.local.billing.begin(f.draft())
  const update=f.local.billing.update.bind(f.local.billing)
  f.local.billing.update=async(...args)=>{await update(...args);reached.resolve();await gate.promise}
  const seen=[], unsubscribe=f.controller.subscribe(()=>seen.push(f.controller.getSnapshot()))
  const recovery=f.controller.refresh();await reached.promise
  const other={...f.household,id:randomUUID(),name:'Other household'}
  f.controller.selectHousehold(other);gate.resolve();await recovery;unsubscribe()
  assert.equal(seen.some(state=>state.household?.id===other.id&&state.operation?.householdId===f.household.id),false)
})

function nativeSdk(platform,t) {
  let user, configurations=0,configuration
  const calls=[], offered=[],originals=new Map()
  const anonymous=()=>user?.startsWith('$RCAnonymousID:')===true
  const remember=()=>{if(!originals.has(user))originals.set(user,user)}
  const scope={accountId:'user_sdk',sessionId:'sess_sdk',deviceId:randomUUID(),householdId:randomUUID(),environment:'production'}
  let database,local
  const openLocalStore=async()=>{if(!local){database=new Database(':memory:');local=new LocalStore(database);await local.initialize();await local.notificationSessions.activate(scope)}return local}
  t.after(()=>database?.db.close())
  const purchases={ setLogLevel:async()=>{}, configure:value=>{
      calls.push(['configure',value]);if(configuration===JSON.stringify(value))return
      configuration=JSON.stringify(value);user=value.appUserID??user??'$RCAnonymousID:'+randomUUID();configurations++;remember()
    },
    isConfigured:async()=>configurations>0,isAnonymous:async()=>anonymous(),
    getAppUserID:async()=>user,logIn:async value=>{
      if(anonymous()&&!originals.has(value)){originals.set(value,originals.get(user));calls.push(['anonymous-alias',value])}
      user=value;remember();calls.push(['login',value])
    },logOut:async()=>{calls.push(['logout',user]);user='$RCAnonymousID:'+randomUUID();remember()},
    getCustomerInfo:async()=>({originalAppUserId:originals.get(user)}),
    getOfferings:async()=>({current:{availablePackages:offered}}),purchasePackage:async value=>{calls.push(['purchase',user,value])},
    purchaseSubscriptionOption:async value=>{calls.push(['option',user,value])},restorePurchases:async()=>{calls.push(['restore',user])},showManageSubscriptions:async()=>{} }
  const { nativeBillingSdk,eraseNativeBillingIdentity }=load(['mobile/src/services/billing-native.ts','mobile/src/services/native-billing-identity.ts'],{
    'react-native':{Platform:{OS:platform}},'expo-linking':{openURL:async url=>calls.push(['open',url])},
    '../storage/native-store':{openLocalStore},
    'react-native-purchases':{default:purchases,__esModule:true,LOG_LEVEL:{ERROR:'ERROR'},PURCHASES_ERROR_CODE:{PURCHASE_CANCELLED_ERROR:'1',PAYMENT_PENDING_ERROR:'20'},RECURRENCE_MODE:{INFINITE_RECURRING:1}} })
  return {sdk:nativeBillingSdk,purchases,calls,offered,scope,originals,openLocalStore,eraseNativeBillingIdentity,get user(){return user},get configurations(){return configurations}}
}
test('native SDK serializes household identity changes until the old purchase finishes and never creates anonymous identities',async t=>{
  const f=nativeSdk('ios',t), first={...f.scope,store:'app_store',publicSdkKey:'appl_fixture',billingCustomerId:randomUUID(),products:[]},second={...first,billingCustomerId:randomUUID()}
  const gate=deferred(),reached=deferred()
  const buying=f.sdk.run(first,()=>{},async()=>{reached.resolve();await gate.promise;assert.equal(f.user,first.billingCustomerId)})
  await reached.promise; const changing=f.sdk.run(second,()=>{},async session=>session.restore())
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(f.user,first.billingCustomerId)
  gate.resolve();await buying;await changing
  assert.equal(f.configurations,1);assert.equal(f.user,second.billingCustomerId)
  const configuration=f.calls.find(call=>call[0]==='configure')[1]
  assert.equal(configuration.shouldShowInAppMessagesAutomatically,false);assert.equal(configuration.automaticDeviceIdentifierCollectionEnabled,false)
})

test('after deletion a new household can purchase and restore without inheriting an anonymous original customer',async t=>{
 for(const platform of ['ios','android']){
  const f=nativeSdk(platform,t),first={...f.scope,store:platform==='ios'?'app_store':'play_store',publicSdkKey:platform==='ios'?'appl_fixture':'goog_fixture',billingCustomerId:randomUUID(),products:[{interval:'monthly',storeProductId:'monthly'}]}
  const second={...first,accountId:'user_next',sessionId:'sess_next',householdId:randomUUID(),billingCustomerId:randomUUID()}
  const local=await f.openLocalStore();await f.sdk.run(first,()=>{},async()=>{})
  const requestId=randomUUID()
  await local.deletedAccounts.eraseAccepted({format:1,origin:'https://www.cyntch.test',accountId:first.accountId,requestId,secret:'f'.repeat(64),submitted:true,intentHash:null,withdrawal:null,
   status:{requestId,state:'pending',acceptedAt:'2026-11-04T01:00:00.000Z',completedAt:null,availableUntil:null,appleRevocationRequired:false}})
  await f.eraseNativeBillingIdentity(first.accountId);assert.equal(await f.purchases.isAnonymous(),true)
  await local.notificationSessions.activate(second)
  const base={isBasePlan:true,storeProductId:'monthly',isPrepaid:false,installmentsInfo:null,freePhase:null,introPhase:null,pricingPhases:[{}],
   fullPricePhase:{billingPeriod:{iso8601:'P1M'},recurrenceMode:1,price:{amountMicros:5990000,formatted:'A$5.99',currencyCode:'AUD'}}}
  f.offered.push({product:{identifier:'monthly',subscriptionPeriod:'P1M',price:5.99,priceString:'A$5.99',currencyCode:'AUD',introPrice:null,installmentsInfo:null,subscriptionOptions:[base]}})
  await f.sdk.run(second,()=>{},async session=>{
   assert.equal(await session.purchase((await session.offers())[0]),'purchased');await session.restore()
  })
  assert.equal((await f.purchases.getCustomerInfo()).originalAppUserId,second.billingCustomerId)
  assert.equal(f.calls.some(call=>call[0]==='anonymous-alias'),false)
  assert.equal(f.calls.filter(call=>call[0]==='purchase'||call[0]==='option').length,1)
  assert.equal(f.calls.find(call=>call[0]==='restore')[1],second.billingCustomerId)
 }
})

test('an unrelated original customer still blocks every purchase and restore',async t=>{
 const f=nativeSdk('ios',t),setup={...f.scope,store:'app_store',publicSdkKey:'appl_fixture',billingCustomerId:randomUUID(),products:[]}
 await f.sdk.run(setup,()=>{},async()=>{});f.originals.set(setup.billingCustomerId,'$RCAnonymousID:unrelated')
 await assert.rejects(f.sdk.run(setup,()=>{},async()=>assert.fail('Unverified identity must not expose purchase methods')),/another household/)
 assert.equal(f.calls.some(call=>['purchase','option','restore'].includes(call[0])),false)
})

test('delayed native initialization cannot configure purchases after access is revoked',async t=>{
 const f=nativeSdk('ios',t),setup={...f.scope,store:'app_store',publicSdkKey:'appl_fixture',billingCustomerId:randomUUID(),products:[]}
 let allowed=true
 f.purchases.setLogLevel=async()=>{allowed=false}
 await assert.rejects(f.sdk.run(setup,()=>{if(!allowed)throw Error('Access revoked')},async()=>assert.fail()),/Store identity could not/)
 assert.equal(f.configurations,0);assert.equal(f.user,undefined)
 assert.equal((await (await f.openLocalStore()).billingIdentity.read()).pending.accountId,setup.accountId)
})
test('native Google prices and purchases use the approved auto-renewing base plan, not a free-trial offer',async t=>{
  const f=nativeSdk('android',t), productId='premium:month'
  const base={isBasePlan:true,storeProductId:productId,isPrepaid:false,installmentsInfo:null,freePhase:null,introPhase:null,pricingPhases:[{}],
    fullPricePhase:{billingPeriod:{iso8601:'P1M'},recurrenceMode:1,price:{amountMicros:5990000,formatted:'A$5.99',currencyCode:'AUD'}}}
  f.offered.push({product:{identifier:productId,price:0,priceString:'Free',currencyCode:'AUD',subscriptionOptions:[{isBasePlan:false},base]}})
  const setup={...f.scope,store:'play_store',publicSdkKey:'goog_fixture',billingCustomerId:randomUUID(),products:[{interval:'monthly',storeProductId:productId}]}
  await f.sdk.run(setup,()=>{},async session=>{const [offer]=await session.offers();assert.equal(offer.price,'A$5.99');assert.equal(offer.amount,5.99);assert.equal(await session.purchase(offer),'purchased')})
  assert.equal(f.calls.find(call=>call[0]==='option')[2],base)
  base.isPrepaid=true;await assert.rejects(f.sdk.run(setup,()=>{},session=>session.offers()),/terms need updating/)
})
test('SDK errors distinguish cancellation and pending payment; stale access checks prevent a queued household login',async t=>{
  const f=nativeSdk('ios',t), setup={...f.scope,store:'app_store',publicSdkKey:'appl_fixture',billingCustomerId:randomUUID(),products:[{interval:'monthly',storeProductId:'monthly'}]}
  f.offered.push({product:{identifier:'monthly',subscriptionPeriod:'P1M',price:5.99,priceString:'$5.99',currencyCode:'AUD',introPrice:null,installmentsInfo:null}})
  for(const [code,expected] of [['1','cancelled'],['20','pending']]) {
    f.purchases.purchasePackage=async()=>{throw{code}}
    assert.equal(await f.sdk.run(setup,()=>{},async session=>session.purchase((await session.offers())[0])),expected)
  }
  f.purchases.purchasePackage=async()=>{throw{code:'2',message:'private provider payload'}}
  await assert.rejects(f.sdk.run(setup,()=>{},async session=>session.purchase((await session.offers())[0])),error=>!error.message.includes('private'))
  const gate=deferred(), reached=deferred(); let allowed=true
  const running=f.sdk.run(setup,()=>{},async()=>{reached.resolve();await gate.promise});await reached.promise
  const queued=f.sdk.run({...setup,billingCustomerId:randomUUID()},()=>{if(!allowed)throw new Error('Kiosk locked')},async()=>assert.fail())
  allowed=false;gate.resolve();await running;await assert.rejects(queued,/Kiosk locked/)
  assert.equal(f.user,setup.billingCustomerId)
})

test('store management does not need purchase setup or SDK identity; delayed cancellation links are fenced',async t=>{
  const f=await fixture(t)
  f.setStatus({purchasesAvailable:false,sources:[{provider:'play_store',status:'active',givesAccess:true}]})
  f.api.prepareBilling=async()=>assert.fail('Management must not need purchase configuration')
  await f.controller.manage();assert.deepEqual(f.calls.find(call=>Array.isArray(call)&&call[0]==='manage'),['manage','play_store'])
  await f.controller.refresh()
  const gate=deferred(), reached=deferred()
  f.api.webBillingCancellation=async()=>{reached.resolve();await gate.promise;return{...f.scope,provider:'stripe',url:'https://billing.stripe.com/p/session/test_fixture'}}
  const opening=f.controller.cancelWebRenewal();await reached.promise;f.setAllowed(false);gate.resolve()
  await assert.rejects(opening,/interrupted/);assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='open'),false)
})

test('native management links use only approved destinations without configuring RevenueCat',async t=>{
  for(const [platform,provider,url] of [
    ['ios','app_store','https://apps.apple.com/account/subscriptions'],
    ['ios','play_store','https://play.google.com/store/account/subscriptions'],
    ['android','app_store','https://account.apple.com/account/manage/section/subscriptions'],
    ['android','play_store','https://play.google.com/store/account/subscriptions']]){
    const f=nativeSdk(platform,t);await f.sdk.manage(provider,()=>{})
    assert.deepEqual(f.calls,[['open',url]]);assert.equal(f.configurations,0)
    await assert.rejects(f.sdk.manage(provider,()=>{throw new Error('Locked')}),/Locked/)
    await assert.rejects(f.sdk.manage('https://evil.test',()=>{}),/Choose the store/)
    await assert.rejects(f.sdk.openWebCancellation('https://evil.test',()=>{}),/not valid/)
    await f.sdk.openWebCancellation('https://billing.stripe.com/p/session/test_fixture',()=>{})
    assert.equal(f.calls.length,2)
  }
})

test('management follows the recorded billing provider across platforms and rechecks ownership',async t=>{
  const f=await fixture(t)
  f.setStatus({purchasesAvailable:false,sources:[{provider:'app_store',status:'active',givesAccess:true}]})
  f.api.prepareBilling=async()=>assert.fail('Cross-platform management must not configure purchasing')
  await f.controller.manage('app_store')
  assert.deepEqual(f.calls.filter(call=>Array.isArray(call)&&call[0]==='manage'),[['manage','app_store']])
  await assert.rejects(f.controller.manage('play_store'),/no subscription you can manage/)
  f.setStatus({canManage:false})
  await assert.rejects(f.controller.manage('app_store'),/no subscription you can manage/)
  assert.equal(f.calls.filter(call=>Array.isArray(call)&&call[0]==='manage').length,1)
  assert.equal(await f.operation(),null,'Opening management must not create a purchase or grant access')
})

test('a delayed provider management request cannot open after switching households',async t=>{
  const f=await fixture(t), gate=deferred(), reached=deferred()
  const response={...f.status,sources:[{provider:'app_store',status:'active',givesAccess:true}]}
  f.api.billingStatus=async()=>{reached.resolve();await gate.promise;return response}
  const opening=f.controller.manage('app_store');await reached.promise
  f.controller.selectHousehold(null);gate.resolve()
  await assert.rejects(opening,/interrupted/)
  assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='manage'),false)
  assert.equal(f.controller.getSnapshot().status,null)
})
