import { all, get } from './db.ts';
import { type Bond, interestTo, project, totalInterest, valueAt } from './bonds.ts';
import { brokerCash, cashBalances, fxRates } from './trades.ts';
import { type Fx, fx, latestRates, monthEndCloses } from './prices.ts';

/** Every income/expense figure excludes own-account transfers. */
const REAL = `transfer = 0`;

/**
 * A row's amount in PLN: itself when already PLN, otherwise converted at the last rate
 * quoted on or before its own date — so a 2025 purchase in euro is worth what it cost
 * you in 2025, not what it would cost today.
 *
 * A currency with no rate at all yields NULL, and SUM skips NULLs, so such a row drops
 * out of the totals instead of being counted at 1:1. `excluded()` reports what fell out.
 */
const PLN = `(amount * CASE WHEN tx.currency = 'PLN' THEN 1 ELSE (
	SELECT close FROM price
	WHERE symbol = tx.currency || 'PLN=X' AND date <= tx.date
	ORDER BY date DESC LIMIT 1
) END)`;

/**
 * A row we can actually put a PLN figure on. Needed wherever rows are GROUPed: a group
 * whose amounts are all unconvertible still forms, and would surface as a category with
 * an empty total rather than not appearing at all.
 */
const CONVERTIBLE = `${PLN} IS NOT NULL`;

export type Period = { from: string; to: string };

export const ALL_TIME: Period = { from: '0000-01-01', to: '9999-12-31' };

export function monthsCovered(): string[] {
	return all<{ m: string }>(`SELECT DISTINCT substr(date,1,7) m FROM tx ORDER BY m`).map((r) => r.m);
}

export function totals(p: Period) {
	const r = get<{ income: number; expenses: number }>(
		`SELECT
			COALESCE(SUM(CASE WHEN amount > 0 THEN ${PLN} END), 0) income,
			COALESCE(-SUM(CASE WHEN amount < 0 THEN ${PLN} END), 0) expenses
		 FROM tx WHERE ${REAL} AND date BETWEEN :from AND :to`,
		p
	)!;
	const saved = r.income - r.expenses;
	return { ...r, saved, savingsRate: r.income > 0 ? saved / r.income : 0 };
}

export function monthly() {
	return all<{ month: string; income: number; expenses: number }>(
		`SELECT substr(date,1,7) month,
			COALESCE(SUM(CASE WHEN amount > 0 THEN ${PLN} END), 0) income,
			COALESCE(-SUM(CASE WHEN amount < 0 THEN ${PLN} END), 0) expenses
		 FROM tx WHERE ${REAL} GROUP BY month ORDER BY month`
	).map((r) => ({ ...r, saved: r.income - r.expenses }));
}

export function byCategory(p: Period) {
	return all<{ category: string; total: number }>(
		`SELECT COALESCE(category,'Uncategorised') category, -SUM(${PLN}) total
		 FROM tx WHERE ${REAL} AND ${CONVERTIBLE} AND amount < 0 AND date BETWEEN :from AND :to
		 GROUP BY category ORDER BY total DESC`,
		p
	);
}

