import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });

/**
 * The tests wipe whatever file this points at, so they set FINANCE_DB to their own copy.
 * Without that they would delete your real ledger — they used to.
 */
export const DB_FILE = process.env.FINANCE_DB || 'data/finance.db';

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tx (
  id TEXT PRIMARY KEY,
  account TEXT, date TEXT, settled TEXT, type TEXT,
  counterparty TEXT, description TEXT,
  amount REAL, currency TEXT, balance REAL,
  category TEXT,
  transfer INTEGER DEFAULT 0,
  -- Kept so the transfer flag stays a pure function of the row rather than a verdict
  -- frozen at import time — see recategorizeAll.
  counter_iban TEXT,
  -- Position in the source export. Millennium writes newest-first, so within one
  -- date the SMALLER seq is the LATER transaction: order by date DESC, seq ASC.
  seq INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tx_date ON tx(date);
-- "the account's latest row" is asked per account and answered by a seek instead of a
-- scan of the whole ledger. DESC/ASC match the order that question is asked in, so the
-- answer is the first index entry read rather than a sort of everything the account has.
CREATE INDEX IF NOT EXISTS tx_account_date ON tx(account, date DESC, seq ASC);

CREATE TABLE IF NOT EXISTS holding (
  id INTEGER PRIMARY KEY,
  kind TEXT, ticker TEXT, name TEXT, qty REAL,
  buy_price REAL, buy_date TEXT,
  price REAL, price_at TEXT,
  currency TEXT DEFAULT 'PLN',
  -- Bonds only. Stocks leave these NULL and are valued by the manual price.
  coupon_rate REAL,              -- annual nominal, decimal: 0.05 = 5%
  maturity TEXT,                 -- YYYY-MM-DD
  compound_freq TEXT,            -- monthly | quarterly | annual
  capitalize INTEGER DEFAULT 1,  -- 1 = interest joins principal, 0 = paid out
  -- 'broker' rows are rebuilt from the trade table on every import: qty and
  -- buy_price are derived, only the manual price survives. 'manual' rows are yours.
  source TEXT DEFAULT 'manual',
  isin TEXT,                     -- broker rows only: the key the importer syncs on
  symbol TEXT                    -- Yahoo ticker the price feed reads: 'CDR.WA'. Blank = untracked.
);

-- Broker execution history. One row per fill, not per order: Bossa splits a single
-- order across commission tiers, so several rows can share a timestamp, symbol and
-- price and differ only in quantity and commission.
--
-- Fills arrive from two exports that overlap. The primary key is therefore natural —
-- date, instrument, side, quantity, price, currency and an occurrence counter — and
-- deliberately excludes value/commission/time: hisPW rounds "wartość" its own way
-- (400 x 21.8385 is filed as 8735.38, not 8735.40) and the cash ledger has no clock,
-- so anything derived from those would stop the two files recognising a shared fill.
CREATE TABLE IF NOT EXISTS trade (
  id TEXT PRIMARY KEY,
  date TEXT,                     -- YYYY-MM-DD
  time TEXT,                     -- hisPW only; '' from the cash ledger
  name TEXT, isin TEXT,
  side TEXT,                     -- K = buy (kupno), S = sell (sprzedaż)
  qty REAL, price REAL,
  commission REAL,
  -- Cash actually moved ("po prowizji"). Buys add the commission, sells subtract it.
  -- This is what the cost basis is built from — both files agree on it, where they
  -- disagree by a cent on qty * price.
  net REAL,
  currency TEXT DEFAULT 'PLN',
  seq INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trade_isin ON trade(isin);

-- Brokerage cash ledger ("historia finansowa"): everything that moved cash, not just
-- fills. Dividends, bond coupons, deposits, FX conversions, tender offers and fees.
-- There is no running-balance column, so cash is a sum over these rows — only right
-- if the export starts at account opening.
CREATE TABLE IF NOT EXISTS cashop (
  id TEXT PRIMARY KEY,
  date TEXT,
  title TEXT, details TEXT,
  amount REAL,                   -- signed: credits positive, debits negative
  currency TEXT DEFAULT 'PLN',
  kind TEXT,                     -- see KINDS in trades.ts
  symbol TEXT,                   -- instrument the operation is about, when named
  seq INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cashop_kind ON cashop(kind);

-- Konto rejestrowe ("Historia dyspozycji"): what moved on the treasury-bond registry
-- account. Same column shape as cashop so both render as one list, but deliberately a
-- separate table: cash there is not brokerage cash, and every balance that sums cashop
-- would be wrong if these rows were mixed in.
CREATE TABLE IF NOT EXISTS bond_op (
  id TEXT PRIMARY KEY,
  date TEXT,
  title TEXT, details TEXT,
  amount REAL,                   -- signed: credits positive, debits negative
  currency TEXT DEFAULT 'PLN',
  kind TEXT,                     -- 'bond' — see KINDS in trades.ts
  symbol TEXT,                   -- bond series, e.g. TOS0827
  seq INTEGER DEFAULT 0
);

-- Daily closes, keyed by the market ticker (holding.symbol) rather than the ISIN: one
-- listing can back several holdings, and the quote is a property of the listing.
CREATE TABLE IF NOT EXISTS price (
  symbol TEXT, date TEXT, close REAL,
  PRIMARY KEY (symbol, date)
);
-- Rates are a tenth of this table but every FX lookup used to scan all of it: the
-- '%PLN=X' suffix cannot use the primary key. Covering, so the scan never leaves it.
CREATE INDEX IF NOT EXISTS price_fx ON price(symbol, date, close) WHERE symbol LIKE '%PLN=X';

CREATE TABLE IF NOT EXISTS rule (
  id INTEGER PRIMARY KEY, pattern TEXT, category TEXT
);

CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY,
  iban TEXT UNIQUE,
  label TEXT,
  kind TEXT,
  currency TEXT DEFAULT 'PLN',
  in_net_worth INTEGER DEFAULT 1,
  -- Manual accounts only: spendable cash (another bank) rather than invested
  -- (a brokerage). Imported bank accounts are always cash. Drives runway.
  is_cash INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshot (
  account_id INTEGER, month TEXT, value REAL,
  PRIMARY KEY (account_id, month)
);
`);

// node:sqlite hands back null-prototype objects; SvelteKit's serializer wants plain ones.
export const all = <T = any>(sql: string, params: any = {}): T[] =>
	(db.prepare(sql).all(params) as any[]).map((r) => ({ ...r })) as T[];

export const get = <T = any>(sql: string, params: any = {}): T | undefined => {
	const r = db.prepare(sql).get(params) as any;
	return r ? ({ ...r } as T) : undefined;
};

export const run = (sql: string, params: any = {}) => db.prepare(sql).run(params);

export function tx<T>(fn: () => T): T {
	db.exec('BEGIN');
	try {
		const out = fn();
		db.exec('COMMIT');
		return out;
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
}

/** Digits-only IBAN, so "PL43 1160 …" and "43 11 6022 …" compare equal. */
export const ibanKey = (s: string) => (s || '').replace(/\D/g, '');

export const ownIbans = (): Set<string> =>
	new Set(
		all<{ iban: string }>(`SELECT iban FROM account WHERE iban IS NOT NULL`).map((r) =>
			ibanKey(r.iban)
		)
	);
