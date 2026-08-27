const fmt = (currency: string, opts: Intl.NumberFormatOptions = {}) =>
	new Intl.NumberFormat('pl-PL', { style: 'currency', currency, ...opts });

/**
 * Brokerage imports bring in non-PLN positions, and printing a USD figure with "zł"
 * is worse than not showing it at all.
 */
export const moneyIn = (n: number, currency = 'PLN') => fmt(currency).format(n ?? 0);
export const signedIn = (n: number, currency = 'PLN') => (n > 0 ? '+' : '') + moneyIn(n, currency);
/** Share prices carry four decimals — 24,4363 rounded to 24,44 is a different price. */
export const priceIn = (n: number, currency = 'PLN') =>
	fmt(currency, { maximumFractionDigits: 4 }).format(n ?? 0);

export const money = (n: number) => moneyIn(n);
export const signed = (n: number) => signedIn(n);
export const percent = (n: number) =>
	new Intl.NumberFormat('pl-PL', { style: 'percent', maximumFractionDigits: 1 }).format(n ?? 0);

/**
 * PLN per unit, from the very rates the server converted its own totals with, so a total
 * added up in the browser matches one added up there. 0 for a currency with no rate at
 * all — which is exactly how the server drops it, and `excluded()` reports it.
 */
export const rateFor = (rates: { currency: string; rate: number }[]) => (currency: string) =>
	currency === 'PLN' ? 1 : (rates.find((r) => r.currency === currency)?.rate ?? 0);

export const CATEGORIES = [
	'Salary',
	'Interest',
	'Groceries',
	'Eating out',
	'Sport',
	'Education',
	'Transport',
	'Bills',
	'Entertainment',
	'Health',
	'Travel',
	'Work/Office',
	'Tax',
	'Fees',
	'Transfer',
	'Uncategorised'
];
