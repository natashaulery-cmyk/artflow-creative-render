import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetSummary, localMonthKey, shiftMonth } from '../src/lib/budgetMath.js';

test('budget categories combine approved ArtFlow expenses and extra manual spending', () => {
  const rows = [
    { category:'Frames & Display',planned:50,manual_spent:5 },
    { category:'Savings',planned:40,manual_spent:20 },
  ];
  const expenses = [
    {category:'Frames & Display',date:'2026-11-04',amount:12,status:'approved'},
    {category:'Frames & Display',date:'2026-11-05',amount:8},
    {category:'Frames & Display',date:'2026-11-06',amount:100,status:'pending'},
    {category:'Frames & Display',date:'2026-10-06',amount:50,status:'approved'},
    {category:'Frames & Display',date:'2026-11-07',amount:50,archived:true},
    {category:'Shipping & Postage',date:'2026-11-08',amount:7,status:'approved'},
  ];
  const result=budgetSummary(rows,expenses,'2026-11',200);
  assert.equal(result.rows[0].automatic,20);
  assert.equal(result.rows[0].spent,25);
  assert.equal(result.rows[0].remaining,25);
  assert.equal(result.rows[1].spent,20);
  assert.equal(result.spent,52);
  assert.equal(result.planned,90);
  assert.equal(result.unallocated,110);
  assert.equal(result.unbudgetedExpenses,7);
  assert.equal(result.budgetRemaining,45);
});

test('month navigation crosses calendar years in local time', () => {
  assert.equal(shiftMonth('2026-01',-1),'2025-12');
  assert.equal(shiftMonth('2026-12',1),'2027-01');
  assert.equal(localMonthKey(new Date(2026,10,8,12)), '2026-11');
});

test('different capitalization of expense category still matches the budget', () => {
  const result=budgetSummary([{category:'Groceries',planned:'100',manual_spent:'0'}],
    [{category:'groceries',date:'2026-11-08',amount:'10.25',status:'approved'}], '2026-11','200');
  assert.equal(result.rows[0].spent,10.25);
  assert.equal(result.rows[0].remaining,89.75);
});
