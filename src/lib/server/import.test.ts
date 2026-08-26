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

	assert.deepEqual(stats.excluded(), [
		{ currency: 'EUR', txns: 2, holdings: 0, cash: 0, rate: 0, rateAt: '' }
	]);
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

test('the net worth series splits by source and carries balances forward', () => {
	const { months, sources } = stats.netWorthSeries();
	assert.ok(months.length > 1);
	assert.deepEqual(months, [...months].sort(), 'months must be chronological');
	assert.ok(sources.every((s) => s.values.length === months.length));

	// The TEST stock above was bought in 2026-01 for 1000.
	const i = months.indexOf('2026-01');
	const own = sources.find((s) => s.label === 'Own holdings (at cost)')!;
	assert.ok(i >= 0, 'the buy month is in the series');
	assert.equal(own.values[i], 1000);
	assert.equal(own.values.slice(0, i).filter(Boolean).length, 0, 'nothing before it was bought');

	// Bank balances hold their last known value rather than dropping to zero on a gap.
	assert.equal(sources.filter((s) => s.label.startsWith('PL')).length, 2);
	const last = sources.reduce((t, s) => t + s.values.at(-1)!, 0);
	assert.ok(Math.abs(last - 59337.78) < 0.01, `last month ${last}`);
});

// ── Bossa brokerage: fills (hisPW) and cash ledger (historia finansowa) ─────

const T = await import('./trades.ts');
const CASH_FILE =
	'2026-08-25 19-41-51_historia_finansowa_wszystkie_810414_2019-08-01_2026-08-25.csv';

const hisPW = () => T.parseBossa(T.decodeBossa(readFileSync('hisPW (1).csv')));
const ledger = () => T.parseCash(T.decodeBossa(readFileSync(CASH_FILE)));
const byName = () => new Map(T.positions().map((p) => [`${p.name}|${p.currency}`, p]));

test('parses the real hisPW export out of Windows-1250 bytes', () => {
	const rows = hisPW();
	assert.equal(rows.length, 51);
	assert.equal(new Set(rows.map((r) => r.id)).size, 51, 'fill keys must be unique');
	assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));

	const [first] = rows;
	assert.deepEqual(
		{ date: first.date, name: first.name, side: first.side, qty: first.qty, net: first.net },
		{ date: '2026-08-14', name: 'XTB', side: 'S', qty: 80, net: 13857.54 }
	);
});

test('a fill file whose own arithmetic is wrong is rejected', () => {
	const head = 'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta\n';
	assert.throws(
		() => T.parseBossa(head + '01.02.2024 10:00:00;X;PL1;10;K;10,00;100,00;5,00;100,00;PLN'),
		/po prowizji/
	);
	assert.throws(() => T.parseBossa('data;papier;isin\n'), /Missing column/);
	assert.throws(
		() => T.parseBossa(head + '01.02.2024 10:00:00;X;PL1;10;Z;10,00;100,00;0,00;100,00;PLN'),
		/unknown side/
	);
});

test('parses the ledger and classifies every operation in it', () => {
	const { ops, trades } = ledger();
	assert.equal(ops.length, 154);
	assert.equal(new Set(ops.map((o) => o.id)).size, 154, 'operation keys must be unique');
	assert.equal(trades.length, 67, 'fills split back out of the settlement rows');
	assert.ok(!ops.some((o) => o.kind === 'other'), 'nothing in this file should fall through');

	const n = (kind: string) => ops.filter((o) => o.kind === kind).length;
	assert.equal(n('trade'), 67);
	assert.equal(n('dividend'), 34);
	assert.equal(n('coupon'), 19);
	assert.equal(n('bond'), 3, 'subscription, refund and redemption');
	assert.equal(n('deposit'), 15);
	assert.equal(n('fx'), 6);
	assert.equal(n('tender'), 1, '"- prowizja TIM" is a fee, not a payout');
	assert.equal(n('fee'), 9);
	assert.equal(ops.reduce((s, o) => s + 1, 0), 67 + 34 + 19 + 3 + 15 + 6 + 1 + 9, 'every row classified');

	// The symbol has to survive both spellings of a dividend title.
	const div = ops.filter((o) => o.kind === 'dividend').map((o) => o.symbol);
	assert.ok(div.includes('ASBIS'), 'Wypłata dywidendy brutto ASBIS');
	assert.ok(div.includes('XTB'), 'Wypłata dywidendy XTB');
	assert.ok(!div.some((s) => s.includes('brutto')));

	// USD fills exist only in this file; hisPW is one market.
	assert.equal(trades.filter((t) => t.currency === 'USD').length, 16);
});

