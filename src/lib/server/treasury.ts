/**
 * obligacjeskarbowe.pl "Historia dyspozycji" (.xls) -> bond holdings.
 *
 * The export is a disposition log, not a portfolio: every purchase appears twice, once
 * as the order ("dyspozycja zakupu") and once as its execution ("zakup papierów"). It
 * also carries no interest rate at all — the rate belongs to the emission, so it is
 * typed in once per series and survives every re-import.
 */
import { createHash } from 'node:crypto';
import type { Bond } from './bonds.ts';
import { db, run, tx } from './db.ts';
import { readXls } from './xls.ts';

export type BondBuy = { code: string; date: string; qty: number; amount: number };

/** Polish savings bonds by prefix: how interest is credited. The term is in the code. */
const TYPES: Record<string, { name: string; freq: Bond['compound_freq']; capitalize: number }> = {
	OTS: { name: '3-month fixed', freq: 'annual', capitalize: 0 },
	ROR: { name: '1-year variable', freq: 'monthly', capitalize: 0 },
	DOR: { name: '2-year variable', freq: 'monthly', capitalize: 0 },
	TOS: { name: '3-year fixed', freq: 'annual', capitalize: 1 },
	COI: { name: '4-year indexed', freq: 'annual', capitalize: 0 },
	EDO: { name: '10-year indexed', freq: 'annual', capitalize: 1 },
	ROS: { name: '6-year family', freq: 'annual', capitalize: 1 },
	ROD: { name: '12-year family', freq: 'annual', capitalize: 1 }
};

const COLUMNS = [
	'DATA DYSPOZYCJI',
	'RODZAJ DYSPOZYCJI',
	'KOD OBLIGACJI',
	'LICZBA OBLIGACJI',
	'KWOTA OPERACJI',
	'STATUS'
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));

/** Executed purchases only, one per fill. */
export function parseDyspozycje(rows: string[][]): BondBuy[] {
	const head = (rows[0] ?? []).map((c) => c.trim().toUpperCase());
	const [cDate, cType, cCode, cQty, cAmount, cStatus] = COLUMNS.map((name) => {
		const i = head.indexOf(name);
		if (i < 0) throw new Error(`Missing column "${name}" — is this a Historia dyspozycji export?`);
		return i;
	});

	const out: BondBuy[] = [];
	rows.slice(1).forEach((r, n) => {
		const cell = (i: number) => (r[i] ?? '').trim();
		// The order row describes the same purchase as its execution — count it once.
		if (!/^zakup papier/i.test(cell(cType))) return;
		if (!/^zrealizowan/i.test(cell(cStatus))) return;

		const date = cell(cDate);
		const code = cell(cCode).toUpperCase();
		const qty = num(cell(cQty));
		const amount = num(cell(cAmount));
		if (!ISO_DATE.test(date)) throw new Error(`Row ${n + 2}: bad date "${date}"`);
		if (!/^[A-Z]{3}\d{4}$/.test(code)) throw new Error(`Row ${n + 2}: bad bond code "${code}"`);
		if (!(qty > 0) || !(amount > 0)) throw new Error(`Row ${n + 2}: bad quantity or amount`);
		out.push({ code, date, qty, amount });
	});
	return out;
}

/**
 * The code names the maturity month (TOS0827 -> August 2027); savings bonds are
 * redeemed on the same day of the month they were bought on.
 */
export function maturityOf(code: string, buyDate: string): string {
	const mm = code.slice(3, 5);
	const year = 2000 + Number(code.slice(5, 7));
	const lastDay = new Date(Date.UTC(year, Number(mm), 0)).getUTCDate();
	const day = Math.min(Number(buyDate.slice(8, 10)), lastDay);
	const maturity = `${year}-${mm}-${String(day).padStart(2, '0')}`;
	if (maturity <= buyDate) throw new Error(`${code} matures ${maturity}, on or before ${buyDate}`);
	return maturity;
}

export type BondHolding = {
	code: string;
	name: string;
	qty: number;
	buy_price: number;
	buy_date: string;
	maturity: string;
	freq: string;
	cap: number;
};

