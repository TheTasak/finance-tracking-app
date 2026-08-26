import { all, get } from './db.ts';
import { type Bond, interestTo, project, totalInterest, valueAt } from './bonds.ts';
import { brokerCash, cashBalances, fxRates } from './trades.ts';

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

/** Expenses per month per category, for the stacked bar on the dashboard. */
export function monthlyByCategory() {
	return all<{ month: string; category: string; total: number }>(
		`SELECT substr(date,1,7) month, COALESCE(category,'Uncategorised') category, -SUM(amount) total
		 FROM tx WHERE ${REAL} AND amount < 0
		 GROUP BY month, category ORDER BY month, total DESC`
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
 * PLN only. Brokerage imports bring in USD positions and the app does no FX, so adding
 * them at 1:1 would quietly inflate net worth. `excluded()` reports what is left out.
 */
export function investmentTotals() {
	const hs = holdings().filter((h) => h.currency === 'PLN');
	const cost = hs.reduce((s, h) => s + h.cost, 0);
	const value = hs.reduce((s, h) => s + h.value, 0);
	return { cost, value, pl: value - cost, plPct: cost ? (value - cost) / cost : 0 };
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

/** Average-cost basis of the open broker positions at each month end, PLN only. */
function stockCostByMonth() {
	// ponytail: average cost, not FIFO — this only feeds a chart. Positions are held at
	// cost throughout because there is no price history to value them with.
	const pos = new Map<string, { qty: number; cost: number }>();
	const out = new Map<string, number>();
	for (const t of all<{ date: string; isin: string; side: string; qty: number; net: number }>(
		`SELECT date, time, isin, side, qty, net FROM trade WHERE currency = 'PLN'
		 ORDER BY date ASC, time ASC, seq ASC`
	)) {
		const p = pos.get(t.isin) ?? { qty: 0, cost: 0 };
		if (t.side === 'K') {
			p.qty += t.qty;
			p.cost += t.net;
		} else {
			const avg = p.qty ? p.cost / p.qty : 0;
			p.qty -= t.qty;
			p.cost = Math.max(0, p.cost - avg * t.qty);
		}
		pos.set(t.isin, p);
		out.set(t.date.slice(0, 7), [...pos.values()].reduce((s, x) => s + x.cost, 0));
	}
	return out;
}

/**
 * Net worth per month, split by where the money sits: one series per bank and manual
 * account, plus brokerage cash, broker stocks at cost and bonds accrued to that month.
 * Point-in-time sources are carried forward over months with no data so nothing dips
 * to zero on a gap.
 */
export function netWorthSeries() {
	const months = monthsCovered();

	const bank = all<{ label: string; month: string; balance: number }>(
		`SELECT a.label, substr(t.date,1,7) month, t.balance FROM tx t
		 JOIN account a ON a.iban = t.account
		 WHERE t.currency = 'PLN' AND a.in_net_worth = 1 AND t.rowid = (
			SELECT rowid FROM tx WHERE account = t.account AND substr(date,1,7) = substr(t.date,1,7)
			ORDER BY date DESC, seq ASC LIMIT 1
		 )`
	);
	const manual = all<{ label: string; month: string; value: number }>(
		`SELECT a.label, s.month, s.value FROM snapshot s
		 JOIN account a ON a.id = s.account_id
		 WHERE a.in_net_worth = 1 AND a.currency = 'PLN'`
	);
	const cash = all<{ month: string; total: number }>(
		`SELECT substr(date,1,7) month, SUM(amount) total FROM cashop
		 WHERE currency = 'PLN' GROUP BY month ORDER BY month`
	);

	const hs = holdings().filter((h) => h.currency === 'PLN');
	const bondsHeld = hs.filter((h) => h.kind === 'bond');
	const ownStocks = hs.filter((h) => h.kind !== 'bond' && h.source !== 'broker');
	const stockCost = stockCostByMonth();
	const boughtIn = (h: { buy_date: string }) => (h.buy_date ?? '').slice(0, 7);

	// Manual snapshots and holdings can predate or postdate the transaction history.
	const allMonths = [
		...new Set([
			...months,
			...manual.map((m) => m.month),
			...cash.map((c) => c.month),
			...stockCost.keys(),
			...[...bondsHeld, ...ownStocks].map(boughtIn)
		])
	]
		.filter(Boolean)
		.sort();
	if (!allMonths.length) return { months: [], sources: [] };

	const sparse = new Map<string, Map<string, number>>();
	const point = (label: string, month: string, value: number) => {
		let m = sparse.get(label);
		if (!m) sparse.set(label, (m = new Map()));
		m.set(month, value);
	};
	for (const b of bank) point(b.label, b.month, b.balance);
	for (const m of manual) point(m.label, m.month, m.value);
	// The broker's ledger has no balance column, so cash is a running sum over it.
	let running = 0;
	for (const c of cash) point('Brokerage cash', c.month, (running += c.total));
	for (const [month, cost] of stockCost) point('Stocks (at cost)', month, cost);

	const sources = [...sparse].map(([label, known]) => {
		let last = 0;
		return { label, values: allMonths.map((m) => (last = known.get(m) ?? last)) };
	});

	// A bond's worth in any month is arithmetic, so it needs no carry-forward.
	const held = (list: typeof hs, at: (h: (typeof hs)[number], month: string) => number) => (month: string) =>
		list.reduce((s, h) => (boughtIn(h) > month ? s : s + at(h, month)), 0);
	if (bondsHeld.length)
		sources.push({
			label: 'Bonds',
			values: allMonths.map(
				held(bondsHeld, (h, month) =>
					isBond(h) ? valueAt(h as unknown as Bond, month) : h.qty * h.buy_price
				)
			)
		});
	if (ownStocks.length)
		sources.push({
			label: 'Own holdings (at cost)',
			values: allMonths.map(held(ownStocks, (h) => h.qty * h.buy_price))
		});

	return { months: allMonths, sources };
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

export type Excluded = {
	currency: string;
	/** Bank rows in this currency, counted rather than summed — they carry no balance. */
	txns: number;
	holdings: number;
	cash: number;
	/** The rate the user last converted at, for reading only. 0 when unknown. */
	rate: number;
	rateAt: string;
};

/**
 * Everything the PLN figures deliberately leave out, per currency, so every page tells
 * the same story. The app does no FX: a USD position added at 1:1 would quietly inflate
 * net worth, so it is reported here instead of being counted anywhere.
 */
export function excluded(): Excluded[] {
	const rates = new Map(fxRates().map((f) => [f.pair.split('/')[1], f]));
	const per = new Map<string, Excluded>();
	const row = (currency: string) => {
		let r = per.get(currency);
		if (!r) {
			const fx = rates.get(currency);
			per.set(
				currency,
				(r = {
					currency,
					txns: 0,
					holdings: 0,
					cash: 0,
					rate: fx?.rate ?? 0,
					rateAt: fx?.date ?? ''
				})
			);
		}
		return r;
	};

	for (const t of all<{ currency: string; n: number }>(
		`SELECT currency, COUNT(*) n FROM tx WHERE currency <> 'PLN' GROUP BY currency`
	))
		row(t.currency).txns = t.n;
	for (const h of holdings()) if (h.currency !== 'PLN') row(h.currency).holdings += h.value;
	for (const c of cashBalances()) if (c.currency !== 'PLN') row(c.currency).cash = c.balance;

	return [...per.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
