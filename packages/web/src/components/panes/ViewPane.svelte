<script lang="ts">
	import { lab } from "../../lib/store.svelte.ts";

	let { id }: { id: string } = $props();
	const view = $derived(lab.canvases.find((c) => c.id === id));

	// Loading until the frame says it loaded; a page the engine can't serve says why, with Try Again.
	let loaded = $state(false);
	let failed = $state("");
	let attempt = $state(0);
	$effect(() => {
		const url = view?.url;
		void view?.version;
		void attempt;
		loaded = false;
		failed = "";
		if (!url) return;
		const controller = new AbortController();
		void fetch(url, { signal: controller.signal, cache: "no-store" })
			.then((response) => {
				if (!response.ok) failed = response.status === 404 ? "This view is no longer on the engine." : `The engine answered ${response.status}.`;
				controller.abort();
			})
			.catch((error: Error) => {
				if (error.name !== "AbortError") failed = "The engine didn't answer.";
			});
		return () => controller.abort();
	});
</script>

<div class="view-pane">
{#if view}
	<div class="bar">
		<span class="title" title={view.title}>{view.title}</span>
		{#if !loaded && !failed}<span class="loading">Loading…</span>{/if}
		<button class="icon-btn" onclick={() => attempt++} aria-label="Reload" title="Reload">
			<svg viewBox="0 0 16 16"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" /></svg>
		</button>
		<button class="icon-btn" onclick={() => window.open(view.url, "_blank", "noopener")} aria-label="Open in its own window" title="Open in its own window">
			<svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>
		</button>
	</div>
	{#if failed}
		<div class="state" role="alert">
			<p>{failed}</p>
			<button class="btn" onclick={() => attempt++}>Try Again</button>
		</div>
	{:else}
		{#key attempt}
			<!-- Agent-made pages run in an opaque origin: scripts work, the engine's API and the app's storage stay out of reach. -->
			<iframe title={view.title} src={view.url} onload={() => (loaded = true)} sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" allow="fullscreen" referrerpolicy="no-referrer"></iframe>
		{/key}
	{/if}
{:else}
	<p class="gone">This view is no longer available.</p>
{/if}
</div>

<style>
	.view-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 34px;
		padding: 2px 6px 2px 12px;
		border-bottom: 1px solid var(--rule);
		font-size: 12px;
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
	}
	.loading {
		color: var(--text-muted);
	}
	iframe {
		flex: 1;
		width: 100%;
		border: 0;
		background: var(--canvas);
	}
	.state {
		margin: auto;
		text-align: center;
		font-size: 13px;
		color: var(--text-muted);
	}
	.gone {
		margin: auto;
		color: var(--text-muted);
		font-size: 13px;
	}
</style>
