<script lang="ts">
	import { onDestroy, untrack } from "svelte";
	import { normalize } from "../../lib/address.ts";
	import { computerName } from "../../lib/places.ts";

	let { id, url, active }: { id: string; url?: string; active: boolean } = $props();

	const desktop = typeof window !== "undefined" ? window.labDesktop?.browser : undefined;
	// The tab starts at the address it was opened with; after that the person and the page move it.
	const start = untrack(() => url ?? "");
	let address = $state(start);
	let current = $state(start);
	let title = $state("");
	let page = $state<BrowserState | undefined>();
	let slot: HTMLDivElement | undefined = $state();
	let addressField: HTMLInputElement | undefined = $state();
	// Only a change between loaded and failed re-places the view, not every title or progress update.
	const failed = $derived(Boolean(page?.failed));

	/** A new load starts clean: the failure notice goes, and the page shows again while it loads. */
	function clearFailure() {
		if (page?.failed) page = { ...page, failed: undefined };
	}

	function go(e?: Event) {
		e?.preventDefault();
		const next = normalize(address);
		if (!next) return;
		current = next;
		clearFailure();
		if (desktop) desktop.navigate(id, next);
	}

	function retry() {
		clearFailure();
		desktop?.go(id, "reload");
	}

	// The page's state is followed for the pane's whole life, also while a failure notice replaces the view.
	$effect(() => {
		if (!desktop) return;
		return desktop.onState((which, s) => {
			if (which !== id) return;
			page = s;
			title = s.title;
			// The address only follows the page while the person isn't typing in it.
			if (document.activeElement !== addressField) address = s.url;
		});
	});

	// The desktop app's real browser view sits exactly over this pane's slot and follows it.
	function bounds() {
		const r = slot!.getBoundingClientRect();
		return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
	}
	$effect(() => {
		if (!desktop || !slot) return;
		if (!active || failed) return desktop.hide(id);
		desktop.show(id, current || "about:blank", bounds());
		const observer = new ResizeObserver(() => desktop.bounds(id, bounds()));
		observer.observe(slot);
		const onWindow = () => desktop.bounds(id, bounds());
		window.addEventListener("resize", onWindow);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", onWindow);
			desktop.hide(id);
		};
	});
	onDestroy(() => desktop?.close(id));
</script>

<div class="browser-pane">
	<form class="bar" onsubmit={go}>
		<span class="lane" title="This browser runs on this computer, with your own sign-ins"><span class="place-dot local"></span>{computerName()}</span>
		{#if desktop}
			<button type="button" class="icon-btn" onclick={() => desktop.go(id, "back")} disabled={!page?.canGoBack} aria-label="Back">
				<svg viewBox="0 0 16 16"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
			</button>
			<button type="button" class="icon-btn" onclick={() => desktop.go(id, "forward")} disabled={!page?.canGoForward} aria-label="Forward">
				<svg viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
			</button>
			{#if page?.loading}
				<button type="button" class="icon-btn" onclick={() => desktop.go(id, "stop")} aria-label="Stop loading">
					<svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></svg>
				</button>
			{:else}
				<button type="button" class="icon-btn" onclick={retry} aria-label="Reload">
					<svg viewBox="0 0 16 16"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" /></svg>
				</button>
			{/if}
		{/if}
		<input class="field address" bind:this={addressField} bind:value={address} placeholder="Address, or a local app such as localhost:3838" aria-label="Address" spellcheck="false" />
	</form>
	{#if !current}
		<div class="blank">
			<p>Apps the agent starts (Shiny, Streamlit, a dev server) open here, and so can any address.</p>
		</div>
	{:else if desktop && failed && page?.failed}
		<!-- The page view is hidden while this shows: nothing in the window can draw over it. -->
		<div class="blank" role="alert">
			<p><strong>This page didn't load.</strong> {page.failed.reason}</p>
			<p class="url">{page.failed.url}</p>
			<button type="button" class="btn" onclick={retry}>Try Again</button>
		</div>
	{:else if desktop}
		<div class="slot" bind:this={slot} title={title}></div>
	{:else}
		<!-- Outside the desktop app: an embedded frame. Many sites refuse to be framed; local apps work. -->
		<iframe class="frame" src={current} title={title || current} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"></iframe>
		<p class="note">If the page stays blank, the site doesn't allow embedding. <a href={current} target="_blank" rel="noopener noreferrer">Open it in a browser tab</a>.</p>
	{/if}
</div>

<style>
	.browser-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--rule);
	}
	.lane {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 8px 0 4px;
		font-size: 12px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.address {
		flex: 1;
		height: 28px;
		margin-left: 4px;
		font-size: 12.5px;
	}
	.slot,
	.frame {
		flex: 1;
		min-height: 0;
		border: 0;
		background: #ffffff;
	}
	.note {
		margin: 0;
		padding: 6px 12px;
		border-top: 1px solid var(--rule);
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.blank {
		margin: auto;
		max-width: 340px;
		text-align: center;
		color: var(--text-muted);
		font-size: 13px;
	}
	.blank strong {
		color: var(--text);
	}
	.blank .url {
		font: 11.5px var(--font-mono);
		overflow-wrap: anywhere;
	}
</style>