/** Expenses per month per category, for the stacked bar on the dashboard. */
export function monthlyByCategory() {
	return all<{ month: string; category: string; total: number }>(
		`SELECT substr(date,1,7) month, COALESCE(category,'Uncategorised') category, -SUM(${PLN}) total
		 FROM tx WHERE ${REAL} AND ${CONVERTIBLE} AND amount < 0
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
	/** Yahoo ticker to price this holding from, e.g. 'CDR.WA' or 'AAPL'. Blank = untracked. */
	symbol: string | null;
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
 * Everything you hold, in PLN. Foreign positions convert at today's rate; a currency we
 * have no rate for is left out and reported by `excluded()` rather than added at 1:1.
 */
export function investmentTotals() {
	const rates = fx();
	let cost = 0;
	let value = 0;
	for (const h of holdings()) {
		const r = rates.now(h.currency);
		if (r === undefined) continue;
		cost += h.cost * r;
		value += h.value * r;
	}
	return { cost, value, pl: value - cost, plPct: cost ? (value - cost) / cost : 0 };
}

export function netWorth() {
	const rates = fx();
	const inv = investmentTotals();
	// A balance is worth what it converts to today, whatever date it was struck.
	const conv = <T extends { currency: string }>(rows: T[]) =>
		rows.flatMap((r) => {
			const rate = rates.now(r.currency);
			return rate === undefined ? [] : [{ row: r, rate }];
		});

	const cash = cashBalances().reduce(
		(s, c) => s + c.balance * (rates.now(c.currency) ?? 0),
		0
	);
	const parts = [
		...conv(bankBalances()).map(({ row, rate }) => ({
			label: row.label,
			value: row.balance * rate,
			as_of: row.date
		})),
		...conv(manualBalances()).map(({ row, rate }) => ({
			label: row.label,
			value: row.value * rate,
			as_of: row.month
		})),
		// The broker's cash ledger has no balance column, so this is a running sum of
		// every operation imported — right only if the export starts at account opening.
		...(cash ? [{ label: 'Brokerage cash', value: cash, as_of: 'ledger' }] : []),
		...(inv.value ? [{ label: 'Investments', value: inv.value, as_of: 'now' }] : [])
	];
	return { parts, total: parts.reduce((s, p) => s + p.value, 0) };
}

/** Keyed by ISIN and currency: the same ISIN on two markets is two cost bases. */
type Lots = Map<string, { qty: number; cost: number; currency: string }>;

/**
 * The open broker position per ISIN after every month that traded. Months without a
 * trade are absent: the position is unchanged, but its market value is not, so the
 * caller carries the lots forward and re-prices them.
 *
 * Cost stays in the currency it was paid in — the caller converts, because which rate
 * applies depends on the month being drawn.
 */
function stockLotsByMonth(): Map<string, Lots> {
	// ponytail: average cost, not FIFO — this only feeds a chart, and cost is just the
	// fallback for months with no close.
	const pos: Lots = new Map();
	const out = new Map<string, Lots>();
	for (const t of all<{
		date: string;
		isin: string;
		side: string;
		qty: number;
		net: number;
		currency: string;
	}>(
		`SELECT date, time, isin, side, qty, net, currency FROM trade
		 ORDER BY date ASC, time ASC, seq ASC`
	)) {
		const key = `${t.isin}|${t.currency}`;
		const p = pos.get(key) ?? { qty: 0, cost: 0, currency: t.currency };
		if (t.side === 'K') {
			p.qty += t.qty;
			p.cost += t.net;
		} else {
			const avg = p.qty ? p.cost / p.qty : 0;
			p.qty -= t.qty;
			p.cost = Math.max(0, p.cost - avg * t.qty);
		}
		pos.set(key, p);
		// Snapshot, not a reference — `pos` keeps mutating as the walk goes on.
		out.set(t.date.slice(0, 7), new Map([...pos].map(([k, v]) => [k, { ...v }])));
	}
	return out;
}

/**
 * Net worth per month, split by where the money sits: one series per bank and manual
 * account, plus brokerage cash, stocks at their market close for that month (cost where
 * there is no close) and bonds accrued to it.
 * Point-in-time sources are carried forward over months with no data so nothing dips
 * to zero on a gap.
 */
export function netWorthSeries() {
	const months = monthsCovered();

	// Every currency is carried through and converted at the rate of the month being
	// drawn, so a past month reads as it did then rather than at today's rate.
	const rates = fx();
	const at = (currency: string, month: string) => rates.on(currency, month);

	const bank = all<{ label: string; month: string; balance: number; currency: string }>(
		// Last row of each account-currency-month, ranked in one pass rather than by a
		// correlated LIMIT 1 that re-scanned the account's history for every row of it.
		`SELECT label, month, balance, currency FROM (
			SELECT a.label, substr(t.date,1,7) month, t.balance, t.currency,
				ROW_NUMBER() OVER (
					PARTITION BY t.account, t.currency, substr(t.date,1,7)
					ORDER BY t.date DESC, t.seq ASC
				) rn
			FROM tx t JOIN account a ON a.iban = t.account
			WHERE a.in_net_worth = 1
		 ) WHERE rn = 1 ORDER BY label, month`
	);
	const manual = all<{ label: string; month: string; value: number; currency: string }>(
		`SELECT a.label, s.month, s.value, a.currency FROM snapshot s
		 JOIN account a ON a.id = s.account_id
		 WHERE a.in_net_worth = 1`
	);
	const cash = all<{ month: string; total: number; currency: string }>(
		`SELECT substr(date,1,7) month, SUM(amount) total, currency FROM cashop
		 GROUP BY month, currency ORDER BY month`
	);

	const hs = holdings().filter((h) => rates.known.has(h.currency));
	const bondsHeld = hs.filter((h) => h.kind === 'bond');
	const ownStocks = hs.filter((h) => h.kind !== 'bond' && h.source !== 'broker');
	const stockLots = stockLotsByMonth();
	const boughtIn = (h: { buy_date: string }) => (h.buy_date ?? '').slice(0, 7);

	// Closes, and the ticker each holding was tagged with. A position closed long ago has
	// no holding row left to carry a ticker, so it falls back to cost — as does any month
	// with no close.
	const closes = monthEndCloses();
	const symbolOf = new Map(
		all<{ isin: string; symbol: string }>(
			`SELECT isin, symbol FROM holding WHERE isin <> '' AND symbol IS NOT NULL AND symbol <> ''`
		).map((r) => [r.isin, r.symbol])
	);
	const closeAt = (symbol: string | undefined, month: string) =>
		symbol ? closes.get(symbol)?.get(month) : undefined;

	// Manual snapshots and holdings can predate or postdate the transaction history.
	const allMonths = [
		...new Set([
			...months,
			...manual.map((m) => m.month),
			...cash.map((c) => c.month),
			...stockLots.keys(),
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
	for (const b of bank) {
		const r = at(b.currency, b.month);
		if (r !== undefined) point(b.label, b.month, b.balance * r);
	}
	for (const m of manual) {
		const r = at(m.currency, m.month);
		if (r !== undefined) point(m.label, m.month, m.value * r);
	}
	// The broker's ledger has no balance column, so cash is a running sum over it. The
	// sum runs in each currency and is converted after, never the other way round: adding
	// USD and PLN first and converting the pile would be meaningless.
	const running = new Map<string, number>();
	for (const c of cash) {
		running.set(c.currency, (running.get(c.currency) ?? 0) + c.total);
		let total = 0;
		for (const [currency, balance] of running) total += balance * (at(currency, c.month) ?? 0);
		point('Brokerage cash', c.month, total);
	}
	// Broker stocks are re-priced every month, not just the ones that traded, so the
	// line moves with the market between trades. Lots carry forward; prices do not.
	let lots: Lots = new Map();
	for (const month of allMonths) {
		lots = stockLots.get(month) ?? lots;
		if (!lots.size) continue;
		let value = 0;
		for (const [key, p] of lots) {
			if (p.qty <= 1e-9) continue;
			const rate = at(p.currency, month);
			if (rate === undefined) continue;
			// The close is quoted in the listing's own currency, as is the cost it falls
			// back to, so the conversion is the same either way.
			const close = closeAt(symbolOf.get(key.split('|')[0]), month);
			value += (close === undefined ? p.cost : p.qty * close) * rate;
		}
		point('Stocks', month, value);
	}

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
				held(
					bondsHeld,
					(h, month) =>
						(isBond(h) ? valueAt(h as unknown as Bond, month) : h.qty * h.buy_price) *
						(at(h.currency, month) ?? 0)
				)
			)
		});
	if (ownStocks.length)
		sources.push({
			label: 'Own holdings',
			values: allMonths.map(
				held(
					ownStocks,
					(h, month) =>
						h.qty *
						(closeAt(h.symbol ?? undefined, month) ?? h.buy_price) *
						(at(h.currency, month) ?? 0)
				)
			)
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
	/** What one unit is worth in PLN, for reading only. 0 when unknown. */
	rate: number;
	rateAt: string;
	/** 'market' = today's Yahoo rate; 'own' = the rate you last converted at yourself. */
	rateSource: 'market' | 'own' | '';
	/** True once real rates exist, meaning these amounts are already inside the totals. */
	converted: boolean;
};

/**
 * Foreign money and what it converts to, per currency, so every page tells the same
 * story about it. Anything with a rate IS now counted in the totals — at the rate of the
 * month or day in question, not today's. A currency with no rate at all is still left
 * out entirely, and `converted` says which case you are looking at.
 */
export function excluded(): Excluded[] {
	// The market rate when we have one, otherwise the rate the user themself converted at.
	// Both are for reading only — no total on this page is ever FX-converted.
	const own = new Map(fxRates().map((f) => [f.pair.split('/')[1], f]));
	const market = new Map(latestRates().map((r) => [r.currency, r]));
	const convertible = fx().known;
	const per = new Map<string, Excluded>();
	const row = (currency: string) => {
		let r = per.get(currency);
		if (!r) {
			const live = market.get(currency);
			const mine = own.get(currency);
			const fx = live ?? mine;
			per.set(
				currency,
				(r = {
					currency,
					txns: 0,
					holdings: 0,
					cash: 0,
					rate: fx?.rate ?? 0,
					rateAt: fx?.date ?? '',
					rateSource: live ? 'market' : mine ? 'own' : '',
					// Only a real rate series feeds the totals; the user's own past
					// conversion is a reading aid, never arithmetic.
					converted: convertible.has(currency)
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
