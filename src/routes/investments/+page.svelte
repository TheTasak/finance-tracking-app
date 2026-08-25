<script lang="ts">
	import { enhance } from '$app/forms';
	import Chart from '$lib/Chart.svelte';
	import { money, percent, signed } from '$lib/fmt';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const stocks = $derived(data.holdings.filter((h) => h.kind === 'stock'));
	const bonds = $derived(data.holdings.filter((h) => h.kind === 'bond'));

	const bondTotals = $derived({
		principal: bonds.reduce((s, b) => s + b.cost, 0),
		accrued: bonds.reduce((s, b) => s + b.accrued, 0),
		atMaturity: bonds.reduce((s, b) => s + b.cost + b.projectedInterest, 0),
		remaining: bonds.reduce((s, b) => s + b.projectedInterest - b.accrued, 0)
	});

	const grid = { color: '#262b36' };
	const ticks = { color: '#8b93a7' };

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
			plugins: { legend: { labels: { color: '#8b93a7' } } }
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
			plugins: { legend: { labels: { color: '#8b93a7' } } }
		}
	});
</script>

<h1>Investments</h1>

{#if data.totals.cost}
	<div class="grid">
		<div class="panel kpi">
			<div class="label">Current value</div>
			<div class="value">{money(data.totals.value)}</div>
		</div>
		<div class="panel kpi">
			<div class="label">Cost basis</div>
			<div class="value">{money(data.totals.cost)}</div>
		</div>
		<div class="panel kpi">
			<div class="label">Profit / loss</div>
			<div class="value" class:pos={data.totals.pl >= 0} class:neg={data.totals.pl < 0}>
				{signed(data.totals.pl)}
				<span style="font-size:1rem">({percent(data.totals.plPct)})</span>
			</div>
		</div>
	</div>
{/if}

<!-- ── Stocks ───────────────────────────────────────────── -->
<div class="panel scroll" style="margin-top:1rem">
	<h2>Stocks</h2>
	{#if stocks.length}
		<table>
			<thead>
				<tr>
					<th>Ticker</th><th>Name</th><th class="num">Qty</th><th class="num">Buy price</th>
					<th class="num">Current price</th><th class="num">Value</th><th class="num">P/L</th><th></th>
				</tr>
			</thead>
			<tbody>
				{#each stocks as h (h.id)}
					<tr>
						<td><strong>{h.ticker}</strong></td>
						<td>{h.name}<div class="note">bought {h.buy_date || '—'}</div></td>
						<td class="num">{h.qty}</td>
						<td class="num">{money(h.buy_price)}</td>
						<td class="num">
							<form method="POST" action="?/setPrice" class="row" use:enhance>
								<input type="hidden" name="id" value={h.id} />
								<input type="number" name="price" step="0.0001" min="0" value={h.price ?? h.buy_price} style="width:7rem" />
								<button type="submit">Set</button>
							</form>
							<div class="note">{h.price_at ? `as of ${h.price_at}` : 'no price set — using buy price'}</div>
						</td>
						<td class="num">{money(h.value)}</td>
						<td class="num" class:pos={h.pl >= 0} class:neg={h.pl < 0}>
							{signed(h.pl)}<div class="note">{percent(h.plPct)}</div>
						</td>
						<td class="num">
							<form method="POST" action="?/remove" use:enhance>
								<input type="hidden" name="id" value={h.id} />
								<button class="danger" type="submit">Delete</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
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

<!-- ── Bonds ────────────────────────────────────────────── -->
<div class="panel scroll" style="margin-top:1rem">
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
							{#if b.isBond}
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
			A bond's value is calculated, not quoted — {money(bondTotals.remaining)} of interest is still
			to come. Value as of {data.month}.
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
	{#if form?.error}<p class="neg">{form.error}</p>{/if}
</div>

<!-- ── Projection ───────────────────────────────────────── -->
{#if data.projection.months.length}
	<div class="panel" style="margin-top:1rem">
		<h2>Future earnings from bonds</h2>
		<Chart config={earnings} height={320} />
		<p class="note">
			Gross interest, and the same net of {percent(data.belka)} Polish capital-gains tax. Projection
			assumes every bond is held to maturity at its fixed rate.
		</p>
	</div>

	{#if data.projection.byBond.length > 1}
		<div class="panel" style="margin-top:1rem">
			<h2>Interest by bond</h2>
			<Chart config={perBond} height={280} />
		</div>
	{/if}
{/if}
