<script lang="ts">
	import { enhance } from '$app/forms';
	import Chart from '$lib/Chart.svelte';
	import { money, moneyIn, percent, priceIn, signed, signedIn } from '$lib/fmt';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const TABS = [
		['dashboard', 'Dashboard'],
		['portfolio', 'Portfolio'],
		['bonds', 'Bonds'],
		['stocks', 'Stocks']
	];
	// The tab lives in the URL so the GET filter forms below can carry it through a reload.
	const tab = $derived(TABS.some(([t]) => t === data.tab) ? data.tab : 'dashboard');

	const stocks = $derived(data.holdings.filter((h) => h.kind === 'stock'));
	const bonds = $derived(data.holdings.filter((h) => h.kind === 'bond'));
	// A part-sold position has a realised result too, so key on "has sold", not "is closed".
	const sold = $derived(data.positions.filter((p) => p.soldQty > 0 || p.dividends));
	/**
	 * PLN per unit, from the very rates the server converted the summary with, so a total
	 * added up here matches one added up there. 0 for a currency with no rate at all —
	 * which is exactly how the server drops it, and `excluded()` reports it.
	 */
	const rateOf = (currency: string) =>
		currency === 'PLN' ? 1 : (data.rates.find((r) => r.currency === currency)?.rate ?? 0);

	// The whole ledger arrives; the picker filters it here so the bond tab can still see
	// its own rows while the ledger is filtered to something else.
	const ops = $derived(data.kind ? data.ops.filter((o) => o.kind === data.kind) : data.ops);
	const bondOps = $derived(data.ops.filter((o) => o.kind === 'bond' || o.kind === 'coupon'));

	/** What each open holding has made: unrealised, plus anything banked on the same ISIN. */
	const held = $derived(
		data.holdings.map((h) => {
			const pos = h.isin
				? data.positions.find((p) => p.isin === h.isin && p.currency === h.currency)
				: undefined;
			const dividends = pos?.dividends ?? 0;
			const realized = pos?.realized ?? 0;
			return { ...h, dividends, realized, earned: h.pl + dividends + realized };
		})
	);

	/** Every held row folded into PLN — the only honest way to total a mixed portfolio. */
	const heldTotals = $derived(
		held.reduce(
			(s, h) => {
				const r = rateOf(h.currency);
				s.cost += h.cost * r;
				s.value += h.value * r;
				s.pl += h.pl * r;
				s.dividends += h.dividends * r;
				s.realized += h.realized * r;
				s.earned += h.earned * r;
				return s;
			},
			{ cost: 0, value: 0, pl: 0, dividends: 0, realized: 0, earned: 0 }
		)
	);

	const soldTotals = $derived(
		sold.reduce(
			(s, p) => {
				const r = rateOf(p.currency);
				s.commission += p.commission * r;
				s.realized += p.realized * r;
				s.dividends += p.dividends * r;
				return s;
			},
			{ commission: 0, realized: 0, dividends: 0 }
		)
	);

	const bondTotals = $derived({
		principal: bonds.reduce((s, b) => s + b.cost, 0),
		accrued: bonds.reduce((s, b) => s + b.accrued, 0),
		atMaturity: bonds.reduce((s, b) => s + b.cost + b.projectedInterest, 0),
		remaining: bonds.reduce((s, b) => s + b.projectedInterest - b.accrued, 0)
	});

	const grid = { color: '#262b36' };
	const ticks = { color: '#8b93a7' };
	const legend = { labels: { color: '#8b93a7' } };
	const month = (s: string) => (s ?? '').slice(0, 7);

	/** Sum rows into one number per month of `months`. Rows outside it are dropped. */
	const bucket = (
		months: string[],
		rows: any[],
		of: (r: any) => string,
		value: (r: any) => number
	) => {
		const idx = new Map(months.map((m, i) => [m, i]));
		const out = months.map(() => 0);
		for (const r of rows) {
			const i = idx.get(of(r));
			if (i !== undefined) out[i] += value(r);
		}
		return out;
	};

	const allocation = $derived({
		type: 'doughnut' as const,
		data: {
			labels: ['Stocks', 'Bonds', 'Brokerage cash'],
			datasets: [
				{
					data: [data.totals.stocks, data.totals.bonds, data.summary.cash],
					backgroundColor: ['#60a5fa', '#4ade80', '#fbbf24'],
					borderColor: '#171a21'
				}
			]
		},
		options: {
			maintainAspectRatio: false,
			plugins: { legend: { position: 'right' as const, labels: { color: '#8b93a7' } } }
		}
	});

	// Mixed chart: bars for the monthly credit, lines for the running total.
	const earnings = $derived({
		type: 'bar' as const,
		data: {
			labels: data.projection.months,
			datasets: [
				{
					type: 'bar' as const,
					label: 'Interest that month',
					data: data.projection.perMonth,
					backgroundColor: '#4ade80',
					yAxisID: 'y'
				},
				{
					type: 'line' as const,
					label: 'Cumulative (gross)',
					data: data.projection.cumulative,
					borderColor: '#60a5fa',
					backgroundColor: '#60a5fa22',
					fill: true,
					tension: 0.2,
					pointRadius: 0,
					yAxisID: 'y1'
				},
				{
					type: 'line' as const,
					label: `Cumulative after ${percent(data.belka)} tax`,
					data: data.projection.cumulativeNet,
					borderColor: '#fbbf24',
					borderDash: [5, 4],
					fill: false,
					tension: 0.2,
					pointRadius: 0,
					yAxisID: 'y1'
				}
			]
		},
		options: {
			maintainAspectRatio: false,
			interaction: { mode: 'index' as const, intersect: false },
			scales: {
				x: { grid, ticks },
				y: { position: 'left' as const, grid, ticks, title: { text: 'per month', display: true, color: '#8b93a7' } },
				y1: {
					position: 'right' as const,
					grid: { drawOnChartArea: false },
					ticks,
					title: { text: 'cumulative', display: true, color: '#8b93a7' }
				}
			},
			plugins: { legend }
		}
	});

	const perBond = $derived({
		type: 'bar' as const,
		data: {
			labels: data.projection.months,
			datasets: data.projection.byBond.map((b, i) => ({
				label: b.label,
				data: b.data,
				backgroundColor: ['#4ade80', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa'][i % 5]
			}))
		},
		options: {
			maintainAspectRatio: false,
			scales: { x: { stacked: true, grid, ticks }, y: { stacked: true, grid, ticks } },
			plugins: { legend }
		}
	});

	/**
	 * What was put into bonds and what came back out. Purchases come from the holdings —
	 * treasury bonds never touch the broker ledger — and the payouts from the ledger.
	 */
	const bondFlow = $derived.by(() => {
		const months = [
			...new Set([...bonds.map((b) => month(b.buy_date)), ...bondOps.map((o) => month(o.date))])
		]
			.filter(Boolean)
			.sort();
		const bought = bucket(months, bonds, (b) => month(b.buy_date), (b) => b.cost);
		let run = 0;
		const cumulative = months.map((_, i) => (run += bought[i]));
		const paid = (kind: string) =>
			bucket(months, bondOps.filter((o) => o.kind === kind), (o) => month(o.date), (o) => o.amount);
		return {
			months,
			config: {
				type: 'bar' as const,
				data: {
					labels: months,
					datasets: [
						{
							type: 'bar' as const,
							label: 'Bought',
							data: bought,
							backgroundColor: '#60a5fa',
							yAxisID: 'y'
						},
						{
							type: 'bar' as const,
							label: 'Interest paid out',
							data: paid('coupon'),
							backgroundColor: '#4ade80',
							yAxisID: 'y'
						},
						{
							type: 'bar' as const,
							label: 'Principal in/out',
							data: paid('bond'),
							backgroundColor: '#a78bfa',
							yAxisID: 'y'
						},
						{
							type: 'line' as const,
							label: 'Invested to date',
							data: cumulative,
							borderColor: '#fbbf24',
							tension: 0.2,
							pointRadius: 0,
							yAxisID: 'y1'
						}
					]
				},
				options: {
					maintainAspectRatio: false,
					interaction: { mode: 'index' as const, intersect: false },
					scales: {
						x: { grid, ticks },
						y: { position: 'left' as const, grid, ticks },
						y1: { position: 'right' as const, grid: { drawOnChartArea: false }, ticks }
					},
					plugins: { legend }
				}
			}
		};
	});

	/**
	 * Cash in and out of stocks per month, and the running total still at risk. One stack
	 * per currency — nothing is ever added across currencies, the app does no FX.
	 * ponytail: two currencies reuse the same two bar colours; the legend separates them.
	 */
	const tradeFlow = $derived.by(() => {
		const months = [...new Set(data.trades.map((t) => month(t.date)))].sort();
		const currencies = [...new Set(data.trades.map((t) => t.currency))];
		const datasets = currencies.flatMap((c) => {
			const rows = data.trades.filter((t) => t.currency === c);
			const at = (side: string) =>
				bucket(months, rows.filter((t) => t.side === side), (t) => month(t.date), (t) => t.net);
			const bought = at('K');
			const soldCash = at('S');
			let run = 0;
			const net = months.map((_, i) => (run += bought[i] - soldCash[i]));
			return [
				{
					type: 'bar' as const,
					label: `Bought (${c})`,
					data: bought,
					backgroundColor: '#60a5fa',
					stack: c,
					yAxisID: 'y'
				},
				{
					type: 'bar' as const,
					label: `Sold (${c})`,
					data: soldCash.map((v) => -v),
					backgroundColor: '#4ade80',
					stack: c,
					yAxisID: 'y'
				},
				{
					type: 'line' as const,
					label: `Net invested (${c})`,
					data: net,
					borderColor: '#fbbf24',
					tension: 0.2,
					pointRadius: 0,
					yAxisID: 'y1'
				}
			];
		});
		return {
			type: 'bar' as const,
			data: { labels: months, datasets },
			options: {
				maintainAspectRatio: false,
				interaction: { mode: 'index' as const, intersect: false },
				scales: {
					x: { stacked: true, grid, ticks },
					y: { stacked: true, position: 'left' as const, grid, ticks },
					y1: { position: 'right' as const, grid: { drawOnChartArea: false }, ticks }
				},
				plugins: { legend }
			}
		};
	});
</script>

<h1>Investments</h1>

<div class="tabs">
	{#each TABS as [t, label] (t)}
		<a href="/investments?tab={t}" aria-current={tab === t ? 'page' : undefined}>{label}</a>
	{/each}
</div>

{#if form?.error}<p class="neg">{form.error}</p>{/if}

<!-- ══ Dashboard ═════════════════════════════════════════ -->
{#if tab === 'dashboard'}
	{#if data.totals.cost || data.summary.cash}
		<div class="grid">
			<div class="panel kpi">
				<div class="label">Portfolio value</div>
				<div class="value">{money(data.totals.value)}</div>
				<div class="sub">cost {money(data.totals.cost)}</div>
			</div>
			<div class="panel kpi">
				<div class="label">Stocks</div>
				<div class="value">{money(data.totals.stocks)}</div>
				<div class="sub">{stocks.length} position{stocks.length === 1 ? '' : 's'} open</div>
			</div>
			<div class="panel kpi">
				<div class="label">Bonds</div>
				<div class="value">{money(data.totals.bonds)}</div>
				<div class="sub">{bonds.length} held · {money(bondTotals.remaining)} still to earn</div>
			</div>
			<div class="panel kpi">
				<div class="label">Brokerage cash</div>
				<div class="value">{money(data.summary.cash)}</div>
				<div class="sub">uninvested, from the ledger</div>
			</div>
			<div class="panel kpi">
				<div class="label">Unrealised P/L</div>
				<div class="value" class:pos={data.totals.pl >= 0} class:neg={data.totals.pl < 0}>
					{signed(data.totals.pl)}
					<span style="font-size:1rem">({percent(data.totals.plPct)})</span>
				</div>
				<div class="sub">on what you still hold</div>
			</div>
			{#if data.income.length}
				<div class="panel kpi">
					<div class="label">Realised P/L</div>
					<div
						class="value"
						class:pos={data.summary.realized >= 0}
						class:neg={data.summary.realized < 0}
					>
						{signed(data.summary.realized)}
					</div>
					<div class="sub">banked on closed lots</div>
				</div>
				<div class="panel kpi">
					<div class="label">Dividends & interest</div>
					<div class="value pos">{money(data.summary.payouts)}</div>
					<div class="sub">paid into the account</div>
				</div>
				<div class="panel kpi">
					<div class="label">Money made</div>
					<div class="value" class:pos={data.summary.made >= 0} class:neg={data.summary.made < 0}>
						{signed(data.summary.made)}
					</div>
					<div class="sub">everything but your own deposits</div>
				</div>
			{/if}
		</div>

		{#each data.excluded.filter((e) => e.holdings || e.cash) as e (e.currency)}
			<p class={e.converted ? 'note' : 'warn'} style="margin-top:1rem">
				{#if e.holdings}<strong>{moneyIn(e.holdings, e.currency)}</strong> of holdings{/if}
				{#if e.holdings && e.cash}and{/if}
				{#if e.cash}<strong>{moneyIn(e.cash, e.currency)}</strong> of cash{/if}
				{#if e.converted}
					— counted in the figures above at {e.currency}/PLN {e.rate.toFixed(4)} (Yahoo,
					{e.rateAt}), so ≈ {money((e.holdings + e.cash) * e.rate)}. Past figures convert at the
					rate of their own month, not this one.
				{:else}
					— left out of the figures above: no {e.currency}/PLN rate is stored, so it would have
					to be counted at 1:1. Refresh prices on the Stocks tab to pull one.
					{#if e.rate}
						For reading only, ≈ {money((e.holdings + e.cash) * e.rate)} at the
						{e.rate.toFixed(4)} you last converted at ({e.rateAt}).
					{/if}
				{/if}
			</p>
		{/each}

		{#if data.totals.value || data.summary.cash}
			<div class="panel" style="margin-top:1rem">
				<h2>Where the money sits</h2>
				<Chart config={allocation} height={240} />
				<p class="note">PLN only — foreign positions are listed above, unconverted.</p>
			</div>
		{/if}
	{:else}
		<p class="note">Nothing imported or entered yet. Add a stock or a bond, or use Import.</p>
	{/if}

	{#if data.projection.months.length}
		<div class="panel" style="margin-top:1rem">
			<h2>Future earnings from bonds</h2>
			<Chart config={earnings} height={320} />
			<p class="note">
				Gross interest, and the same net of {percent(data.belka)} Polish capital-gains tax.
				Projection assumes every bond is held to maturity at its fixed rate.
			</p>
		</div>
	{/if}

	{#if data.income.length}
		<div class="panel scroll" style="margin-top:1rem">
			<h2>Where the money came from</h2>
			<table>
				<thead>
					<tr>
						<th></th><th class="num">Realised gains</th><th class="num">Dividends</th>
						<th class="num">Bond interest</th><th class="num">Bond principal</th>
						<th class="num">Fees</th><th class="num">Money made</th>
					</tr>
				</thead>
				<tbody>
					{#each data.income as i (i.currency)}
						<tr>
							<td><strong>{i.currency}</strong></td>
							<td class="num" class:pos={i.realized >= 0} class:neg={i.realized < 0}>
								{signedIn(i.realized, i.currency)}
							</td>
							<td class="num pos">{i.dividends ? signedIn(i.dividends, i.currency) : '—'}</td>
							<td class="num pos">{i.coupons ? signedIn(i.coupons, i.currency) : '—'}</td>
							<td class="num" class:pos={i.bond >= 0} class:neg={i.bond < 0}>
								{i.bond ? signedIn(i.bond, i.currency) : '—'}
							</td>
							<td class="num neg">{i.fees ? signedIn(i.fees, i.currency) : '—'}</td>
							<td class="num" class:pos={i.total >= 0} class:neg={i.total < 0}>
								<strong>{signedIn(i.total, i.currency)}</strong>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="note" style="margin-top:.5rem">
				Figures are per currency, unconverted. <em>Bond principal</em> nets subscriptions,
				oversubscription refunds and redemptions together, so it shows the result on the bond
				rather than counting the principal coming back as income.
				{#each data.income.filter((i) => i.deposits) as i (i.currency)}
					Your own deposits — {moneyIn(i.deposits, i.currency)} — are in the ledger below but
					never counted here: moving money in is not a gain.
				{/each}
			</p>
		</div>
	{/if}

	{#if data.ops.length}
		<div class="panel scroll" style="margin-top:1rem">
			<h2>Brokerage cash ledger</h2>
			<form class="row" style="margin-bottom:.75rem">
				<input type="hidden" name="tab" value="dashboard" />
				<label class="field">
					Type
					<select name="kind">
						<option value="">All</option>
						{#each Object.entries(data.kinds) as [k, label] (k)}
							<option value={k} selected={data.kind === k}>{label}</option>
						{/each}
					</select>
				</label>
				<button type="submit">Filter</button>
				{#if data.kind}
					<a href="/investments?tab=dashboard" class="note" style="padding:.4rem">Reset</a>
				{/if}
			</form>

			<table>
				<thead>
					<tr>
						<th>Date</th><th>Type</th><th>Operation</th><th class="num">Amount</th>
					</tr>
				</thead>
				<tbody>
					{#each ops as o (o.id)}
						<tr>
							<td>{o.date}</td>
							<td><span class="badge">{data.kinds[o.kind] ?? o.kind}</span></td>
							<td>
								{o.title}
								{#if o.details}<div class="note">{o.details}</div>{/if}
							</td>
							<td class="num" class:pos={o.amount >= 0} class:neg={o.amount < 0}>
								{moneyIn(o.amount, o.currency)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="note" style="margin-top:.5rem">
				{ops.length} operations{data.kind ? ' (filtered)' : ''}.
				{#each data.cash as c (c.currency)}
					Balance {moneyIn(c.balance, c.currency)} ({c.from} to {c.to}).
				{/each}
				This is a running sum — the export carries no balance column, so it is only right if
				your file starts at account opening. If you also track this brokerage as a manual
				account, untick it on Accounts so it is not counted twice.
			</p>
		</div>
	{/if}
{/if}

<!-- ══ Portfolio ═════════════════════════════════════════ -->
{#if tab === 'portfolio'}
	<div class="panel scroll">
		<h2>What you hold now</h2>
		{#if held.length}
			<table>
				<thead>
					<tr>
						<th>Instrument</th><th>Type</th><th class="num">Qty</th><th class="num">Cost</th>
						<th class="num">Value</th><th class="num">Unrealised</th><th class="num">Dividends</th>
						<th class="num">Realised</th><th class="num">Earned</th>
					</tr>
				</thead>
				<tbody>
					{#each held as h (h.id)}
						<tr>
							<td>
								<strong>{h.ticker}</strong>
								{#if h.currency !== 'PLN'}<span class="badge">{h.currency}</span>{/if}
								<div class="note">{h.name}</div>
							</td>
							<td>
								{h.kind === 'bond' ? 'Bond' : 'Stock'}
								<div class="note">bought {h.buy_date || '—'}</div>
							</td>
							<td class="num">{h.qty}</td>
							<td class="num">{moneyIn(h.cost, h.currency)}</td>
							<td class="num">{moneyIn(h.value, h.currency)}</td>
							<td class="num" class:pos={h.pl >= 0} class:neg={h.pl < 0}>
								{signedIn(h.pl, h.currency)}<div class="note">{percent(h.plPct)}</div>
							</td>
							<td class="num pos">{h.dividends ? moneyIn(h.dividends, h.currency) : '—'}</td>
							<td class="num" class:pos={h.realized >= 0} class:neg={h.realized < 0}>
								{h.realized ? signedIn(h.realized, h.currency) : '—'}
							</td>
							<td class="num" class:pos={h.earned >= 0} class:neg={h.earned < 0}>
								<strong>{signedIn(h.earned, h.currency)}</strong>
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th colspan="3">Total in PLN</th>
						<th class="num">{money(heldTotals.cost)}</th>
						<th class="num">{money(heldTotals.value)}</th>
						<th class="num" class:pos={heldTotals.pl >= 0} class:neg={heldTotals.pl < 0}>
							{signed(heldTotals.pl)}
						</th>
						<th class="num pos">{heldTotals.dividends ? money(heldTotals.dividends) : '—'}</th>
						<th
							class="num"
							class:pos={heldTotals.realized >= 0}
							class:neg={heldTotals.realized < 0}
						>
							{heldTotals.realized ? signed(heldTotals.realized) : '—'}
						</th>
						<th class="num" class:pos={heldTotals.earned >= 0} class:neg={heldTotals.earned < 0}>
							{signed(heldTotals.earned)}
						</th>
					</tr>
				</tfoot>
			</table>
			<p class="note" style="margin-top:.5rem">
				Each row is in its own currency; the total converts every one of them at its newest
				stored rate{#each data.rates as r, i (r.currency)}{i ? ',' : ' —'} 1 {r.currency} =
					{r.rate.toFixed(4)} PLN{/each}. A currency with no rate stored is left out of the
				total rather than added at 1:1.
				<em>Earned</em> is the unrealised move plus every dividend and every realised gain
				booked on the same instrument, so a position you have trimmed still shows what it
				made in total. A bond's value is calculated from its terms, not quoted.
			</p>
		{:else}
			<p class="note">Nothing held yet.</p>
		{/if}
	</div>

	{#if sold.length}
		<div class="panel scroll" style="margin-top:1rem">
			<h2>What each instrument made</h2>
			<table>
				<thead>
					<tr>
						<th>Instrument</th><th class="num">Bought</th><th class="num">Sold</th>
						<th class="num">Still held</th><th class="num">Commission</th>
						<th class="num">Realised P/L</th><th class="num">Dividends</th><th class="num">Total</th>
					</tr>
				</thead>
				<tbody>
					{#each sold as p (p.isin + p.currency)}
						<tr>
							<td>
								<strong>{p.name}</strong>
								{#if p.currency !== 'PLN'}<span class="badge">{p.currency}</span>{/if}
								{#if p.inferred}<span class="badge">tendered</span>{/if}
								<div class="note">{p.isin}</div>
							</td>
							<td class="num">{p.boughtQty}</td>
							<td class="num">{p.soldQty}</td>
							<td class="num">{p.openQty || '—'}</td>
							<td class="num">{moneyIn(p.commission, p.currency)}</td>
							<td class="num" class:pos={p.realized >= 0} class:neg={p.realized < 0}>
								{signedIn(p.realized, p.currency)}
								{#if p.unmatchedQty}
									<div class="warn">{p.unmatchedQty} sold with no purchase imported</div>
								{/if}
							</td>
							<td class="num pos">{p.dividends ? moneyIn(p.dividends, p.currency) : '—'}</td>
							<td
								class="num"
								class:pos={p.realized + p.dividends >= 0}
								class:neg={p.realized + p.dividends < 0}
							>
								<strong>{signedIn(p.realized + p.dividends, p.currency)}</strong>
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th colspan="4">Total in PLN</th>
						<th class="num">{money(soldTotals.commission)}</th>
						<th
							class="num"
							class:pos={soldTotals.realized >= 0}
							class:neg={soldTotals.realized < 0}
						>
							{signed(soldTotals.realized)}
						</th>
						<th class="num pos">{soldTotals.dividends ? money(soldTotals.dividends) : '—'}</th>
						<th
							class="num"
							class:pos={soldTotals.realized + soldTotals.dividends >= 0}
							class:neg={soldTotals.realized + soldTotals.dividends < 0}
						>
							{signed(soldTotals.realized + soldTotals.dividends)}
						</th>
					</tr>
				</tfoot>
			</table>
			<p class="note" style="margin-top:.5rem">
				FIFO matching — the oldest lot is sold first, per instrument <em>and per currency</em>,
				because the same ISIN can trade on two markets with two cost bases. Both commissions are
				inside the realised figure, so it is cash actually made. Gross of the
				{percent(data.belka)} Belka tax.
			</p>
			{#if data.tradeTotals.inferred.length}
				<p class="warn">
					Tender offer{data.tradeTotals.inferred.length > 1 ? 's' : ''} on
					{data.tradeTotals.inferred.map((p) => p.name).join(', ')}: the ledger gives the cash
					but not the quantity, so the whole open position was taken as tendered. Correct if the
					tender settled in full — check it if yours was partial.
				</p>
			{/if}
			{#if data.tradeTotals.orphans.length}
				<p class="warn">
					Ledger operations naming an instrument with no imported trades:
					{data.tradeTotals.orphans.map((o) => `${o.symbol} (${money(o.total)})`).join(', ')}.
					Import the fills for those and they will be attributed.
				</p>
			{/if}
		</div>
	{/if}
{/if}

<!-- ══ Bonds ═════════════════════════════════════════════ -->
{#if tab === 'bonds'}
	<div class="panel scroll">
		<h2>Bonds</h2>
		{#if bonds.length}
			<table>
				<thead>
					<tr>
						<th>Symbol</th><th>Terms</th><th class="num">Qty</th><th class="num">Principal</th>
						<th class="num">Value now</th><th class="num">Interest to date</th>
						<th class="num">At maturity</th><th></th>
					</tr>
				</thead>
				<tbody>
					{#each bonds as b (b.id)}
						<tr>
							<td><strong>{b.ticker}</strong><div class="note">{b.name}</div></td>
							<td>
								{#if b.source === 'treasury'}
									<!-- The .xls export has no rate in it: it belongs to the emission, not the
									     purchase, so it is typed in here once and survives every re-import. -->
									<form method="POST" action="?/setRate" class="row" use:enhance>
										<input type="hidden" name="id" value={b.id} />
										<input
											type="number"
											name="coupon_rate"
											step="0.01"
											min="0"
											required
											placeholder="% p.a."
											style="width:5.5rem"
											value={b.coupon_rate ? (b.coupon_rate * 100).toFixed(2) : ''}
										/>
										<button type="submit">Rate</button>
									</form>
									<div class="note">
										{b.compound_freq} · {b.capitalize ? 'capitalised' : 'paid out'} · {b.buy_date} →
										{b.maturity}
									</div>
								{:else if b.isBond}
									{percent(b.coupon_rate ?? 0)} p.a. · {b.compound_freq}
									<span class="badge">{b.capitalize ? 'capitalised' : 'paid out'}</span>
									<div class="note">{b.buy_date} → {b.maturity}</div>
								{:else}
									<span class="warn">incomplete — re-add with a rate, maturity and frequency</span>
								{/if}
							</td>
							<td class="num">{b.qty}</td>
							<td class="num">{money(b.cost)}</td>
							<td class="num">{money(b.value)}</td>
							<td class="num pos">{money(b.accrued)}</td>
							<td class="num">
								{money(b.cost + b.projectedInterest)}
								<div class="note pos">{signed(b.projectedInterest)} total</div>
							</td>
							<td class="num">
								<form method="POST" action="?/remove" use:enhance>
									<input type="hidden" name="id" value={b.id} />
									<button class="danger" type="submit">Delete</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th colspan="3">Total</th>
						<th class="num">{money(bondTotals.principal)}</th>
						<th class="num"></th>
						<th class="num pos">{money(bondTotals.accrued)}</th>
						<th class="num">{money(bondTotals.atMaturity)}</th>
						<th></th>
					</tr>
				</tfoot>
			</table>
			<p class="note" style="margin-top:.5rem">
				A bond's value is calculated, not quoted — {money(bondTotals.remaining)} of interest is
				still to come. Value as of {data.month}.
			</p>
		{:else}
			<p class="note">No bonds yet.</p>
		{/if}

		<form method="POST" action="?/addBond" class="row" use:enhance style="margin-top:1rem">
			<label class="field">Symbol<input name="ticker" placeholder="TOS0529" required /></label>
			<label class="field">Name<input name="name" placeholder="3-year fixed rate" /></label>
			<label class="field">
				Qty<input type="number" name="qty" step="1" min="1" value="1" required />
			</label>
			<label class="field">
				Price per bond<input type="number" name="buy_price" step="0.01" min="0" value="100" required />
			</label>
			<label class="field">
				Interest % p.a.<input type="number" name="coupon_rate" step="0.01" min="0" placeholder="5" required />
			</label>
			<label class="field">Purchase date<input type="date" name="buy_date" required /></label>
			<label class="field">Maturity<input type="date" name="maturity" required /></label>
			<label class="field">
				Interest added
				<select name="compound_freq">
					<option value="monthly">Monthly</option>
					<option value="quarterly">Quarterly</option>
					<option value="annual">Annually</option>
				</select>
			</label>
			<label class="field">
				Capitalised<input type="checkbox" name="capitalize" checked />
			</label>
			<label class="field">
				Currency<select name="currency"><option>PLN</option><option>EUR</option><option>USD</option></select>
			</label>
			<button type="submit">Add bond</button>
		</form>
		<p class="note">
			Untick <em>capitalised</em> if the coupon is paid to your account instead of compounding into
			the bond.
		</p>
	</div>

	{#if bondFlow.months.length}
		<div class="panel" style="margin-top:1rem">
			<h2>Bond transaction history</h2>
			<Chart config={bondFlow.config} height={300} />
			<p class="note">
				Purchases come from the bonds themselves; interest and principal from the brokerage
				ledger, so treasury bonds bought outside the broker show a purchase with no payouts
				against it. Ledger amounts are as booked, unconverted.
			</p>
		</div>
	{/if}

	{#if data.projection.byBond.length > 1}
		<div class="panel" style="margin-top:1rem">
			<h2>Interest by bond</h2>
			<Chart config={perBond} height={280} />
		</div>
	{/if}

	{#if bondOps.length}
		<div class="panel scroll" style="margin-top:1rem">
			<h2>Bond operations</h2>
			<table>
				<thead>
					<tr><th>Date</th><th>Type</th><th>Operation</th><th class="num">Amount</th></tr>
				</thead>
				<tbody>
					{#each bondOps as o (o.id)}
						<tr>
							<td>{o.date}</td>
							<td><span class="badge">{data.kinds[o.kind] ?? o.kind}</span></td>
							<td>{o.title}{#if o.details}<div class="note">{o.details}</div>{/if}</td>
							<td class="num" class:pos={o.amount >= 0} class:neg={o.amount < 0}>
								{moneyIn(o.amount, o.currency)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="note" style="margin-top:.5rem">
				Subscriptions, oversubscription refunds, redemptions and coupons from the brokerage
				ledger — {bondOps.length} operations.
			</p>
		</div>
	{/if}
{/if}

<!-- ══ Stocks ════════════════════════════════════════════ -->
{#if tab === 'stocks'}
	<div class="panel scroll">
		<div class="row" style="justify-content:space-between;align-items:baseline">
			<h2>Stocks</h2>
			{#if stocks.some((h) => h.symbol)}
				<form method="POST" action="?/refreshPrices" use:enhance>
					<button type="submit">Refresh prices</button>
				</form>
			{/if}
		</div>
		{#if data.rates.length}
			<p class="note" style="margin:.25rem 0 .75rem">
				{#each data.rates as r, i (r.currency)}{i ? ' · ' : ''}<strong
						>1 {r.currency} = {r.rate.toFixed(4)} PLN</strong
					>
					({r.date}){/each}
				— Yahoo, refreshed together with the prices.
			</p>
		{/if}
		{#if form?.refreshed}
			<ul class="note" style="margin:.25rem 0 .75rem">
				{#each form.refreshed as r (r.symbol)}
					<li class:neg={!!r.error}>
						<strong>{r.symbol}</strong>
						{#if r.error}— {r.error}{:else}{r.close} · {r.rows} day{r.rows === 1 ? '' : 's'} stored{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if stocks.length}
			<table>
				<thead>
					<tr>
						<th>Ticker</th><th>Name</th><th class="num">Qty</th><th class="num">Buy price</th>
						<th>Ticker (Yahoo)</th>
						<th class="num">Current price</th><th class="num">Value</th><th class="num">P/L</th><th></th>
					</tr>
				</thead>
				<tbody>
					{#each stocks as h (h.id)}
						<tr>
							<td>
								<strong>{h.ticker}</strong>
								{#if h.source === 'broker'}<span class="badge">Bossa</span>{/if}
							</td>
							<td>{h.name}<div class="note">bought {h.buy_date || '—'}</div></td>
							<td class="num">{h.qty}</td>
							<td class="num">{priceIn(h.buy_price, h.currency)}</td>
							<td>
								<form method="POST" action="?/setSymbol" class="row" use:enhance>
									<input type="hidden" name="id" value={h.id} />
									<input
										name="symbol"
										value={h.symbol ?? ''}
										placeholder="CDR.WA"
										style="width:6.5rem"
										aria-label="Yahoo ticker for {h.ticker}"
									/>
									<button type="submit">Save</button>
								</form>
							</td>
							<td class="num">
								<form method="POST" action="?/setPrice" class="row" use:enhance>
									<input type="hidden" name="id" value={h.id} />
									<input type="number" name="price" step="0.0001" min="0" value={h.price ?? h.buy_price} style="width:7rem" />
									<button type="submit">Set</button>
								</form>
								<div class="note">{h.price_at ? `as of ${h.price_at}` : 'no price set — using buy price'}</div>
							</td>
							<td class="num">{moneyIn(h.value, h.currency)}</td>
							<td class="num" class:pos={h.pl >= 0} class:neg={h.pl < 0}>
								{signedIn(h.pl, h.currency)}<div class="note">{percent(h.plPct)}</div>
							</td>
							<td class="num">
								{#if h.source === 'broker'}
									<span class="note">imported</span>
								{:else}
									<form method="POST" action="?/remove" use:enhance>
										<input type="hidden" name="id" value={h.id} />
										<button class="danger" type="submit">Delete</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if stocks.some((h) => h.source === 'broker')}
				<p class="note" style="margin-top:.5rem">
					<span class="badge">Bossa</span> rows come from the imported trade history — quantity and
					buy price are the FIFO cost of the lots still open, commission included. Re-importing
					rebuilds them, so edit them at the broker, not here. The price is still yours to type.
				</p>
			{/if}
			<p class="note" style="margin-top:.5rem">
				Put a holding's <a href="https://finance.yahoo.com/" target="_blank" rel="noreferrer">Yahoo
				Finance</a> ticker in the <strong>Ticker</strong> column — <code>CDR.WA</code> for CD Projekt
				on the GPW, <code>VUAA.L</code> in London, <code>AAPL</code> in New York — and
				<em>Refresh prices</em> fills the price and stores the daily history behind the net-worth
				chart. Leave it blank to keep typing the price yourself. A listing quoted in a different
				currency than you hold is refused rather than converted: this app does no FX.
			</p>
		{:else}
			<p class="note">No stocks yet.</p>
		{/if}

		<form method="POST" action="?/addStock" class="row" use:enhance style="margin-top:1rem">
			<label class="field">Ticker<input name="ticker" placeholder="CDR" required /></label>
			<label class="field">Name<input name="name" placeholder="CD Projekt" /></label>
			<label class="field">Qty<input type="number" name="qty" step="0.0001" min="0" required /></label>
			<label class="field">Buy price<input type="number" name="buy_price" step="0.0001" min="0" required /></label>
			<label class="field">Buy date<input type="date" name="buy_date" /></label>
			<label class="field">
				Currency<select name="currency"><option>PLN</option><option>EUR</option><option>USD</option></select>
			</label>
			<button type="submit">Add stock</button>
		</form>
	</div>

	{#if data.trades.length}
		<div class="panel" style="margin-top:1rem">
			<h2>Trading activity{data.isin ? ' (filtered)' : ''}</h2>
			<Chart config={tradeFlow} height={300} />
			<p class="note">
				Cash out on buys, cash back on sells, and the running total still invested — one stack
				per currency, never added together. Commission is inside every figure.
			</p>
		</div>

		<div class="panel scroll" style="margin-top:1rem">
			<h2>Trade history</h2>
			<form class="row" style="margin-bottom:.75rem">
				<input type="hidden" name="tab" value="stocks" />
				<label class="field">
					Instrument
					<select name="isin">
						<option value="">All</option>
						{#each data.positions as p (p.isin + p.currency)}
							<option value={p.isin} selected={data.isin === p.isin}>
								{p.name} ({p.currency})
							</option>
						{/each}
					</select>
				</label>
				<button type="submit">Filter</button>
				{#if data.isin}
					<a href="/investments?tab=stocks" class="note" style="padding:.4rem">Reset</a>
				{/if}
			</form>

			<table>
				<thead>
					<tr>
						<th>Date</th><th>Instrument</th><th>Side</th><th class="num">Qty</th>
						<th class="num">Price</th><th class="num">Commission</th><th class="num">Cash</th>
					</tr>
				</thead>
				<tbody>
					{#each data.trades as t (t.id)}
						<tr>
							<td>{t.date}{#if t.time}<div class="note">{t.time}</div>{/if}</td>
							<td>{t.name}</td>
							<td class:pos={t.side === 'S'} class:neg={t.side === 'K'}>
								{t.side === 'K' ? 'Buy' : 'Sell'}
							</td>
							<td class="num">{t.qty}</td>
							<td class="num">{priceIn(t.price, t.currency)}</td>
							<td class="num">{moneyIn(t.commission, t.currency)}</td>
							<td class="num" class:pos={t.side === 'S'} class:neg={t.side === 'K'}>
								{signedIn(t.side === 'S' ? t.net : -t.net, t.currency)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="note" style="margin-top:.5rem">
				{data.trades.length} fills{data.isin ? ' (filtered)' : ''}. Bossa splits one order across
				commission tiers, so several rows can share a timestamp and price.
			</p>
		</div>
	{/if}
{/if}
