/**
 * Bond accrual projection.
 *
 * Interest is earned every month and *capitalised* on the period boundary — the two are
 * not the same event. Crediting a whole coupon on its anniversary instead would leave a
 * yearly bond showing no interest for eleven months and a spike on the twelfth.
 *
 * ponytail: everything is on month granularity — a month is a twelfth of a year, never
 * an exact day count. Real day-count conventions (ACT/365 etc.) shift a coupon by a few
 * złoty; swap monthIndex() for a day-count if that matters.
 */

export const BELKA = 0.19; // PL flat tax on interest income

export type Bond = {
	id: number;
	ticker: string;
	name: string;
	qty: number;
	buy_price: number;
	buy_date: string;
	coupon_rate: number; // annual nominal, as a decimal (0.05 = 5%)
	maturity: string;
	compound_freq: 'monthly' | 'quarterly' | 'annual';
	capitalize: number; // 1 = interest joins the principal, 0 = paid out as cash
	currency: string;
};

export const PERIODS: Record<Bond['compound_freq'], number> = {
	monthly: 12,
	quarterly: 4,
	annual: 1
};

/** Months since year 0, so month arithmetic never touches Date. */
const monthIndex = (isoDate: string) => {
	const [y, m] = isoDate.split('-').map(Number);
	return y * 12 + (m - 1);
};

const monthLabel = (idx: number) =>
	`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;

export type Accrual = { month: string; interest: number; balance: number };

/**
 * One row per month, from the month after purchase to maturity. `interest` is what that
 * month earned; `balance` is what the holding is worth at the end of it — capitalised
 * principal plus whatever has accrued since the last capitalisation.
 */
export function accruals(b: Bond): Accrual[] {
	const principal = b.qty * b.buy_price;
	const perYear = PERIODS[b.compound_freq] ?? 1;
	const step = 12 / perYear; // months between capitalisations

	const start = monthIndex(b.buy_date);
	const end = monthIndex(b.maturity);
	if (!(end > start) || !(principal > 0)) return [];

	const out: Accrual[] = [];
	let base = principal; // what interest is reckoned on
	let pending = 0; // earned since the last capitalisation

	for (let m = start + 1; m <= end; m++) {
		// Simple within the period, compounded at its end: a period's monthly slices add
		// up to exactly its coupon on `base`, so a short final stub needs no pro-rating —
		// it simply has fewer months in it.
		const interest = (base * b.coupon_rate) / 12;
		pending += interest;

		if ((m - start) % step === 0 || m === end) {
			if (b.capitalize) base += pending;
			pending = 0;
		}
		// A payout bond's interest leaves the bond, so only a capitalising one is worth
		// more than par between capitalisations.
		out.push({ month: monthLabel(m), interest, balance: base + (b.capitalize ? pending : 0) });
	}
	return out;
}

/** Principal + interest accrued up to and including `month` (YYYY-MM). */
export function valueAt(b: Bond, month: string): number {
	const principal = b.qty * b.buy_price;
	const rows = accruals(b).filter((a) => a.month <= month);
	if (!rows.length) return principal;
	const last = rows[rows.length - 1];
	// Non-capitalising bonds pay interest out, so the holding itself stays at par.
	return b.capitalize ? last.balance : principal;
}

/** Interest credited so far, whether it was capitalised or paid out. */
export function interestTo(b: Bond, month: string): number {
	return accruals(b)
		.filter((a) => a.month <= month)
		.reduce((s, a) => s + a.interest, 0);
}

export function totalInterest(b: Bond): number {
	return accruals(b).reduce((s, a) => s + a.interest, 0);
}

export type Projection = {
	months: string[];
	perMonth: number[];
	cumulative: number[];
	cumulativeNet: number[];
	byBond: { id: number; label: string; data: number[] }[];
};

/** Aggregate every bond's future interest onto one monthly timeline. */
export function project(bonds: Bond[]): Projection {
	const rows = bonds.map((b) => ({ b, acc: accruals(b) }));
	const months = [...new Set(rows.flatMap((r) => r.acc.map((a) => a.month)))].sort();

	const perMonth = months.map((m) =>
		rows.reduce(
			(s, r) => s + r.acc.filter((a) => a.month === m).reduce((t, a) => t + a.interest, 0),
			0
		)
	);

	let run = 0;
	const cumulative = perMonth.map((v) => (run += v));

	return {
		months,
		perMonth,
		cumulative,
		cumulativeNet: cumulative.map((v) => v * (1 - BELKA)),
		byBond: rows.map((r) => ({
			id: r.b.id,
			label: r.b.ticker || r.b.name,
			data: months.map((m) => r.acc.filter((a) => a.month === m).reduce((t, a) => t + a.interest, 0))
		}))
	};
}
