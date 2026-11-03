/* eslint-disable @typescript-eslint/no-require-imports -- Transport contract and real Clerk hint recognition. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto')
const path=require('node:path'),Module=require('node:module'),{buildSync}=require('esbuild'),root=path.resolve(__dirname,'..'),loaded=new Module(__filename,module)
loaded._compile(buildSync({entryPoints:[path.join(root,'mobile/src/services/account-deletion-submission.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,__filename)
const {AccountDeletionSubmissionApi}=loaded.exports,origin='https://www.cyntch.test',endpoint=origin+'/api/mobile/account-deletion'
const clerkErrors=Module.createRequire(path.join(root,'mobile/package.json'))('@clerk/shared/authorization-errors')
function fixture(){
 const scope={accountId:'user_parent',sessionId:'sess_verified',deviceId:randomUUID()},requestId=randomUUID()
 const credentials={...scope,token:'synthetic-token',installationSecret:randomBytes(32).toString('hex')}
 const saved={...scope,origin,intent:{operationId:requestId,revision:'a'.repeat(64),ownership:[],confirmAccountDeletion:true,acknowledgeSubscriptions:true},recovery:{requestId,secret:randomBytes(32).toString('hex')}}
 const receipt={...scope,status:{requestId,state:'pending',acceptedAt:'2026-11-04T02:00:00.000Z',completedAt:null,appleRevocationRequired:false,availableUntil:null}}
 return {credentials,saved,receipt}
}
const response=(data,status=202,extra={})=>({status,url:endpoint,redirected:false,headers:new Headers(),json:async()=>data,...extra})

test('submission sends immutable intent with current credentials only to its bound origin',async()=>{
 const f=fixture(),calls=[],api=new AccountDeletionSubmissionApi(origin,async(...args)=>{calls.push(args);return response({...f.receipt,secret:'strip',status:{...f.receipt.status,work:'strip'}})})
 assert.deepEqual(await api.submit({...f.saved,token:'not-for-body'},f.credentials),f.receipt)
 const [url,init]=calls[0];assert.equal(url,endpoint);assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(init.body),f.saved.intent)
 assert.equal(init.headers['X-Cyntch-Deletion-Key'],f.saved.recovery.secret);assert.equal(init.headers.Authorization,'Bearer '+f.credentials.token)
 assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(init.referrerPolicy,'no-referrer')
 for(const patch of [{accountId:'user_other'},{sessionId:'sess_new'},{deviceId:randomUUID()},{token:''},{installationSecret:'invalid'}])await assert.rejects(api.submit(f.saved,{...f.credentials,...patch}),{code:'authentication'})
 for(const patch of [{origin:'https://other.test'},{recovery:{...f.saved.recovery,requestId:randomUUID()}},{intent:{...f.saved.intent,confirmAccountDeletion:false}}])await assert.rejects(api.submit({...f.saved,...patch},f.credentials),{code:'authentication'})
 assert.equal(calls.length,1)
})

test('reverification hints preserve the original request and require an explicit retry with a fresh token',async()=>{
 const f=fixture(),hint=require('@clerk/shared/authorization-errors').reverificationError('strict'),calls=[]
 const api=new AccountDeletionSubmissionApi(origin,async(url,init)=>{calls.push([url,init]);return calls.length===1?response(hint,403):response(f.receipt)})
 const result=await api.submit(f.saved,f.credentials);assert.equal(clerkErrors.isReverificationHint(result),true);assert.equal(calls.length,1)
 assert.deepEqual(await api.submit(f.saved,{...f.credentials,token:'reverified-token'}),f.receipt)
 assert.equal(calls[0][1].body,calls[1][1].body);assert.equal(calls[1][1].headers.Authorization,'Bearer reverified-token')
})

test('only matching explicit acceptance can report success; unknown errors never expose provider messages',async()=>{
 const f=fixture()
 for(const [status,code,serverCode]of[[401,'authentication'],[403,'forbidden'],[409,'conflict'],[409,'changed','account_deletion_review_changed'],
  [409,'withdrawn','account_deletion_withdrawn'],[423,'kiosk'],[429,'limited'],[503,'unavailable','account_deletion_unavailable'],[503,'retry'],[404,'retry'],[400,'retry']]){
  await assert.rejects(new AccountDeletionSubmissionApi(origin,async()=>response({error:f.saved.recovery.secret,code:serverCode},status)).submit(f.saved,f.credentials),
   error=>error.code===code&&!error.message.includes(f.saved.recovery.secret))
 }
 for(const patch of [{accountId:'user_other'},{sessionId:'sess_other'},{deviceId:randomUUID()},{status:{...f.receipt.status,requestId:randomUUID()}},{status:{...f.receipt.status,acceptedAt:'2026-02-30T00:00:00.000Z'}}]){
  await assert.rejects(new AccountDeletionSubmissionApi(origin,async()=>response({...f.receipt,...patch})).submit(f.saved,f.credentials),{code:'retry'})
 }
 for(const extra of [{url:'https://other.test/delete'},{redirected:true}])await assert.rejects(new AccountDeletionSubmissionApi(origin,async()=>response(f.receipt,202,extra)).submit(f.saved,f.credentials),{code:'retry'})
 await assert.rejects(new AccountDeletionSubmissionApi(origin,async()=>response(f.receipt,200)).submit(f.saved,f.credentials),{code:'retry'})
 const complete={...f.receipt,status:{...f.receipt.status,state:'completed',completedAt:'2026-11-04T02:01:00.000Z',availableUntil:'2027-02-02T02:01:00.000Z'}}
 assert.deepEqual(await new AccountDeletionSubmissionApi(origin,async()=>response(complete,200)).submit(f.saved,f.credentials),complete)
})

test('abort, timeout and lost reply do not retry or fabricate acceptance',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const f=fixture();let notify,calls=0;const entered=new Promise(resolve=>{notify=resolve})
 const api=new AccountDeletionSubmissionApi(origin,async(_,init)=>{calls++;return response(null,202,{json:()=>new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(new Error(f.saved.recovery.secret)),{once:true});notify()})})})
 const pending=assert.rejects(api.submit(f.saved,f.credentials),{code:'retry'});await entered;t.mock.timers.tick(25_000);await pending;assert.equal(calls,1)
 const abort=new AbortController();abort.abort();await assert.rejects(api.submit(f.saved,f.credentials,abort.signal),{code:'cancelled'});assert.equal(calls,1)
 await assert.rejects(new AccountDeletionSubmissionApi(origin,async()=>{throw new Error(f.credentials.token)}).submit(f.saved,f.credentials),error=>error.code==='retry'&&!error.message.includes(f.credentials.token))
})
