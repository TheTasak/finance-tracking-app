import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { importRows, parseMillennium } from '$lib/server/import';
import { all } from '$lib/server/db';

const MAX_BYTES = 20 * 1024 * 1024;

export const load: PageServerLoad = () => ({
	stored: all<{ n: number }>(`SELECT COUNT(*) n FROM tx`)[0].n,
	range: all<{ from: string; to: string }>(`SELECT MIN(date) "from", MAX(date) "to" FROM tx`)[0]
});

export const actions: Actions = {
	default: async ({ request }) => {
		const file = (await request.formData()).get('csv');
		if (!(file instanceof File) || !file.size) return fail(400, { error: 'Choose a CSV file.' });
		if (file.size > MAX_BYTES) return fail(400, { error: 'File larger than 20 MB.' });

		try {
			const rows = parseMillennium(await file.text());
			if (!rows.length) return fail(400, { error: 'No data rows in that file.' });
			return { ...importRows(rows), name: file.name };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not parse that file.' });
		}
	}
};
