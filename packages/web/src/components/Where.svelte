<script lang="ts">
	// Where a model runs, as a glyph and a name: a shield for private places, a cloud for cloud services. The sentence
	// on where data goes is in its title and, for screen readers, its label.
	import type { ModelWhere } from "@enrichedlab/protocol";
	import { isPrivate, whereName, whereNote } from "../lib/where.ts";

	let { where, named = true }: { where: ModelWhere; named?: boolean } = $props();
	const shield = $derived(isPrivate(where));
</script>

<span class="where" class:cloud={!shield} title={whereNote(where)} aria-label={whereNote(where)}>
	<svg viewBox="0 0 12 12" aria-hidden="true">
		{#if shield}
			<path d="M6 1.25 2.25 2.75v3.1c0 2.3 1.55 3.95 3.75 4.9 2.2-.95 3.75-2.6 3.75-4.9v-3.1z" />
		{:else}
			<path d="M3.4 9.75h5.4a2.15 2.15 0 0 0 .3-4.28A3.05 3.05 0 0 0 3.2 5.9 1.93 1.93 0 0 0 3.4 9.75z" />
		{/if}
	</svg>
	{#if named}<span aria-hidden="true">{whereName(where)}</span>{/if}
</span>

<style>
	.where {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.where span {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	svg {
		flex: none;
		width: 12px;
		height: 12px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.2;
		stroke-linejoin: round;
	}
	/* Cloud reads in full text color: the one people should notice before sending research data. */
	.cloud {
		color: var(--text);
	}
</style>
