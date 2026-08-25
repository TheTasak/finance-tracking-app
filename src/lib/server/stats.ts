import { all, get } from './db.ts';
import { type Bond, interestTo, project, totalInterest, valueAt } from './bonds.ts';
import { brokerCash } from './trades.ts';

/** Every income/expense figure is PLN-only and excludes own-account transfers. */
const REAL = `transfer = 0 AND currency = 'PLN'`;

export type Period = { from: string; to: string };

export const ALL_TIME: Period = { from: '0000-01-01', to: '9999-12-31' };

export function monthsCovered(): string[] {
	return all<{ m: string }>(`SELECT DISTINCT substr(date,1,7) m FROM tx ORDER BY m`).map((r) => r.m);
}

export function totals(p: Period) {
	const r = get<{ income: number; expenses: number }>(
		`SELECT
			COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) income,
			COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0) expenses
		 FROM tx WHERE ${REAL} AND date BETWEEN :from AND :to`,
		p
	)!;
	const saved = r.income - r.expenses;
	return { ...r, saved, savingsRate: r.income > 0 ? saved / r.income : 0 };
}

export function monthly() {
	return all<{ month: string; income: number; expenses: number }>(
		`SELECT substr(date,1,7) month,
			COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) income,
			COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0) expenses
		 FROM tx WHERE ${REAL} GROUP BY month ORDER BY month`
	).map((r) => ({ ...r, saved: r.income - r.expenses }));
}

export function byCategory(p: Period) {
	return all<{ category: string; total: number }>(
		`SELECT COALESCE(category,'Uncategorised') category, -SUM(amount) total
		 FROM tx WHERE ${REAL} AND amount < 0 AND date BETWEEN :from AND :to
		 GROUP BY category ORDER BY total DESC`,
		p
	);
}

/** Latest bank balance per account — Saldo is the bank's own running balance, never re-derived. */
function bankBalances() {
	return all<{ iban: string; label: string; balance: number; currency: string; date: string }>(
		`SELECT a.iban, a.label, a.currency, t.balance, t.date
		 FROM account a
		 JOIN tx t ON t.id = (
			SELECT id FROM tx WHERE account = a.iban ORDER BY date DESC, seq ASC LIMIT 1
		 )
		 WHERE a.kind = 'bank' AND a.in_net_worth = 1`
	);
}

function manualBalances() {
	return all<{
		id: number;
		label: string;
		currency: string;
		value: number;
		month: string;
		is_cash: number;
	}>(
		`SELECT a.id, a.label, a.currency, a.is_cash, s.value, s.month
		 FROM account a
		 JOIN snapshot s ON s.account_id = a.id AND s.month = (
			SELECT MAX(month) FROM snapshot WHERE account_id = a.id
		 )
		 WHERE a.kind = 'manual' AND a.in_net_worth = 1`
	);
}

export type Holding = {
	id: number;
	kind: string;
	ticker: string;
	name: string;
	qty: number;
	buy_price: number;
	buy_date: string;
	price: number | null;
	price_at: string | null;
	currency: string;
	coupon_rate: number | null;
	maturity: string | null;
	compound_freq: Bond['compound_freq'] | null;
	capitalize: number;
	/** 'broker' rows are derived from the trade table; 'manual' ones were typed in. */
	source: string;
	isin: string | null;
};

/** A bond is only projectable once it has a rate, a maturity and a frequency. */
export const isBond = (h: Holding): boolean =>
	h.kind === 'bond' && !!h.coupon_rate && !!h.maturity && !!h.compound_freq;

export const currentMonth = () => new Date().toISOString().slice(0, 7);

export function holdings() {
	const month = currentMonth();
	return all<Holding>(`SELECT * FROM holding ORDER BY kind, ticker`).map((h) => {
		const cost = h.qty * h.buy_price;
		// A bond's worth today is arithmetic, not a quote — never ask the user to type it.
		const bond = isBond(h);
		const value = bond ? valueAt(h as Bond, month) : h.qty * (h.price ?? h.buy_price);
		const accrued = bond ? interestTo(h as Bond, month) : 0;
		return {
			...h,
			isBond: bond,
			cost,
			value,
			accrued,
			// Paid-out coupons leave the holding at par, so count them as gains too.
			pl: value - cost + (bond && !h.capitalize ? accrued : 0),
			plPct: cost ? (value - cost + (bond && !h.capitalize ? accrued : 0)) / cost : 0,
			projectedInterest: bond ? totalInterest(h as Bond) : 0
		};
	});
}

/** Every bond that has enough data to project. */
export function bonds(): Bond[] {
	return all<Holding>(`SELECT * FROM holding WHERE kind = 'bond' ORDER BY maturity`).filter(
		isBond
	) as unknown as Bond[];
}

export const bondProjection = () => project(bonds());

/**
 * PLN only. Brokerage imports bring in USD positions and the app does no FX, so
 * adding them at 1:1 would quietly inflate net worth — they come back under
 * `byCurrency` instead, for the UI to show beside the PLN figure.
 */
export function investmentTotals() {
	const hs = holdings();
	const sum = (list: typeof hs) => {
		const cost = list.reduce((s, h) => s + h.cost, 0);
		const value = list.reduce((s, h) => s + h.value, 0);
		return { cost, value, pl: value - cost, plPct: cost ? (value - cost) / cost : 0 };
	};
	const currencies = [...new Set(hs.map((h) => h.currency))];
	return {
		...sum(hs.filter((h) => h.currency === 'PLN')),
		byCurrency: currencies
			.filter((c) => c !== 'PLN')
			.map((currency) => ({ currency, ...sum(hs.filter((h) => h.currency === currency)) }))
	};
}

