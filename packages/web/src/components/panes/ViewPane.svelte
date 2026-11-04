<script lang="ts">
	import { lab } from "../../lib/store.svelte.ts";

	let { id }: { id: string } = $props();
	const view = $derived(lab.canvases.find((c) => c.id === id));
</script>

{#if view}
	<!-- Agent-made pages run in an opaque origin: scripts work, the engine's API and the app's storage stay out of reach. -->
	<iframe title={view.title} src={view.url} sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" allow="fullscreen" referrerpolicy="no-referrer"></iframe>
{:else}
	<p class="gone">This view is no longer available.</p>
{/if}

<style>
	iframe {
		flex: 1;
		width: 100%;
		border: 0;
		background: var(--canvas);
	}
	.gone {
		margin: auto;
		color: var(--text-faint);
		font-size: 13px;
	}
</style>
