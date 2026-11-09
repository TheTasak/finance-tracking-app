<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let busy = $state('');

	const submit = (which: string) => () => {
		busy = which;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = '';
		};
	};

	const sources = $derived([
		{
			id: 'bank',
			title: 'Bank — Millennium',
			span: data.bank,
			unit: 'transactions',
			note: 'Rows are keyed by a hash of account, date, amount, description and balance, so re-uploading an overlapping export adds only what is new.'
		},
		{
			id: 'pko',
			title: 'Bank — PKO BP',
			span: data.bank,
			unit: 'bank transactions (all banks)',
			account: true,
			note: 'The “Historia operacji” CSV, exactly as downloaded (Windows-1250). The export never says which account it came from, so type the 26-digit account number once — it is remembered after the first import.'
		},
		{
			id: 'bossa',
			title: 'Brokerage fills — Bossa hisPW',
			span: data.trades,
			unit: 'fills',
			note: 'The transaction-history export: buys and sells only, with the broker’s own commission split. Import it for the most exact cost basis.'
		},
		{
			id: 'cash',
			title: 'Brokerage ledger — historia finansowa',
			span: data.ops,
			unit: 'operations',
			note: 'The full cash history: dividends, bond coupons and redemptions, deposits, currency exchanges, tender offers, fees — and the fills again, which collapse onto the ones hisPW already gave. This is the more complete file; hisPW covers one market only.'
		},
		{
			id: 'bonds',
			title: 'Treasury bonds — Konto Rejestrowe',
			span: data.bonds,
			unit: 'bond series',
			accept: '.xls',
			note: 'The “Historia dyspozycji” .xls, exactly as downloaded. Purchases of one series merge into a single holding. The export has no interest rate — type it in once per series on the portfolio page and it survives every re-import. Each purchase is also kept as an operation, listed under Bonds on the portfolio page.'
		}
	]);
</script>

<h1>Import</h1>

<p class="note">
	Both Bossa exports are semicolon-separated and Windows-1250 encoded — upload them
	exactly as downloaded. Every format is keyed on its own content, so re-importing is
	safe and overlapping exports add only what is new.
</p>

{#each sources as s (s.id)}
	<div class="panel" style="margin-top:1rem">
		<h2>{s.title}</h2>
		<p class="note">{s.note}</p>

		<form
			method="POST"
			action="?/{s.id}"
			enctype="multipart/form-data"
			class="row"
			style="margin-top:.75rem"
			use:enhance={submit(s.id)}
		>
			{#if s.account}
				<label class="field">
					Account number<input
						name="account"
						required
						size="34"
						placeholder="12 1020 0000 0000 0000 0000 0000"
						value={data.pkoAccounts[0] ?? ''}
					/>
				</label>
			{/if}
			<label class="field">
				File<input type="file" name="csv" accept={s.accept ?? '.csv,text/csv'} required />
			</label>
			<button type="submit" disabled={!!busy}>{busy === s.id ? 'Importing…' : 'Import'}</button>
		</form>

		<p style="margin-top:.75rem">
			{s.span.n} {s.unit} stored
			{#if s.span.from}<span class="note">· {s.span.from} to {s.span.to}</span>{/if}
		</p>
	</div>
{/each}

{#if form?.error}
	<p class="neg" style="margin-top:1rem">{form.error}</p>
{:else if form?.added !== undefined}
	<p style="margin-top:1rem">
		<strong class="pos">{form.added} added</strong>, {form.skipped} already present
		{#if 'fills' in form && form.fills}
			<span class="note">· {form.fills} of them new fills</span>
		{/if}
		{#if 'ops' in form && form.ops}
			<span class="note">· {form.ops} new operations</span>
		{/if}
		<span class="note">({form.name})</span>
		<a href="/investments" class="note">· view portfolio</a>
	</p>
{/if}
