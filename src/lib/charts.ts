/**
 * Chart.js theme and the configs more than one page draws. The palette mirrors
 * app.css's custom properties — Chart.js renders to a canvas, so it cannot read them.
 */
export const grid = { color: '#262b36' };
export const ticks = { color: '#8b93a7' };
export const legend = { labels: { color: '#8b93a7' } };
const axes = { x: { grid, ticks }, y: { grid, ticks } };

/** Stable colours so a category keeps its slice colour between renders. */
export const colorFor = (s: string, alpha = 1) => {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
	// Comma syntax: Chart.js' colour parser doesn't read the `hsl(h s l / a)` slash form.
	return `hsla(${h}, 62%, 55%, ${alpha})`;
};

/** Income against expenses, month by month. Drawn on the dashboard and on /transactions. */
export const incomeExpenseBars = (
	monthly: { month: string; income: number; expenses: number }[]
) => ({
	type: 'bar' as const,
	data: {
		labels: monthly.map((m) => m.month),
		datasets: [
			{ label: 'Income', data: monthly.map((m) => m.income), backgroundColor: '#4ade80' },
			{ label: 'Expenses', data: monthly.map((m) => m.expenses), backgroundColor: '#f87171' }
		]
	},
	options: { maintainAspectRatio: false, scales: axes, plugins: { legend } }
});

/** Spending split by category. Drawn on the dashboard and on /transactions. */
export const spendingDoughnut = (byCategory: { category: string; total: number }[]) => ({
	type: 'doughnut' as const,
	data: {
		labels: byCategory.map((c) => c.category),
		datasets: [
			{
				data: byCategory.map((c) => c.total),
				backgroundColor: byCategory.map((c) => colorFor(c.category)),
				borderColor: '#171a21'
			}
		]
	},
	options: {
		maintainAspectRatio: false,
		plugins: { legend: { position: 'right' as const, labels: legend.labels } }
	}
});
