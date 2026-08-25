import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { run } from '$lib/server/db';
import { bondProjection, currentMonth, holdings, investmentTotals } from '$lib/server/stats';
import { BELKA, PERIODS } from '$lib/server/bonds';
import {
	KINDS,
	cashBalances,
	cashOps,
	fxRates,
	portfolioIncome,
	positions,
	tradeTotals,
	trades
} from '$lib/server/trades';

export const load: PageServerLoad = ({ url }) => {
	const isin = url.searchParams.get('isin') || '';
	const kind = url.searchParams.get('kind') || '';
	return {
		holdings: holdings(),
		totals: investmentTotals(),
		projection: bondProjection(),
		month: currentMonth(),
		belka: BELKA,
		positions: positions(),
		tradeTotals: tradeTotals(),
		income: portfolioIncome(),
		cash: cashBalances(),
		fx: fxRates(),
		kinds: KINDS,
		// ponytail: whole history, no paging — a personal broker account is hundreds of
		// rows, not millions. Add LIMIT/OFFSET like /transactions if it ever drags.
		trades: trades(isin),
		ops: cashOps(kind),
		isin,
		kind
	};
};

const num = (v: FormDataEntryValue | null) => {
	const n = Number(String(v ?? '').replace(',', '.'));
	return Number.isFinite(n) ? n : NaN;
};
const str = (v: FormDataEntryValue | null) => String(v ?? '').trim();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const actions: Actions = {
	addStock: async ({ request }) => {
		const f = await request.formData();
		const h = {
			ticker: str(f.get('ticker')).toUpperCase(),
			name: str(f.get('name')),
			qty: num(f.get('qty')),
			buy_price: num(f.get('buy_price')),
			buy_date: str(f.get('buy_date')),
			currency: str(f.get('currency')) || 'PLN'
		};
		if (!h.ticker) return fail(400, { error: 'Ticker is required.' });
		if (!(h.qty > 0)) return fail(400, { error: 'Quantity must be greater than zero.' });
		if (!(h.buy_price >= 0)) return fail(400, { error: 'Buy price must be a number.' });

		run(
			`INSERT INTO holding (kind, ticker, name, qty, buy_price, buy_date, price, currency)
			 VALUES ('stock', :ticker, :name, :qty, :buy_price, :buy_date, NULL, :currency)`,
			h
		);
		return { ok: true };
	},

	addBond: async ({ request }) => {
		const f = await request.formData();
		const ratePct = num(f.get('coupon_rate'));
		const b = {
			ticker: str(f.get('ticker')).toUpperCase(),
			name: str(f.get('name')),
			qty: num(f.get('qty')),
			buy_price: num(f.get('buy_price')),
			buy_date: str(f.get('buy_date')),
			maturity: str(f.get('maturity')),
			// The form takes a human percent; the engine works in decimals.
			coupon_rate: ratePct / 100,
			compound_freq: str(f.get('compound_freq')),
			capitalize: f.get('capitalize') ? 1 : 0,
			currency: str(f.get('currency')) || 'PLN'
		};

		if (!b.ticker) return fail(400, { error: 'Name or symbol is required.' });
		if (!(b.qty > 0)) return fail(400, { error: 'Quantity must be greater than zero.' });
		if (!(b.buy_price > 0)) return fail(400, { error: 'Price per bond must be greater than zero.' });
		if (!(ratePct >= 0)) return fail(400, { error: 'Interest rate must be a number.' });
		if (!ISO_DATE.test(b.buy_date)) return fail(400, { error: 'Purchase date is required.' });
		if (!ISO_DATE.test(b.maturity)) return fail(400, { error: 'Maturity date is required.' });
		if (b.maturity <= b.buy_date)
			return fail(400, { error: 'Maturity must be after the purchase date.' });
		if (!(b.compound_freq in PERIODS)) return fail(400, { error: 'Pick an interest frequency.' });

		run(
			`INSERT INTO holding
				(kind, ticker, name, qty, buy_price, buy_date, currency, coupon_rate, maturity, compound_freq, capitalize)
			 VALUES
				('bond', :ticker, :name, :qty, :buy_price, :buy_date, :currency, :coupon_rate, :maturity, :compound_freq, :capitalize)`,
			b
		);
		return { ok: true };
	},

	setPrice: async ({ request }) => {
		const f = await request.formData();
		const price = num(f.get('price'));
		if (!(price >= 0)) return fail(400, { error: 'Price must be a number.' });
		run(`UPDATE holding SET price = :price, price_at = :at WHERE id = :id`, {
			id: Number(f.get('id')),
			price,
			at: new Date().toISOString().slice(0, 10)
		});
		return { ok: true };
	},

	remove: async ({ request }) => {
		const f = await request.formData();
		run(`DELETE FROM holding WHERE id = :id`, { id: Number(f.get('id')) });
		return { ok: true };
	}
};
