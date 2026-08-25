import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';

// Fresh DB per run — db.ts opens data/finance.db at import time.
rmSync('data/finance.db', { force: true });
rmSync('data/finance.db-wal', { force: true });
rmSync('data/finance.db-shm', { force: true });

const { parseMillennium, importRows } = await import('./import.ts');
const { all, get, run } = await import('./db.ts');
const stats = await import('./stats.ts');

const CSV = readFileSync('Historia_transakcji_20260824_154727.csv', 'utf8');

test('parses every row of the real export', () => {
	const rows = parseMillennium(CSV);
	assert.equal(rows.length, 313);
	assert.equal(new Set(rows.map((r) => r.id)).size, 313, 'row hashes must be unique');
	assert.equal(new Set(rows.map((r) => r.account)).size, 3);
	assert.ok(rows.every((r) => Number.isFinite(r.amount) && Number.isFinite(r.balance)));
	// NBSP in Opis is normalised away.
	assert.ok(!rows.some((r) => r.description.includes(' ')));
});

test('import is idempotent and flags own transfers', () => {
	const rows = parseMillennium(CSV);
	assert.deepEqual(importRows(rows), { added: 313, skipped: 0 });
	assert.deepEqual(importRows(parseMillennium(CSV)), { added: 0, skipped: 313 });

	// 3 outgoing legs on PL43 + 3 matching incoming on PL65. The 1000 PLN from
	// Iwona Tasarz is intra-bank but NOT own-account, so it stays as income.
	const t = all<{ amount: number }>(`SELECT amount FROM tx WHERE transfer = 1`);
	const out = t.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0);
	const inc = t.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
	assert.equal(out, -35000, 'outgoing own transfers');
	assert.equal(inc, 35000, 'incoming own transfers must match exactly');
});

test('PLN totals exclude transfers and EUR', () => {
	const { income, expenses, savingsRate } = stats.totals(stats.ALL_TIME);

	// 54 803 salary + 1 000 from Iwona + 160.88 interest + 97.45 refunds. No 35k of own transfers.
	assert.ok(Math.abs(income - 56061.33) < 0.01, `income ${income}`);
	// 50 308.60 of PLN debits minus the 35 000 that were transfers.
	assert.ok(Math.abs(expenses - 15308.6) < 0.01, `expenses ${expenses}`);
	assert.ok(Math.abs(savingsRate - 0.7269) < 0.001, `savings rate ${savingsRate}`);

	assert.deepEqual(stats.excluded(), [{ currency: 'EUR', n: 2 }]);
});

test('salary is categorised and the top spend category is real', () => {
	const salary = get<{ n: number }>(`SELECT COUNT(*) n FROM tx WHERE category = 'Salary'`)!;
	assert.equal(salary.n, 4);
	const cats = stats.byCategory(stats.ALL_TIME);
	assert.ok(cats.length > 3);
	assert.ok(!cats.some((c) => c.category === 'Transfer'), 'transfers must not appear as spending');
});

test('net worth uses the bank Saldo and reacts to holdings', () => {
	const before = stats.netWorth().total;
	// PL43 last balance 8050.29 + PL65 50287.49
	assert.ok(Math.abs(before - 58337.78) < 0.01, `net worth ${before}`);

	run(
		`INSERT INTO holding (kind, ticker, name, qty, buy_price, buy_date, price)
		 VALUES ('stock','TEST','Test',10,100,'2026-01-01',120)`
	);
	const inv = stats.investmentTotals();
	assert.equal(inv.cost, 1000);
	assert.equal(inv.value, 1200);
	assert.equal(inv.pl, 200);
	assert.ok(Math.abs(inv.plPct - 0.2) < 1e-9);
	assert.ok(Math.abs(stats.netWorth().total - (before + 1200)) < 0.01);
});
