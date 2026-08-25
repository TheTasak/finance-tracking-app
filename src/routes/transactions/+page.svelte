<script lang="ts">
	import { enhance } from '$app/forms';
	import { money, percent } from '$lib/fmt';
	import { CATEGORIES } from '$lib/fmt';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const options = $derived([...new Set([...CATEGORIES, ...data.categories])].sort());
	const label = (iban: string) =>
		data.accounts.find((a: any) => a.iban === iban)?.label ?? iban.slice(-6);

	const pageUrl = (offset: number) => {
		const q = new URLSearchParams(
			Object.entries(data.filters).filter(([, v]) => v) as [string, string][]
		);
		if (offset) q.set('offset', String(offset));
		return `?${q}`;
	};
</script>

<h1>Transactions</h1>

<form class="row panel" data-sveltekit-keepfocus>
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
	<a href="/transactions" class="note" style="padding:.4rem">Reset</a>
</form>

<p class="note">
	{data.total} matching · net of non-transfer rows
	<strong class:pos={data.sum >= 0} class:neg={data.sum < 0}>{money(data.sum)}</strong>
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
						{money(r.amount)}
						{#if r.currency !== 'PLN'}<span class="badge">{r.currency}</span>{/if}
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

{#if data.total > data.pageSize}
	<p class="row" style="margin-top:1rem">
		{#if data.offset > 0}
			<a href={pageUrl(Math.max(0, data.offset - data.pageSize))}>← Previous</a>
		{/if}
		<span class="note">{data.offset + 1}–{Math.min(data.offset + data.pageSize, data.total)}</span>
		{#if data.offset + data.pageSize < data.total}
			<a href={pageUrl(data.offset + data.pageSize)}>Next →</a>
		{/if}
	</p>
{/if}

{#if data.uncategorised.groups}
	<div class="panel" style="margin-top:1.5rem">
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
				long-tail one-offs — categorise them inline in the table above, or leave them.
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
