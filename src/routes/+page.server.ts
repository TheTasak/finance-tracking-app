import type { PageServerLoad } from './$types';
import * as stats from '$lib/server/stats';
import { get } from '$lib/server/db';

/** The rows a named period covers, dated from the newest transaction, not the wall clock. */
function period(name: string, months: string[]): stats.Slice {
	const last = months.at(-1);
	if (!last || name === 'all') return stats.ALL_TIME;
	if (name === 'month') return stats.between(`${last}-01`, `${last}-31`);
	return stats.between(`${months.at(-3) ?? months[0]}-01`, `${last}-31`);
}

export const load: PageServerLoad = ({ url }) => {
	const months = stats.monthsCovered();
	const name = url.searchParams.get('period') ?? 'all';
	const p = period(name, months);

	const holdings = get<{ n: number }>(`SELECT COUNT(*) n FROM holding`)!.n;
	const snapshots = get<{ n: number }>(`SELECT COUNT(*) n FROM snapshot`)!.n;

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
