import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });

export const db = new DatabaseSync('data/finance.db');
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tx (
  id TEXT PRIMARY KEY,
  account TEXT, date TEXT, settled TEXT, type TEXT,
  counterparty TEXT, description TEXT,
  amount REAL, currency TEXT, balance REAL,
  category TEXT,
  transfer INTEGER DEFAULT 0,
  -- Position in the source export. Millennium writes newest-first, so within one
  -- date the SMALLER seq is the LATER transaction: order by date DESC, seq ASC.
  seq INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tx_date ON tx(date);

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
  capitalize INTEGER DEFAULT 1   -- 1 = interest joins principal, 0 = paid out
);

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

// SQLite has no ADD COLUMN IF NOT EXISTS, so bring older files up to date by hand.
for (const [table, col, def] of [
	['tx', 'seq', 'INTEGER DEFAULT 0'],
	['holding', 'coupon_rate', 'REAL'],
	['holding', 'maturity', 'TEXT'],
	['holding', 'compound_freq', 'TEXT'],
	['holding', 'capitalize', 'INTEGER DEFAULT 1'],
	['account', 'is_cash', 'INTEGER DEFAULT 0']
] as const) {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

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
