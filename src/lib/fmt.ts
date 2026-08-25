const pln = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });
const pct = new Intl.NumberFormat('pl-PL', { style: 'percent', maximumFractionDigits: 1 });

export const money = (n: number) => pln.format(n ?? 0);
export const percent = (n: number) => pct.format(n ?? 0);
export const signed = (n: number) => (n > 0 ? '+' : '') + money(n);

export const CATEGORIES = [
	'Salary',
	'Interest',
	'Groceries',
	'Eating out',
	'Transport',
	'Entertainment',
	'Health',
	'Travel',
	'Work/Office',
	'Tax',
	'Fees',
	'Transfer',
	'Uncategorised'
];

/** Stable colours so a category keeps its slice colour between renders. */
export const colorFor = (s: string) => {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
	return `hsl(${h} 62% 55%)`;
};
