# Import formats

Five files, five parsers, all in `src/lib/server/`. Every parser is pure: text or bytes
in, rows out, `throw new Error` naming the row and the problem on anything it cannot
read. Nothing touches the database until the matching `import*()` runs, and that runs in
one transaction.

## 1. Bank Millennium — "Historia transakcji" CSV

`import.ts` · `parseMillennium(text)` → `tx`

UTF-8 with a BOM, comma-separated, `""` escapes, **newest row first**. Columns are found
by Polish header name, not position: `Numer rachunku/karty`, `Data transakcji`,
`Data rozliczenia`, `Rodzaj transakcji`, `Na konto/Z konta`, `Odbiorca/Zleceniodawca`,
`Opis`, `Obciążenia`, `Uznania`, `Saldo`, `Waluta`.

- Debits already carry a minus sign; `amount = Obciążenia || Uznania`.
- `Saldo` is the bank's own running balance and is stored as-is — never re-derived. Hence
  a one-month export gives the same net worth as a five-year one.
- `Na konto/Z konta` is reduced to digits (`ibanKey`) and kept as `counter_iban`; a
  counter-IBAN the user owns is what makes a row an own transfer. `PRZELEW WEWNĘTRZNY`
  is *not* a signal — Millennium uses it for any intra-bank transfer.
- Row id: `sha256(account|date|amount|description|balance)`.
- Every account in the file is registered in `account` *before* the rows are inserted, so
  own-transfer detection works on the very first import.

## 1b. PKO BP — "Historia operacji" CSV

`import.ts` · `parsePko(text, account)` → `tx` (same `Row` and `importRows()` as Millennium)

**Windows-1250**, comma-separated, `""` escapes. Columns: `Data operacji`, `Data waluty`,
`Typ transakcji`, `Kwota` (signed), `Waluta`, `Saldo po transakcji`, `Opis transakcji`,
followed by unnamed columns. Those columns hold `"Label: value"` cells such as `Rachunek odbiorcy`/`nadawcy`,
`Nazwa odbiorcy`/`nadawcy`, `Tytuł` and `Lokalizacja`.

- **The export never names its own account.** The import form asks for the 26-digit
  number and prefills it from any account with PKO's bank code (`1020`) already in `tx`.
- Counterparty = `Nazwa …`, else the `Adres:` part of `Lokalizacja` (web/card payments);
  a `Tytuł` that is only digits (a payment reference) is replaced by that address.
