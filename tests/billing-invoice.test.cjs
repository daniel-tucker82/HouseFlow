/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness compiles TypeScript modules with isolated dependency mocks. */
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {buildSync} = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const filename = path.join(__dirname,'../lib/billing-invoice.ts')
const compiled = buildSync({entryPoints:[filename],bundle:true,platform:'node',format:'cjs',write:false})
const loaded = new Module(filename,module)
loaded._compile(compiled.outputFiles[0].text,filename)
const {paidInvoicePeriodEnd} = loaded.exports
const prices = new Set(['price_month','price_year'])
const line = (end,subscription='sub_one',price='price_month',amount=599) => ({
  parent:{subscription_item_details:{subscription}},pricing:{price_details:{price}},amount,period:{start:100,end}
})
test('access uses the paid service period, including invoices settled with credits',()=>{
  assert.equal(paidInvoicePeriodEnd({status:'paid',amount_remaining:0,amount_paid:0,lines:{data:[line(200)]}},'sub_one',prices).getTime(),200000)
})
test('open and unpaid invoices never extend access',()=>{
  for (const status of ['open','draft','void','uncollectible'])
    assert.equal(paidInvoicePeriodEnd({status,amount_remaining:599,lines:{data:[line(900)]}},'sub_one',prices),null)
})
test('unrelated prices, subscriptions and credit lines cannot extend access',()=>{
  const invoice={status:'paid',amount_remaining:0,lines:{data:[line(200),line(900,'sub_other'),line(1000,'sub_one','price_other'),line(1200,'sub_one','price_month',-599)]}}
  assert.equal(paidInvoicePeriodEnd(invoice,'sub_one',prices).getTime(),200000)
})
