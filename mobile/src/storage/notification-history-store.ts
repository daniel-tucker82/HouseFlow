import type { HouseholdSummary } from "../../../shared/mobile/contracts"
import type { NotificationHistoryAction, NotificationHistoryPage, NotificationHistoryScope, NotificationHistorySource } from "../../../shared/mobile/notification-history"
import type { LocalDatabase, SqlConnection } from "./local-store"
import { requireKioskParentAccess } from "./kiosk-store"

export interface HistoryOperation { id: string; action: NotificationHistoryAction; attempts: number; nextAttemptMs: number }
export function applyHistoryAction(page: NotificationHistoryPage, action: NotificationHistoryAction): NotificationHistoryPage {
  if (page.householdId!==action.householdId || page.source!==action.source) return page
  const applies=(item: NotificationHistoryPage["items"][number]) => "notificationId" in action ? item.id===action.notificationId
    : item.createdAt<action.through.time || (item.createdAt===action.through.time && item.id<=action.through.id)
  return {...page,items:action.action==="dismiss" || action.action==="dismissAll" ? page.items.filter(item=>!applies(item))
    : page.items.map(item=>applies(item)?{...item,read:true}:item)}
}
export class NotificationHistoryStore {
  constructor(private readonly db: LocalDatabase) {}
  initialize(){return this.db.execAsync(`CREATE TABLE IF NOT EXISTS notification_history_cache (
    account_id TEXT NOT NULL,household_id TEXT NOT NULL,source TEXT NOT NULL,context_key TEXT NOT NULL,role TEXT NOT NULL,data TEXT NOT NULL,
    PRIMARY KEY(account_id,household_id,source));
    CREATE TABLE IF NOT EXISTS notification_history_actions (
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,household_id TEXT NOT NULL,data TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,
      sequence INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS history_actions_scope ON notification_history_actions(account_id,household_id,sequence);`)}
  private async guard(tx:SqlConnection,scope:NotificationHistoryScope){
    await requireKioskParentAccess(tx)
    if(!await tx.getFirstAsync("SELECT 1 FROM notification_sessions WHERE account_id=? AND session_id=? AND revoked=0",scope.accountId,scope.sessionId))throw new Error("Sign in again to open notifications.")
    if(await tx.getFirstAsync("SELECT 1 FROM revoked_households WHERE account_id=? AND household_id=?",scope.accountId,scope.householdId))throw new Error("Household access is no longer available.")
  }
  async read(scope:NotificationHistoryScope,source:NotificationHistorySource,context:string){
    await this.guard(this.db,scope)
    const row=await this.db.getFirstAsync<{data:string}>("SELECT data FROM notification_history_cache WHERE account_id=? AND household_id=? AND source=? AND context_key=?",scope.accountId,scope.householdId,source,context)
    return row?JSON.parse(row.data) as NotificationHistoryPage:null
  }
  async pending(accountId:string,householdId:string|null=null,tx:SqlConnection=this.db):Promise<HistoryOperation[]>{
    return (await tx.getAllAsync<{id:string;data:string;attempts:number;next_attempt_ms:number}>("SELECT id,data,attempts,next_attempt_ms FROM notification_history_actions WHERE account_id=? AND (? IS NULL OR household_id=?) ORDER BY sequence,id",accountId,householdId,householdId))
      .map(row=>({id:row.id,action:JSON.parse(row.data),attempts:row.attempts,nextAttemptMs:row.next_attempt_ms}))
  }
  async isPending(scope:NotificationHistoryScope,id:string){
    let pending=false
    await this.db.withExclusiveTransactionAsync(async tx=>{
      await this.guard(tx,scope)
      pending=Boolean(await tx.getFirstAsync("SELECT 1 FROM notification_history_actions WHERE id=? AND account_id=? AND household_id=?",id,scope.accountId,scope.householdId))
    })
    return pending
  }
  async cache(scope:NotificationHistoryScope,page:NotificationHistoryPage,context:string,append=false,current:()=>boolean=()=>true){
    await this.db.withExclusiveTransactionAsync(async tx=>{
      if(!current())return
      await this.guard(tx,scope)
      if(page.accountId!==scope.accountId||page.sessionId!==scope.sessionId||page.deviceId!==scope.deviceId||page.householdId!==scope.householdId||page.filterKey!==context)throw new Error("Notification choices changed. Wait for them to sync, then refresh history.")
      const board=await tx.getFirstAsync<{data:string}>("SELECT data FROM board_snapshots WHERE account_id=? AND household_id=?",scope.accountId,scope.householdId)
      const cachedBoard=board?JSON.parse(board.data):null
      if((cachedBoard?.server??cachedBoard)?.household?.role!==page.role)throw new Error("Household permissions changed. Refresh notifications.")
      const old=await tx.getFirstAsync<{data:string}>("SELECT data FROM notification_history_cache WHERE account_id=? AND household_id=? AND source=? AND context_key=?",scope.accountId,scope.householdId,page.source,context)
      if(append&&old){const previous=JSON.parse(old.data) as NotificationHistoryPage;const ids=new Set(previous.items.map(item=>item.id));page={...page,items:[...previous.items,...page.items.filter(item=>!ids.has(item.id))],through:previous.through}}
      for(const operation of await this.pending(scope.accountId,scope.householdId,tx))page=applyHistoryAction(page,operation.action)
      if(!current())return
      await tx.runAsync(`INSERT INTO notification_history_cache(account_id,household_id,source,context_key,role,data) VALUES(?,?,?,?,?,?)
        ON CONFLICT(account_id,household_id,source) DO UPDATE SET context_key=excluded.context_key,role=excluded.role,data=excluded.data`,scope.accountId,scope.householdId,page.source,context,page.role,JSON.stringify(page))
    })
  }
  async enqueue(scope:NotificationHistoryScope,id:string,action:NotificationHistoryAction,context:string,current:()=>boolean=()=>true){
    await this.db.withExclusiveTransactionAsync(async tx=>{
      await this.guard(tx,scope)
      if(!current()||action.householdId!==scope.householdId)throw new Error("The household changed. Try again.")
      const row=await tx.getFirstAsync<{data:string}>("SELECT data FROM notification_history_cache WHERE account_id=? AND household_id=? AND source=? AND context_key=?",scope.accountId,scope.householdId,action.source,context)
      if(!row)throw new Error("Load notification history before changing it.")
      const sequence=(await tx.getFirstAsync<{next:number}>("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM notification_history_actions"))!.next
      await tx.runAsync("INSERT INTO notification_history_actions(id,account_id,household_id,data,sequence) VALUES(?,?,?,?,?)",id,scope.accountId,scope.householdId,JSON.stringify(action),sequence)
      await tx.runAsync("UPDATE notification_history_cache SET data=? WHERE account_id=? AND household_id=? AND source=?",JSON.stringify(applyHistoryAction(JSON.parse(row.data),action)),scope.accountId,scope.householdId,action.source)
    })
  }
  acknowledge(accountId:string,id:string){return this.db.runAsync("DELETE FROM notification_history_actions WHERE account_id=? AND id=?",accountId,id)}
  forgetCache(accountId:string,householdId:string){return this.db.runAsync("DELETE FROM notification_history_cache WHERE account_id=? AND household_id=?",accountId,householdId)}
  forgetAccountCache(accountId:string){return this.db.runAsync("DELETE FROM notification_history_cache WHERE account_id=?",accountId)}
  fail(accountId:string,operation:HistoryOperation,now:number){return this.db.runAsync("UPDATE notification_history_actions SET attempts=attempts+1,next_attempt_ms=? WHERE account_id=? AND id=?",now+Math.min(60_000,2000*2**Math.min(operation.attempts,5)),accountId,operation.id)}
  async clear(accountId:string,householdId:string,tx?:SqlConnection):Promise<void>{
    if(!tx)return this.db.withExclusiveTransactionAsync(transaction=>this.clear(accountId,householdId,transaction))
    await tx.runAsync("DELETE FROM notification_history_cache WHERE account_id=? AND household_id=?",accountId,householdId)
    await tx.runAsync("DELETE FROM notification_history_actions WHERE account_id=? AND household_id=?",accountId,householdId)
  }
  async reconcile(accountId:string,households:HouseholdSummary[],tx:SqlConnection){
    const rows=await tx.getAllAsync<{household_id:string;role:string}>("SELECT DISTINCT household_id,role FROM notification_history_cache WHERE account_id=?",accountId)
    for(const row of rows)if(!households.some(h=>h.id===row.household_id&&h.role===row.role))await this.clear(accountId,row.household_id,tx)
    const queued=await tx.getAllAsync<{household_id:string}>("SELECT DISTINCT household_id FROM notification_history_actions WHERE account_id=?",accountId)
    for(const row of queued)if(!households.some(h=>h.id===row.household_id))await this.clear(accountId,row.household_id,tx)
  }
}
