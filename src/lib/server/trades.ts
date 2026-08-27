import { createHash } from 'node:crypto';
import { all, db, run, tx } from './db.ts';

/** Bossa writes Windows-1250, so "ilość" only decodes correctly out of the raw bytes. */
export const decodeBossa = (buf: ArrayBuffer | Uint8Array) =>
	new TextDecoder('windows-1250').decode(buf);

const clean = (s: string) => (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
/** Polish decimals: "1 234,56" -> 1234.56. */
const num = (s: string) => Number(clean(s).replace(/\s/g, '').replace(',', '.'));
const round = (n: number) => Math.round(n * 100) / 100;

const header = (line: string, columns: string[], what: string) => {
	const h = line.split(';').map((c) => clean(c).toLowerCase());
	return columns.map((name) => {
		const i = h.indexOf(name);
		if (i < 0) throw new Error(`Missing column "${name}" — is this a Bossa ${what} CSV export?`);
		return i;
	});
};

const rows = (text: string) =>
	text
		.replace(/^﻿/, '')
		.split(/\r?\n/)
		.filter((l) => l.trim());

/** DD.MM.YYYY[ HH:MM:SS] or YYYY-MM-DD -> [ISO date, time]. */
function stamp(s: string, row: number): [string, string] {
	const pl = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}:\d{2}:\d{2}))?$/);
	if (pl) return [`${pl[3]}-${pl[2]}-${pl[1]}`, pl[4] ?? ''];
	const iso = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?$/);
	if (iso) return [iso[1], iso[2] ?? ''];
	throw new Error(`Row ${row}: bad date "${s}"`);
}

// ── Trades ──────────────────────────────────────────────────────────────────────

export type Trade = {
	id: string;
	date: string;
	time: string;
	name: string;
	isin: string;
	side: 'K' | 'S';
	qty: number;
	price: number;
	commission: number;
	net: number;
	currency: string;
	seq: number;
};

/**
 * Both broker exports list the same fills, so identity has to be a natural key.
 * `n` is the occurrence within its group: a genuinely repeated fill (Energy Fuels
 * sold 100 twice at 5.63 on the same day) must survive as two rows, and must land
 * on the same two ids whichever file it is read from.
 */
const tradeId = (t: Omit<Trade, 'id'>, n: number) =>
	createHash('sha256')
		.update([t.date, t.isin, t.side, t.qty, t.price, t.currency, n].join('|'))
		.digest('hex');

function withIds(list: Omit<Trade, 'id'>[]): Trade[] {
	const seen = new Map<string, number>();
	return list.map((t) => {
		const group = [t.date, t.isin, t.side, t.qty, t.price, t.currency].join('|');
		const n = seen.get(group) ?? 0;
		seen.set(group, n + 1);
		return { ...t, id: tradeId(t, n) };
	});
}

const HISPW = ['data', 'papier', 'isin', 'ilość', '-', 'cena', 'wartość', 'prowizja', 'po prowizji', 'waluta'];

