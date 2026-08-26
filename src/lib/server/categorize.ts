import { all, db, get, run, tx } from './db.ts';

export const UNCATEGORISED = 'Uncategorised';

/** Seeded from the merchants actually present in the Millennium export. First match wins. */
const SEED: [string, string][] = [
	['TUTLO', 'Salary'],
	['KAPITALIZACJA', 'Interest'],
	['Odsetki premiowe', 'Interest'],
	['PODATEK OD ODSETEK', 'Tax'],
	['PROWIZJA', 'Fees'],
	['LIDL', 'Groceries'],
	['Carrefour', 'Groceries'],
	['AUCHAN', 'Groceries'],
	['Biedronka', 'Groceries'],
	['Żabka', 'Groceries'],
	['Piekarnia', 'Groceries'],
	['ZAKUP BILETU MIEJSKIEGO', 'Transport'],
	['MOBILE-TRAFFIC', 'Transport'],
	['KOLEO', 'Transport'],
	['Kolej', 'Transport'],
	['PATREON', 'Entertainment'],
	['HUMBLEBUNDL', 'Entertainment'],
	['VALVE', 'Entertainment'],
	['Gamefound', 'Entertainment'],
	['FANATICAL', 'Entertainment'],
	['APTEKA', 'Health'],
	['DOZ ', 'Health'],
	['Psychoterapia', 'Health'],
	['CitySpace', 'Work/Office'],
	['KFC', 'Eating out'],
	['KOFEINA', 'Eating out'],
	['WILD ROOTS', 'Eating out'],
	['Bezpieczna Przestrzen', 'Eating out'],
	['APARTHOTEL', 'Travel'],
	['BOOKING', 'Travel']
];

export function seedRules() {
	if (all(`SELECT 1 FROM rule LIMIT 1`).length) return;
	const ins = db.prepare(`INSERT INTO rule (pattern, category) VALUES (:pattern, :category)`);
	tx(() => {
		for (const [pattern, category] of SEED) ins.run({ pattern, category });
	});
}
seedRules();

type Rule = { id: number; pattern: string; category: string };
let cache: Rule[] | null = null;

const rules = () => (cache ??= all<Rule>(`SELECT * FROM rule ORDER BY id`));
const invalidateRules = () => (cache = null);

/**
 * Collapse a card description into something worth turning into a rule.
 * Millennium appends a settlement date, a city, a country code and a payment
 * reference to almost every card row — none of which identify the merchant.
 */
function merchantKey(description: string, counterparty: string, type = ''): string {
	const raw = (description || counterparty || type || '').trim();
	let s = raw
		.replace(/\s*\d{4}-\d{2}-\d{2}.*$/, '') // trailing settlement date
		// Any token carrying a digit is a reference, ticket, store or order number,
		// never the merchant — dropping them is what makes rows group at all.
		.split(/\s+/)
		.filter((w) => !/\d/.test(w))
		.join(' ')
		.replace(/\s+[A-Z]{3}$/, '') // country code: POL, GBR, USA, LUX
		.replace(/[\s.,*:;-]+$/, '')
		.trim();
	if (!s) s = raw.replace(/\s+/g, ' ').trim();
	return s.slice(0, 40) || '(no description)';
}

export function applyRules(description: string, counterparty: string, type = ''): string {
	const hay = `${description} ${counterparty} ${type}`.toLowerCase();
	return rules().find((r) => hay.includes(r.pattern.toLowerCase()))?.category ?? UNCATEGORISED;
}

/**
 * Spending that no rule matched, grouped by merchant and ranked by money.
 * Ranking by amount rather than count is deliberate: one 1 699 zł purchase
 * matters more than twenty 3 zł bus tickets.
 */
export function uncategorisedMerchants(limit = 25) {
	const rows = all<{ description: string; counterparty: string; type: string; amount: number }>(
		`SELECT description, counterparty, type, amount FROM tx
		 WHERE transfer = 0 AND currency = 'PLN' AND amount < 0
		   AND (category IS NULL OR category = :u)`,
		{ u: UNCATEGORISED }
	);

	const groups = new Map<string, { merchant: string; n: number; total: number }>();
	for (const r of rows) {
		const key = merchantKey(r.description, r.counterparty, r.type);
		const g = groups.get(key) ?? { merchant: key, n: 0, total: 0 };
		g.n++;
		g.total += -r.amount;
		groups.set(key, g);
	}

	const list = [...groups.values()].sort((a, b) => b.total - a.total);
	const total = list.reduce((s, g) => s + g.total, 0);
	const spend = get<{ s: number }>(
		`SELECT COALESCE(-SUM(amount),0) s FROM tx
		 WHERE transfer = 0 AND currency = 'PLN' AND amount < 0`
	)!.s;

	return {
		list: list.slice(0, limit),
		groups: list.length,
		shown: Math.min(limit, list.length),
		txns: rows.length,
		total,
		share: spend ? total / spend : 0
	};
}

/** Re-runs every rule over stored rows. Manual edits are lost by design — rules are the source of truth. */
export function recategorizeAll() {
	invalidateRules();
	const rows = all<{ id: string; description: string; counterparty: string; type: string }>(
		`SELECT id, description, counterparty, type FROM tx WHERE transfer = 0`
	);
	const upd = db.prepare(`UPDATE tx SET category = :category WHERE id = :id`);
	tx(() => {
		for (const r of rows)
			upd.run({ id: r.id, category: applyRules(r.description, r.counterparty, r.type) });
	});
	run(`UPDATE tx SET category = 'Transfer' WHERE transfer = 1`);
	return rows.length;
}
