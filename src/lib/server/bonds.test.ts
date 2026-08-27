import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Bond, accruals, interestTo, project, totalInterest, valueAt } from './bonds.ts';

/** The example from the brief: 3-year, fixed 5% annual, capitalised monthly. */
const THREE_YEAR: Bond = {
	id: 1,
	ticker: 'TOS0529',
	name: '3-year fixed',
	qty: 100,
	buy_price: 100, // 10 000 PLN principal
	buy_date: '2026-05-01',
	coupon_rate: 0.05,
	maturity: '2029-05-01',
	compound_freq: 'monthly',
	capitalize: 1,
	currency: 'PLN'
};

test('monthly capitalisation compounds to the closed-form value', () => {
	const rows = accruals(THREE_YEAR);
	assert.equal(rows.length, 36, '3 years of monthly credits');
	assert.equal(rows[0].month, '2026-06');
	assert.equal(rows.at(-1)!.month, '2029-05');

	// 10 000 * (1 + 0.05/12)^36
	const expected = 10000 * (1 + 0.05 / 12) ** 36;
	assert.ok(Math.abs(rows.at(-1)!.balance - expected) < 1e-6, `${rows.at(-1)!.balance}`);
	assert.ok(Math.abs(totalInterest(THREE_YEAR) - (expected - 10000)) < 1e-6);

	// First month is exactly one month of simple interest on the principal.
	assert.ok(Math.abs(rows[0].interest - 10000 * (0.05 / 12)) < 1e-9);
	// Compounding must beat simple interest over the full term.
	assert.ok(totalInterest(THREE_YEAR) > 10000 * 0.05 * 3);
});

test('valueAt walks the curve and never runs past maturity', () => {
	assert.equal(valueAt(THREE_YEAR, '2026-05'), 10000, 'no interest in the purchase month');
	assert.ok(Math.abs(valueAt(THREE_YEAR, '2026-06') - 10000 * (1 + 0.05 / 12)) < 1e-9);
	const atMaturity = valueAt(THREE_YEAR, '2029-05');
	assert.equal(valueAt(THREE_YEAR, '2035-01'), atMaturity, 'flat after maturity');
});

test('annual and quarterly frequencies credit the right number of times', () => {
	const annual = { ...THREE_YEAR, compound_freq: 'annual' as const };
	const quarterly = { ...THREE_YEAR, compound_freq: 'quarterly' as const };
	// Every frequency earns monthly; the frequency only says how often it compounds.
	assert.equal(accruals(annual).length, 36);
	assert.equal(accruals(quarterly).length, 36);

	// Same nominal rate, more frequent compounding => strictly more interest.
	assert.ok(totalInterest(annual) < totalInterest(quarterly));
	assert.ok(totalInterest(quarterly) < totalInterest(THREE_YEAR));
	assert.ok(Math.abs(totalInterest(annual) - (10000 * 1.05 ** 3 - 10000)) < 1e-6);
});

test('a payout bond stays at par and pays simple interest', () => {
	const payout: Bond = { ...THREE_YEAR, capitalize: 0, compound_freq: 'annual' };
	assert.equal(valueAt(payout, '2029-05'), 10000, 'principal is unchanged');
	// 3 x 500, no compounding.
	assert.ok(Math.abs(totalInterest(payout) - 1500) < 1e-9);
	for (const a of accruals(payout)) assert.ok(Math.abs(a.interest - 500 / 12) < 1e-9);
});

test('a stub period shorter than a full quarter accrues pro-rata', () => {
	// 14 months on a quarterly bond => 4 full quarters + a 2-month stub.
	const stub: Bond = { ...THREE_YEAR, maturity: '2027-07-01', compound_freq: 'quarterly' };
	const rows = accruals(stub);
	assert.equal(rows.length, 14);
	assert.equal(rows.at(-1)!.month, '2027-07');
	// The stub is 2 of a quarter's 3 months, so it earns two monthly slices, not three.
	const base = rows[11].balance; // capitalised through the fourth quarter
	const stubInterest = rows.slice(12).reduce((t, a) => t + a.interest, 0);
	assert.ok(Math.abs(stubInterest - (base * 0.05) / 6) < 1e-9);
	assert.ok(Math.abs(stubInterest / (base * (0.05 / 4)) - 2 / 3) < 1e-9);
});

test('project sums bonds onto one timeline and nets off Belka tax', () => {
	const other: Bond = {
		...THREE_YEAR,
		id: 2,
		ticker: 'OTS',
		qty: 10,
		buy_date: '2026-05-01',
		maturity: '2027-05-01',
		compound_freq: 'annual'
	};
	const p = project([THREE_YEAR, other]);

	assert.equal(p.months[0], '2026-06');
	assert.equal(p.months.at(-1), '2029-05');
	assert.equal(p.byBond.length, 2);
	assert.equal(p.cumulative.length, p.months.length);

	// The one-year bond earns through all twelve of its months, 50 in total.
	const bond2 = p.byBond.find((b) => b.id === 2)!;
	assert.equal(bond2.data.filter((v) => v > 0).length, 12);
	assert.ok(Math.abs(bond2.data.reduce((t, v) => t + v, 0) - 50) < 1e-9);
	assert.ok(Math.abs(bond2.data[p.months.indexOf('2027-05')] - 50 / 12) < 1e-9);

	const gross = totalInterest(THREE_YEAR) + totalInterest(other);
	assert.ok(Math.abs(p.cumulative.at(-1)! - gross) < 1e-6);
	assert.ok(Math.abs(p.cumulativeNet.at(-1)! - gross * 0.81) < 1e-6);
	// Cumulative must be monotonic.
	assert.deepEqual(p.cumulative, [...p.cumulative].sort((a, b) => a - b));
});

test('an unfinished or backwards bond projects nothing instead of looping', () => {
	assert.deepEqual(accruals({ ...THREE_YEAR, maturity: '2025-01-01' }), []);
	assert.deepEqual(accruals({ ...THREE_YEAR, maturity: THREE_YEAR.buy_date }), []);
	assert.deepEqual(accruals({ ...THREE_YEAR, qty: 0 }), []);
	assert.deepEqual(project([]).months, []);
});

test('a yearly bond earns every month, not only on its anniversary', () => {
	const annual: Bond = { ...THREE_YEAR, compound_freq: 'annual' };
	const rows = accruals(annual);

	// The reported bug: nothing showed until the first anniversary.
	assert.ok(interestTo(annual, '2026-06') > 0, 'one month in, one month of interest');
	assert.ok(Math.abs(interestTo(annual, '2026-06') - 10000 * (0.05 / 12)) < 1e-9);
	assert.ok(Math.abs(interestTo(annual, '2027-05') - 500) < 1e-9, 'a year in, a full coupon');

	// And the flat chart: within a year every month earns the same, and no month is a spike.
	const year = rows.slice(0, 12).map((a) => a.interest);
	assert.ok(year.every((v) => Math.abs(v - year[0]) < 1e-9));
	assert.ok(Math.max(...rows.map((a) => a.interest)) < 2 * Math.min(...rows.map((a) => a.interest)));

	// Value follows along instead of stepping once a year, and still lands on the coupon.
	assert.ok(valueAt(annual, '2026-06') > 10000);
	assert.ok(Math.abs(valueAt(annual, '2027-05') - 10500) < 1e-9);
	assert.ok(Math.abs(totalInterest(annual) - (10000 * 1.05 ** 3 - 10000)) < 1e-6);
});
