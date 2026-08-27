import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';

// Own DB file, wiped per run: db.ts opens FINANCE_DB at import time, and the other
// suites run in parallel with this one.
process.env.FINANCE_DB = 'data/test-treasury.db';
for (const s of ['', '-wal', '-shm']) rmSync(`data/test-treasury.db${s}`, { force: true });

const { readXls } = await import('./xls.ts');
const { importTreasuryBonds, maturityOf, parseDyspozycje, toHoldings } = await import(
	'./treasury.ts'
);
const { bondOps } = await import('./trades.ts');
const { get, run } = await import('./db.ts');
const { interestTo } = await import('./bonds.ts');

const XLS = readFileSync('HistoriaDyspozycji.xls');

test('reads the real .xls out of its OLE container', () => {
	const rows = readXls(XLS);
	assert.equal(rows.length, 19, 'header + 9 purchases, each logged twice');
	assert.equal(rows[0][0], 'DATA DYSPOZYCJI');
	assert.deepEqual(rows[1].slice(0, 3), ['2024-08-02', 'dyspozycja zakupu', 'TOS0827']);
	assert.equal(rows[1][5], '220', 'quantity comes from a numeric cell, not a string');
});

test('order rows collapse onto their execution', () => {
	const buys = parseDyspozycje(readXls(XLS));
	assert.equal(buys.length, 9);
	assert.equal(
		buys.reduce((s, b) => s + b.qty, 0),
		1250
	);
	assert.equal(
		buys.reduce((s, b) => s + b.amount, 0),
		125000
	);
	assert.ok(buys.every((b) => b.amount === b.qty * 100));
});

test('a missing column is named, not guessed at', () => {
	assert.throws(() => parseDyspozycje([['DATA DYSPOZYCJI', 'STATUS']]), /Missing column "RODZAJ DYSPOZYCJI"/);
});

test('purchases of one series merge into one holding', () => {
	const hs = toHoldings(parseDyspozycje(readXls(XLS)));
	assert.deepEqual(
		hs.map((h) => h.code).sort(),
		['TOS0328', 'TOS0329', 'TOS0428', 'TOS0827', 'TOS1128']
	);
	assert.ok(hs.every((h) => h.buy_price === 100 && h.freq === 'annual' && h.cap === 1));

	const march = hs.find((h) => h.code === 'TOS0329')!;
	assert.equal(march.qty, 500, '200 + 90 + 100 + 110 across four days');
	assert.equal(march.buy_date, '2026-03-13', 'earliest lot');
	assert.equal(march.maturity, '2029-03-13');
	assert.equal(hs.find((h) => h.code === 'TOS0428')!.qty, 230);
});

test('maturity is the coded month on the purchase day', () => {
	assert.equal(maturityOf('TOS0827', '2024-08-02'), '2027-08-02');
	assert.equal(maturityOf('EDO0336', '2026-03-31'), '2036-03-31');
	// A short month cannot hold the 31st.
	assert.equal(maturityOf('TOS0231', '2028-03-31'), '2031-02-28');
	assert.throws(() => maturityOf('TOS0325', '2026-03-13'), /on or before/);
});

test('re-import updates in place and keeps the rate you typed', () => {
	const buys = parseDyspozycje(readXls(XLS));
	assert.deepEqual(importTreasuryBonds(buys), { added: 5, skipped: 0, ops: 9 });

	run(`UPDATE holding SET coupon_rate = 0.0595 WHERE isin = 'TOS0827'`);
	// Same file again, plus a later lot in a series already held.
	assert.deepEqual(
		importTreasuryBonds([...buys, { code: 'TOS1128', date: '2025-11-20', qty: 50, amount: 5000 }]),
		{ added: 0, skipped: 5, ops: 1 }
	);

	const held = get<any>(`SELECT * FROM holding WHERE isin = 'TOS0827'`)!;
	assert.equal(held.coupon_rate, 0.0595, 'the rate is not in the export — do not clear it');
	assert.equal(held.qty, 220);
	assert.equal(get<any>(`SELECT qty FROM holding WHERE isin = 'TOS1128'`)!.qty, 150);
	assert.equal(get<any>(`SELECT COUNT(*) n FROM holding`)!.n, 5);

	// One year in, 220 bonds at 5.95% have earned their first annual credit.
	assert.ok(Math.abs(interestTo(held, '2025-08') - 22000 * 0.0595) < 1e-9);
});

test('the dispositions survive the import, one row per lot', () => {
	// Runs after the re-import test above: the same file twice, plus one extra lot.
	const ops = bondOps().filter((o) => o.source === 'registry');
	assert.equal(ops.length, 10, '9 purchases in the file, deduped, plus the extra TOS1128 lot');
	assert.equal(
		ops.reduce((s, o) => s + o.amount, 0),
		-130000,
		'money out: 125 000 from the file plus the 5 000 lot'
	);

	const march = ops.filter((o) => o.symbol === 'TOS0329');
	assert.equal(march.length, 4, 'four lots stay four operations, not one merged holding');
	assert.deepEqual(
		march.map((o) => o.date).sort(),
		['2026-03-13', '2026-03-27', '2026-03-30', '2026-03-30']
	);
	assert.ok(ops.every((o) => o.kind === 'bond' && o.currency === 'PLN'));
	// Two lots landed on 2026-03-30: the occurrence counter has to keep both.
	assert.equal(march.filter((o) => o.date === '2026-03-30').length, 2);
});
