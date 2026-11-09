import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';

// Own DB: import.test.ts asserts totals that PKO rows would change.
process.env.FINANCE_DB = 'data/test-pko.db';
for (const s of ['', '-wal', '-shm']) rmSync(`data/test-pko.db${s}`, { force: true });

const { parsePko, importRows } = await import('./import.ts');
const { decodeBossa } = await import('./trades.ts');

const CSV = decodeBossa(readFileSync('operacje_pko.csv'));
const ACC = '12 1020 0000 0000 0000 0000 0000';

test('parses the real PKO export', () => {
	const rows = parsePko(CSV, ACC);
	assert.equal(rows.length, 22);
	assert.equal(new Set(rows.map((r) => r.id)).size, 22);
	// Within a day the file is out of order; seq 0 must be the closing balance.
	assert.equal(rows[0].balance, 746.79);
	for (let i = 0; i < rows.length - 1; i++)
		assert.equal(Math.round((rows[i].balance - rows[i].amount) * 100), Math.round(rows[i + 1].balance * 100));
	// Web payments name the merchant only under "Lokalizacja".
	assert.equal(rows.find((r) => r.amount === -48.67)!.counterparty, 'store.steampowered.com');
});

test('requires the account number', () => {
	assert.throws(() => parsePko(CSV, ''), /26-digit/);
});

test('import is idempotent', () => {
	assert.deepEqual(importRows(parsePko(CSV, ACC)), { added: 22, skipped: 0 });
	assert.deepEqual(importRows(parsePko(CSV, ACC)), { added: 0, skipped: 22 });
});
