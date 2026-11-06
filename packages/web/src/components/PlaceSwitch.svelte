<script lang="ts">
	// Where this session's files and commands act: this computer, or a lab's sandbox. It sits beside the model in
	// the composer because the two together answer "how will the next thing be done". A move carries the session's
	// repository and happens between turns.
	import { lab } from "../lib/store.svelte.ts";
	import { tick } from "svelte";
	import { computerName, SANDBOX_NOTE } from "../lib/places.ts";
	import { rpc } from "../lib/rpc.ts";

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let chip: HTMLButtonElement | undefined = $state();

	async function toggle() {
		open = !open;
		if (!open) return;
		await tick();
		root?.querySelector<HTMLButtonElement>(".menu-item[aria-checked='true'], .menu-item:not(:disabled)")?.focus();
	}

	function close(refocus = true) {
		open = false;
		if (refocus) chip?.focus();
	}

	/** Moving is a transfer, so it's reviewed first (lab.requestMove). */
	function choose(id: string) {
		close();
		void lab.requestMove(id);
	}

	function keys(e: KeyboardEvent) {
		if (!open || !root) return;
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const items = [...root.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
		const at = items.indexOf(document.activeElement as HTMLButtonElement);
		e.preventDefault();
		items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
	}

	function outside(e: PointerEvent) {
		if (open && root && !root.contains(e.target as Node)) close(false);
	}

	const site = $derived(lab.summary?.site ? lab.sites.find((s) => s.name === lab.summary!.site) : undefined);
	const movingTo = $derived(lab.moving ? (lab.places.find((p) => p.id === lab.moving)?.title ?? lab.moving) : "");
</script>

<svelte:window onpointerdown={outside} />

<div class="switch" bind:this={root} onkeydown={keys} role="none">
	<button type="button" class="chip" bind:this={chip} onclick={toggle} aria-haspopup="menu" aria-expanded={open} disabled={Boolean(lab.moving)} title="Where this session's files and commands run">
		<span class="place-dot" class:local={lab.place.id === "local"} style:--dot={`var(${lab.place.color})`}></span>
		<span class="label">{lab.moving ? `Moving to ${movingTo}…` : lab.place.id === "local" ? lab.place.title : `${lab.place.title} sandbox`}</span>
		<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 7.5 3-3 3 3" /></svg>
	</button>
	{#if open}
		<div class="menu" role="menu" aria-label="Run on">
			{#if lab.pinned}
				<p class="note">{site?.title ?? "This lab"} keeps its sessions' code and data inside the lab, so this session stays in its sandbox.</p>
			{:else}
				<p class="menu-label">Run files and commands on</p>
				{#each lab.places as place (place.id)}
					{@const needsSignIn = Boolean(place.site && !place.site.signedIn)}
					{@const labToLab = place.id !== "local" && lab.place.id !== "local" && place.id !== lab.place.id}
					{@const unavailable = (!place.ready && !needsSignIn) || Boolean(place.site?.isolated) || lab.busy || labToLab}
					<button type="button" class="menu-item" role="menuitemradio" aria-checked={place.id === lab.place.id} disabled={unavailable && place.id !== lab.place.id} onclick={() => choose(place.id)}>
						<span class="check" aria-hidden="true">{place.id === lab.place.id ? "✓" : ""}</span>
						<span>
							<span class="line"><span class="place-dot" class:local={place.id === "local"} style:--dot={`var(${place.color})`}></span>{place.id === "local" ? place.title : `${place.title} sandbox`}</span>
							<small>
								{#if place.id === "local"}
									Your files, with the operating system's containment
								{:else if place.site?.isolated}
									Start a new {place.title} session to work there
								{:else if needsSignIn}
									Not signed in: choose to sign in
								{:else if labToLab}
									Move back to {computerName()} first; the work comes home as a branch
								{:else if !place.ready}
									{place.title} has no sandbox for you yet
								{:else if lab.busy}
									Moves happen between turns
								{:else}
									{SANDBOX_NOTE}
								{/if}
							</small>
						</span>
						<span></span>
					</button>
				{/each}
				<p class="foot">The model is chosen beside this and stays the same when the session moves.</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.switch {
		position: relative;
		min-width: 0;
	}
	.chip {
		display: flex;
		align-items: center;
		gap: 7px;
		height: 30px;
		max-width: 240px;
		padding: 0 9px 0 10px;
		border-radius: 999px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text-muted);
		transition: background-color 120ms ease-out, color 120ms ease-out;
	}
	.chip:hover:not(:disabled),
	.chip[aria-expanded="true"] {
		background: var(--hover);
		color: var(--text);
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chip svg {
		width: 11px;
		height: 11px;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
	}
	.menu {
		left: -4px;
		bottom: calc(100% + 10px);
		width: min(340px, 86vw);
		max-height: min(60vh, 420px);
		overflow-y: auto;
		transform-origin: bottom left;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.note,
	.foot {
		margin: 6px 9px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--text-muted);
	}
	.foot {
		margin-top: 6px;
		padding-top: 8px;
		border-top: 1px solid var(--rule);
	}
	@media (max-width: 560px) {
		.chip {
			max-width: 140px;
		}
	}
</style>
