import type { PageServerLoad } from './$types';
import * as stats from '$lib/server/stats';
import { all } from '$lib/server/db';

/** from/to for a named period, derived from the newest transaction rather than the wall clock. */
function period(name: string, months: string[]): stats.Period {
	const last = months.at(-1);
	if (!last || name === 'all') return stats.ALL_TIME;
	if (name === 'month') return { from: `${last}-01`, to: `${last}-31` };
	const from = months.at(-3) ?? months[0];
	return { from: `${from}-01`, to: `${last}-31` };
}

export const load: PageServerLoad = ({ url }) => {
	const months = stats.monthsCovered();
	const name = url.searchParams.get('period') ?? 'all';
	const p = period(name, months);

	const holdings = all<{ n: number }>(`SELECT COUNT(*) n FROM holding`)[0].n;
	const snapshots = all<{ n: number }>(`SELECT COUNT(*) n FROM snapshot`)[0].n;

	return {
		period: name,
		hasData: months.length > 0,
		totals: stats.totals(p),
		monthly: stats.monthly(),
		byCategory: stats.byCategory(p),
		monthlyByCategory: stats.monthlyByCategory(),
		netWorth: stats.netWorth(),
		netWorthSeries: stats.netWorthSeries(),
		investments: stats.investmentTotals(),
		excluded: stats.excluded(),
		doubleCountRisk: holdings > 0 && snapshots > 0
	};
};
