import { all, db, get, run, tx } from './db.ts';

/**
 * Price feed, from Yahoo Finance's chart endpoint.
 *
 * One call does both jobs the app needs: the daily series carries the whole history
 * *and* the latest session, so "current price" is just its last row.
 *
 * This used to read Stooq, which now answers every request with a browser check and
 * then refuses the CSV outright ("Odmowa dostępu"). Yahoo needs no cookie, no session
 * and no key — hence `symbol` holds a Yahoo ticker: `CDR.WA`, `VUAA.L`, `AAPL`.
 */

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

/** Yahoo serves JSON to anything, but a browser agent avoids the occasional 429. */
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type Close = { date: string; close: number };
export type Series = { currency: string; rows: Close[] };

/** Yahoo's shape, narrowed to the parts worth trusting. */
type Chart = {
	chart?: {
		error?: { code?: string; description?: string } | null;
		result?: {
			meta?: { currency?: string; gmtoffset?: number; dataGranularity?: string };
			timestamp?: number[];
			indicators?: { quote?: { close?: (number | null)[] }[] };
		}[];
	};
};

/**
 * Daily closes for one symbol, oldest first, with the currency Yahoo quotes it in —
 * the caller has to check that, because a GBP listing of a fund you hold in PLN would
 * otherwise be multiplied straight into your net worth.
 *
 * `from` (YYYY-MM-DD) asks for a slice instead of the whole listing, so a refresh
 * re-downloads days rather than decades.
 */
export async function history(symbol: string, from = ''): Promise<Series> {
	// Always an explicit window, never `range=max`: that quietly answers with MONTHLY
	// bars dated the 1st, which would feed monthEndCloses a month's opening price.
	// period1=0 asks for everything and still comes back daily.
	const q = new URLSearchParams({
		interval: '1d',
		period1: from ? String(Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000)) : '0',
		period2: String(Math.floor(Date.now() / 1000))
	});

	const res = await fetch(`${BASE}/${encodeURIComponent(symbol)}?${q}`, {
		headers: { 'user-agent': UA, accept: 'application/json' }
	});

	// Yahoo reports an unknown ticker as a 404 carrying a JSON reason, so read the body
	// before trusting the status either way.
	const body = (await res.json().catch(() => null)) as Chart | null;
	const err = body?.chart?.error;
	if (err) throw new Error(`${symbol}: ${err.description ?? err.code ?? 'rejected by Yahoo'}`);
	const r = body?.chart?.result?.[0];
	if (!r) throw new Error(`${symbol}: Yahoo returned no data (HTTP ${res.status})`);

	// Yahoo decides the granularity itself and says so. Anything but daily would store
	// month-opening prices under daily dates, so refuse it rather than average it away.
	const grain = r.meta?.dataGranularity;
	if (grain && grain !== '1d') throw new Error(`${symbol}: Yahoo answered with ${grain} bars`);

	return { currency: (r.meta?.currency ?? '').toUpperCase(), rows: closes(r) };
}

/**
 * Zip Yahoo's parallel timestamp and close arrays into dated rows.
 *
 * The timestamps are the session *open* in UTC, so a market east of Greenwich would
 * land on the previous day if read as UTC — shift by the exchange's own offset and the
 * date is the one the exchange traded on.
 */
