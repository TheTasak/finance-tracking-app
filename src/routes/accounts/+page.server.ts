import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { all, db, run, tx } from '$lib/server/db';
import { monthsCovered } from '$lib/server/stats';

/** Months to show in the snapshot grid: everything with data, plus the 12 most recent. */
function gridMonths(): string[] {
	const seen = new Set([
		...monthsCovered(),
		...all<{ month: string }>(`SELECT DISTINCT month FROM snapshot`).map((r) => r.month)
	]);
	const now = new Date();
	for (let i = 0; i < 12; i++) {
		const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
		seen.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
	}
	return [...seen].sort();
}

export const load: PageServerLoad = () => {
	const months = gridMonths();
	const snaps = all<{ account_id: number; month: string; value: number }>(`SELECT * FROM snapshot`);
	const values: Record<string, number> = {};
	for (const s of snaps) values[`${s.account_id}|${s.month}`] = s.value;

	return {
		months,
		values,
		accounts: all(`SELECT * FROM account ORDER BY kind DESC, label`),
		latestBalance: Object.fromEntries(
			all<{ iban: string; balance: number; date: string }>(
				`SELECT account iban, balance, date FROM tx t WHERE rowid = (
					SELECT rowid FROM tx WHERE account = t.account ORDER BY date DESC, seq ASC LIMIT 1
				 )`
			).map((r) => [r.iban, r])
		)
	};
};

export const actions: Actions = {
	addAccount: async ({ request }) => {
		const f = await request.formData();
		const label = String(f.get('label') ?? '').trim();
		if (!label) return fail(400, { error: 'Name is required.' });
		run(
			`INSERT INTO account (iban, label, kind, currency, in_net_worth, is_cash)
			 VALUES (NULL, :label, 'manual', :currency, 1, :isCash)`,
			{
				label,
				currency: String(f.get('currency') || 'PLN'),
				isCash: f.get('is_cash') ? 1 : 0
			}
		);
		return { ok: true };
	},

	updateAccount: async ({ request }) => {
		const f = await request.formData();
		const label = String(f.get('label') ?? '').trim();
		if (!label) return fail(400, { error: 'Name is required.' });
		run(
			`UPDATE account SET label = :label, in_net_worth = :inNw, is_cash = :isCash WHERE id = :id`,
			{
				id: Number(f.get('id')),
				label,
				inNw: f.get('in_net_worth') ? 1 : 0,
				isCash: f.get('is_cash') ? 1 : 0
			}
		);
		return { ok: true };
	},

	deleteAccount: async ({ request }) => {
		const f = await request.formData();
		const id = Number(f.get('id'));
		tx(() => {
			run(`DELETE FROM snapshot WHERE account_id = :id`, { id });
			run(`DELETE FROM account WHERE id = :id AND kind = 'manual'`, { id });
		});
		return { ok: true };
	},

	/** Saves the whole snapshot grid in one submit; a blank cell clears that month. */
	saveSnapshots: async ({ request }) => {
		const f = await request.formData();
		const upsert = db.prepare(
			`INSERT OR REPLACE INTO snapshot (account_id, month, value) VALUES (:id, :month, :value)`
		);
		const del = db.prepare(`DELETE FROM snapshot WHERE account_id = :id AND month = :month`);

		// Validate everything before writing, so one typo doesn't half-save the grid.
		const writes: { id: number; month: string; value: number | null }[] = [];
		for (const [key, raw] of f.entries()) {
			const m = key.match(/^s\|(\d+)\|(\d{4}-\d{2})$/);
			if (!m) continue;
			const text = String(raw).trim().replace(/\s/g, '').replace(',', '.');
			if (!text) {
				writes.push({ id: Number(m[1]), month: m[2], value: null });
				continue;
			}
			const value = Number(text);
			if (!Number.isFinite(value)) return fail(400, { error: `"${raw}" (${m[2]}) is not a number.` });
			writes.push({ id: Number(m[1]), month: m[2], value });
		}

		tx(() => {
			for (const w of writes) {
				if (w.value === null) del.run({ id: w.id, month: w.month });
				else upsert.run(w);
			}
		});
		return { ok: true, saved: writes.filter((w) => w.value !== null).length };
	}
};