/** hisPW export -> fills. Carries the broker's own commission split, so it is the better source. */
export function parseBossa(text: string): Trade[] {
	const lines = rows(text);
	if (!lines.length) throw new Error('Empty file');
	const [cDate, cName, cIsin, cQty, cSide, cPrice, cValue, cComm, cNet, cCur] = header(
		lines[0],
		HISPW,
		'hisPW'
	);

	return withIds(
		lines.slice(1).map((line, n) => {
			const f = line.split(';').map(clean);
			const [date, time] = stamp(f[cDate], n + 2);
			const side = f[cSide].toUpperCase();
			if (side !== 'K' && side !== 'S') throw new Error(`Row ${n + 2}: unknown side "${f[cSide]}"`);

			const t = {
				date,
				time,
				name: f[cName],
				isin: f[cIsin],
				side: side as 'K' | 'S',
				qty: num(f[cQty]),
				price: num(f[cPrice]),
				commission: num(f[cComm]),
				net: num(f[cNet]),
				currency: f[cCur] || 'PLN',
				seq: n
			};
			// "wartość" is never stored — it is qty * price, give or take the broker's own
			// rounding — but it has to be read to check the file against itself.
			const value = num(f[cValue]);
			if (![t.qty, t.price, value, t.commission, t.net].every(Number.isFinite))
				throw new Error(`Row ${n + 2}: unparseable number`);
			if (!(t.qty > 0)) throw new Error(`Row ${n + 2}: quantity must be positive`);

			// Trust the file, but refuse one whose own arithmetic disagrees — a wrong
			// "po prowizji" would silently poison every cost basis downstream.
			const expected = t.side === 'K' ? value + t.commission : value - t.commission;
			if (Math.abs(expected - t.net) > 0.02)
				throw new Error(`Row ${n + 2}: "po prowizji" ${t.net} ≠ ${expected.toFixed(2)}`);
			return t;
		})
	);
}

// ── Cash ledger ─────────────────────────────────────────────────────────────────

export type CashOp = {
	id: string;
	date: string;
	title: string;
	details: string;
	amount: number;
	currency: string;
	kind: Kind;
	symbol: string;
	seq: number;
};

export type Kind =
	| 'trade'
	| 'dividend'
	| 'coupon'
	| 'bond'
	| 'deposit'
	| 'fee'
	| 'fx'
	| 'tender'
	| 'other';

/** Human labels for the ledger UI, in the order they are worth reading. */
export const KINDS: Record<Kind, string> = {
	trade: 'Trade settlement',
	dividend: 'Dividend',
	coupon: 'Bond interest',
	bond: 'Bond principal',
	tender: 'Tender offer',
	deposit: 'Deposit',
	fx: 'Currency exchange',
	fee: 'Fee',
	other: 'Other'
};

/**
 * The ledger only says what happened in Polish prose, so the type has to be read off
 * the title. Order matters: "Rozliczenie wezwania - prowizja TIM" is a fee, not a
 * tender payout, so the fee test has to come first.
 */
function classify(title: string): { kind: Kind; symbol: string } {
	const t = title.trim();
	const after = (re: RegExp) => (t.match(re)?.[1] ?? '').replace(/[:.]+$/, '').trim();

	if (/^Rozliczenie transakcji/i.test(t)) return { kind: 'trade', symbol: '' };
	if (/prowizja|^Opłata/i.test(t)) return { kind: 'fee', symbol: after(/prowizja (.+)$/i) };
	if (/^Rozliczenie wezwania/i.test(t)) return { kind: 'tender', symbol: after(/wezwania (.+)$/i) };
	if (/^Wypłata dywidendy/i.test(t))
		return { kind: 'dividend', symbol: after(/dywidendy (?:brutto )?(.+)$/i) };
	if (/odsetek/i.test(t)) return { kind: 'coupon', symbol: after(/obligacji (.+)$/i) };
	// Subscription, oversubscription refund and redemption are all principal moving:
	// netted together they are the realised result on the bond, never income on their own.
	if (/^(Zapisy na obligacje|Wykup obligacji|Zwrot nadpłaty)/i.test(t))
		return { kind: 'bond', symbol: after(/(?:obligacje|obligacji|nadpłaty) (.+)$/i) };
	if (/^Przelew/i.test(t)) return { kind: 'deposit', symbol: '' };
	if (/^Wymiana waluty/i.test(t)) return { kind: 'fx', symbol: after(/waluty (\S+)/i) };
	return { kind: 'other', symbol: '' };
}

const CASH = ['data', 'tytuł operacji', 'szczegóły', 'kwota', 'waluta'];

/** "NAME (ISIN) QTY x PRICE CUR nr REF" — the only structured part of the ledger. */
const DETAILS = /^(.+?) \(([A-Z]{2}[A-Z0-9]{10})\) ([\d.]+) x ([\d.]+) ([A-Z]{3}) nr (\S+)$/;