export function closes(result: NonNullable<NonNullable<Chart['chart']>['result']>[number]): Close[] {
	const stamps = result.timestamp ?? [];
	const values = result.indicators?.quote?.[0]?.close ?? [];
	const offset = result.meta?.gmtoffset ?? 0;

	const out: Close[] = [];
	for (let i = 0; i < stamps.length; i++) {
		const close = values[i];
		// A halted or untraded session comes back as null; skip it rather than store 0.
		if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue;
		out.push({
			date: new Date((stamps[i] + offset) * 1000).toISOString().slice(0, 10),
			close
		});
	}
	return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Yahoo's ticker for "one unit of `currency`, priced in PLN" — USDPLN=X, EURPLN=X. It
 * lands in the same `price` table as everything else: a rate is just a close.
 */
export const fxSymbol = (currency: string) => `${currency.toUpperCase()}PLN=X`;

/**
 * The currencies worth a rate: whatever non-PLN money actually turns up in the ledger,
 * the holdings or the brokerage cash. Read from the data rather than listed, so a GBP
 * position starts being quoted without anyone editing this file.
 */
export const foreignCurrencies = (): string[] =>
	all<{ currency: string }>(
		`SELECT DISTINCT currency FROM (
			SELECT currency FROM tx        WHERE currency <> 'PLN' AND currency <> ''
			UNION SELECT currency FROM holding WHERE currency <> 'PLN' AND currency <> ''
			UNION SELECT currency FROM cashop  WHERE currency <> 'PLN' AND currency <> ''
		 ) ORDER BY currency`
	).map((r) => r.currency);

export type Rate = { currency: string; rate: number; date: string };

/** The newest stored rate per currency: what one unit of it is worth in PLN. */
export function latestRates(): Rate[] {
	return all<Rate>(
		`SELECT replace(symbol, 'PLN=X', '') currency, close rate, date FROM price p
		 WHERE symbol LIKE '%PLN=X'
		   AND date = (SELECT MAX(date) FROM price WHERE symbol = p.symbol)
		 ORDER BY currency`
	);
}

/** Newest close stored for a symbol, if any. */
const latest = (symbol: string) =>
	get<Close>(`SELECT date, close FROM price WHERE symbol = :symbol ORDER BY date DESC LIMIT 1`, {
		symbol
	});

function store(symbol: string, rows: Close[]) {
	const ins = db.prepare(
		`INSERT INTO price (symbol, date, close) VALUES (:symbol, :date, :close)
		 ON CONFLICT (symbol, date) DO UPDATE SET close = excluded.close`
	);
	tx(() => {
		for (const r of rows) ins.run({ symbol, ...r });
	});
}

export type Refreshed = {
	symbol: string;
	rows: number;
	close?: number;
	currency?: string;
	error?: string;
};

/**
 * Pull every tracked symbol and write the newest close back onto its holdings, so the
 * rest of the app keeps reading `holding.price` exactly as it did when that number was
 * typed by hand. A symbol that fails is reported and skipped — one dead ticker must not
 * cost you the other nine.
 */
export async function refreshPrices(): Promise<Refreshed[]> {
	const tracked = all<{ symbol: string; currencies: string }>(
		`SELECT symbol, GROUP_CONCAT(DISTINCT currency) currencies FROM holding
		 WHERE symbol IS NOT NULL AND symbol <> '' GROUP BY symbol ORDER BY symbol`
	);

	// Exchange rates ride along on the same run. They are quoted in PLN by definition, so
	// they carry no holding currency to check against.
	const fx = foreignCurrencies().map((c) => ({ symbol: fxSymbol(c), currencies: '' }));

	const out: Refreshed[] = [];
	for (const { symbol, currencies } of [...tracked, ...fx]) {
		try {
			// Re-ask from the last stored day, not the day after: the most recent close can
			// still be revised, and re-reading one row is cheaper than being wrong.
			const { currency, rows } = await history(symbol, latest(symbol)?.date ?? '');
			if (!rows.length) throw new Error(`${symbol}: no usable closes`);

			// The app does no FX anywhere else, so it must not start here by accident. A
			// listing quoted in another currency is refused, not converted.
			const wrong = currencies ? currencies.split(',').filter((c) => c !== currency) : [];
			if (wrong.length)
				throw new Error(
					`quoted in ${currency}, but you hold it in ${wrong.join('/')} — pick a ${wrong[0]} listing`
				);

			store(symbol, rows);
			const newest = rows[rows.length - 1];
			run(`UPDATE holding SET price = :close, price_at = :date WHERE symbol = :symbol`, {
				symbol,
				...newest
			});
			out.push({ symbol, rows: rows.length, close: newest.close, currency });
		} catch (e) {
			out.push({ symbol, rows: 0, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}

/**
 * Month-end close per symbol, for valuing past holdings on the net-worth chart. The
 * last close *in* the month, so a month that ended on a holiday still gets a price.
 */
export function monthEndCloses(): Map<string, Map<string, number>> {
	const out = new Map<string, Map<string, number>>();
	for (const r of all<{ symbol: string; month: string; close: number }>(
		`SELECT symbol, substr(date,1,7) month, close FROM price p
		 WHERE date = (SELECT MAX(date) FROM price WHERE symbol = p.symbol AND substr(date,1,7) = substr(p.date,1,7))`
	)) {
		let m = out.get(r.symbol);
		if (!m) out.set(r.symbol, (m = new Map()));
		m.set(r.month, r.close);
	}
	return out;
}
