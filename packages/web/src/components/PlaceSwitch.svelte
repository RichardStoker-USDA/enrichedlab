<script lang="ts">
	import { lab } from "../lib/store.svelte.ts";
	import { runsOn, SANDBOX_NOTE } from "../lib/places.ts";

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();

	function choose(id: string) {
		open = false;
		if (id !== lab.place.id) void lab.movePlace(id);
	}

	function outside(e: PointerEvent) {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}

	const site = $derived(lab.summary?.site ? lab.sites.find((s) => s.name === lab.summary!.site) : undefined);
</script>

<svelte:window onpointerdown={outside} onkeydown={(e) => e.key === "Escape" && (open = false)} />

<div class="switch" bind:this={root}>
	<button class="pill" onclick={() => (open = !open)} aria-haspopup="menu" aria-expanded={open} disabled={Boolean(lab.moving) || lab.busy} title={lab.busy ? "Moves happen between turns" : "Where this session's files and commands act"}>
		<span class="place-dot" class:local={lab.place.id === "local"} style:--dot={`var(${lab.place.color})`}></span>
		<span>{lab.moving ? `Moving to ${lab.places.find((p) => p.id === lab.moving)?.title ?? lab.moving}…` : runsOn(lab.place)}</span>
		<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
	</button>
	{#if open}
		<div class="menu" role="menu">
			{#if lab.pinned}
				<p class="note">{site?.title ?? "This lab"} keeps its sessions' code and data in its sandbox, so this session stays there.</p>
			{:else}
				<p class="menu-label">Run this session's files and commands on</p>
				{#each lab.places as place (place.id)}
					<button class="menu-item" class:on={place.id === lab.place.id} role="menuitemradio" aria-checked={place.id === lab.place.id} disabled={!place.ready || Boolean(place.site?.isolated)} onclick={() => choose(place.id)}>
						<span class="place-dot" class:local={place.id === "local"} style:--dot={`var(${place.color})`}></span>
						<span>
							{place.id === "local" ? place.title : `${place.title} sandbox`}
							<small>
								{#if place.id === "local"}
									Your files, contained by the operating system
								{:else if place.site?.isolated}
									Start a new {place.title} session to work there
								{:else if !place.ready}
									{place.site?.signedIn ? "No sandbox for you yet" : "Sign in first"}
								{:else}
									{SANDBOX_NOTE}
								{/if}
							</small>
						</span>
						<span class="check" aria-hidden="true">{place.id === lab.place.id ? "✓" : ""}</span>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.switch {
		position: relative;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 30px;
		padding: 0 10px 0 12px;
		border-radius: 15px;
		border: 1px solid var(--rule-strong);
		font-size: 12.5px;
		font-weight: 500;
		white-space: nowrap;
	}
	.pill:hover:not(:disabled) {
		background: var(--hover);
	}
	.pill:disabled {
		color: var(--text-muted);
	}
	.pill svg {
		width: 12px;
		height: 12px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		color: var(--text-faint);
	}
	.menu {
		right: 0;
		top: calc(100% + 6px);
		width: 320px;
	}
	.note {
		margin: 6px 10px;
		font-size: 13px;
		color: var(--text-muted);
	}
	.check {
		color: var(--accent-text);
	}
	@media (max-width: 560px) {
		.pill span:not(.place-dot) {
			max-width: 120px;
			overflow: hidden;
			text-overflow: ellipsis;
		}
	}
</style>
