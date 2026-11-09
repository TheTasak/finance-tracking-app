import { createHash } from 'node:crypto';
import { db, ibanKey, ownIbans, tx } from './db.ts';
import { TRANSFER, applyRules } from './categorize.ts';

export type Row = {
	id: string;
	account: string;
	date: string;
	settled: string;
	type: string;
	counterparty: string;
	description: string;
	amount: number;
	currency: string;
	balance: number;
	counterIban: string;
	/** Position in the source export (0 = first line). Newest-first, so lower = later. */
	seq: number;
};

const clean = (s: string) => (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** Splits one CSV line honouring "" escapes. */
function splitLine(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else quoted = false;
			} else cur += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') {
			out.push(cur);
			cur = '';
		} else cur += c;
	}
	out.push(cur);
	return out;
}

const COLUMNS = [
	'Numer rachunku/karty',
	'Data transakcji',
	'Data rozliczenia',
	'Rodzaj transakcji',
	'Na konto/Z konta',
	'Odbiorca/Zleceniodawca',
	'Opis',
	'Obciążenia',
	'Uznania',
	'Saldo',
	'Waluta'
];

/** Millennium export -> rows. Debits already carry a minus sign in the file. */
export function parseMillennium(text: string): Row[] {
	const lines = text
		.replace(/^﻿/, '')
		.split(/\r?\n/)
		.filter((l) => l.trim());
	if (!lines.length) throw new Error('Empty file');

	const header = splitLine(lines[0]).map(clean);
	const [cAcc, cDate, cSettled, cType, cTo, cParty, cDesc, cDeb, cCred, cBal, cCur] = COLUMNS.map(
		(name) => {
			const i = header.indexOf(name);
			if (i < 0) throw new Error(`Missing column "${name}" — is this a Millennium CSV export?`);
			return i;
		}
	);

	return lines.slice(1).map((line, n) => {
		const f = splitLine(line).map(clean);
		const account = f[cAcc];
		const date = f[cDate];
		const description = f[cDesc];
		const balance = Number(f[cBal]);
		const amount = Number(f[cDeb] || f[cCred] || 0);

		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Row ${n + 2}: bad date "${date}"`);
		if (!Number.isFinite(amount)) throw new Error(`Row ${n + 2}: unparseable amount`);

		return {
			id: createHash('sha256')
				.update([account, date, amount, description, balance].join('|'))
				.digest('hex'),
			account,
			date,
			settled: f[cSettled],
			type: f[cType],
			counterparty: f[cParty],
			description,
			amount,
			currency: f[cCur] || 'PLN',
			balance,
			counterIban: ibanKey(f[cTo]),
			seq: n
		};
	});
}

const PKO_COLUMNS = ['Data operacji', 'Data waluty', 'Typ transakcji', 'Kwota', 'Waluta', 'Saldo po transakcji', 'Opis transakcji'];

const cents = (n: number) => Math.round(n * 100);

/**
 * PKO lists days newest-first but rows *within* a day in no reliable order, and
 * `ORDER BY date DESC, seq ASC` must find the closing balance first. Rebuild each day's
 * order from the balance chain (balance - amount = previous row's balance); if the chain
 * does not close, keep the file's order.
 */
function chainDay<T extends { amount: number; balance: number }>(day: T[]): T[] {
	const prevs = new Set(day.map((r) => cents(r.balance - r.amount)));
	const out: T[] = [];
	let cur = day.find((r) => !prevs.has(cents(r.balance)));
	const left = new Set(day);
	while (cur) {
		out.push(cur);
		left.delete(cur);
		const want = cents(cur.balance - cur.amount);
		cur = [...left].find((r) => cents(r.balance) === want);
	}
	return out.length === day.length ? out : day;
}

/**
 * PKO BP "Historia operacji" CSV -> rows. The export never names the account it came from,
 * so the caller supplies it. Details sit in free "Label: value" cells after "Opis transakcji".
 */
export function parsePko(text: string, account: string): Row[] {
	account = clean(account);
	if (ibanKey(account).length !== 26) throw new Error('Enter the 26-digit PKO account number.');

	const lines = text
		.replace(/^\uFEFF/, '')
		.split(/\r?\n/)
		.filter((l) => l.trim());
	if (!lines.length) throw new Error('Empty file');

	const header = splitLine(lines[0]).map(clean);
	const [cDate, cSettled, cType, cAmt, cCur, cBal, cDesc] = PKO_COLUMNS.map((name) => {
		const i = header.indexOf(name);
		if (i < 0) throw new Error(`Missing column "${name}" — is this a PKO BP CSV export?`);
		return i;
	});

	const parsed = lines.slice(1).map((line, n) => {
		const f = splitLine(line).map(clean);
		const details = f.slice(cDesc).filter(Boolean);
		const field = (...labels: string[]) => {
			for (const d of details) {
				const m = d.match(/^'?([^:]+):\s*(.*)$/);
				if (m && labels.includes(m[1])) return m[2];
			}
			return '';
		};
		const date = f[cDate];
		const amount = Number(f[cAmt]);
		const balance = Number(f[cBal]);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Row ${n + 2}: bad date "${date}"`);
		if (!Number.isFinite(amount)) throw new Error(`Row ${n + 2}: unparseable amount`);
		if (!Number.isFinite(balance)) throw new Error(`Row ${n + 2}: unparseable balance`);

		// Card/web payments: the merchant is only in "Lokalizacja: [Kraj: … Miasto: …] Adres: x".
		const place = field('Lokalizacja').replace(/^.*Adres:\s*/, '');
		const title = field('Tytuł');
		return {
			id: createHash('sha256')
				.update([account, date, amount, details.join('|'), balance].join('|'))
				.digest('hex'),
			account,
			date,
			settled: f[cSettled],
			type: f[cType],
			counterparty: field('Nazwa odbiorcy', 'Nazwa nadawcy') || place,
			// A web payment's "title" is just its reference number.
			description: /^\d+$/.test(title) ? place : title,
			amount,
			currency: f[cCur] || 'PLN',
			balance,
			counterIban: ibanKey(field('Rachunek odbiorcy', 'Rachunek nadawcy')),
			seq: 0
		};
	});

	const days = new Map<string, Row[]>();
	for (const r of parsed) days.set(r.date, [...(days.get(r.date) ?? []), r]);
	return [...days.values()].flatMap(chainDay).map((r, seq) => ({ ...r, seq }));
}

