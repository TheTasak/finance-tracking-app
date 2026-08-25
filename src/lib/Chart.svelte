<script lang="ts">
	import { Chart, registerables, type ChartConfiguration } from 'chart.js';
	Chart.register(...registerables);

	let { config, height = 260 }: { config: ChartConfiguration; height?: number } = $props();

	let canvas: HTMLCanvasElement;

	$effect(() => {
		const chart = new Chart(canvas, config);
		return () => chart.destroy();
	});
</script>

<div style:height="{height}px"><canvas bind:this={canvas}></canvas></div>
