<script lang="ts">
	import Chart from '$lib/Chart.svelte';
	import { money, moneyIn, percent, signed, colorFor } from '$lib/fmt';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const PERIODS = [
		['month', 'This month'],
		['3m', 'Last 3 months'],
		['all', 'All time']
	];

	const grid = { color: '#262b36' };
	const ticks = { color: '#8b93a7' };
	const axes = { x: { grid, ticks }, y: { grid, ticks } };

	const incomeVsExpenses = $derived({
		type: 'bar' as const,
		data: {
			labels: data.monthly.map((m) => m.month),
			datasets: [
				{ label: 'Income', data: data.monthly.map((m) => m.income), backgroundColor: '#4ade80' },
				{ label: 'Expenses', data: data.monthly.map((m) => m.expenses), backgroundColor: '#f87171' }
			]
		},
		options: {
			maintainAspectRatio: false,
			scales: axes,
			plugins: { legend: { labels: { color: '#8b93a7' } } }
		}
	});

	const spending = $derived({
		type: 'doughnut' as const,
		data: {
			labels: data.byCategory.map((c) => c.category),
			datasets: [
				{
					data: data.byCategory.map((c) => c.total),
					backgroundColor: data.byCategory.map((c) => colorFor(c.category)),
					borderColor: '#171a21'
				}
			]
		},
		options: {
			maintainAspectRatio: false,
			plugins: { legend: { position: 'right' as const, labels: { color: '#8b93a7' } } }
		}
	});

	const legend = { labels: { color: '#8b93a7' } };
	const stacked = { x: { stacked: true, grid, ticks }, y: { stacked: true, grid, ticks } };

	const expensesByCategory = $derived.by(() => {
		const months = data.monthly.map((m) => m.month);
		const cats = [...new Set(data.monthlyByCategory.map((r) => r.category))];
		const at = new Map(data.monthlyByCategory.map((r) => [`${r.month}|${r.category}`, r.total]));
		return {
			type: 'bar' as const,
			data: {
				labels: months,
				datasets: cats.map((c) => ({
					label: c,
					data: months.map((m) => at.get(`${m}|${c}`) ?? 0),
					backgroundColor: colorFor(c)
				}))
			},
			options: {
				maintainAspectRatio: false,
				scales: stacked,
				plugins: { legend, tooltip: { mode: 'index' as const, intersect: false } }
			}
		};
	});

	const netWorthArea = $derived({
		type: 'line' as const,
		data: {
			labels: data.netWorthSeries.months,
			datasets: data.netWorthSeries.sources.map((s) => ({
				label: s.label,
				data: s.values,
				borderColor: colorFor(s.label),
				backgroundColor: colorFor(s.label, 0.35),
				fill: true,
				pointRadius: 0,
				tension: 0.25
			}))
		},
		options: {
			maintainAspectRatio: false,
			scales: { x: { grid, ticks }, y: { stacked: true, grid, ticks } },
			plugins: { legend, tooltip: { mode: 'index' as const, intersect: false } }
		}
	});
</script>

<h1>Dashboard</h1>

{#if !data.hasData}
	<div class="panel">
		<p>No transactions yet. <a href="/import">Import a Millennium CSV</a> to get started.</p>
	</div>
{:else}
	<nav class="periods">
		{#each PERIODS as [key, label] (key)}
			<a href="?period={key}" class:sel={data.period === key}>{label}</a>
		{/each}
	</nav>

	<div class="grid">
		<div class="panel kpi">
			<div class="label">Net worth</div>
			<div class="value">{money(data.netWorth.total)}</div>
			<div class="sub">
				{#each data.netWorth.parts as p (p.label)}
					<div>{p.label} · {money(p.value)} <span class="muted">({p.as_of})</span></div>
				{/each}
			</div>
		</div>
		<div class="panel kpi">
			<div class="label">Income</div>
			<div class="value pos">{money(data.totals.income)}</div>
			<div class="sub">own-account transfers excluded</div>
		</div>
		<div class="panel kpi">
			<div class="label">Expenses</div>
			<div class="value neg">{money(data.totals.expenses)}</div>
			<div class="sub">own-account transfers excluded</div>
		</div>
		<div class="panel kpi">
			<div class="label">Saved</div>
			<div class="value" class:pos={data.totals.saved >= 0} class:neg={data.totals.saved < 0}>
				{percent(data.totals.savingsRate)}
			</div>
			<div class="sub">{money(data.totals.saved)} of {money(data.totals.income)}</div>
		</div>
	</div>

	{#if data.investments.cost}
		<div class="panel kpi" style="margin-top:1rem">
			<div class="label">Investments</div>
			<div class="value">
				{money(data.investments.value)}
				<span
					style="font-size:1rem"
					class:pos={data.investments.pl >= 0}
					class:neg={data.investments.pl < 0}
				>
					{signed(data.investments.pl)} ({percent(data.investments.plPct)})
				</span>
			</div>
			<div class="sub">cost basis {money(data.investments.cost)}</div>
		</div>
	{/if}

	<div class="grid" style="margin-top:1rem">
		<div class="panel">
			<h2>Income vs expenses by month</h2>
			<Chart config={incomeVsExpenses} />
		</div>
		<div class="panel">
			<h2>Spending by category</h2>
			<Chart config={spending} />
		</div>
	</div>

	<div class="panel" style="margin-top:1rem">
		<h2>Expenses by category and month</h2>
		<Chart config={expensesByCategory} height={320} />
	</div>

	<div class="panel" style="margin-top:1rem">
		<h2>Net worth by source</h2>
		<Chart config={netWorthArea} height={320} />
		<p class="note">
			Bank balances and manual snapshots are the ones the bank or you stated. Stocks are carried at
			cost, not market value, because there is no price history to back-date them — see
			<a href="/investments">Investments</a> for today's valuation. Bonds are accrued to each month.
		</p>
	</div>

	{#if data.excluded.length || data.doubleCountRisk}
		<div class="panel" style="margin-top:1rem">
			{#each data.excluded as e (e.currency)}
				<p class="note">
					Not in the PLN figures above — the app does no FX conversion:
					{#if e.holdings}<strong>{moneyIn(e.holdings, e.currency)}</strong> of holdings,{/if}
					{#if e.cash}<strong>{moneyIn(e.cash, e.currency)}</strong> of brokerage cash,{/if}
					{#if e.txns}{e.txns} {e.currency} bank transaction{e.txns === 1 ? '' : 's'},{/if}
					{#if e.rate && e.holdings + e.cash}
						together <strong>≈ {money((e.holdings + e.cash) * e.rate)}</strong> at the
						{e.rate} you last converted at ({e.rateAt}) — for reading only, it is counted nowhere.
					{:else}
						all held and shown in {e.currency}.
					{/if}
				</p>
			{/each}
			{#if data.doubleCountRisk}
				<p class="warn">
					You have both manual account snapshots and individual holdings. If a holding sits inside a
					snapshotted account (e.g. an XTB position), untick <em>include in net worth</em> for that
					account on the <a href="/accounts">Accounts</a> page or it is counted twice.
				</p>
			{/if}
		</div>
	{/if}
{/if}

<style>
	.periods {
		display: flex;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}
	.periods a {
		color: var(--muted);
		text-decoration: none;
		font-size: 0.85rem;
		padding: 0.2rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 99px;
	}
	.periods a.sel {
		color: var(--text);
		background: var(--panel);
	}
</style>
