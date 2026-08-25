# finance-app

Personal finance tracker for Bank Millennium and Bossa CSV exports, plus
manually-tracked investments and external accounts.

```bash
npm run dev                        # http://localhost:5173
npm test                           # bond math + all three CSV importers
npm run build && node build/index.js
```

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
| Import | Upload a Millennium CSV, a Bossa `hisPW` CSV, or a Bossa cash ledger |

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

**Two Bossa exports, one portfolio.** Both are Windows-1250 and semicolon-separated,
and both are read as bytes rather than text — `file.text()` mangles *ilość*.

- **`hisPW`** — exchange fills only, with the broker's own commission split. Most exact
  cost basis, but it covers one market: it omits USD trades and anything that is not a
  buy or a sell.
- **historia finansowa** — the full cash ledger. Dividends, bond coupons and
  redemptions, deposits, currency exchanges, tender offers, fees, *and* every fill
  again. This is the more complete file.

They overlap, so a fill's primary key is natural: date, instrument, side, quantity,
price, currency and an occurrence counter. It deliberately excludes value, commission
and time — `hisPW` files 400 × 21.8385 as 8735.38 rather than 8735.40 and the ledger
has no clock, so anything derived from those would stop the two files recognising a
shared fill. The counter is what keeps a genuinely repeated fill (Energy Fuels sold
100 at 5.63 twice in one day) as two lots. Import either file, or both, in any order.

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

- FX conversion. Non-PLN positions and cash are stored, priced and shown in their own
  currency, but never added to a PLN total. The Investments page prints them beside the
  PLN figures with the rate you last converted at yourself, for reading only.
- Automatic share prices. Stock prices are typed by hand, imported positions included.
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
