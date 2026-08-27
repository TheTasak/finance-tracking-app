/**
 * Minimal .xls reader: the OLE2 container plus the handful of BIFF8 records a plain
 * table export uses. Enough for obligacjeskarbowe.pl, which offers no CSV at all.
 *
 * ponytail: no formulas, no number formats, no dates (this export writes them as
 * text), first worksheet only, and a string table that must fit one record — it
 * throws rather than silently losing strings. Reach for SheetJS if a real
 * spreadsheet ever has to be read.
 */

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;

/** Sector numbers of one FAT chain, in order. */
function chainOf(start: number, fat: number[]): number[] {
	const out: number[] = [];
	for (let s = start; s !== ENDOFCHAIN && s < fat.length; s = fat[s]) {
		if (out.length > fat.length) throw new Error('Corrupt .xls: sector chain loops.');
		out.push(s);
	}
	return out;
}

/** Pull one named stream out of an OLE2 compound file. */
function oleStream(buf: Buffer, want: string): Buffer {
	if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0)
		throw new Error('Not an .xls file.');

	const secSize = 1 << buf.readUInt16LE(30);
	const miniSize = 1 << buf.readUInt16LE(32);
	const cutoff = buf.readUInt32LE(56);
	const sector = (s: number) => buf.subarray((s + 1) * secSize, (s + 2) * secSize);
	const cat = (secs: number[], read: (s: number) => Buffer, size?: number) =>
		Buffer.concat(secs.map(read)).subarray(0, size);

	// DIFAT: the first 109 FAT sector numbers sit in the header, the rest in a chain
	// of DIFAT sectors whose last slot points at the next one.
	const difat: number[] = [];
	for (let i = 0; i < 109; i++) {
		const s = buf.readUInt32LE(76 + i * 4);
		if (s === FREESECT || s === ENDOFCHAIN) break;
		difat.push(s);
	}
	for (let d = buf.readUInt32LE(68); d !== FREESECT && d !== ENDOFCHAIN; ) {
		const base = (d + 1) * secSize;
		for (let i = 0; i < secSize / 4 - 1; i++) {
			const s = buf.readUInt32LE(base + i * 4);
			if (s !== FREESECT) difat.push(s);
		}
		d = buf.readUInt32LE(base + secSize - 4);
	}

	const fat: number[] = [];
	for (const s of difat)
		for (let i = 0; i < secSize / 4; i++) fat.push(buf.readUInt32LE((s + 1) * secSize + i * 4));

	// Directory: fixed 128-byte entries, name as a UTF-16 length in bytes incl. the NUL.
	const dir = cat(chainOf(buf.readUInt32LE(48), fat), sector);
	const entries = [];
	for (let o = 0; o + 128 <= dir.length; o += 128) {
		const len = dir.readUInt16LE(o + 64);
		if (!len) continue;
		entries.push({
			name: dir.toString('utf16le', o, o + len - 2),
			type: dir[o + 66],
			start: dir.readUInt32LE(o + 116),
			size: Number(dir.readBigUInt64LE(o + 120))
		});
	}

	const e = entries.find((x) => x.name === want);
	if (!e) throw new Error(`No "${want}" stream — is this a .xls workbook?`);
	if (e.size >= cutoff) return cat(chainOf(e.start, fat), sector, e.size);

	// Streams under the cutoff live packed inside the root entry's mini-sector store.
	const root = entries.find((x) => x.type === 5)!;
	const store = cat(chainOf(root.start, fat), sector, root.size);
	const miniTable = cat(chainOf(buf.readUInt32LE(60), fat), sector);
	const miniFat: number[] = [];
	for (let i = 0; i + 4 <= miniTable.length; i += 4) miniFat.push(miniTable.readUInt32LE(i));
	return cat(
		chainOf(e.start, miniFat),
		(s) => store.subarray(s * miniSize, (s + 1) * miniSize),
		e.size
	);
}

/** RK: a double with its low 34 bits dropped, optionally an integer and/or x100. */
function rk(d: Buffer, o: number): number {
	const raw = d.readInt32LE(o);
	let v: number;
	if (raw & 2) v = raw >> 2;
	else {
		const b = Buffer.alloc(8);
		b.writeInt32LE(raw & ~3, 4);
		v = b.readDoubleLE(0);
	}
	return raw & 1 ? v / 100 : v;
}

/** XLUnicodeString: char count, flags, then 8- or 16-bit chars plus optional extras. */
function xlString(d: Buffer, o: number) {
	const cch = d.readUInt16LE(o);
	const flags = d[o + 2];
	let p = o + 3;
	const rich = flags & 8 ? ((p += 2), d.readUInt16LE(p - 2)) : 0;
	const ext = flags & 4 ? ((p += 4), d.readUInt32LE(p - 4)) : 0;
	const bytes = cch * (flags & 1 ? 2 : 1);
	// The 8-bit form is UTF-16 with the high byte stripped, which is exactly latin1.
	const text = d.toString(flags & 1 ? 'utf16le' : 'latin1', p, p + bytes);
	return { text, end: p + bytes + rich * 4 + ext };
}

/** Cells of the first worksheet, as text, row-major and 0-indexed. */
export function readXls(input: ArrayBuffer | Buffer): string[][] {
	const wb = oleStream(Buffer.isBuffer(input) ? input : Buffer.from(input), 'Workbook');
	const sst: string[] = [];
	const rows: string[][] = [];
	const put = (r: number, c: number, v: string) => ((rows[r] ??= [])[c] = v);
	let sheets = 0;

	scan: for (let p = 0; p + 4 <= wb.length; ) {
		const type = wb.readUInt16LE(p);
		const len = wb.readUInt16LE(p + 2);
		const d = wb.subarray(p + 4, p + 4 + len);
		p += 4 + len;

		switch (type) {
			case 0x0809: // BOF — workbook globals first, then one per sheet
				if (d.readUInt16LE(2) === 0x0010 && sheets++) break scan;
				break;
			case 0x00fc: {
				// SST. A table too big for one record continues in CONTINUE records, and
				// splicing those needs per-string state we do not keep — refuse instead.
				const n = d.readUInt32LE(4);
				for (let o = 8; sst.length < n && o < d.length; ) {
					const s = xlString(d, o);
					sst.push(s.text);
					o = s.end;
				}
				if (sst.length < n)
					throw new Error(`.xls string table spans several records (${sst.length}/${n}).`);
				break;
			}
			case 0x00fd: // LABELSST
				put(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? '');
				break;
			case 0x0204: // LABEL
				put(d.readUInt16LE(0), d.readUInt16LE(2), xlString(d, 6).text);
				break;
			case 0x0203: // NUMBER
				put(d.readUInt16LE(0), d.readUInt16LE(2), String(d.readDoubleLE(6)));
				break;
			case 0x027e: // RK
				put(d.readUInt16LE(0), d.readUInt16LE(2), String(rk(d, 6)));
				break;
			case 0x00bd: {
				// MULRK: one record for a run of cells across a row.
				const r = d.readUInt16LE(0);
				const c0 = d.readUInt16LE(2);
				for (let i = 0; 4 + i * 6 + 6 <= d.length; i++) put(r, c0 + i, String(rk(d, 6 + i * 6)));
				break;
			}
		}
	}
	return Array.from(rows, (r) => Array.from(r ?? [], (c) => c ?? ''));
}
