/**
 * Whole-fortune projection: compound what you already have, add what you save
 * each month, and let the mix of stocks and bonds set the growth rate.
 *
 * ponytail: one blended rate over the whole pot — existing bonds are projected at
 * the blended rate rather than their own fixed schedule, and returns are smooth
 * rather than volatile. Good enough to compare scenarios; not a retirement plan.
 * For per-bucket accrual, split `wealth` into stock/bond/cash and grow each.
 */

export type Assumptions = {
	start: number; // net worth today
	monthlyIncome: number;
	savingsRate: number; // 0..1
	stockReturn: number; // annual, decimal
	bondReturn: number; // annual, decimal
	stockAllocation: number; // 0..1 of new money and existing pot
	incomeGrowth: number; // annual raise, decimal
	years: number;
};

export type Wealth = {
	months: string[];
	wealth: number[];
	contributed: number[]; // start + every złoty you actually paid in
	blended: number; // the effective annual rate
	final: number;
	totalContributed: number;
	totalGrowth: number;
};

export const addMonths = (month: string, n: number) => {
	const [y, m] = month.split('-').map(Number);
	const idx = y * 12 + (m - 1) + n;
	return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};

export function projectWealth(a: Assumptions, startMonth: string): Wealth {
	const n = Math.max(0, Math.round(a.years * 12));
	const blended = a.stockAllocation * a.stockReturn + (1 - a.stockAllocation) * a.bondReturn;
	const monthlyRate = blended / 12;

	let wealth = a.start;
	let contributed = a.start;
	let income = a.monthlyIncome;

	const months = [startMonth];
	const wealthSeries = [wealth];
	const contributedSeries = [contributed];

	for (let i = 1; i <= n; i++) {
		// Raise lands on each anniversary, so month 13 is the first raised month.
		if (i > 1 && (i - 1) % 12 === 0) income *= 1 + a.incomeGrowth;

		const deposit = income * a.savingsRate;
		wealth = wealth * (1 + monthlyRate) + deposit;
		contributed += deposit;

		months.push(addMonths(startMonth, i));
		wealthSeries.push(wealth);
		contributedSeries.push(contributed);
	}

	return {
		months,
		wealth: wealthSeries,
		contributed: contributedSeries,
		blended,
		final: wealth,
		totalContributed: contributed,
		totalGrowth: wealth - contributed
	};
}

/** Value at a whole number of years in, for the checkpoint cards. */
export const at = (w: Wealth, years: number) => w.wealth[Math.min(years * 12, w.wealth.length - 1)];

/**
 * The pot that sustains you indefinitely: annual spending divided by the rate you
 * withdraw each year. 4% is the usual rule of thumb, hence "25x annual expenses".
 */
export const fireNumber = (monthlyExpenses: number, withdrawalRate: number) =>
	withdrawalRate > 0 ? (monthlyExpenses * 12) / withdrawalRate : Infinity;

/** Months of expenses your cash covers with no income at all. */
export const runway = (liquid: number, monthlyExpenses: number) =>
	monthlyExpenses > 0 ? liquid / monthlyExpenses : Infinity;

/** First month the pot reaches `target`, or null if it never does. */
export function reaches(w: Wealth, target: number): string | null {
	const i = w.wealth.findIndex((v) => v >= target);
	return i < 0 ? null : w.months[i];
}
