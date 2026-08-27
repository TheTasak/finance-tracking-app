import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { importRows, parseMillennium } from '$lib/server/import';
import { decodeBossa, importCash, importTrades, parseBossa, parseCash } from '$lib/server/trades';
import { importTreasuryBonds, parseTreasuryXls } from '$lib/server/treasury';
import { all } from '$lib/server/db';

const MAX_BYTES = 20 * 1024 * 1024;

const span = (table: string, col = 'date', where = '1') =>
	all<{ n: number; from: string; to: string }>(
		`SELECT COUNT(*) n, MIN(${col}) "from", MAX(${col}) "to" FROM ${table} WHERE ${where}`
	)[0];

export const load: PageServerLoad = () => ({
	bank: span('tx'),
	trades: span('trade'),
	ops: span('cashop'),
	bonds: span('holding', 'buy_date', "source = 'treasury'")
});

/** Every upload shares the same size guard, error reporting and result shape. */
async function upload<T extends object>(request: Request, read: (f: File) => Promise<T>) {
	const file = (await request.formData()).get('csv');
	if (!(file instanceof File) || !file.size) return fail(400, { error: 'Choose a file.' });
	if (file.size > MAX_BYTES) return fail(400, { error: 'File larger than 20 MB.' });
	try {
		return { ...(await read(file)), name: file.name };
	} catch (e) {
		return fail(400, { error: e instanceof Error ? e.message : 'Could not parse that file.' });
	}
}

const nonEmpty = <T>(rows: T[]) => {
	if (!rows.length) throw new Error('No data rows in that file.');
	return rows;
};

// Bossa exports are Windows-1250, so they are read as bytes — f.text() mangles "ilość".
const bytes = async (f: File) => decodeBossa(await f.arrayBuffer());

export const actions: Actions = {
	bank: ({ request }) =>
		upload(request, async (f) => importRows(nonEmpty(parseMillennium(await f.text())))),

	bossa: ({ request }) =>
		upload(request, async (f) => ({
			...importTrades(nonEmpty(parseBossa(await bytes(f)))),
			kind: 'trades'
		})),

	cash: ({ request }) =>
		upload(request, async (f) => {
			const parsed = parseCash(await bytes(f));
			nonEmpty(parsed.ops);
			return { ...importCash(parsed), kind: 'ops' };
		}),

	bonds: ({ request }) =>
		upload(request, async (f) =>
			importTreasuryBonds(nonEmpty(parseTreasuryXls(await f.arrayBuffer())))
		)
};