/** historia finansowa export -> every cash operation, with the fills split back out. */
export function parseCash(text: string): { ops: CashOp[]; trades: Trade[] } {
	const lines = rows(text);
	if (!lines.length) throw new Error('Empty file');
	const [cDate, cTitle, cDetails, cAmount, cCur] = header(lines[0], CASH, 'historia finansowa');

	const ops: CashOp[] = [];
	const fills: Omit<Trade, 'id'>[] = [];
	const seen = new Map<string, number>();

	lines.slice(1).forEach((line, n) => {
		const f = line.split(';').map(clean);
		const [date] = stamp(f[cDate], n + 2);
		const amount = num(f[cAmount]);
		if (!Number.isFinite(amount)) throw new Error(`Row ${n + 2}: unparseable amount`);
		const title = f[cTitle];
		const details = f[cDetails] ?? '';
		const { kind, symbol } = classify(title);
		const currency = f[cCur] || 'PLN';

		// Nothing distinguishes two identical operations on one day, so count occurrences.
		const group = [date, title, details, amount, currency].join('|');
		const dup = seen.get(group) ?? 0;
		seen.set(group, dup + 1);

		ops.push({
			id: createHash('sha256').update(`${group}|${dup}`).digest('hex'),
			date,
			title,
			details,
			amount,
			currency,
			kind,
			symbol,
			seq: n
		});

		if (kind !== 'trade') return;
		const m = details.match(DETAILS);
		if (!m) throw new Error(`Row ${n + 2}: cannot read the fill out of "${details}"`);
		const [, name, isin, qty, price, cur] = m;
		if (cur !== currency) throw new Error(`Row ${n + 2}: ${cur} fill settled in ${currency}`);

		const side = /kupna/i.test(title) ? 'K' : 'S';
		// The ledger states cash moved, not the value/commission split, so derive it.
		// It can land a cent or two off the broker's own figures; hisPW wins when both
		// files are imported, because INSERT OR IGNORE keeps whichever came first.
		const value = round(Number(qty) * Number(price));
		fills.push({
			date,
			time: '',
			name,
			isin,
			side,
			qty: Number(qty),
			price: Number(price),
			commission: round(side === 'K' ? Math.abs(amount) - value : value - Math.abs(amount)),
			net: Math.abs(amount),
			currency,
			seq: n
		});
	});

	return { ops, trades: withIds(fills) };
}

// ── Import ──────────────────────────────────────────────────────────────────────

const insertTrades = (list: Trade[]) => {
	const ins = db.prepare(`
		INSERT OR IGNORE INTO trade
			(id, date, time, name, isin, side, qty, price, commission, net, currency, seq)
		VALUES (:id, :date, :time, :name, :isin, :side, :qty, :price, :commission, :net, :currency, :seq)
	`);
	let added = 0;
	for (const t of list) added += Number(ins.run({ ...t }).changes);
	return { added, skipped: list.length - added };
};

export function importTrades(list: Trade[]) {
	const out = tx(() => insertTrades(list));
	syncBrokerHoldings();
	return out;
}

export function importCash({ ops, trades }: { ops: CashOp[]; trades: Trade[] }) {
	const ins = db.prepare(`
		INSERT OR IGNORE INTO cashop (id, date, title, details, amount, currency, kind, symbol, seq)
		VALUES (:id, :date, :title, :details, :amount, :currency, :kind, :symbol, :seq)
	`);
	const out = tx(() => {
		let added = 0;
		for (const o of ops) added += Number(ins.run({ ...o }).changes);
		// Fills already known from hisPW collapse onto the same natural key.
		const fills = insertTrades(trades);
		return { added, skipped: ops.length - added, fills: fills.added };
	});
	syncBrokerHoldings();
	return out;
}

