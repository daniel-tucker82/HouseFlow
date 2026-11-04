/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the SDK storage boundary with persistent interrupted keychain operations. */
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module'),{buildSync}=require('esbuild'),{DatabaseSync}=require('node:sqlite'),{randomUUID}=require('node:crypto')
const root=path.resolve(__dirname,'..')
function load(files,mocks={}){const loaded=new Module(__filename,module);loaded.require=name=>mocks[name]??require(name);loaded._compile(buildSync({stdin:{contents:files.map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:Object.keys(mocks)}).outputFiles[0].text,__filename);return loaded.exports}
const {ClerkOfflineCache,SecureResourceStore,filterClerkOfflineResource,waitForClerkOfflineCleanup,LocalStore}=load(['mobile/src/storage/clerk-offline-cache.ts','mobile/src/storage/secure-resource-store.ts','mobile/src/storage/local-store.ts'])
const pk='pk_test_Zml4dHVyZS5jbGVyay5hY2NvdW50cy5kZXYk',key=kind=>`__clerk_cache_${kind}_${pk}`
const token=user=>'header.'+Buffer.from(JSON.stringify({sub:user,sid:'sess_'+user,exp:1793800000})).toString('base64url')+'.signature'
const session=user=>({object:'session',id:'sess_'+user,status:'active',user:{id:user,first_name:'SECRET_'+user,email_addresses:[{email_address:user+'@fixture.test'}]},last_active_token:{jwt:token(user)}})
const client=(users=['user_a','user_b'],active='user_b')=>JSON.stringify({object:'client',id:'client_fixture',sessions:users.map(session),last_active_session_id:'sess_'+active,
 sign_in:{identifier:'SECRET_user_a',user_data:{first_name:'SECRET_user_a'}},sign_up:{email_address:'SECRET_user_a'}})
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
function fixture(){
 const values=new Map(),deleted=new Set(),calls=[],fault={after:Infinity,count:0,fail:false}
 const storage={
  async get(key){calls.push(['get',key]);if(fault.fail)throw Error('private keychain error');return values.get(key)??null},
  async set(key,value){calls.push(['set',key]);assert.ok(Buffer.byteLength(value,'utf8')<=2048);values.set(key,value);if(++fault.count===fault.after)throw Error('Interrupted keychain write')},
  async remove(key){calls.push(['remove',key]);values.delete(key);if(++fault.count===fault.after)throw Error('Interrupted keychain remove')},
 }
 let cache=new ClerkOfflineCache(new SecureResourceStore(storage),pk,async()=>[...deleted])
 return {values,deleted,calls,fault,storage,get cache(){return cache},restart(){cache=new ClerkOfflineCache(new SecureResourceStore(storage),pk,async()=>[...deleted])}}
}
function seedLegacy(f,kind,value,slot='A'){
 const name=key(kind),chunks=Array.from(value.matchAll(/[\s\S]{1,400}/g),match=>match[0])
 f.values.set(`${name}-latest`,slot);f.values.set(`${name}-${slot}-metadata`,JSON.stringify({totalChunks:chunks.length}));f.values.set(`${name}-${slot}-complete`,'true')
 chunks.forEach((chunk,index)=>f.values.set(`${name}-${slot}-chunk-${index}`,chunk))
}
function storedValue(f,kind){
 const prefix=key(kind)+'.cyntch-v1',state=JSON.parse(f.values.get(prefix+'.manifest'))
 if(!state.active)return null
 return Array.from({length:state[state.active]},(_,i)=>f.values.get(`${prefix}.${state.active}.${i}`)).join('')
}

test('offline resource cache migrates both legacy slots and preserves the active signed-in account',async()=>{
 const f=fixture();seedLegacy(f,'client',client());seedLegacy(f,'client',client(['user_a'],'user_a'),'B')
 f.values.set(key('client')+'-latest','A')
 assert.equal(await f.cache.get(key('client')),client());assert.equal(storedValue(f,'client'),client())
 assert.equal([...f.values.keys()].some(name=>name.startsWith(key('client')+'-')),false)
 f.restart();assert.equal(await f.cache.get(key('client')),client())
})

test('deletion removes profile and JWT snapshots while preserving a newer account and its original token',async()=>{
 const f=fixture();await f.cache.set(key('client'),client());await f.cache.set(key('session_jwt'),JSON.stringify(token('user_b')));await f.cache.set(key('environment'),'public-settings')
 f.deleted.add('user_a');await f.cache.eraseDeletedAccount('user_a')
 const saved=JSON.parse(await f.cache.get(key('client')))
 assert.deepEqual(saved.sessions,[session('user_b')]);assert.equal(saved.last_active_session_id,'sess_user_b');assert.equal(saved.sign_in,null);assert.equal(saved.sign_up,null)
 assert.equal(await f.cache.get(key('session_jwt')),JSON.stringify(token('user_b')));assert.equal(await f.cache.get(key('environment')),'public-settings')
 assert.equal([...f.values.values()].join('').includes('SECRET_user_a'),false)
 f.deleted.add('user_b');await f.cache.eraseDeletedAccount('user_b')
 assert.equal(await f.cache.get(key('session_jwt')),null);assert.equal(JSON.parse(await f.cache.get(key('client'))).last_active_session_id,null)
})

test('late SDK writes and cold-start legacy reads cannot restore a deleted profile or session token',async()=>{
 const f=fixture();f.deleted.add('user_a');seedLegacy(f,'client',client());seedLegacy(f,'session_jwt',JSON.stringify(token('user_a')))
 assert.equal(JSON.parse(await f.cache.get(key('client'))).sessions.length,1);assert.equal(await f.cache.get(key('session_jwt')),null)
 await f.cache.set(key('client'),client());await f.cache.set(key('session_jwt'),JSON.stringify(token('user_a')));f.restart()
 assert.equal(JSON.parse(await f.cache.get(key('client'))).sessions[0].user.id,'user_b');assert.equal(await f.cache.get(key('session_jwt')),null)
 assert.equal([...f.values.values()].join('').includes('SECRET_user_a'),false)
})

test('an unaccepted deletion and another Clerk project cannot remove cached account data',async()=>{
 const f=fixture();await f.cache.set(key('client'),client());const before=[...f.values]
 await assert.rejects(f.cache.eraseDeletedAccount('user_a'),/Confirm account deletion/)
 await assert.rejects(f.cache.set(key('client')+'other',client()),/needs another attempt/)
 assert.deepEqual([...f.values],before)
})

test('unknown session owners, token mismatches and malformed tokens are discarded without inventing a session',()=>{
 const deleted=new Set(['user_a']),data=JSON.parse(client())
 data.sessions.push({...session('user_c'),last_active_token:{jwt:token('user_a')}})
 data.sessions.push({...session('user_d'),user:null,public_user_data:{first_name:'Unknown'}})
 data.sessions.push({...session('user_e'),actor:{sub:'user_a'}})
 const saved=JSON.parse(filterClerkOfflineResource('client',JSON.stringify(data),deleted));assert.deepEqual(saved.sessions,[session('user_b')])
 for(const value of ['broken','{}','"not.a.jwt"','null'])assert.equal(filterClerkOfflineResource('session_jwt',value,deleted),null)
 assert.equal(filterClerkOfflineResource('client','{"sessions":[]}',deleted),null)
})

test('a deletion committed during a cache read is checked again before returning a profile',async()=>{
 const f=fixture();await f.cache.set(key('client'),client());const original=f.storage.get
 f.storage.get=async name=>{const result=await original(name);if(name.endsWith('.a.0'))f.deleted.add('user_a');return result}
 assert.deepEqual(JSON.parse(await f.cache.get(key('client'))).sessions,[session('user_b')])
 await f.cache.eraseDeletedAccount('user_a');assert.equal([...f.values.values()].join('').includes('SECRET_user_a'),false)
})

test('cleanup queues behind a pending write and cannot discard another cache key',async()=>{
 const f=fixture(),entered=deferred(),release=deferred(),set=f.storage.set;let paused=false
 f.storage.set=async(name,value)=>{if(name.endsWith('.a.0')&&!paused){paused=true;entered.resolve();await release.promise}return set(name,value)}
 const writing=f.cache.set(key('client'),client());await entered.promise
 f.deleted.add('user_a');let cleaned=false;const cleanup=f.cache.eraseDeletedAccount('user_a').then(()=>{cleaned=true})
 await assert.rejects(waitForClerkOfflineCleanup(cleanup,10),/needs another attempt/)
 const newer=f.cache.set(key('session_jwt'),JSON.stringify(token('user_b')))
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cleaned,false)
 release.resolve();await Promise.all([writing,cleanup,newer]);assert.equal(await f.cache.get(key('session_jwt')),JSON.stringify(token('user_b')))
 assert.equal([...f.values.values()].join('').includes('SECRET_user_a'),false)
})

