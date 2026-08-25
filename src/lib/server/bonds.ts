/**
 * Bond accrual projection.
 *
 * ponytail: everything is on month granularity — a period is credited on a month
 * boundary, never on an exact day count. Real day-count conventions (ACT/365 etc.)
 * shift a coupon by a few złoty; swap monthIndex() for a day-count if that matters.
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
 * One row per interest credit, from the purchase month to maturity.
 * `balance` is principal + capitalised interest after that credit.
 */
export function accruals(b: Bond): Accrual[] {
	const principal = b.qty * b.buy_price;
	const perYear = PERIODS[b.compound_freq] ?? 1;
	const step = 12 / perYear;
	const ratePerPeriod = b.coupon_rate / perYear;

	const start = monthIndex(b.buy_date);
	const end = monthIndex(b.maturity);
	if (!(end > start) || !(principal > 0)) return [];

	const out: Accrual[] = [];
	let balance = principal;

	for (let m = start + step; ; m += step) {
		// A final stub shorter than a full period still accrues, pro-rata by months.
		const capped = Math.min(m, end);
		const fraction = (capped - (m - step)) / step;
		const interest = balance * ratePerPeriod * fraction;

		if (b.capitalize) balance += interest;
		out.push({ month: monthLabel(capped), interest, balance });

		if (capped >= end) break;
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
	perMonthNet: number[];
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
		perMonthNet: perMonth.map((v) => v * (1 - BELKA)),
		cumulativeNet: cumulative.map((v) => v * (1 - BELKA)),
		byBond: rows.map((r) => ({
			id: r.b.id,
			label: r.b.ticker || r.b.name,
			data: months.map((m) => r.acc.filter((a) => a.month === m).reduce((t, a) => t + a.interest, 0))
		}))
	};
}