- Days come newest-first, but rows **within a day are not ordered**. `seq` is rebuilt per
  day from the balance chain (`balance − amount` = previous row's balance), falling back to file
  order if the chain does not close, so `date DESC, seq ASC` finds the closing balance.
- Row id: `sha256(account|date|amount|all detail cells|balance)`.

## 2. Bossa — `hisPW` (exchange fills)

`trades.ts` · `parseBossa(text)` → `trade`

**Windows-1250, semicolon-separated.** Read as bytes and decoded explicitly —
`file.text()` mangles `ilość`. Columns: `data`, `papier`, `isin`, `ilość`, `-` (side),
`cena`, `wartość`, `prowizja`, `po prowizji`, `waluta`. Side is `K` (kupno) / `S`
(sprzedaż). Dates arrive as `DD.MM.YYYY HH:MM:SS`.

- One row per **fill**, not per order: Bossa splits an order across commission tiers.
- `po prowizji` (cash actually moved) is checked against `wartość ± prowizja` and the file
  is rejected if its own arithmetic is off by more than 0.02 — a wrong figure here would
  poison every cost basis downstream.
- `wartość` is read for that check and never stored: it is `qty × price` give or take the
  broker's rounding.
- Most exact source, narrowest coverage: one market, buys and sells only.

## 3. Bossa — "historia finansowa" (cash ledger)

`trades.ts` · `parseCash(text)` → `{ ops, trades }` → `cashop` + `trade`

Same encoding and separator. Columns: `data`, `tytuł operacji`, `szczegóły`, `kwota`,
`waluta`. Amounts are signed. The whole cash story: deposits, dividends, bond coupons and
redemptions, FX conversions, tender offers, fees — **and every fill again**.

The kind has to be read off Polish prose in the title, and order matters
(`classify()` in `trades.ts`):

| Title matches | `kind` |
|---|---|
| `Rozliczenie transakcji…` | `trade` (the fill is split back out) |
| `…prowizja…`, `Opłata…` | `fee` — tested before `tender`, so "Rozliczenie wezwania - prowizja TIM" is a fee |
| `Rozliczenie wezwania X` | `tender` |
| `Wypłata dywidendy [brutto] X` | `dividend` |
| `…odsetek…` | `coupon` |
| `Zapisy na obligacje` / `Wykup obligacji` / `Zwrot nadpłaty` | `bond` (principal; netted, so 100 → 101.06 earns 1.06) |
| `Przelew…` | `deposit` — reported, never counted as a gain |
| `Wymiana waluty X/Y rate` | `fx` — the only place the user's own conversion rate is recorded |
| anything else | `other` |

A `trade` row's `szczegóły` is the one structured field:
`NAME (ISIN) QTY x PRICE CUR nr REF`. The fill is rebuilt from it and the commission
derived from the cash moved (the ledger states only the total), which can land a cent
from the broker's own split — so when both files are imported, `hisPW` wins by arriving
first through `INSERT OR IGNORE`.

**Shared fill identity** (both files): `sha256(date|isin|side|qty|price|currency|n)` where
`n` counts occurrences within that group. Value, commission and time are deliberately
excluded — `hisPW` rounds `wartość` its own way and the ledger has no clock, so anything
derived from those would stop the two files recognising the same fill. `n` is what keeps a
genuinely repeated fill (sold 100 at 5.63 twice in one day) as two lots.

Cash op id: `sha256(date|title|details|amount|currency|dup)`.

## 4. obligacjeskarbowe.pl — "Historia dyspozycji" `.xls`

`treasury.ts` · `parseTreasuryXls(buf)` → bond `holding` rows, via `xls.ts`

The site offers no CSV, so `xls.ts` reads the OLE2 container and the handful of BIFF8
records a plain table uses (`SST`, `LABELSST`, `LABEL`, `NUMBER`, `RK`, `MULRK`), first
worksheet only. It refuses a string table that spans `CONTINUE` records rather than
losing strings quietly. Reach for SheetJS if a real spreadsheet ever has to be read.

Columns: `DATA DYSPOZYCJI`, `RODZAJ DYSPOZYCJI`, `KOD OBLIGACJI`, `LICZBA OBLIGACJI`,
`KWOTA OPERACJI`, `STATUS`.

- It is a disposition log, not a portfolio: each purchase appears twice, as the order and
  as its execution. Only `zakup papierów` + `zrealizowan*` rows count.
- **No interest rate anywhere in the export** — the rate belongs to the emission, so it is
  typed once per series on `/investments` and `coupon_rate` is left out of both the insert
  and the update so a re-import can never wipe it.
- Bond type comes from the code prefix (`OTS`, `ROR`, `DOR`, `TOS`, `COI`, `EDO`, `ROS`,
  `ROD`) → term, compounding frequency, and whether interest capitalises.
- Maturity is read off the code: `TOS0827` → August 2027, on the day of the month it was
  bought (clamped to the month's length).
- Lots of one code merge into one holding — every purchase of a code falls in the same
  month, and accrual works at month granularity anyway.
- Nothing is ever deleted: redemption has no row in this export yet, so a matured series
  is removed by hand.

## Adding another source

1. `parse*()` in `lib/server/` — pure, header-name lookup, throw with the row number.
2. `import*()` — natural-key id, `INSERT OR IGNORE`, wrapped in `tx()`.
3. An action in `routes/import/+page.server.ts`, reusing the `upload()` helper (20 MB cap,
   error shape); add a card to `routes/import/+page.svelte` and a `span()` to its `load`.
4. A test with a real export, asserting the row count and a re-import adding zero.
