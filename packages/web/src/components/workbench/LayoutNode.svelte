<script lang="ts">
	import type { Node } from "../../lib/layout.ts";
	import { lab } from "../../lib/store.svelte.ts";
	import LayoutNode from "./LayoutNode.svelte";
	import TabGroup from "./TabGroup.svelte";

	let { node }: { node: Node } = $props();
	let box: HTMLDivElement | undefined = $state();

	/** Drag the gutter after child `i`: the two neighbors trade size, each keeping at least 12%. */
	function drag(e: PointerEvent, i: number) {
		if (node.type !== "split" || !box) return;
		const split = node;
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const rect = box.getBoundingClientRect();
		const total = split.dir === "row" ? rect.width : rect.height;
		const start = split.dir === "row" ? e.clientX : e.clientY;
		const sizes = [...split.sizes];
		const pair = sizes[i]! + sizes[i + 1]!;
		const move = (ev: PointerEvent) => {
			const delta = ((split.dir === "row" ? ev.clientX : ev.clientY) - start) / total;
			const a = Math.min(pair - 0.12, Math.max(0.12, sizes[i]! + delta));
			const next = [...sizes];
			next[i] = a;
			next[i + 1] = pair - a;
			lab.resizeSplit(split.id, next);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", () => handle.removeEventListener("pointermove", move), { once: true });
	}

	/** Arrow keys move the gutter by 5%; Home evens the two sides. */
	function nudge(e: KeyboardEvent, i: number) {
		if (node.type !== "split") return;
		const back = node.dir === "row" ? "ArrowLeft" : "ArrowUp";
		const forward = node.dir === "row" ? "ArrowRight" : "ArrowDown";
		if (e.key === "Home") return void (e.preventDefault(), even(i));
		if (e.key !== back && e.key !== forward) return;
		e.preventDefault();
		const sizes = [...node.sizes];
		const pair = sizes[i]! + sizes[i + 1]!;
		const a = Math.min(pair - 0.12, Math.max(0.12, sizes[i]! + (e.key === forward ? 0.05 : -0.05) * pair));
		sizes[i] = a;
		sizes[i + 1] = pair - a;
		lab.resizeSplit(node.id, sizes);
	}

	function even(i: number) {
		if (node.type !== "split") return;
		const sizes = [...node.sizes];
		const half = (sizes[i]! + sizes[i + 1]!) / 2;
		sizes[i] = sizes[i + 1] = half;
		lab.resizeSplit(node.id, sizes);
	}
</script>

{#if node.type === "split"}
	<div class="split" class:column={node.dir === "column"} bind:this={box}>
		{#each node.children as child, i (child.id)}
			<div class="cell" style:flex-grow={node.sizes[i]}>
				<LayoutNode node={child} />
			</div>
			{#if i < node.children.length - 1}
				<!-- A focusable separator is the ARIA window-splitter pattern: arrows move it, Home evens it. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					class="gutter"
					role="separator"
					tabindex="0"
					aria-label="Resize the panes"
					aria-orientation={node.dir === "row" ? "vertical" : "horizontal"}
					aria-valuemin={12}
					aria-valuemax={88}
					aria-valuenow={Math.round((node.sizes[i]! / (node.sizes[i]! + node.sizes[i + 1]!)) * 100)}
					onpointerdown={(e) => drag(e, i)}
					onkeydown={(e) => nudge(e, i)}
					ondblclick={() => even(i)}
				></div>
			{/if}
		{/each}
	</div>
{:else}
	<TabGroup group={node} />
{/if}

<style>
	.split {
		flex: 1;
		display: flex;
		min-width: 0;
		min-height: 0;
	}
	.split.column {
		flex-direction: column;
	}
	.cell {
		flex-basis: 0;
		min-width: 0;
		min-height: 0;
		display: flex;
	}
	.gutter {
		flex: none;
		width: 1px;
		background: var(--rule);
		position: relative;
		cursor: col-resize;
		touch-action: none;
	}
	.column > .gutter {
		width: auto;
		height: 1px;
		cursor: row-resize;
	}
	.gutter::after {
		content: "";
		position: absolute;
		inset: 0 -4px;
	}
	.column > .gutter::after {
		inset: -4px 0;
	}
	.gutter:hover,
	.gutter:focus-visible {
		background: var(--accent);
	}
	.gutter:focus-visible {
		outline: none;
		box-shadow: 0 0 0 1px var(--focus-inner);
	}
</style>
