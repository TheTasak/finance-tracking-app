<script lang="ts">
	import { enhance } from '$app/forms';
	import { money, moneyIn, rateFor } from '$lib/fmt';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const rateOf = $derived(rateFor(data.rates));

	const manual = $derived(data.accounts.filter((a: any) => a.kind === 'manual'));
	const bank = $derived(data.accounts.filter((a: any) => a.kind === 'bank'));
</script>

<h1>Accounts</h1>

<div class="panel scroll">
	<h2>Bank accounts</h2>
	<p class="note">Imported from CSV. Balance is the bank's own running Saldo on the newest row.</p>
	<table>
		<thead>
			<tr><th colspan="4">Name · IBAN · balance · in net worth</th></tr>
		</thead>
		<tbody>
			{#each bank as a (a.id)}
				<tr>
					<td colspan="4">
						<!-- One form per row so renaming and the net-worth toggle submit together. -->
						<form method="POST" action="?/updateAccount" class="bankrow" use:enhance>
							<input type="hidden" name="id" value={a.id} />
							<input name="label" value={a.label} />
							<span class="note">{a.iban}</span>
							<span class="num">
								{#if data.latestBalance[a.iban]}
									<!-- A foreign account is stated in its own currency; PLN is the conversion. -->
									{moneyIn(data.latestBalance[a.iban].balance, a.currency)}
									{#if a.currency !== 'PLN'}
										{#if rateOf(a.currency)}
											<span class="note">
												≈ {money(data.latestBalance[a.iban].balance * rateOf(a.currency))}
											</span>
										{:else}
											<span class="warn">no {a.currency}/PLN rate stored</span>
										{/if}
									{/if}
									<span class="note">{data.latestBalance[a.iban].date}</span>
								{:else}—{/if}
							</span>
							<label class="field">
								In net worth
								<input type="checkbox" name="in_net_worth" checked={!!a.in_net_worth} />
							</label>
							<button type="submit">Save</button>
						</form>
					</td>
				</tr>
			{:else}
				<tr><td colspan="4" class="note">Import a CSV first.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<div class="panel" style="margin-top:1rem">
	<h2>Manual accounts</h2>
	<p class="note">
		Anything you don't import a CSV for — another bank, a brokerage, a wallet, cash under the
		mattress. You type one balance per month and the net-worth line carries the last value forward
		over blank months, so a single current figure is enough to get started.
	</p>
	<p class="note">
		Tick <strong>cash</strong> for money you could spend this month — a current or savings account
		at another bank. Leave it unticked for invested money like XTB; that still counts toward net
		worth, just not toward your emergency runway.
	</p>

	{#each manual as a (a.id)}
		<form method="POST" action="?/updateAccount" class="row" use:enhance style="margin-bottom:.5rem">
			<input type="hidden" name="id" value={a.id} />
			<label class="field">Name<input name="label" value={a.label} /></label>
			<label class="field">
				In net worth
				<input type="checkbox" name="in_net_worth" checked={!!a.in_net_worth} />
			</label>
			<label class="field">
				Cash
				<input type="checkbox" name="is_cash" checked={!!a.is_cash} />
			</label>
			<span class="badge">{a.currency}</span>
			<button type="submit">Save</button>
			<button
				class="danger"
				type="submit"
				formaction="?/deleteAccount"
				onclick={(e) => !confirm(`Delete ${a.label} and its snapshots?`) && e.preventDefault()}
			>
				Delete
			</button>
		</form>
	{:else}
		<p class="note">None yet.</p>
	{/each}

	<form method="POST" action="?/addAccount" class="row" use:enhance style="margin-top:1rem">
		<label class="field">New account<input name="label" placeholder="XTB" required /></label>
		<label class="field">
			Currency
			<select name="currency"><option>PLN</option><option>EUR</option><option>USD</option></select>
		</label>
		<label class="field">
			Cash
			<input type="checkbox" name="is_cash" />
		</label>
		<button type="submit">Add</button>
	</form>
	{#if form?.error}<p class="neg">{form.error}</p>{/if}
</div>

{#if manual.length}
	<div class="panel" style="margin-top:1rem">
		<h2>Monthly balances</h2>
		<form method="POST" action="?/saveSnapshots" use:enhance>
			<div class="scroll">
				<table>
					<thead>
						<tr>
							<th>Month</th>
							{#each manual as a (a.id)}
								<th class="num">
									{a.label}
									{#if a.currency !== 'PLN'}<span class="note">{a.currency}</span>{/if}
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each data.months as m (m)}
							<tr>
								<td>{m}</td>
								{#each manual as a (a.id)}
									<td class="num">
										<input
											type="number"
											step="0.01"
											name="s|{a.id}|{m}"
											value={data.values[`${a.id}|${m}`] ?? ''}
											placeholder="—"
											style="width:8rem"
										/>
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<button type="submit" style="margin-top:1rem">Save balances</button>
			{#if form?.saved !== undefined}<span class="note"> {form.saved} saved</span>{/if}
		</form>
	</div>
{/if}

<style>
	.bankrow {
		display: grid;
		grid-template-columns: 1fr auto auto auto auto;
		gap: 1rem;
		align-items: center;
	}
	.bankrow .field {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
</style>
