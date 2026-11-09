# finance-app

Personal finance tracker for Bank Millennium, PKO BP and Bossa CSV exports, plus
manually-tracked investments and external accounts.

```bash
npm run dev                        # http://localhost:5173
npm test                           # bond math, every importer, prices and FX
npm run build && node build/index.js
```

What the importable files look like: [docs/formats.md](docs/formats.md). The column
comments in `src/lib/server/db.ts` are the schema documentation.

`npm test` runs `node:test` over `src/**/*.test.ts`; `npm run check` runs svelte-check.
The tests point `FINANCE_DB` at their own file and wipe it, and their fixtures are the
real exports sitting in the repo root, which are gitignored — a fresh clone fails them on
the missing file, and the assertions name exact row counts from those exports.

Data lives in `data/finance.db` (SQLite via the built-in `node:sqlite` — no native
build step). It is gitignored. Delete the file to start over; the schema is
recreated on boot and missing columns are added automatically.

## Pages

| Page | What it does |
|---|---|
| Dashboard | Net worth, income, expenses, savings rate, spending by category |
| Transactions | Filter, search, re-categorise, triage uncategorised merchants, manage rules |
| Investments | Positions, bonds, money made (gains, dividends, coupons, fees), trade history, cash ledger |
| Projection | Whole-fortune forecast, emergency runway, financial-independence target |
| Accounts | Rename bank accounts, add manual ones (other banks, XTB, Revolut), type monthly balances |
| Import | Upload a Millennium or PKO BP CSV, a Bossa `hisPW` CSV, a Bossa cash ledger, or an obligacjeskarbowe.pl `.xls` |

## How it fits together

SvelteKit 2 (Svelte 5 runes) + `node:sqlite`. No ORM, no API layer: every page loads
through a `+page.server.ts` that calls `src/lib/server/*` directly, and every write is a
form action. Chart.js is the only runtime dependency.

```
upload  ──▶ parse*()         ──▶ import*()        ──▶ SQLite (data/finance.db)
            pure, throws on         INSERT OR IGNORE      │
            a bad file              inside one tx         │
                                                          ▼
                                            stats.ts / trades.ts / bonds.ts
                                            read-only derivation, no cache in the DB
                                                          │
                                                          ▼
                                            +page.server.ts load() ──▶ +page.svelte
```

Nothing derived is stored: positions, cost basis, net worth, bond value and every chart
are recomputed per request. Two exceptions are written on purpose — `holding` rows with
`source='broker'` or `'treasury'`, mirrors of the trade history and the bond export so
imported positions run through the manual-holding code paths unchanged, and `price`,
because Yahoo is a network call.

Four conventions that bite if ignored:

- **`seq` is reverse order.** Millennium writes newest-first, so within one date the
  *smaller* `seq` is the *later* row: `ORDER BY date DESC, seq ASC`.
- **Conversion happens in SQL for transactions, in JS for balances.** `stats.ts`'s `PLN`
  snippet converts a `tx` row at the last rate on or before its own date; `fx()` converts
  balances and holdings at `now()`. Never convert at 1:1 as a fallback.
- **Derived flags are recomputed, not frozen.** `tx.transfer` and `tx.category` are a pure
  function of the row plus the current rules, which is why deleting a `Transfer` rule puts
  the row back into spending.
- **`fx()` and `monthEndCloses()` are memoised** on `total_changes()` + `data_version()`, so
  one render converts every figure at the same rates and a write anywhere invalidates them.

## Things worth knowing

**Own transfers are netted out.** Moving money to your own savings account is not
income and not an expense. Detection is by counter-IBAN only — `PRZELEW WEWNĘTRZNY`
means *intra-bank*, not *intra-owner*, so a transfer from another person's Millennium
account still counts as real income.

**Re-importing is safe.** Each row is keyed by a hash of account, date, amount,
description and balance, so overlapping exports add only what is new.

**Balances come from the bank.** The `Saldo` column is used as-is, never re-derived.
The export is newest-first, so rows carry a `seq` and month-end balances are picked
with `ORDER BY date DESC, seq ASC`.

**Two Bossa exports, one portfolio.** `hisPW` is exchange fills only, carrying the
broker's own commission split — the most exact cost basis, but one market and buys and
sells only. *historia finansowa* is the full cash ledger and the more complete file. They
overlap on the fills they share and collapse onto the same natural key, so import either
or both, in any order. Encodings, columns and that key are in
[formats.md](docs/formats.md).

