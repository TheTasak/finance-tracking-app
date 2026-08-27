import type { Actions, PageServerLoad } from './$types';
import { all, get, run } from '$lib/server/db';
import { CONVERTIBLE, PLN, REAL } from '$lib/server/stats';
import { recategorizeAll, uncategorisedMerchants } from '$lib/server/categorize';
import { fail } from '@sveltejs/kit';

const PAGE = 100;

export const load: PageServerLoad = ({ url }) => {
	const q = url.searchParams;
	const filters = {
		from: q.get('from') || '',
		to: q.get('to') || '',
		account: q.get('account') || '',
		category: q.get('category') || '',
		search: q.get('search') || ''
	};

	const where: string[] = [];
	const p: Record<string, string | number> = {};
	if (filters.from) (where.push('date >= :from'), (p.from = filters.from));
	if (filters.to) (where.push('date <= :to'), (p.to = filters.to));
	if (filters.account) (where.push('account = :account'), (p.account = filters.account));
	if (filters.category) (where.push('category = :category'), (p.category = filters.category));
	if (filters.search) {
		where.push('(description LIKE :s OR counterparty LIKE :s OR type LIKE :s)');
		p.s = `%${filters.search}%`;
	}
	const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	// Every figure on the Dashboard tab is the same filter as the history table, minus
	// own-account transfers — the same rule the main dashboard totals use.
	const realSql = `${sql ? `${sql} AND` : 'WHERE'} ${REAL}`;

	const total = all<{ n: number }>(`SELECT COUNT(*) n FROM tx ${sql}`, p)[0].n;
	// A stale or hand-edited offset past the end lands on the last page, not an empty table.
	const lastOffset = Math.max(0, Math.ceil(total / PAGE) - 1) * PAGE;
	const offset = Math.min(Math.max(0, Number(q.get('offset') || 0)), lastOffset);

	return {
		// The tab lives in the URL so the GET filter form below can carry it through a reload.
		tab: q.get('tab') || 'dashboard',
		filters,
		offset,
		pageSize: PAGE,
		total,
		sum: all<{ s: number }>(`SELECT COALESCE(SUM(${PLN}),0) s FROM tx ${realSql}`, p)[0].s,
		summary: get<{ income: number; expenses: number; n: number }>(
			`SELECT
				COALESCE(SUM(CASE WHEN amount > 0 THEN ${PLN} END), 0) income,
				COALESCE(-SUM(CASE WHEN amount < 0 THEN ${PLN} END), 0) expenses,
				COUNT(*) n
			 FROM tx ${realSql}`,
			p
		)!,
		monthly: all<{ month: string; income: number; expenses: number }>(
			`SELECT substr(date,1,7) month,
				COALESCE(SUM(CASE WHEN amount > 0 THEN ${PLN} END), 0) income,
				COALESCE(-SUM(CASE WHEN amount < 0 THEN ${PLN} END), 0) expenses
			 FROM tx ${realSql} GROUP BY month ORDER BY month`,
			p
		),
		byCategory: all<{ category: string; total: number }>(
			`SELECT COALESCE(category,'Uncategorised') category, -SUM(${PLN}) total
			 FROM tx ${realSql} AND ${CONVERTIBLE} AND amount < 0
			 GROUP BY category ORDER BY total DESC`,
			p
		),
		rows: all(
			`SELECT * FROM tx ${sql} ORDER BY date DESC, seq ASC LIMIT ${PAGE} OFFSET ${offset}`,
			p
		),
		accounts: all(`SELECT iban, label FROM account WHERE iban IS NOT NULL ORDER BY label`),
		categories: all<{ category: string }>(
			`SELECT DISTINCT category FROM tx WHERE category IS NOT NULL ORDER BY category`
		).map((r) => r.category),
		rules: all(`SELECT * FROM rule ORDER BY id`),
		uncategorised: uncategorisedMerchants()
	};
};

export const actions: Actions = {
	setCategory: async ({ request }) => {
		const f = await request.formData();
		const id = String(f.get('id') ?? '');
		const category = String(f.get('category') ?? '').trim();
		if (!id || !category) return fail(400, { error: 'id and category required' });
		run(`UPDATE tx SET category = :category WHERE id = :id`, { id, category });
		return { ok: true };
	},

	addRule: async ({ request }) => {
		const f = await request.formData();
		const pattern = String(f.get('pattern') ?? '').trim();
		const category = String(f.get('category') ?? '').trim();
		if (!pattern || !category) return fail(400, { error: 'pattern and category required' });
		run(`INSERT INTO rule (pattern, category) VALUES (:pattern, :category)`, { pattern, category });
		return { ok: true, recategorized: recategorizeAll() };
	},

	deleteRule: async ({ request }) => {
		const f = await request.formData();
		run(`DELETE FROM rule WHERE id = :id`, { id: Number(f.get('id')) });
		return { ok: true, recategorized: recategorizeAll() };
	}
};
