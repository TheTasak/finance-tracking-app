<script lang="ts">
	import { enhance } from '$app/forms';
	import Chart from '$lib/Chart.svelte';
	import { CATEGORIES, money, moneyIn, percent } from '$lib/fmt';
	import { incomeExpenseBars, spendingDoughnut } from '$lib/charts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const TABS = [
		['dashboard', 'Dashboard'],
		['history', 'Transaction history'],
		['rules', 'Rules']
	];
	// The tab lives in the URL so the GET filter form below can carry it through a reload.
	const tab = $derived(TABS.some(([t]) => t === data.tab) ? data.tab : 'dashboard');

	const options = $derived([...new Set([...CATEGORIES, ...data.categories])].sort());
	const label = (iban: string) =>
		data.accounts.find((a: any) => a.iban === iban)?.label ?? iban.slice(-6);

	const pageUrl = (offset: number) => {
		const q = new URLSearchParams(
			Object.entries(data.filters).filter(([, v]) => v) as [string, string][]
		);
		q.set('tab', 'history');
		if (offset) q.set('offset', String(offset));
		return `?${q}`;
	};

	const pages = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));
	const current = $derived(Math.min(pages, Math.floor(data.offset / data.pageSize) + 1));
	/**
	 * Page numbers to offer: the ends, and a two-wide window around where you are. Gaps
	 * between them render as an ellipsis, so 19 pages and 900 pages both fit on one line.
	 */
	const pageList = $derived.by(() =>
		[...new Set([1, pages, current - 2, current - 1, current, current + 1, current + 2])]
			.filter((n) => n >= 1 && n <= pages)
			.sort((a, b) => a - b)
	);

	const filtered = $derived(Object.values(data.filters).some(Boolean));

	const incomeVsExpenses = $derived(incomeExpenseBars(data.monthly));
	const spending = $derived(spendingDoughnut(data.byCategory));
</script>

