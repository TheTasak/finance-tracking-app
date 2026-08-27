# Architecture

SvelteKit 2 (Svelte 5 runes) + `node:sqlite`. No ORM, no API layer: every page loads
through a `+page.server.ts` that calls `src/lib/server/*` directly, and every write is a
form action. Chart.js is the only runtime dependency.

Domain rules (what own transfers mean, how money made is defined, what is deliberately
not modelled) live in the top-level [README](../README.md). This file is the map: where
code lives and how data moves through it. [formats.md](formats.md) documents the four
files the app can eat.

## Data flow

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

Nothing derived is stored. Positions, cost basis, net worth, bond value and the charts
are recomputed on every request from `tx`, `trade`, `cashop`, `holding`, `snapshot` and
`price`. The two exceptions are written on purpose:

- `holding` rows with `source='broker'` / `'treasury'` — mirrors of the trade history and
  the bond export, rebuilt on every import so the manual-holding code paths (pricing,
  charts, net worth) work on imported positions unchanged.
- `price` — downloaded closes and FX rates, cached because Yahoo is a network call.

## Files

| File | Role |
|---|---|
| `lib/server/db.ts` | Connection, schema, migrations, `all/get/run/tx` helpers, `ibanKey`, `ownIbans` |
| `lib/server/import.ts` | Millennium CSV → `tx`. Row id = hash of account/date/amount/description/balance |
| `lib/server/categorize.ts` | Rules, seed list, merchant normalisation, `recategorizeAll` |
| `lib/server/trades.ts` | Both Bossa exports → `trade` + `cashop`; FIFO `positions()`, `portfolioIncome()`, `syncBrokerHoldings()` |
| `lib/server/xls.ts` | Minimal OLE2 + BIFF8 reader (obligacjeskarbowe.pl ships .xls only) |
| `lib/server/treasury.ts` | Historia dyspozycji .xls → bond `holding` rows |
| `lib/server/bonds.ts` | Month-by-month accrual, `valueAt`, `interestTo`, `project`, `BELKA` |
| `lib/server/prices.ts` | Yahoo chart API, `price` table, `fx()` lookup, `monthEndCloses()`, `refreshPrices()` |
| `lib/server/stats.ts` | Everything the pages read: totals, categories, `netWorth`, `netWorthSeries`, `holdings`, `projectionDefaults`, `excluded` |
| `lib/projection.ts` | Client-side wealth projection (`projectWealth`, `fireNumber`, `runway`) — pure, no DB |
| `lib/fmt.ts` | `Intl` money/percent formatters, category list, stable category colours |
| `lib/Chart.svelte` | Chart.js wrapper: `$effect` creates, teardown destroys |

## Routes

| Route | Loads | Actions |
|---|---|---|
| `/` | `totals`, `monthly`, `byCategory`, `monthlyByCategory`, `netWorth`, `netWorthSeries`, `excluded` | — |
| `/transactions` | filtered page of `tx` (100/page), rules, uncategorised merchants | `setCategory`, `addRule`, `deleteRule` |
| `/investments` | holdings, positions, income, cash ledger, trades, bond projection, rates | `addStock`, `addBond`, `setPrice`, `setRate`, `setSymbol`, `refreshPrices`, `remove` |
| `/projection` | `projectionDefaults` | — (sliders recompute in the browser) |
| `/accounts` | accounts, snapshot grid, latest bank balance | `addAccount`, `updateAccount`, `deleteAccount`, `saveSnapshots` |
| `/import` | row counts and date span per source | `bank`, `bossa`, `cash`, `bonds` |

## Tables

`tx` bank rows · `trade` broker fills · `cashop` broker cash ledger · `holding` stocks and
bonds (manual, `broker`, `treasury`) · `price` daily closes *and* FX rates
(`USDPLN=X`) · `rule` category patterns · `account` bank + manual accounts ·
`snapshot` typed monthly balances for manual accounts.

Full column comments are in `lib/server/db.ts` — that file is the schema documentation.
Schema changes go there: `CREATE TABLE IF NOT EXISTS` for new tables, plus a row in the
`ADD COLUMN` list so existing `data/finance.db` files catch up on boot.

## Conventions that bite if ignored

**Import is idempotent.** Every id is a hash of the row's own natural key, and every
insert is `INSERT OR IGNORE`. Re-importing overlapping exports adds only what is new,
and the two Bossa files recognise the fills they share. Do not add a surrogate key.

**`seq` is reverse order.** Millennium writes newest-first, so within one date the
*smaller* `seq` is the *later* row: `ORDER BY date DESC, seq ASC`.

**Money conversion happens in SQL for transactions, in JS for balances.** `stats.ts`'s
`PLN` snippet converts a `tx` row at the last rate on or before its own date; `fx()`
converts balances and holdings at `now()`. A currency with no rate at all yields NULL,
`SUM` skips it, and `excluded()` reports what fell out — never convert at 1:1 as a
fallback.

**Derived flags are recomputed, not frozen.** `tx.transfer` and `tx.category` are a pure
function of the row plus the current rules, which is why deleting a `Transfer` rule puts
the row back into spending (`recategorizeAll`).

**`fx()` and `monthEndCloses()` are memoised** on `total_changes()` + `data_version()`, so
one render converts every figure at the same rates and a write anywhere invalidates them.

**Bond value is arithmetic, never a quote.** Rate + maturity + frequency in, monthly
accrual out. Stocks are the opposite: a price from Yahoo, or typed in.

## Running it

```bash
npm run dev      # http://localhost:5173
npm test         # node:test over src/**/*.test.ts
npm run check    # svelte-check
npm run build && node build/index.js
```

Tests set `FINANCE_DB` to their own file and wipe it — `db.ts` reads that env var for
exactly this reason. Their fixtures are the real exports sitting in the repo root
(`Historia_transakcji_*.csv`, `hisPW (1).csv`, `*_historia_finansowa_*.csv`,
`HistoriaDyspozycji.xls`), which are gitignored, and the assertions name exact row counts
from those files: on a fresh clone with no exports the import tests fail on the missing
file, and swapping in a longer export means updating the counts.
