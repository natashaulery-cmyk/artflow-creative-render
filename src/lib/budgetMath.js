const money = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
};
const key = (name) => String(name || '').trim().toLowerCase();

export function budgetSummary(categories = [], expenses = [], month = '', incomeTarget = 0) {
  const expenseTotals = new Map();
  let allApprovedSpending = 0;
  for (const expense of expenses) {
    if (!expense || expense.archived === true || expense.status === 'pending') continue;
    if (String(expense.date || '').slice(0, 7) !== month) continue;
    const amount = money(expense.amount);
    allApprovedSpending += amount;
    const category = key(expense.category) || 'uncategorized';
    expenseTotals.set(category, money((expenseTotals.get(category) || 0) + amount));
  }
  const mappedKeys = new Set();
  let planned = 0, categorySpending = 0, manualSpending = 0;
  const rows = categories.map((row) => {
    const category = key(row.category);
    mappedKeys.add(category);
    const allocated = money(row.planned);
    const automatic = money(expenseTotals.get(category) || 0);
    const manual = money(row.manual_spent);
    const spent = money(automatic + manual);
    planned += allocated;
    categorySpending += automatic;
    manualSpending += manual;
    return { ...row, planned: allocated, automatic, manual_spent: manual,
      spent, remaining: money(allocated - spent) };
  });
  const unbudgeted = [...expenseTotals].filter(([name]) => !mappedKeys.has(name))
    .reduce((sum, [,value]) => sum + value, 0);
  const income = money(incomeTarget);
  const spent = money(allApprovedSpending + manualSpending);
  return {
    rows,
    income,
    planned: money(planned),
    spent,
    trackedExpenseSpending: money(allApprovedSpending),
    manualSpending: money(manualSpending),
    unbudgetedExpenses: money(unbudgeted),
    unallocated: money(income - planned),
    budgetRemaining: money(planned - categorySpending - manualSpending),
    incomeAfterSpending: money(income - spent),
  };
}

export function localMonthKey(date = new Date()) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}
export function shiftMonth(key, delta) {
  const [year, month] = String(key).split('-').map(Number);
  const date = new Date(year, month - 1 + delta, 1, 12);
  return localMonthKey(date);
}