<!-- Same filter on both tabs, so a slice you set up on one carries to the other. -->
{#snippet filterForm(t: string)}
	<form class="row panel" data-sveltekit-keepfocus>
		<input type="hidden" name="tab" value={t} />
		<label class="field">From<input type="date" name="from" value={data.filters.from} /></label>
		<label class="field">To<input type="date" name="to" value={data.filters.to} /></label>
		<label class="field">
			Account
			<select name="account">
				<option value="">All</option>
				{#each data.accounts as a (a.iban)}
					<option value={a.iban} selected={data.filters.account === a.iban}>{a.label}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			Category
			<select name="category">
				<option value="">All</option>
				{#each data.categories as c (c)}
					<option value={c} selected={data.filters.category === c}>{c}</option>
				{/each}
			</select>
		</label>
		<label class="field">Search<input name="search" value={data.filters.search} /></label>
		<button type="submit">Filter</button>
		<a href="/transactions?tab={t}" class="note" style="padding:.4rem">Reset</a>
	</form>
{/snippet}

<h1>Transactions</h1>

<div class="tabs">
	{#each TABS as [t, label] (t)}
		<a href="/transactions?tab={t}" aria-current={tab === t ? 'page' : undefined}>{label}</a>
	{/each}
</div>

<!-- ══ Dashboard ═════════════════════════════════════════ -->
{#if tab === 'dashboard'}
	{@render filterForm('dashboard')}

	{#if data.summary.n}
		<div class="grid" style="margin-top:1rem">
			<div class="panel kpi">
				<div class="label">Income</div>
				<div class="value pos">{money(data.summary.income)}</div>
				<div class="sub">own-account transfers excluded</div>
			</div>
			<div class="panel kpi">
				<div class="label">Expenses</div>
				<div class="value neg">{money(data.summary.expenses)}</div>
				<div class="sub">own-account transfers excluded</div>
			</div>
			<div class="panel kpi">
				<div class="label">Net</div>
				<div class="value" class:pos={data.summary.saved >= 0} class:neg={data.summary.saved < 0}>
					{money(data.summary.saved)}
				</div>
				<div class="sub">
					{data.summary.income > 0 ? percent(data.summary.saved / data.summary.income) : '—'} of income
				</div>
			</div>
			<div class="panel kpi">
				<div class="label">Transactions</div>
				<div class="value">{data.summary.n}</div>
				<div class="sub">
					{data.total} matching including transfers{filtered ? ' · filtered' : ''}
				</div>
			</div>
		</div>

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

		{#if data.uncategorised.groups}
			<p class="note" style="margin-top:1rem">
				<strong>{money(data.uncategorised.total)}</strong> across {data.uncategorised.txns}
				transactions sits in {data.uncategorised.groups} uncategorised merchants —
				<strong>{percent(data.uncategorised.share)}</strong> of all spending.
				<a href="/transactions?tab=rules">Make a few rules</a> and the breakdown above sharpens up.
			</p>
		{/if}
	{:else}
		<div class="panel" style="margin-top:1rem">
			<p class="note">
				{filtered
					? 'Nothing matches these filters.'
					: 'No transactions yet.'}
				{#if !filtered}<a href="/import">Import a Millennium CSV</a> to get started.{/if}
			</p>
		</div>
	{/if}
{/if}

<!-- ══ Transaction history ═══════════════════════════════ -->
{#if tab === 'history'}
	{@render filterForm('history')}

	<p class="note">
		{data.total} matching · net of non-transfer rows
		<strong class:pos={data.summary.saved >= 0} class:neg={data.summary.saved < 0}>
			{money(data.summary.saved)}
		</strong>
	</p>

	<div class="panel scroll">
		<table>
			<thead>
				<tr>
					<th>Date</th>
					<th>Account</th>
					<th>Counterparty / description</th>
					<th class="num">Amount</th>
					<th>Category</th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as r (r.id)}
					<tr class:transfer={r.transfer}>
						<td>{r.date}</td>
						<td>{label(r.account)}</td>
						<td>
							{r.counterparty || r.type}
							<div class="note">{r.description}</div>
						</td>
						<td class="num" class:pos={r.amount > 0 && !r.transfer} class:neg={r.amount < 0 && !r.transfer}>
							{moneyIn(r.amount, r.currency)}
						</td>
						<td>
							{#if r.transfer}
								<span class="badge">transfer</span>
							{:else}
								<form method="POST" action="?/setCategory" use:enhance>
									<input type="hidden" name="id" value={r.id} />
									<select name="category" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
										{#each options as c (c)}
											<option value={c} selected={r.category === c}>{c}</option>
										{/each}
									</select>
								</form>
							{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="note">Nothing matches these filters.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if pages > 1}
		<p class="pager">
			{#if current > 1}
				<a href={pageUrl((current - 2) * data.pageSize)}>← Previous</a>
			{/if}
			{#each pageList as n, i (n)}
				{#if i && n > pageList[i - 1] + 1}<span>…</span>{/if}
				{#if n === current}
					<strong aria-current="page">{n}</strong>
				{:else}
					<a href={pageUrl((n - 1) * data.pageSize)}>{n}</a>
				{/if}
			{/each}
			{#if current < pages}
				<a href={pageUrl(current * data.pageSize)}>Next →</a>
			{/if}
			<span class="note">
				{data.offset + 1}–{Math.min(data.offset + data.pageSize, data.total)} of {data.total} rows
				· page {current} of {pages}
			</span>
		</p>
	{/if}
{/if}

<!-- ══ Rules ═════════════════════════════════════════════ -->
{#if tab === 'rules'}
	{#if data.uncategorised.groups}
		<div class="panel">
			<h2>Uncategorised merchants</h2>
			<p class="note">
				<strong>{money(data.uncategorised.total)}</strong> across
				{data.uncategorised.txns} transactions and {data.uncategorised.groups} merchants —
				<strong>{percent(data.uncategorised.share)}</strong> of all spending. Biggest first, so a
				handful of rules covers most of it.
			</p>
			<p class="note">
				Each pattern is prefilled with the full merchant name, which matches only that merchant.
				Shorten it to catch variants — <code>Decathlon</code> catches both the Łódź and Warszawa
				spellings. Matching ignores case.
			</p>

			<div class="scroll">
				<table>
					<thead>
						<tr>
							<th>Merchant</th>
							<th class="num">Spent</th>
							<th class="num">Txns</th>
							<th>Make a rule</th>
						</tr>
					</thead>
					<tbody>
						{#each data.uncategorised.list as m (m.merchant)}
							<tr>
								<td>{m.merchant}</td>
								<td class="num neg">{money(m.total)}</td>
								<td class="num">{m.n}</td>
								<td>
									<form method="POST" action="?/addRule" class="row" use:enhance>
										<input name="pattern" value={m.merchant} size="24" required />
										<!-- Placeholder first so a stray click can't silently pick "Eating out". -->
										<select name="category" required>
											<option value="" disabled selected>Category…</option>
											{#each options.filter((c) => c !== 'Transfer' && c !== 'Uncategorised') as c (c)}
												<option value={c}>{c}</option>
											{/each}
										</select>
										<button type="submit">Add</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if data.uncategorised.groups > data.uncategorised.shown}
				<p class="note" style="margin-top:.75rem">
					Showing the top {data.uncategorised.shown} of {data.uncategorised.groups}. The rest are
					long-tail one-offs — categorise them inline on
					<a href="/transactions?tab=history">Transaction history</a>, or leave them.
				</p>
			{/if}
		</div>
	{/if}

	<div class="panel" style="margin-top:1.5rem">
		<h2>Category rules</h2>
		<p class="note">
			First matching pattern wins (case-insensitive substring of description, counterparty and type).
			Adding or deleting a rule re-categorises every stored transaction, overwriting manual edits.
		</p>
		<form method="POST" action="?/addRule" class="row" use:enhance>
			<label class="field">Pattern<input name="pattern" placeholder="LIDL" required /></label>
			<label class="field">
				Category
				<input name="category" list="cats" placeholder="Groceries" required />
				<datalist id="cats">
					{#each options as c (c)}<option value={c}></option>{/each}
				</datalist>
			</label>
			<button type="submit">Add rule</button>
		</form>

		<div class="scroll" style="margin-top:1rem">
			<table>
				<thead><tr><th>Pattern</th><th>Category</th><th></th></tr></thead>
				<tbody>
					{#each data.rules as r (r.id)}
						<tr>
							<td>{r.pattern}</td>
							<td>{r.category}</td>
							<td class="num">
								<form method="POST" action="?/deleteRule" use:enhance>
									<input type="hidden" name="id" value={r.id} />
									<button class="danger" type="submit">Delete</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{/if}

<style>
	.pager {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
		flex-wrap: wrap;
		margin-top: 1rem;
	}
	.pager .note {
		margin-left: auto;
	}
</style>
