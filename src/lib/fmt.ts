const pln = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });
const pct = new Intl.NumberFormat('pl-PL', { style: 'percent', maximumFractionDigits: 1 });

export const money = (n: number) => pln.format(n ?? 0);
export const percent = (n: number) => pct.format(n ?? 0);
export const signed = (n: number) => (n > 0 ? '+' : '') + money(n);

// Brokerage imports bring in non-PLN positions, and printing a USD figure with "zł"
// is worse than not showing it at all. Formatters are cached — Intl is not cheap.
const byCurrency = new Map<string, Intl.NumberFormat>();
export const moneyIn = (n: number, currency = 'PLN') => {
	let f = byCurrency.get(currency);
	if (!f)
		byCurrency.set(
			currency,
			(f = new Intl.NumberFormat('pl-PL', { style: 'currency', currency }))
		);
	return f.format(n ?? 0);
};
export const signedIn = (n: number, currency = 'PLN') => (n > 0 ? '+' : '') + moneyIn(n, currency);

/** Share prices carry four decimals — 24,4363 rounded to 24,44 is a different price. */
const prices = new Map<string, Intl.NumberFormat>();
export const priceIn = (n: number, currency = 'PLN') => {
	let f = prices.get(currency);
	if (!f)
		prices.set(
			currency,
			(f = new Intl.NumberFormat('pl-PL', {
				style: 'currency',
				currency,
				minimumFractionDigits: 2,
				maximumFractionDigits: 4
			}))
		);
	return f.format(n ?? 0);
};

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
