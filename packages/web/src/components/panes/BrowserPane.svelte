<script lang="ts">
	import { onDestroy, untrack } from "svelte";

	let { id, url, active }: { id: string; url?: string; active: boolean } = $props();

	const desktop = typeof window !== "undefined" ? window.labDesktop?.browser : undefined;
	// The tab starts at the address it was opened with; after that the person and the page move it.
	const start = untrack(() => url ?? "");
	let address = $state(start);
	let current = $state(start);
	let title = $state("");
	let page = $state<BrowserState | undefined>();
	let slot: HTMLDivElement | undefined = $state();

	function normalize(text: string): string {
		const t = text.trim();
		if (!t) return "";
		if (/^https?:\/\//i.test(t)) return t;
		if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(t)) return `http://${t}`;
		return /\s/.test(t) || !/\./.test(t) ? `https://duckduckgo.com/?q=${encodeURIComponent(t)}` : `https://${t}`;
	}

	function go(e?: Event) {
		e?.preventDefault();
		const next = normalize(address);
		if (!next) return;
		current = next;
		if (desktop) desktop.navigate(id, next);
	}

	// The desktop app's real browser view sits exactly over this pane's slot and follows it.
	function bounds() {
		const r = slot!.getBoundingClientRect();
		return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
	}
	$effect(() => {
		if (!desktop || !slot) return;
		if (!active) return desktop.hide(id);
		desktop.show(id, current || "about:blank", bounds());
		const observer = new ResizeObserver(() => desktop.bounds(id, bounds()));
		observer.observe(slot);
		const onWindow = () => desktop.bounds(id, bounds());
		window.addEventListener("resize", onWindow);
		const off = desktop.onState((which, s) => {
			if (which !== id) return;
			page = s;
			title = s.title;
			if (document.activeElement?.className !== "address") address = s.url;
		});
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", onWindow);
			off();
			desktop.hide(id);
		};
	});
	onDestroy(() => desktop?.close(id));
</script>

<div class="browser-pane">
	<form class="bar" onsubmit={go}>
		{#if desktop}
			<button type="button" class="icon-btn" onclick={() => desktop.go(id, "back")} disabled={!page?.canGoBack} aria-label="Back">
				<svg viewBox="0 0 16 16"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
			</button>
			<button type="button" class="icon-btn" onclick={() => desktop.go(id, "forward")} disabled={!page?.canGoForward} aria-label="Forward">
				<svg viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
			</button>
			<button type="button" class="icon-btn" onclick={() => desktop.go(id, "reload")} aria-label="Reload">
				<svg viewBox="0 0 16 16"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" /></svg>
			</button>
		{/if}
		<input class="field address" bind:value={address} placeholder="Address, or a local app such as localhost:3838" aria-label="Address" spellcheck="false" />
	</form>
	{#if !current}
		<div class="blank">
			<p>Apps the agent starts (Shiny, Streamlit, a dev server) open here, and so can any address.</p>
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
		max-width: 320px;
		text-align: center;
		color: var(--text-faint);
		font-size: 13px;
	}
</style>