test('every interrupted migration write or removal resumes without reviving the deleted legacy account',async()=>{
 const reference=fixture();seedLegacy(reference,'client',client());reference.deleted.add('user_a');await reference.cache.eraseDeletedAccount('user_a')
 for(let stop=1;stop<=reference.fault.count;stop++){
  const f=fixture();seedLegacy(f,'client',client());f.deleted.add('user_a');f.fault.after=stop
  await assert.rejects(f.cache.eraseDeletedAccount('user_a'),/Interrupted/)
  f.fault.after=Infinity;f.restart();await f.cache.eraseDeletedAccount('user_a')
  assert.deepEqual(JSON.parse(await f.cache.get(key('client'))).sessions,[session('user_b')])
  assert.equal([...f.values.values()].join('').includes('SECRET_user_a'),false,`Interruption ${stop}`)
 }
})

test('every interrupted replacement preserves either the previous or the new complete cache and cleans allocated chunks',async()=>{
 const reference=fixture();await reference.cache.set(key('environment'),'old');reference.fault.count=0
 const next='📚'.repeat(1400);await reference.cache.set(key('environment'),next)
 for(let stop=1;stop<=reference.fault.count;stop++){
  const f=fixture();await f.cache.set(key('environment'),'old');f.fault.count=0;f.fault.after=stop
  await assert.rejects(f.cache.set(key('environment'),next),/Interrupted/);f.fault.after=Infinity;f.restart()
  assert.ok(['old',next].includes(await f.cache.get(key('environment'))))
  const state=JSON.parse(f.values.get(key('environment')+'.cyntch-v1.manifest'))
  assert.equal(state[state.active==='a'?'b':'a'],0)
  await f.cache.set(key('environment'),'');assert.equal(await f.cache.get(key('environment')),null)
  assert.equal([...f.values.keys()].filter(name=>name.startsWith(key('environment')+'.cyntch-v1.')).length,1)
 }
})

