<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let busy = $state(false);
</script>

<h1>Import</h1>

<div class="panel">
	<p class="note">
		Bank Millennium CSV export. Rows are keyed by a hash of account, date, amount, description and
		balance, so re-uploading an overlapping export adds only what is new.
	</p>

	<form
		method="POST"
		enctype="multipart/form-data"
		class="row"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update();
				busy = false;
			};
		}}
	>
		<label class="field">CSV file<input type="file" name="csv" accept=".csv,text/csv" required /></label>
		<button type="submit" disabled={busy}>{busy ? 'Importing…' : 'Import'}</button>
	</form>

	{#if form?.error}
		<p class="neg" style="margin-top:1rem">{form.error}</p>
	{:else if form?.added !== undefined}
		<p style="margin-top:1rem">
			<strong class="pos">{form.added} added</strong>, {form.skipped} already present
			<span class="note">({form.name})</span>
		</p>
	{/if}
</div>

<div class="panel" style="margin-top:1rem">
	<h2>Stored</h2>
	<p>
		{data.stored} transactions
		{#if data.range?.from}<span class="note">· {data.range.from} to {data.range.to}</span>{/if}
	</p>
</div>