export function netWorth() {
	const bank = bankBalances().filter((b) => b.currency === 'PLN');
	const manual = manualBalances().filter((m) => m.currency === 'PLN');
	const inv = investmentTotals();
	const cash = brokerCash();
	const parts = [
		...bank.map((b) => ({ label: b.label, value: b.balance, as_of: b.date })),
		...manual.map((m) => ({ label: m.label, value: m.value, as_of: m.month })),
		// The broker's cash ledger has no balance column, so this is a running sum of
		// every operation imported — right only if the export starts at account opening.
		...(cash ? [{ label: 'Brokerage cash', value: cash, as_of: 'ledger' }] : []),
		...(inv.value ? [{ label: 'Investments', value: inv.value, as_of: 'now' }] : [])
	];
	return { parts, total: parts.reduce((s, p) => s + p.value, 0) };
}

/**
 * Net worth per month: end-of-month bank Saldo + manual snapshots, both carried
 * forward over months with no data so the line never dips to zero on a gap.
 */
export function netWorthSeries() {
	const months = monthsCovered();
	if (!months.length) return [];

	const bank = all<{ iban: string; month: string; balance: number }>(
		`SELECT account iban, substr(date,1,7) month, balance FROM tx t
		 WHERE currency = 'PLN' AND rowid = (
			SELECT rowid FROM tx WHERE account = t.account AND substr(date,1,7) = substr(t.date,1,7)
			ORDER BY date DESC, seq ASC LIMIT 1
		 )
		 AND account IN (SELECT iban FROM account WHERE in_net_worth = 1)`
	);
	const manual = all<{ id: number; month: string; value: number }>(
		`SELECT s.account_id id, s.month, s.value FROM snapshot s
		 JOIN account a ON a.id = s.account_id
		 WHERE a.in_net_worth = 1 AND a.currency = 'PLN'`
	);

	const keys = [
		...new Set([...bank.map((b) => 'b:' + b.iban), ...manual.map((m) => 'm:' + m.id)])
	];
	const at = new Map<string, number>();
	for (const b of bank) at.set(`b:${b.iban}|${b.month}`, b.balance);
	for (const m of manual) at.set(`m:${m.id}|${m.month}`, m.value);

	// Manual snapshots can predate or postdate the transaction history.
	const allMonths = [...new Set([...months, ...manual.map((m) => m.month)])].sort();

	const last = new Map<string, number>();
	return allMonths.map((month) => {
		for (const k of keys) {
			const v = at.get(`${k}|${month}`);
			if (v !== undefined) last.set(k, v);
		}
		return { month, total: [...last.values()].reduce((s, v) => s + v, 0) };
	});
}

/**
 * Starting assumptions for the wealth projection, read off the real history so the
 * page opens on the user's actual behaviour rather than invented numbers.
 */
export function projectionDefaults() {
	const months = monthly();
	const t = totals(ALL_TIME);
	const hs = holdings();

	// PLN only, to match `start` — the app does no FX.
	const pln = hs.filter((h) => h.currency === 'PLN');
	const stockValue = pln.filter((h) => h.kind === 'stock').reduce((s, h) => s + h.value, 0);
	const bondValue = pln.filter((h) => h.kind === 'bond').reduce((s, h) => s + h.value, 0);
	const invested = stockValue + bondValue;

	// Weighted average coupon of the bonds actually held, so the bond leg starts honest.
	const bondPrincipal = pln.filter((h) => h.isBond).reduce((s, h) => s + h.cost, 0);
	const weightedCoupon = bondPrincipal
		? pln.filter((h) => h.isBond).reduce((s, h) => s + (h.coupon_rate ?? 0) * h.cost, 0) /
			bondPrincipal
		: 0.05;

	// Runway is about cash you can actually spend: imported bank accounts, plus any
	// manual account you flagged as cash (another bank you don't export from).
	// Brokerages and holdings are excluded — you can't spend them this month.
	const liquid =
		bankBalances()
			.filter((b) => b.currency === 'PLN')
			.reduce((s, b) => s + b.balance, 0) +
		manualBalances()
			.filter((m) => m.currency === 'PLN' && m.is_cash)
			.reduce((s, m) => s + m.value, 0);

	return {
		start: netWorth().total,
		liquid,
		monthlyExpenses: months.length ? t.expenses / months.length : 0,
		withdrawalRate: 0.04,
		monthlyIncome: months.length ? t.income / months.length : 0,
		savingsRate: t.savingsRate,
		stockReturn: 0.07,
		bondReturn: weightedCoupon,
		// Default to the mix actually held; 60/40 is only a fallback for an empty portfolio.
		stockAllocation: invested ? stockValue / invested : 0.6,
		incomeGrowth: 0,
		years: 20,
		monthsOfHistory: months.length
	};
}

/** Anything the PLN figures deliberately leave out, so the UI can say so. */
export function excluded() {
	return all<{ currency: string; n: number }>(
		`SELECT currency, COUNT(*) n FROM tx WHERE currency <> 'PLN' GROUP BY currency`
	);
}