export const trades = (isin = '') =>
	all<Trade>(
		`SELECT * FROM trade ${isin ? 'WHERE isin = :isin' : ''} ORDER BY date DESC, time DESC, seq ASC`,
		isin ? { isin } : {}
	);

export const cashOps = (kind = '') =>
	all<CashOp>(
		`SELECT * FROM cashop ${kind ? 'WHERE kind = :kind' : ''} ORDER BY date DESC, seq ASC`,
		kind ? { kind } : {}
	);

/**
 * Every bond money movement, from both places they happen: the brokerage ledger
 * (Catalyst coupons and redemptions) and the treasury registry account, whose
 * dispositions treasury.ts writes to bond_op.
 */
export const bondOps = () =>
	all<CashOp & { source: string }>(
		`SELECT id, date, title, details, amount, currency, kind, symbol, seq, 'broker' source
		   FROM cashop WHERE kind IN ('bond', 'coupon')
		 UNION ALL
		 SELECT id, date, title, details, amount, currency, kind, symbol, seq, 'registry' source
		   FROM bond_op
		 ORDER BY date DESC, seq ASC`
	);

// ── Positions ───────────────────────────────────────────────────────────────────

export type Position = {
	isin: string;
	name: string;
	currency: string;
	openQty: number;
	/** Average cost of the lots still open, commission included. */
	avgCost: number;
	cost: number;
	firstBuy: string;
	boughtQty: number;
	soldQty: number;
	/** Net of commissions on both legs, FIFO-matched. */
	realized: number;
	commission: number;
	/** Shares sold with no purchase in the file — excluded from realized P/L. */
	unmatchedQty: number;
	dividends: number;
	/** True when a tender offer was priced by assuming it took the whole position. */
	inferred: boolean;
};

type Lot = { qty: number; unit: number; date: string };

/**
 * FIFO cost basis per instrument *and currency*. The same ISIN can trade on two
 * markets — Energy Fuels was bought in PLN on the GPW and in USD on XASE — and their
 * cost bases must never be mixed.
 *
 * Commissions ride on the lot (buys) and reduce the proceeds (sells), so `realized`
 * is the cash actually made. An export that starts mid-history can sell shares it
 * never shows bought; those go to `unmatchedQty` rather than being priced at a cost
 * of zero, which would report the whole proceeds as profit.
 */
