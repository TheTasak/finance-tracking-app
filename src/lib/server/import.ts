import { createHash } from 'node:crypto';
import { db, ibanKey, ownIbans, tx } from './db.ts';
import { applyRules } from './categorize.ts';

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

export function importRows(rows: Row[]) {
	const ins = db.prepare(`
		INSERT OR IGNORE INTO tx
			(id, account, date, settled, type, counterparty, description, amount, currency, balance, category, transfer, seq)
		VALUES (:id, :account, :date, :settled, :type, :counterparty, :description, :amount, :currency, :balance, :category, :transfer, :seq)
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
			const transfer = r.counterIban && own.has(r.counterIban) ? 1 : 0;
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
					transfer,
					category: transfer ? 'Transfer' : applyRules(r.description, r.counterparty, r.type)
				}).changes
			);
		}
		return { added, skipped: rows.length - added };
	});
}
