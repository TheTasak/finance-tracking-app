import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	type Assumptions,
	addMonths,
	at,
	fireNumber,
	projectWealth,
	reaches,
	runway
} from './projection.ts';

const BASE: Assumptions = {
	start: 10000,
	monthlyIncome: 14000,
	savingsRate: 0.5, // 7000 a month
	stockReturn: 0.07,
	bondReturn: 0.05,
	stockAllocation: 0.5, // blended 6%
	incomeGrowth: 0,
	years: 10
};

test('addMonths rolls over years correctly', () => {
	assert.equal(addMonths('2026-08', 1), '2026-09');
	assert.equal(addMonths('2026-12', 1), '2027-01');
	assert.equal(addMonths('2026-01', 24), '2028-01');
	assert.equal(addMonths('2026-08', 0), '2026-08');
});

test('zero return means wealth is exactly what you paid in', () => {
	const w = projectWealth({ ...BASE, stockReturn: 0, bondReturn: 0 }, '2026-08');
	assert.equal(w.blended, 0);
	assert.equal(w.final, 10000 + 7000 * 120);
	assert.deepEqual(w.wealth, w.contributed);
	assert.equal(w.totalGrowth, 0);
});

test('matches the closed-form future value of a lump sum plus an annuity', () => {
	const w = projectWealth(BASE, '2026-08');
	const r = 0.06 / 12;
	const n = 120;
	// FV = P(1+r)^n + PMT * ((1+r)^n - 1)/r
	const expected = 10000 * (1 + r) ** n + 7000 * (((1 + r) ** n - 1) / r);
	assert.ok(Math.abs(w.final - expected) < 1e-6, `${w.final} vs ${expected}`);

	assert.equal(w.months.length, 121, 'includes month zero');
	assert.equal(w.months[0], '2026-08');
	assert.equal(w.months.at(-1), '2036-08');
	assert.equal(w.wealth[0], 10000, 'starts at current net worth');
	assert.equal(w.totalContributed, 10000 + 7000 * 120);
	assert.ok(w.totalGrowth > 0);
});

test('blended rate follows the stock/bond allocation', () => {
	const allStocks = projectWealth({ ...BASE, stockAllocation: 1 }, '2026-08');
	const allBonds = projectWealth({ ...BASE, stockAllocation: 0 }, '2026-08');
	assert.ok(Math.abs(allStocks.blended - 0.07) < 1e-12);
	assert.ok(Math.abs(allBonds.blended - 0.05) < 1e-12);
	assert.ok(allStocks.final > allBonds.final, 'higher return must end higher');
});

test('saving more and earning more both raise the outcome', () => {
	const base = projectWealth(BASE, '2026-08').final;
	assert.ok(projectWealth({ ...BASE, savingsRate: 0.6 }, '2026-08').final > base);
	assert.ok(projectWealth({ ...BASE, monthlyIncome: 16000 }, '2026-08').final > base);
	// Rate and income scale contributions identically.
	const a = projectWealth({ ...BASE, savingsRate: 0.25 }, '2026-08').final;
	const b = projectWealth({ ...BASE, monthlyIncome: 7000 }, '2026-08').final;
	assert.ok(Math.abs(a - b) < 1e-9);
});

test('a raise lands on the anniversary, not immediately', () => {
	const w = projectWealth(
		{ ...BASE, incomeGrowth: 0.1, years: 2, stockReturn: 0, bondReturn: 0 },
		'2026-08'
	);
	// First 12 deposits at 7000, next 12 at 7700.
	assert.equal(w.totalContributed, 10000 + 7000 * 12 + 7700 * 12);
	assert.ok(projectWealth({ ...BASE, incomeGrowth: 0.1 }, '2026-08').final > projectWealth(BASE, '2026-08').final);
});

test('checkpoints and milestones read off the curve', () => {
	const w = projectWealth(BASE, '2026-08');
	assert.equal(at(w, 0), 10000);
	assert.equal(at(w, 10), w.final);
	assert.equal(at(w, 99), w.final, 'clamps past the horizon');
	assert.ok(at(w, 5) < at(w, 10), 'monotonic while saving');

	const m = reaches(w, 100000)!;
	assert.ok(m, 'must cross 100k within 10 years');
	assert.ok(w.wealth[w.months.indexOf(m)] >= 100000);
	assert.ok(w.wealth[w.months.indexOf(m) - 1] < 100000, 'first crossing, not a later one');
	assert.equal(reaches(w, 1e12), null, 'unreachable target returns null');
});

test('fire number and runway', () => {
	// 3 827/mo -> 45 924/yr -> /0.04 = 25x annual expenses.
	assert.ok(Math.abs(fireNumber(3827.15, 0.04) - 3827.15 * 12 * 25) < 1e-9);
	assert.ok(fireNumber(3827.15, 0.035) > fireNumber(3827.15, 0.04), 'safer rate needs a bigger pot');
	assert.equal(fireNumber(1000, 0), Infinity, 'never withdrawing needs an infinite pot');

	assert.ok(Math.abs(runway(58337.78, 3827.15) - 15.243) < 0.01);
	assert.equal(runway(50000, 0), Infinity, 'no spending means you never run out');
	assert.equal(runway(0, 1000), 0);
});

test('the projection crosses the fire number at a sane point', () => {
	const w = projectWealth(BASE, '2026-08');
	const target = fireNumber(3000, 0.04); // 900 000
	const hit = reaches(w, target)!;
	assert.ok(hit, 'reachable within 10 years at these settings');
	assert.ok(w.wealth[w.months.indexOf(hit)] >= target);
	// Spending more pushes the finish line out.
	assert.ok(fireNumber(4000, 0.04) > target);
	const later = reaches(w, fireNumber(4000, 0.04));
	assert.ok(later === null || later > hit);
});

test('a zero-year horizon is just today', () => {
	const w = projectWealth({ ...BASE, years: 0 }, '2026-08');
	assert.deepEqual(w.months, ['2026-08']);
	assert.equal(w.final, 10000);
	assert.equal(w.totalGrowth, 0);
});
