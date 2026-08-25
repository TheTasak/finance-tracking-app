# finance-app

Personal finance tracker for Bank Millennium CSV exports, plus manually-tracked
investments and external accounts.

```bash
npm run dev                        # http://localhost:5173
npm test                           # bond math + CSV import checks
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
| Investments | Stocks (manual price) and bonds (calculated), future-earnings chart |
| Projection | Whole-fortune forecast, emergency runway, financial-independence target |
| Accounts | Rename bank accounts, add manual ones (other banks, XTB, Revolut), type monthly balances |
| Import | Upload a Millennium CSV |

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

- FX conversion. Non-PLN rows are stored and shown but excluded from PLN totals.
- Automatic share prices. Stock prices are typed by hand.
- Day-count conventions for bonds — accrual is on month boundaries.
- Bonds bought away from par: interest accrues on the purchase price, not a
  separate nominal.
- Projection uses one blended return over the whole pot and smooth, non-volatile
  growth. Figures are nominal — no inflation, no tax on gains. It compares
  scenarios; it is not a retirement plan.