/**
 * One holding per bond code, merged from its purchase lots. Every purchase of a code
 * falls in the same month — the code names the maturity month and the term is fixed —
 * so merging costs nothing at the month granularity the accrual engine works in.
 */
export function toHoldings(buys: BondBuy[]): BondHolding[] {
	const codes = new Map<string, BondBuy[]>();
	for (const b of buys) codes.set(b.code, [...(codes.get(b.code) ?? []), b]);

	return [...codes].map(([code, lots]) => {
		const qty = lots.reduce((s, l) => s + l.qty, 0);
		const amount = lots.reduce((s, l) => s + l.amount, 0);
		const buy_date = lots.reduce((a, l) => (l.date < a ? l.date : a), lots[0].date);
		const type = TYPES[code.slice(0, 3)] ?? {
			name: code.slice(0, 3),
			freq: 'annual' as const,
			capitalize: 1
		};
		return {
			code,
			name: type.name,
			qty,
			buy_price: amount / qty,
			buy_date,
			maturity: maturityOf(code, buy_date),
			freq: type.freq,
			cap: type.capitalize
		};
	});
}

/**
 * The purchases themselves, kept as operations rather than only folded into holdings —
 * the Bonds tab lists them next to the brokerage ledger's coupons and redemptions.
 *
 * Two identical purchases of one series on one day are indistinguishable in the export,
 * so the id counts occurrences the way the brokerage ledger does: re-importing the same
 * file changes nothing, a file with a genuine extra lot adds one row.
 */
function insertOps(buys: BondBuy[]) {
	const ins = db.prepare(`
		INSERT OR IGNORE INTO bond_op (id, date, title, details, amount, currency, kind, symbol, seq)
		VALUES (:id, :date, :title, :details, :amount, 'PLN', 'bond', :symbol, :seq)
	`);
	const seen = new Map<string, number>();
	let added = 0;
	buys.forEach((b, seq) => {
		const group = [b.code, b.date, b.qty, b.amount].join('|');
		const dup = seen.get(group) ?? 0;
		seen.set(group, dup + 1);
		added += Number(
			ins.run({
				id: createHash('sha256').update(`treasury|${group}|${dup}`).digest('hex'),
				date: b.date,
				title: `Zakup papierów ${b.code}`,
				details: `${b.qty} × ${(b.amount / b.qty).toFixed(2)} PLN`,
				// Buying bonds takes money out of the registry account.
				amount: -b.amount,
				symbol: b.code,
				seq
			}).changes
		);
	});
	return added;
}

export function importTreasuryBonds(buys: BondBuy[]) {
	const rows = toHoldings(buys);
	return tx(() => {
		const ops = insertOps(buys);
		let added = 0;
		for (const h of rows) {
			// coupon_rate is left out of both statements on purpose: the export has no rate,
			// so the one typed in for this series is the only one there is.
			const hit = run(
				`UPDATE holding SET ticker = :code, name = :name, qty = :qty, buy_price = :buy_price,
					buy_date = :buy_date, maturity = :maturity, compound_freq = :freq, capitalize = :cap
				 WHERE source = 'treasury' AND isin = :code`,
				h
			).changes;
			if (!hit) {
				run(
					`INSERT INTO holding
						(kind, source, isin, ticker, name, qty, buy_price, buy_date, maturity, compound_freq, capitalize, currency)
					 VALUES
						('bond', 'treasury', :code, :code, :name, :qty, :buy_price, :buy_date, :maturity, :freq, :cap, 'PLN')`,
					h
				);
				added++;
			}
		}
		// ponytail: nothing is ever deleted. Redemption is not in this export's vocabulary
		// yet, and a partial export must not wipe series it does not mention — a matured
		// series goes away by hand. Revisit when a "wykup" row actually shows up.
		return { added, skipped: rows.length - added, ops };
	});
}

export const parseTreasuryXls = (buf: ArrayBuffer) => parseDyspozycje(readXls(buf));
