<script lang="ts">
	import type { Edge, Group } from "../../lib/layout.ts";
	import { placeOf } from "../../lib/places.ts";
	import { lab } from "../../lib/store.svelte.ts";
	import Pane from "./Pane.svelte";

	let { group }: { group: Group } = $props();

	const TYPE = "application/x-enrichedlab-tab";
	let edge = $state<Edge | undefined>();
	let body: HTMLDivElement | undefined = $state();

	function edgeAt(e: DragEvent): Edge {
		const r = body!.getBoundingClientRect();
		const x = (e.clientX - r.left) / r.width;
		const y = (e.clientY - r.top) / r.height;
		const near = Math.min(x, 1 - x, y, 1 - y);
		if (near > 0.22) return "center";
		if (near === x) return "left";
		if (near === 1 - x) return "right";
		return near === y ? "top" : "bottom";
	}

	function over(e: DragEvent) {
		if (!e.dataTransfer?.types.includes(TYPE)) return;
		e.preventDefault();
		edge = edgeAt(e);
	}

	function drop(e: DragEvent, at?: Edge) {
		const id = e.dataTransfer?.getData(TYPE);
		edge = undefined;
		if (id) lab.movePane(id, group.id, at ?? edgeAt(e));
	}

	const ARROWS: Record<string, Edge> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" };

	/** Tabs keys: arrows, Home and End switch; Delete closes; Alt+Shift+arrow moves the tab to that edge. */
	function keys(e: KeyboardEvent, index: number) {
		const tabs = group.tabs;
		const tab = tabs[index]!;
		if (e.altKey && e.shiftKey && ARROWS[e.key]) {
			e.preventDefault();
			lab.movePane(tab.id, group.id, ARROWS[e.key]!);
			return;
		}
		let next: number | undefined;
		if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
		else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = tabs.length - 1;
		else if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			next = tabs.length > 1 ? Math.min(index, tabs.length - 2) : undefined;
			lab.closePane(tab.id);
			if (next !== undefined) requestAnimationFrame(() => document.getElementById(`tab-${group.tabs[next!]?.id}`)?.focus());
			return;
		}
		if (next === undefined) return;
		e.preventDefault();
		lab.focusPane(tabs[next]!.id);
		document.getElementById(`tab-${tabs[next]!.id}`)?.focus();
	}

	/** The place a tab's work came from, for tabs of data that live in a lab. */
	function placeFor(ref?: string) {
		const view = ref ? lab.canvases.find((c) => c.id === ref) : undefined;
		return view?.source && view.source.place !== "local" ? placeOf(lab.places, view.source.place) : undefined;
	}
</script>

<section class="group">
	<div class="tabs" role="tablist" aria-label="Open panes" tabindex="-1" ondragover={(e) => e.dataTransfer?.types.includes(TYPE) && e.preventDefault()} ondrop={(e) => drop(e, "center")}>
		{#each group.tabs as tab, index (tab.id)}
			{@const place = placeFor(tab.ref)}
			{@const active = tab.id === group.active}
			<div class="tab" class:active role="presentation" draggable="true" ondragstart={(e) => e.dataTransfer?.setData(TYPE, tab.id)} onauxclick={(e) => e.button === 1 && lab.closePane(tab.id)}>
				<button id={`tab-${tab.id}`} class="label" role="tab" aria-selected={active} aria-controls={`panel-${tab.id}`} tabindex={active ? 0 : -1}
					title="Arrows switch, Delete closes, Alt+Shift+arrow moves the pane"
					onclick={() => lab.focusPane(tab.id)} onkeydown={(e) => keys(e, index)}>
					{#if place}<span class="place-dot" style:--dot={`var(${place.color})`} title={`From the ${place.title} sandbox`}></span>{/if}
					<span class="kind">{tab.kind === "view" ? "" : tab.kind}</span>
					<span class="name">{tab.title}</span>
				</button>
				<button class="close" tabindex="-1" onclick={() => lab.closePane(tab.id)} aria-label={`Close ${tab.title}`}>
					<svg viewBox="0 0 10 10"><path d="m2.5 2.5 5 5M7.5 2.5l-5 5" /></svg>
				</button>
			</div>
		{/each}
	</div>
	<div class="body" bind:this={body} role="region" aria-label="Panes" ondragover={over} ondragleave={() => (edge = undefined)} ondrop={(e) => drop(e)}>
		{#each group.tabs as tab (tab.id)}
			<div class="pane" class:shown={tab.id === group.active} id={`panel-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`}>
				<Pane {tab} active={tab.id === group.active} />
			</div>
		{/each}
		{#if edge}
			<div class="drop {edge}" aria-hidden="true"></div>
		{/if}
	</div>
</section>

<style>
	.group {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--canvas);
	}
	.tabs {
		display: flex;
		align-items: stretch;
		gap: 1px;
		height: 34px;
		flex: none;
		overflow-x: auto;
		scrollbar-width: none;
		background: var(--surface);
		border-bottom: 1px solid var(--rule);
	}
	.tab {
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 220px;
		padding: 0 4px 0 12px;
		font-size: 12.5px;
		color: var(--text-muted);
		cursor: default;
		user-select: none;
		border-right: 1px solid var(--rule);
	}
	.tab:hover {
		color: var(--text);
	}
	.label {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		height: 100%;
		color: inherit;
		font: inherit;
	}
	/* The tab strip scrolls and clips, so the global ring is drawn inside. */
	.label:focus-visible {
		outline-offset: -3px;
		box-shadow: none;
	}
	.tab.active {
		background: var(--canvas);
		color: var(--text);
		box-shadow: inset 0 -1px 0 var(--canvas), inset 0 2px 0 var(--accent);
	}
	.kind {
		font: 10.5px var(--font-mono);
		text-transform: lowercase;
		color: var(--text-faint);
	}
	.kind:empty {
		display: none;
	}
	.name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.close {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: 4px;
		color: var(--text-faint);
		opacity: 0;
	}
	.tab:hover .close,
	.tab.active .close,
	.close:focus-visible {
		opacity: 1;
	}
	.close:hover {
		background: var(--hover);
		color: var(--text);
	}
	.close svg {
		width: 10px;
		height: 10px;
		stroke: currentColor;
		stroke-width: 1.4;
	}
	.body {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.pane {
		display: none;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}
	.pane.shown {
		display: flex;
	}
	.drop {
		position: absolute;
		z-index: 10;
		border-radius: var(--radius-small);
		background: light-dark(rgb(2 40 81 / 0.08), rgb(255 191 0 / 0.1));
		box-shadow: inset 0 0 0 2px var(--accent);
		pointer-events: none;
		transition: inset 120ms var(--ease-out);
	}
	.drop.center {
		inset: 6px;
	}
	.drop.left {
		inset: 6px 50% 6px 6px;
	}
	.drop.right {
		inset: 6px 6px 6px 50%;
	}
	.drop.top {
		inset: 6px 6px 50% 6px;
	}
	.drop.bottom {
		inset: 50% 6px 6px 6px;
	}
</style>