test('missing committed chunks cannot fall back to an older account and corrupt allocation metadata fails safely',async()=>{
 const f=fixture();await f.cache.set(key('client'),client());await f.cache.set(key('client'),client(['user_b']))
 const prefix=key('client')+'.cyntch-v1',state=JSON.parse(f.values.get(prefix+'.manifest'))
 f.values.delete(`${prefix}.${state.active}.0`);seedLegacy(f,'client',client(['user_a'],'user_a'))
 assert.equal(await f.cache.get(key('client')),null)
 assert.equal([...f.values.keys()].filter(name=>name.startsWith(prefix+'.')).length,1,'Unreachable fragments must also be removed')
 f.values.set(prefix+'.manifest',JSON.stringify({version:1,active:'a',a:1e20,b:0,legacy:false}))
 await assert.rejects(f.cache.get(key('client')),/needs another attempt/)
})

test('native adapter uses real SQLite deletion fences, encrypted storage and sanitized errors',async t=>{
 const f=fixture(),raw=new DatabaseSync(':memory:')
 const db={execAsync:async sql=>raw.exec(sql),runAsync:async(sql,...args)=>raw.prepare(sql).run(...args),getFirstAsync:async(sql,...args)=>raw.prepare(sql).get(...args)??null,
  getAllAsync:async(sql,...args)=>raw.prepare(sql).all(...args),withExclusiveTransactionAsync:async work=>{raw.exec('BEGIN');try{await work(db);raw.exec('COMMIT')}catch(error){raw.exec('ROLLBACK');throw error}}}
 const local=new LocalStore(db);await local.initialize();const prior=process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk
 t.after(()=>{raw.close();if(prior===undefined)delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;else process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=prior})
 const options=[]
 const native=load(['mobile/src/services/native-clerk-offline-cache.ts'],{
  '../storage/native-store':{openLocalStore:async()=>local},
  'expo-secure-store':{AFTER_FIRST_UNLOCK:2,getItemAsync:async(name,option)=>{options.push(option);return f.storage.get(name)},setItemAsync:async(name,value,option)=>{options.push(option);return f.storage.set(name,value)},deleteItemAsync:async(name,option)=>{options.push(option);return f.storage.remove(name)}},
 })
 const cache=native.nativeClerkResourceCache();await cache.set(key('client'),client());await cache.set(key('session_jwt'),JSON.stringify(token('user_a')))
 const requestId=randomUUID();await local.deletedAccounts.eraseAccepted({format:1,origin:'https://www.cyntch.test',accountId:'user_a',requestId,secret:'f'.repeat(64),submitted:true,intentHash:null,withdrawal:null,
  status:{requestId,state:'pending',acceptedAt:'2026-11-04T01:00:00.000Z',completedAt:null,availableUntil:null,appleRevocationRequired:false}})
 await native.eraseNativeClerkOfflineCache('user_a');assert.deepEqual(JSON.parse(await cache.get(key('client'))).sessions,[session('user_b')]);assert.equal(await cache.get(key('session_jwt')),null)
 assert.ok(options.length>0);assert.ok(options.every(option=>option.keychainAccessible===2))
 f.fault.fail=true;await assert.rejects(cache.get(key('client')),error=>error.message.includes('could not be updated')&&!error.message.includes('private'))
})