export function importRows(rows: Row[]) {
	const ins = db.prepare(`
		INSERT OR IGNORE INTO tx
			(id, account, date, settled, type, counterparty, description, amount, currency, balance, category, transfer, seq, counter_iban)
		VALUES (:id, :account, :date, :settled, :type, :counterparty, :description, :amount, :currency, :balance, :category, :transfer, :seq, :counter_iban)
	`);
	const insAcc = db.prepare(
		`INSERT OR IGNORE INTO account (iban, label, kind, currency) VALUES (:iban, :label, 'bank', :currency)`
	);

	return tx(() => {
		// Register every account in the file first, so an own-transfer leg is recognised
		// even on the very first import when the account table is still empty.
		for (const iban of new Set(rows.map((r) => r.account))) {
			const r = rows.find((x) => x.account === iban)!;
			insAcc.run({ iban, label: iban.slice(0, 7) + '…' + iban.slice(-4), currency: r.currency });
		}
		const own = ownIbans();

		let added = 0;
		for (const r of rows) {
			// Only a counter-IBAN we own makes this an own-transfer. Do NOT trust
			// "PRZELEW WEWNĘTRZNY" — Millennium uses it for any intra-bank transfer,
			// including genuine income from another person's Millennium account.
			//
			// A rule categorising the row as Transfer counts too: that is how an account of
			// yours at another bank is recognised, since the export names it without an IBAN.
			const category = applyRules(r.description, r.counterparty, r.type);
			const transfer =
				(r.counterIban && own.has(r.counterIban)) || category === TRANSFER ? 1 : 0;
			added += Number(
				ins.run({
					id: r.id,
					account: r.account,
					date: r.date,
					settled: r.settled,
					type: r.type,
					counterparty: r.counterparty,
					description: r.description,
					amount: r.amount,
					currency: r.currency,
					balance: r.balance,
					seq: r.seq,
					counter_iban: r.counterIban,
					transfer,
					category: transfer ? TRANSFER : category
				}).changes
			);
		}
		return { added, skipped: rows.length - added };
	});
}