**Cost basis is FIFO, per instrument *and per currency*.** The same ISIN can trade on
two markets — Energy Fuels was bought in PLN on the GPW and in USD on XASE — and one
queue for both would price USD lots at PLN cost. Buy commission joins the lot, sell
commission comes off the proceeds, so realised P/L is cash actually made, gross of the
19% Belka tax. An export that starts mid-history can sell shares it never shows being
bought; those go to *unmatched* rather than being priced at zero cost, which would book
the whole proceeds as profit.

**Open positions are rebuilt into holdings on every import**, as `holding` rows marked
`broker`, keyed on ISIN plus currency. Quantity and buy price are the FIFO cost of the
lots still open; the current price stays hand-typed and survives a re-import. Sell a
position to zero and its holding disappears.

**A tender offer is inferred.** `Rozliczenie wezwania TIM` pays cash for shares without
ever appearing as a fill, and names the instrument but not the quantity — so the whole
open position is taken as tendered, the position closes, and the row is flagged
*tendered* in the UI. Right for a tender that settles in full; check it if yours was
partial.

**Money made excludes your own deposits.** Realised gains + dividends + bond coupons +
bond principal − fees. `Przelew do DM BOŚ` is reported in the ledger and never counted:
moving money in is not a gain. Bond principal nets subscriptions, oversubscription
refunds and redemptions together, so a 100 PLN bond coming back as 101.06 shows as the
1.06 it earned, not 101.06 of income.

**Brokerage cash is a running sum.** The ledger has no balance column, unlike the bank
export, so cash is the sum of every operation imported — only right if the export
starts at account opening. It joins net worth as its own line; if you also track the
brokerage as a manual account, untick that account so it is not counted twice. It stays
out of the runway figure, being at a broker rather than spendable this month.

**Bonds are calculated, not quoted.** Give a bond its rate, maturity and compounding
frequency and the app derives current value, interest to date and the full payment
schedule. Untick *capitalised* for coupons paid out to your account instead of
compounding. Projections show gross and net of the 19% Belka tax.

**Savings rate** = `(income − expenses) / income`, transfers excluded from both.

**Uncategorised triage.** The bottom of Transactions ranks unmatched merchants by
money, not by count, and prefills a rule for each. Descriptions are normalised by
dropping the settlement date, country code and any token containing a digit — those
are ticket, order and store numbers, and removing them is what makes rows group.
Patterns are prefilled full-length (safe, matches one merchant); shorten them to
catch variants. Matching ignores case.

**No full history needed.** Balances come from the export's `Saldo` column, which is
the bank's own running balance — a one-month export gives exactly the same net worth
as a five-year one. For accounts you can't export at all, add a manual account on
the Accounts page and type this month's balance; that single figure is enough.

**Runway and FIRE.** Runway counts imported bank accounts plus any manual account
ticked as *cash*. Brokerages and holdings are excluded — you can't spend them
this month. The independence target is annual spending divided by the
withdrawal rate (4% by default, i.e. 25x annual spending).

**The projection opens on your real numbers.** Starting net worth, average monthly
income, savings rate, bond return (the weighted coupon of the bonds you hold) and
the stock/bond split all come from your own data; every one is then editable. The
sliders recompute in the browser, so nothing round-trips to the server.

## Not included

- FX for a currency the feed has never quoted. Amounts *are* converted, at the stored
  `<CUR>PLN=X` rates: a transaction at the rate in force on its own date, a balance or a
  holding at the newest rate. A currency with no rate at all is left out of every total
  and reported separately rather than counted at 1:1.
- Prices for a holding with no Yahoo ticker. Tag a holding with one (`CDR.WA`, `AAPL`)
  and *Refresh prices* pulls its daily closes and the FX rates; anything untagged keeps
  the price you typed. A listing quoted in a currency you do not hold it in is refused
  rather than converted.
- Share splits. Neither export lists them, so a split silently changes the quantity
  and makes the old cost basis per share wrong.
- Withholding tax on dividends. Gross amounts are recorded as the broker paid them.
- Bonds held at the broker are cash flow only — the ledger gives coupons and
  redemptions but no rate or maturity, so add the bond by hand for a projection.
- Tax lots other than FIFO.
- Day-count conventions for bonds — accrual is on month boundaries.
- Bonds bought away from par: interest accrues on the purchase price, not a
  separate nominal.
- Projection uses one blended return over the whole pot and smooth, non-volatile
  growth. Figures are nominal — no inflation, no tax on gains. It compares
  scenarios; it is not a retirement plan.
