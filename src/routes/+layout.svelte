<script lang="ts">
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import './app.css';

	let { children } = $props();

	const nav = [
		['/', 'Dashboard'],
		['/transactions', 'Transactions'],
		['/investments', 'Investments'],
		['/projection', 'Projection'],
		['/accounts', 'Accounts'],
		['/import', 'Import']
	];
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<nav>
	<strong>Finance</strong>
	{#each nav as [href, label] (href)}
		<a {href} aria-current={page.url.pathname === href ? 'page' : undefined}>{label}</a>
	{/each}
</nav>

<main>{@render children()}</main>
