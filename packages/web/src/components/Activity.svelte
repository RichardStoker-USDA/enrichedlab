<script lang="ts">
	import { lab } from "../lib/store.svelte.ts";
	import { summarize, type StepItem } from "../lib/turns.ts";
	import Approval from "./Approval.svelte";
	import Step from "./Step.svelte";

	let { steps, live = false }: { steps: StepItem[]; live?: boolean } = $props();

	const waiting = $derived(steps.some((s) => s.kind === "running" && s.waiting));
	// Short stretches stay open; long finished ones fold to their summary until asked.
	let opened = $state<boolean | undefined>(undefined);
	const open = $derived(opened ?? (live || waiting || steps.length <= 3));
	const summary = $derived(summarize(steps));
	const failed = $derived(steps.some((s) => s.kind === "done" && !s.event.ok && s.event.decision !== "denied"));
	const lastId = $derived(steps.at(-1)?.id);
</script>

<div class="activity" class:live>
	{#if steps.length > 3 || !open}
		<button class="summary" onclick={() => (opened = !open)} aria-expanded={open}>
			<span class="caret" class:open></span>
			<span class="text">{summary}</span>
			<span class="count">{steps.length} steps</span>
			{#if failed}<span class="flag" aria-label="a step failed">✕</span>{/if}
		</button>
	{/if}
	{#if open}
		<div class="steps">
			{#each steps as step (step.id)}
				{#if step.kind === "done"}
					<Step event={step.event} live={live && step.id === lastId} />
				{:else}
					<Step running={{ verb: step.name, target: step.target, output: lab.partial.output[step.id], waiting: Boolean(step.waiting) }} live={step.id === lastId} />
					{#if step.waiting}
						<Approval request={step.waiting} />
					{/if}
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.activity {
		margin: 10px 0 12px;
	}
	.summary {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 30px;
		padding: 4px 8px 4px 0;
		border-radius: var(--radius-small);
		text-align: left;
		font-size: 13px;
		color: var(--text-muted);
	}
	.summary:hover {
		color: var(--text);
	}
	.caret {
		width: 0;
		height: 0;
		margin: 0 2px 0 4px;
		border-left: 4px solid currentColor;
		border-top: 3.5px solid transparent;
		border-bottom: 3.5px solid transparent;
		transition: transform 140ms var(--ease-out);
	}
	.caret.open {
		transform: rotate(90deg);
	}
	.text {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.count {
		font-size: 11.5px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.flag {
		color: var(--bad);
		font-size: 11px;
	}
	.steps {
		margin-top: 2px;
		border-left: 1px solid var(--rule-strong);
		padding-left: 2px;
	}
	.live .steps {
		border-left-color: var(--live);
	}
</style>
