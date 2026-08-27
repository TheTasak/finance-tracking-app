<script lang="ts">
	import { untrack } from 'svelte';
	import Chart from '$lib/Chart.svelte';
	import { money, percent } from '$lib/fmt';
	import { grid, ticks } from '$lib/charts';
	import { at, fireNumber, projectWealth, reaches, runway } from '$lib/projection';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const d = $derived(data.defaults);

	/** Server defaults -> the percent-based numbers the form actually binds to. */
	const snapshot = (x: PageData['defaults']) => ({
		start: Math.round(x.start),
		monthlyIncome: Math.round(x.monthlyIncome),
		savingsRate: Math.round(x.savingsRate * 100),
		stockReturn: +(x.stockReturn * 100).toFixed(1),
		bondReturn: +(x.bondReturn * 100).toFixed(1),
		stockAllocation: Math.round(x.stockAllocation * 100),
		incomeGrowth: x.incomeGrowth * 100,
		years: x.years,
		monthlyExpenses: Math.round(x.monthlyExpenses),
		withdrawalRate: +(x.withdrawalRate * 100).toFixed(1)
	});

	// untrack: these are seed values, not a live mirror of the load data.
	let k = $state(untrack(() => snapshot(data.defaults)));
	const reset = () => (k = snapshot(d));

	// Everything recomputes in the browser, so dragging a slider is instant.
	const w = $derived(
		projectWealth(
			{
				start: k.start,
				monthlyIncome: k.monthlyIncome,
				savingsRate: k.savingsRate / 100,
				stockReturn: k.stockReturn / 100,
				bondReturn: k.bondReturn / 100,
				stockAllocation: k.stockAllocation / 100,
				incomeGrowth: k.incomeGrowth / 100,
				years: k.years
			},
			data.month
		)
	);

	const monthlyDeposit = $derived((k.monthlyIncome * k.savingsRate) / 100);
	const MILESTONES = [250_000, 500_000, 1_000_000, 2_000_000];

	const fire = $derived(fireNumber(k.monthlyExpenses, k.withdrawalRate / 100));
	const fireMonth = $derived(reaches(w, fire));
	const months = $derived(runway(d.liquid, k.monthlyExpenses));

	// One label per year keeps a 20-year x-axis readable.
	const yearly = <T,>(arr: T[]) => arr.filter((_, i) => i % 12 === 0);

	const config = $derived({
		type: 'line' as const,
		data: {
			labels: yearly(w.months),
			datasets: [
				{
					label: 'Projected wealth',
					data: yearly(w.wealth),
					borderColor: '#4ade80',
					backgroundColor: '#4ade8022',
					fill: true,
					tension: 0.2,
					pointRadius: 0
				},
				{
					label: 'Money you put in',
					data: yearly(w.contributed),
					borderColor: '#60a5fa',
					borderDash: [5, 4],
					fill: false,
					tension: 0.2,
					pointRadius: 0
				},
				{
					// Flat dataset instead of the annotation plugin — one less dependency.
					label: `Financial independence (${money(fire)})`,
					data: yearly(w.months).map(() => fire),
					borderColor: '#fbbf24',
					borderDash: [2, 3],
					borderWidth: 1.5,
					fill: false,
					pointRadius: 0
				}
			]
		},
		options: {
			maintainAspectRatio: false,
			interaction: { mode: 'index' as const, intersect: false },
			scales: {
				x: { grid, ticks },
				y: {
					grid,
					ticks: {
						color: '#8b93a7',
						callback: (v: any) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)
					}
				}
			},
			plugins: { legend: { labels: { color: '#8b93a7' } } }
		}
	});
</script>

<h1>Projection</h1>