test('the two exports recognise the fills they share', () => {
	assert.deepEqual(T.importTrades(hisPW()), { added: 51, skipped: 0 });

	// All 51 PLN fills are already known; only the 16 USD ones are new. The natural key
	// has to survive hisPW filing 400 x 21.8385 as 8735.38 rather than 8735.40.
	const first = T.importCash(ledger());
	assert.equal(first.added, 154);
	assert.equal(first.fills, 16, 'PLN fills must collapse onto the hisPW rows');
	assert.equal(T.trades().length, 67);

	assert.deepEqual(T.importCash(ledger()), { added: 0, skipped: 154, fills: 0 });
	assert.deepEqual(T.importTrades(hisPW()), { added: 0, skipped: 51 });
	assert.equal(T.trades().length, 67);
});

test('the same ISIN on two markets keeps two cost bases', () => {
	const by = byName();
	// Energy Fuels: 372 bought and sold in PLN on the GPW, 1200 bought and 1050 sold in
	// USD on XASE. One FIFO queue for both would price USD lots at PLN cost.
	const pln = by.get('Energy Fuels Inc.|PLN')!;
	const usd = by.get('Energy Fuels Inc.|USD')!;
	assert.equal(pln.openQty, 0);
	assert.equal(usd.openQty, 150);
	assert.equal(usd.boughtQty, 1200);
	assert.equal(usd.soldQty, 1050);
	assert.ok(Math.abs(pln.realized - (9122.02 + 1930.77 - 6663.46)) < 0.01);
	assert.ok(usd.realized > 0);
	assert.ok(
		!T.positions().some((p) => p.unmatchedQty),
		'nothing sold without a purchase'
	);
});

test('a tender offer closes the position it paid for', () => {
	// TIM was bought twice (120 shares, 2958.20) and never sold on the exchange, so it
	// only leaves the portfolio via "Rozliczenie wezwania TIM" — 6082.80, no quantity.
	const tim = byName().get('TIM|PLN')!;
	assert.equal(tim.openQty, 0, 'a tendered position is not still held');
	assert.equal(tim.soldQty, 120);
	assert.equal(tim.inferred, true, 'the quantity was assumed, and must be flagged');
	assert.ok(Math.abs(tim.realized - (6082.8 - 2958.2)) < 0.01, `${tim.realized}`);
	assert.deepEqual(
		T.tradeTotals().inferred.map((p) => p.name),
		['TIM']
	);
	assert.equal(get(`SELECT 1 FROM holding WHERE isin = 'PLTIM0000016'`), undefined);
});

test('dividends land on the instrument that paid them', () => {
	const by = byName();
	assert.ok(Math.abs(by.get('XTB|PLN')!.dividends - 6708.3) < 0.01);
	assert.ok(Math.abs(by.get('ASBIS|PLN')!.dividends - 2715.44) < 0.01);
	assert.equal(by.get('CDPROJEKT|PLN')!.dividends, 0);
	assert.deepEqual(T.tradeTotals().orphans, [], 'every payer matches an imported instrument');
});

test('money made counts gains and income but never your own deposits', () => {
	const [pln] = T.portfolioIncome().filter((i) => i.currency === 'PLN');
	assert.ok(Math.abs(pln.dividends - 13656.89) < 0.01, `dividends ${pln.dividends}`);
	assert.ok(Math.abs(pln.coupons - 19.96) < 0.01, `coupons ${pln.coupons}`);
	// -1000 subscribed, +900 refunded, +101.06 redeemed: the bond returned its 1.06 coupon,
	// not 101.06 of income.
	assert.ok(Math.abs(pln.bond - 1.06) < 0.01, `bond ${pln.bond}`);
	assert.ok(Math.abs(pln.fees + 73.46) < 0.01, `fees ${pln.fees}`);
	assert.equal(pln.deposits, 70000);
	assert.ok(
		Math.abs(pln.total - (pln.realized + pln.dividends + pln.coupons + pln.bond + pln.fees)) < 1e-9,
		'deposits must be outside the total'
	);
});

