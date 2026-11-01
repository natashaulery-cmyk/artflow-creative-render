import test from 'node:test';
import assert from 'node:assert/strict';
import { averageOrderCost as calculate } from '../src/lib/averageOrderCost.js';
const now = new Date(2026,10,1);
const row = (id,size,cost,extra={}) => ({id,size,total_cost:cost,sale_date:'2026-09-01',...extra});
test('size groups reconcile to the full-period total, with a weighted overall average',()=>{
  const result=calculate([row('a','5 x 7',9),row('b','5×7',3),row('c','8x10','18')],now);
  assert.equal(result.sizes.length,2);assert.equal(result.sizes[0].size,'5x7');
  assert.equal(result.sizes[0].average,6);assert.equal(result.sizes[1].average,18);
  assert.equal(result.total,30);assert.equal(result.average,10);assert.equal(result.monthly,10);
  assert.equal(result.sizes.reduce((s,r)=>s+r.total,0),result.total);
});
test('completed-month bounds exclude current, older, archived, and canceled sales',()=>{
  const result=calculate([row('a','5x7',3,{sale_date:'2026-08-01'}),row('b','8x10',6,{sale_date:'2026-10-31'}),row('c','5x7',100,{sale_date:'2026-11-01'}),row('d','5x7',100,{sale_date:'2026-07-31'}),row('e','5x7',100,{status:'canceled'}),row('f','5x7',100,{archived:true})],now);
  assert.equal(result.total,9);assert.equal(result.count,2);
});
test('bundles count once overall, duplicate record copies do not inflate costs',()=>{
  const a=row('a','5x7',6,{order_id:'bundle',platform:'Depop'});
  const result=calculate([a,{...a},row('b','8x10',9,{order_id:'bundle',platform:'Depop'})],now);
  assert.equal(result.total,15);assert.equal(result.count,1);assert.equal(result.average,15);
});
test('unknown sizes and missing costs remain visible without invented estimates',()=>{
 const result=calculate([row('a','',0),row('b',null,NaN)],now);
 assert.equal(result.missing,2);assert.equal(result.hasCosts,false);assert.equal(result.sizes[0].size,'Size not recorded');
 assert.equal(calculate([],new Date(2026,0,1)).count,0);
});
test('monthly selection isolates a month and does not divide its reserve by three',()=>{
 const orders=[row('a','5x7',6,{sale_date:'2026-09-30'}),row('b','8x10',12,{sale_date:'2026-10-01'}),row('c','8x10',18,{sale_date:'2026-10-31'}),row('d','5x7',100,{sale_date:'2026-11-01'})];
 const september=calculate(orders,now,'2026-09');
 const october=calculate(orders,now,'2026-10');
 assert.equal(september.total,6);assert.equal(october.total,30);assert.equal(october.monthly,30);
 assert.equal(october.average,15);assert.equal(october.sizes[0].monthly,30);assert.equal(october.period,'October 2026');
 assert.equal(calculate(orders,now,'2026-08').hasCosts,false);
});
test('monthly views cross year boundaries and reject invalid month input',()=>{
 const orders=[row('a','5x7',9,{sale_date:'2025-12-31'}),row('b','5x7',6,{sale_date:'2026-01-01'})];
 assert.equal(calculate(orders,new Date(2026,1,1),'2025-12').total,9);
 assert.equal(calculate(orders,new Date(2026,1,1),'2026-01').total,6);
 assert.equal(calculate(orders,new Date(2026,1,1),'2026-13').total,15);
});