{#if !d.monthsOfHistory}
	<div class="panel">
		<p>No history yet. <a href="/import">Import a CSV</a> so the defaults mean something.</p>
	</div>
{/if}

<div class="panel">
	<h2>Assumptions</h2>
	<div class="knobs">
		<label class="field">
			Starting net worth
			<input type="number" bind:value={k.start} step="1000" min="0" />
		</label>
		<label class="field">
			Monthly income
			<input type="number" bind:value={k.monthlyIncome} step="500" min="0" />
		</label>
		<label class="field">
			Savings rate · <strong>{k.savingsRate}%</strong>
			<input type="range" bind:value={k.savingsRate} min="0" max="100" step="1" />
		</label>
		<label class="field">
			Stocks in the mix · <strong>{k.stockAllocation}%</strong>
			<input type="range" bind:value={k.stockAllocation} min="0" max="100" step="5" />
		</label>
		<label class="field">
			Stock return %/yr
			<input type="number" bind:value={k.stockReturn} step="0.5" min="-20" max="50" />
		</label>
		<label class="field">
			Bond return %/yr
			<input type="number" bind:value={k.bondReturn} step="0.25" min="0" max="50" />
		</label>
		<label class="field">
			Annual raise %
			<input type="number" bind:value={k.incomeGrowth} step="0.5" min="0" max="50" />
		</label>
		<label class="field">
			Monthly spending
			<input type="number" bind:value={k.monthlyExpenses} step="100" min="0" />
		</label>
		<label class="field">
			Withdrawal rate %
			<input type="number" bind:value={k.withdrawalRate} step="0.25" min="0.5" max="20" />
		</label>
		<label class="field">
			Horizon · <strong>{k.years} years</strong>
			<input type="range" bind:value={k.years} min="1" max="40" step="1" />
		</label>
	</div>
	<p class="note" style="margin-top:.75rem">
		Defaults come from your own history: {money(d.monthlyIncome)}/month average income and a
		{percent(d.savingsRate)} savings rate over {d.monthsOfHistory} month{d.monthsOfHistory === 1
			? ''
			: 's'}. You save <strong>{money(monthlyDeposit)}</strong> a month at these settings, growing at
		a blended <strong>{percent(w.blended)}</strong> a year.
		<button type="button" onclick={reset} style="margin-left:.5rem">Reset</button>
	</p>
</div>

<div class="grid" style="margin-top:1rem">
	<div class="panel kpi">
		<div class="label">In {k.years} years</div>
		<div class="value pos">{money(w.final)}</div>
		<div class="sub">from {money(k.start)} today</div>
	</div>
	<div class="panel kpi">
		<div class="label">You put in</div>
		<div class="value">{money(w.totalContributed)}</div>
		<div class="sub">including today's {money(k.start)}</div>
	</div>
	<div class="panel kpi">
		<div class="label">Growth on top</div>
		<div class="value pos">{money(w.totalGrowth)}</div>
		<div class="sub">
			{w.totalContributed ? percent(w.totalGrowth / w.totalContributed) : '—'} of what you paid in
		</div>
	</div>
	<div class="panel kpi">
		<div class="label">In 5 / 10 years</div>
		<div class="value" style="font-size:1.2rem">
			{money(at(w, 5))}<br />{money(at(w, 10))}
		</div>
	</div>
</div>

<div class="grid" style="margin-top:1rem">
	<div class="panel kpi">
		<div class="label">Emergency runway</div>
		<div class="value" class:pos={months >= 6} class:neg={months < 3}>
			{Number.isFinite(months) ? `${months.toFixed(1)} months` : '∞'}
		</div>
		<div class="sub">
			{money(d.liquid)} in cash ÷ {money(k.monthlyExpenses)}/month. Imported bank accounts plus
			manual accounts ticked as cash — holdings and brokerages don't count.
		</div>
	</div>
	<div class="panel kpi">
		<div class="label">Financial independence at</div>
		<div class="value">{money(fire)}</div>
		<div class="sub">
			{money(k.monthlyExpenses * 12)}/year ÷ {k.withdrawalRate}% — that is {(
				100 / k.withdrawalRate
			).toFixed(0)}× annual spending
		</div>
	</div>
	<div class="panel kpi">
		<div class="label">You get there</div>
		<div class="value" class:pos={!!fireMonth}>
			{fireMonth ?? `not within ${k.years} yrs`}
		</div>
		<div class="sub">
			{#if fireMonth}
				{(w.months.indexOf(fireMonth) / 12).toFixed(1)} years away · {money(w.wealth[w.months.indexOf(fireMonth)])}
			{:else}
				Stretch the horizon, save more, or spend less.
			{/if}
		</div>
	</div>
</div>

<div class="panel" style="margin-top:1rem">
	<h2>Fortune over time</h2>
	<Chart {config} height={340} />
	<p class="note">
		The gap between the green and blue lines is compounding; the amber line is the pot that would
		cover your spending forever. Nominal złoty, before inflation and tax on gains; returns are
		assumed smooth, which real markets are not.
	</p>
</div>

<div class="panel" style="margin-top:1rem">
	<h2>Milestones</h2>
	<table>
		<thead><tr><th>Target</th><th>Reached</th><th class="num">Years away</th></tr></thead>
		<tbody>
			{#each MILESTONES as target (target)}
				{@const hit = reaches(w, target)}
				<tr>
					<td>{money(target)}</td>
					<td>{hit ?? `not within ${k.years} years`}</td>
					<td class="num">
						{hit ? (w.months.indexOf(hit) / 12).toFixed(1) : '—'}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.knobs {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	}
	.knobs input[type='range'] {
		padding: 0;
		accent-color: #4ade80;
	}
</style>
