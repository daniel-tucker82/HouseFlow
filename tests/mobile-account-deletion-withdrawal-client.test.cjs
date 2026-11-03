/* eslint-disable @typescript-eslint/no-require-imports -- Withdrawal transport, scope binding and Clerk hint handling. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto')
const path=require('node:path'),Module=require('node:module'),{buildSync}=require('esbuild'),root=path.resolve(__dirname,'..'),loaded=new Module(__filename,module)
loaded._compile(buildSync({entryPoints:[path.join(root,'mobile/src/services/account-deletion-withdrawal.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,__filename)
const {AccountDeletionWithdrawalApi}=loaded.exports,origin='https://www.cyntch.test',endpoint=origin+'/api/mobile/account-deletion/withdraw'
const mobileClerkErrors=Module.createRequire(path.join(root,'mobile/package.json'))('@clerk/shared/authorization-errors')
function fixture(){
 const credentials={accountId:'user_parent',sessionId:'sess_verified',deviceId:randomUUID(),token:'synthetic-signed-token',installationSecret:randomBytes(32).toString('hex')}
 const recovery={origin,accountId:credentials.accountId,requestId:randomUUID(),secret:randomBytes(32).toString('hex')}
 const receipt={accountId:credentials.accountId,sessionId:credentials.sessionId,deviceId:credentials.deviceId,requestId:recovery.requestId,outcome:'withdrawn',withdrawnAt:'2026-11-04T02:00:00.000Z'}
 return {credentials,recovery,receipt}
}
const response=(data,status=200,extra={})=>({status,url:endpoint,redirected:false,headers:new Headers(),json:async()=>data,...extra})

test('withdrawal sends authenticated scope and recovery only to the fixed origin with no cookie or redirect forwarding',async()=>{
 const f=fixture(),calls=[],api=new AccountDeletionWithdrawalApi(origin,async(...args)=>{calls.push(args);return response({...f.receipt,secret:'must-strip',provider:'must-strip'})})
 assert.deepEqual(await api.withdraw(f.recovery,f.credentials),f.receipt)
 const [url,options]=calls[0];assert.equal(url,endpoint);assert.equal(options.method,'POST');assert.equal(options.body,undefined)
 assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store')
 assert.equal(options.headers.Authorization,'Bearer '+f.credentials.token)
 assert.equal(options.headers['X-Cyntch-Deletion-Key'],f.recovery.secret);assert.equal(options.headers['X-Cyntch-Installation'],f.credentials.installationSecret)
 for(const credentials of [{...f.credentials,accountId:'user_other'},{...f.credentials,token:''},{...f.credentials,sessionId:'invalid'},{...f.credentials,deviceId:'invalid'},{...f.credentials,installationSecret:'short'}])await assert.rejects(api.withdraw(f.recovery,credentials),{code:'authentication'})
 await assert.rejects(api.withdraw({...f.recovery,origin:'https://other.test'},f.credentials),{code:'authentication'});assert.equal(calls.length,1)
})

test('Clerk strict reverification remains a recognizable hint and can never be mistaken for withdrawal',async()=>{
 const f=fixture(),hint=require('@clerk/shared/authorization-errors').reverificationError('strict')
 const api=new AccountDeletionWithdrawalApi(origin,async()=>response({...hint,private:'discard'},403))
 const result=await api.withdraw(f.recovery,f.credentials)
 assert.deepEqual(result,hint);assert.equal(mobileClerkErrors.isReverificationHint(result),true)
 for(const changed of [{...hint,clerk_error:{...hint.clerk_error,reason:'different'}},{...hint,clerk_error:{...hint.clerk_error,metadata:{reverification:'lax'}}}]){
  await assert.rejects(new AccountDeletionWithdrawalApi(origin,async()=>response(changed,403)).withdraw(f.recovery,f.credentials),{code:'forbidden'})
 }
 const accepted={...f.receipt,outcome:'accepted',withdrawnAt:null}
 assert.deepEqual(await new AccountDeletionWithdrawalApi(origin,async()=>response(accepted)).withdraw(f.recovery,f.credentials),accepted)
})

test('wrong request, account, session, device, outcome or redirected withdrawal replies are rejected',async()=>{
 const f=fixture()
 for(const patch of [{accountId:'user_other'},{sessionId:'sess_other'},{deviceId:randomUUID()},{requestId:randomUUID()},{outcome:'pending'},{withdrawnAt:null},{withdrawnAt:'2026-02-30T01:00:00.000Z'}]){
  await assert.rejects(new AccountDeletionWithdrawalApi(origin,async()=>response({...f.receipt,...patch})).withdraw(f.recovery,f.credentials),{code:'retry'})
 }
 for(const extra of [{url:'https://other.test/withdraw'},{redirected:true}])await assert.rejects(new AccountDeletionWithdrawalApi(origin,async()=>response(f.receipt,200,extra)).withdraw(f.recovery,f.credentials),{code:'retry'})
})

test('withdrawal failures never surface credentials or imply cancellation',async()=>{
 const f=fixture()
 for(const [status,code]of[[401,'authentication'],[403,'forbidden'],[409,'conflict'],[423,'kiosk'],[429,'limited'],[503,'retry'],[404,'retry']]){
  const api=new AccountDeletionWithdrawalApi(origin,async()=>response({error:f.recovery.secret},status))
  await assert.rejects(api.withdraw(f.recovery,f.credentials),error=>error.code===code&&!error.message.includes(f.recovery.secret))
 }
 await assert.rejects(new AccountDeletionWithdrawalApi(origin,async()=>{throw new Error(f.credentials.token)}).withdraw(f.recovery,f.credentials),error=>error.code==='retry'&&!error.message.includes(f.credentials.token))
})

test('timeout or explicit cancellation aborts the withdrawal request without fabricating a receipt',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const f=fixture();let started;const entered=new Promise(resolve=>{started=resolve})
 const api=new AccountDeletionWithdrawalApi(origin,async(_,options)=>response(null,200,{json:()=>new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('Interrupted')),{once:true});started()})}))
 const timed=assert.rejects(api.withdraw(f.recovery,f.credentials),{code:'retry'});await entered;t.mock.timers.tick(25_000);await timed
 const controller=new AbortController();controller.abort()
 await assert.rejects(new AccountDeletionWithdrawalApi(origin,async()=>assert.fail('Already cancelled request was sent')).withdraw(f.recovery,f.credentials,controller.signal),{code:'cancelled'})
})