export function positions(): Position[] {
	const fills = all<Trade>(`SELECT * FROM trade ORDER BY date ASC, time ASC, seq ASC`);
	// A tender offer pays cash for shares without ever appearing as a fill, so the
	// position would otherwise sit there for ever. The ledger names the instrument and
	// the proceeds but not the quantity, so it is read as taking the whole position —
	// true for a tender that fully settles, and flagged as inferred either way.
	const tenders = all<CashOp>(
		`SELECT * FROM cashop WHERE kind = 'tender' AND amount > 0 ORDER BY date ASC, seq ASC`
	);
	const dividends = all<{ symbol: string; currency: string; total: number }>(
		`SELECT symbol, currency, SUM(amount) total FROM cashop
		 WHERE kind = 'dividend' GROUP BY symbol, currency`
	);

	const acc = new Map<string, Position & { lots: Lot[] }>();
	const keyOf = (isin: string, currency: string) => `${isin}|${currency}`;

	const open = (isin: string, name: string, currency: string) => {
		const k = keyOf(isin, currency);
		let p = acc.get(k);
		if (!p)
			acc.set(
				k,
				(p = {
					isin,
					name,
					currency,
					openQty: 0,
					avgCost: 0,
					cost: 0,
					firstBuy: '',
					boughtQty: 0,
					soldQty: 0,
					realized: 0,
					commission: 0,
					unmatchedQty: 0,
					dividends: 0,
					inferred: false,
					lots: []
				})
			);
		return p;
	};

	/** Consume lots oldest-first and bank the difference. Returns shares left unmatched. */
	const sell = (p: Position & { lots: Lot[] }, qty: number, proceeds: number) => {
		const unit = proceeds / qty;
		let left = qty;
		while (left > 0 && p.lots.length) {
			const lot = p.lots[0];
			const take = Math.min(left, lot.qty);
			p.realized += (unit - lot.unit) * take;
			lot.qty -= take;
			left -= take;
			if (lot.qty <= 1e-9) p.lots.shift();
		}
		return left;
	};

	// One date-ordered stream, tenders after the fills that share their date.
	const events = [
		...fills.map((f) => ({ at: `${f.date} ${f.time} 0`, fill: f, tender: null as CashOp | null })),
		...tenders.map((c) => ({ at: `${c.date} ~ 1`, fill: null as Trade | null, tender: c }))
	].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

	for (const e of events) {
		if (e.fill) {
			const t = e.fill;
			const p = open(t.isin, t.name, t.currency);
			p.name = t.name; // the broker renames instruments; the newest label wins
			p.commission += t.commission;
			if (t.side === 'K') {
				p.boughtQty += t.qty;
				p.firstBuy ||= t.date;
				p.lots.push({ qty: t.qty, unit: t.net / t.qty, date: t.date });
			} else {
				p.soldQty += t.qty;
				p.unmatchedQty += sell(p, t.qty, t.net);
			}
			continue;
		}

		const c = e.tender!;
		const held = [...acc.values()].find(
			(p) => p.currency === c.currency && held0(p) > 1e-9 && matches(p.name, c.symbol)
		);
		if (!held) continue; // nothing to close; the ledger row still shows in the UI
		const qty = held0(held);
		held.soldQty += qty;
		held.inferred = true;
		sell(held, qty, c.amount);
	}

	const div = new Map(dividends.map((d) => [`${d.symbol.toUpperCase()}|${d.currency}`, d.total]));

	return [...acc.values()]
		.map(({ lots, ...p }) => {
			const cost = lots.reduce((s, l) => s + l.qty * l.unit, 0);
			const openQty = lots.reduce((s, l) => s + l.qty, 0);
			return {
				...p,
				openQty,
				cost,
				avgCost: openQty ? cost / openQty : 0,
				firstBuy: lots[0]?.date ?? p.firstBuy,
				dividends: div.get(`${p.name.toUpperCase()}|${p.currency}`) ?? 0
			};
		})
		.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

/** The ledger writes a short symbol; the fill writes the broker's instrument name. */
const matches = (name: string, symbol: string) =>
	!!symbol && name.toUpperCase().startsWith(symbol.toUpperCase());

/** Shares still open mid-walk — `openQty` is only finalised once the stream ends. */
const held0 = (p: { lots: Lot[] }) => p.lots.reduce((s, l) => s + l.qty, 0);

// ── Money made ──────────────────────────────────────────────────────────────────

/** Running cash at the broker, per currency. Only complete if the export is. */
export const cashBalances = () =>
	all<{ currency: string; balance: number; from: string; to: string; n: number }>(
		`SELECT currency, SUM(amount) balance, MIN(date) "from", MAX(date) "to", COUNT(*) n
		 FROM cashop GROUP BY currency ORDER BY balance DESC`
	);

/**
 * The rate the user themself converted at, newest first. Not used in any total — the
 * app does no FX — but a non-PLN figure is unreadable without one.
 */
export function fxRates() {
	const seen = new Set<string>();
	const out: { date: string; pair: string; rate: number }[] = [];
	for (const r of all<{ date: string; title: string }>(
		`SELECT date, title FROM cashop WHERE kind = 'fx' ORDER BY date DESC`
	)) {
		const m = r.title.match(/([A-Z]{3})\/([A-Z]{3})\s+([\d.]+)/);
		const pair = m && `${m[1]}/${m[2]}`;
		if (!m || !pair || seen.has(pair)) continue;
		seen.add(pair);
		out.push({ date: r.date, pair, rate: Number(m[3]) });
	}
	return out;
}

export type Income = {
	currency: string;
	realized: number;
	dividends: number;
	coupons: number;
	/** Subscriptions, oversubscription refunds and redemptions netted: the bond result. */
	bond: number;
	fees: number;
	deposits: number;
	total: number;
};

/**
 * Everything the portfolio actually earned, split by where it came from, per currency.
 * Deposits are reported but never counted — moving your own money in is not a gain.
 * Trade settlements are not counted either: their result is `realized`.
 */
export function portfolioIncome(): Income[] {
	const buckets = all<{ currency: string; kind: Kind; total: number }>(
		`SELECT currency, kind, SUM(amount) total FROM cashop GROUP BY currency, kind`
	);
	const ps = positions();
	const currencies = [
		...new Set([...buckets.map((b) => b.currency), ...ps.map((p) => p.currency)])
	];
	const at = (currency: string, kind: Kind) =>
		buckets.find((b) => b.currency === currency && b.kind === kind)?.total ?? 0;

	return currencies
		.map((currency) => {
			const realized = ps
				.filter((p) => p.currency === currency)
				.reduce((s, p) => s + p.realized, 0);
			const row = {
				currency,
				realized,
				dividends: at(currency, 'dividend'),
				coupons: at(currency, 'coupon'),
				bond: at(currency, 'bond'),
				fees: at(currency, 'fee'),
				deposits: at(currency, 'deposit')
			};
			return { ...row, total: realized + row.dividends + row.coupons + row.bond + row.fees };
		})
		.sort((a, b) => b.total - a.total);
}

/** The two things the portfolio can't tell you from its own numbers, so the UI must. */
export function tradeTotals() {
	const ps = positions();
	return {
		/** Positions whose quantity was assumed from a tender offer's cash. */
		inferred: ps.filter((p) => p.inferred),
		/** Ledger operations that name an instrument nothing in the trade history matches. */
		orphans: all<{ symbol: string; kind: string; n: number; total: number }>(
			`SELECT symbol, kind, COUNT(*) n, SUM(amount) total FROM cashop
			 WHERE symbol <> '' AND kind IN ('dividend','tender') GROUP BY symbol, kind`
		).filter((o) => !ps.some((p) => matches(p.name, o.symbol)))
	};
}

// ── Holdings sync ───────────────────────────────────────────────────────────────

/**
 * Mirror the open positions into `holding` so they get valued, charted and counted in
 * net worth by the code that already does that for hand-entered stocks. Only qty and
 * cost are derived — the manually typed price survives a re-import.
 */
export function syncBrokerHoldings() {
	const open = positions().filter((p) => p.openQty > 1e-9);
	tx(() => {
		for (const p of open) {
			const params = {
				isin: p.isin,
				name: p.name,
				qty: p.openQty,
				buy_price: p.avgCost,
				buy_date: p.firstBuy,
				currency: p.currency
			};
			const hit = run(
				`UPDATE holding SET ticker = :name, name = :isin, qty = :qty, buy_price = :buy_price,
					buy_date = :buy_date
				 WHERE source = 'broker' AND isin = :isin AND currency = :currency`,
				params
			).changes;
			if (!hit)
				run(
					`INSERT INTO holding (kind, source, isin, ticker, name, qty, buy_price, buy_date, currency)
					 VALUES ('stock', 'broker', :isin, :name, :isin, :qty, :buy_price, :buy_date, :currency)`,
					params
				);
		}
		// A position sold to zero — or tendered away — stops being a holding. The same
		// ISIN can be open in one currency and closed in another, so match on both.
		const safe = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');
		const keep = open.map((p) => `'${safe(p.isin)}|${safe(p.currency)}'`).join(',') || `''`;
		run(`DELETE FROM holding WHERE source = 'broker' AND isin || '|' || currency NOT IN (${keep})`);
	});
}