test('cash balance and net worth pick up the brokerage', () => {
	const cash = T.cashBalances();
	assert.ok(Math.abs(cash.find((c) => c.currency === 'PLN')!.balance - 38487.91) < 0.01);
	assert.ok(Math.abs(cash.find((c) => c.currency === 'USD')!.balance - 7614.08) < 0.01);
	assert.deepEqual(T.fxRates(), [{ date: '2024-10-29', pair: 'PLN/USD', rate: 4.0317 }]);

	const nw = stats.netWorth();
	assert.ok(nw.parts.some((p) => p.label === 'Brokerage cash' && Math.abs(p.value - 38487.91) < 0.01));

	// USD holdings must not be added to PLN at 1:1 — they are reported, never counted.
	const inv = stats.investmentTotals();
	const plnHoldings = all<{ v: number }>(
		`SELECT SUM(qty * buy_price) v FROM holding WHERE currency = 'PLN'`
	)[0].v;
	assert.ok(Math.abs(inv.cost - plnHoldings) < 0.01, 'PLN cost basis only');

	// Every page reads the same gap off excluded(): holdings, broker cash and bank rows.
	const gaps = stats.excluded();
	assert.deepEqual(gaps.map((e) => e.currency), ['EUR', 'USD'], 'EUR bank rows still reported');
	const usd = gaps.find((e) => e.currency === 'USD')!;
	assert.equal(usd.txns, 0, 'no USD bank transactions');
	assert.ok(Math.abs(usd.cash - 7614.08) < 0.01);
	assert.ok(Math.abs(usd.rate - 4.0317) < 1e-9, 'the rate the user last converted at');
	assert.equal(usd.rateAt, '2024-10-29');
	const usdHoldings = all<{ v: number }>(
		`SELECT SUM(qty * buy_price) v FROM holding WHERE currency = 'USD'`
	)[0].v;
	assert.ok(Math.abs(usd.holdings - usdHoldings) < 0.01, 'no price set, so value is cost');
	// None of it reached net worth: every part is a PLN figure and they sum to the total.
	assert.ok(usd.holdings + usd.cash > 0, 'there is USD to leave out');
	const investments = nw.parts.find((p) => p.label === 'Investments')!;
	assert.ok(Math.abs(investments.value - inv.value) < 0.01, 'PLN holdings only');
	assert.ok(
		Math.abs(nw.total - nw.parts.reduce((s, p) => s + p.value, 0)) < 1e-9,
		'no hidden currency conversion in the total'
	);
});

test('a sell with no purchase imported is flagged, not counted as pure profit', () => {
	const rows = T.parseBossa(
		'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta\n' +
			'01.02.2024 10:00:00;GHOST;PLGHOST0001;100;S;10,00;1000,00;3,80;996,20;PLN'
	);
	assert.deepEqual(T.importTrades(rows), { added: 1, skipped: 0 });

	const ghost = T.positions().find((p) => p.isin === 'PLGHOST0001')!;
	assert.equal(ghost.unmatchedQty, 100);
	assert.equal(ghost.realized, 0, 'no cost basis means no P/L claim');
	assert.equal(ghost.openQty, 0);
	assert.deepEqual(
		T.positions()
			.filter((p) => p.unmatchedQty)
			.map((p) => p.isin),
		['PLGHOST0001']
	);
	run(`DELETE FROM trade WHERE isin = 'PLGHOST0001'`);
});

test('a repeated identical fill survives as two lots', () => {
	// Energy Fuels sold 100 at 5.63 twice on the same day, under two order numbers.
	const same = T.trades().filter(
		(t) => t.date === '2025-06-03' && t.qty === 100 && t.price === 5.63
	);
	assert.equal(same.length, 2, 'a natural key must still separate genuine repeats');
	assert.equal(new Set(same.map((t) => t.id)).size, 2);
});

test('open positions become priceable holdings and survive a re-import', () => {
	T.importTrades(hisPW());
	const broker = all<{ isin: string; currency: string; price: number | null }>(
		`SELECT isin, currency, price FROM holding WHERE source = 'broker'`
	);
	assert.equal(broker.length, T.positions().filter((p) => p.openQty > 1e-9).length);
	assert.equal(broker.length, 10, 'nine instruments, one of them open in two currencies');
	assert.ok(broker.some((h) => h.currency === 'USD'), 'USD positions are held too');
	assert.ok(broker.every((h) => h.price === null), "prices are the user's to type");

	// A hand-typed price must not be wiped by the next import.
	run(`UPDATE holding SET price = 99, price_at = '2026-08-25' WHERE isin = 'PLXTRDM00011'`);
	T.importCash(ledger());
	const xtb = get<{ price: number; qty: number }>(
		`SELECT price, qty FROM holding WHERE isin = 'PLXTRDM00011'`
	)!;
	assert.equal(xtb.price, 99);
	assert.equal(xtb.qty, 220);

	// Selling out drops the holding, and only for the currency that closed.
	run(`DELETE FROM trade WHERE isin = 'CA2926717083' AND side = 'K' AND currency = 'USD'`);
	T.syncBrokerHoldings();
	assert.equal(get(`SELECT 1 FROM holding WHERE isin = 'CA2926717083'`), undefined);
	assert.ok(get(`SELECT 1 FROM holding WHERE isin = 'PLXTRDM00011'`), 'PLN sleeve untouched');
});
