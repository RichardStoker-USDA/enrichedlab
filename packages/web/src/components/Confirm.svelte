<script lang="ts">
	// A yes-or-no before something that can't be undone. The safe choice has focus; Escape cancels.
	import { shortPath } from "../lib/format.ts";
	import { lab } from "../lib/store.svelte.ts";

	let dialog: HTMLDialogElement | undefined = $state();
	let cancel: HTMLButtonElement | undefined = $state();
	let working = $state(false);

	$effect(() => {
		if (!dialog) return;
		if (lab.confirming && !dialog.open) {
			dialog.showModal();
			cancel?.focus();
		} else if (!lab.confirming && dialog.open) dialog.close();
	});

	async function go() {
		const pending = lab.confirming;
		if (!pending) return;
		working = true;
		try {
			await pending.run();
		} finally {
			working = false;
			lab.confirming = undefined;
		}
	}
</script>

<dialog class="sheet confirm" bind:this={dialog} onclose={() => (lab.confirming = undefined)} aria-labelledby="confirm-title" aria-describedby="confirm-detail">
	{#if lab.confirming}
		<h2 id="confirm-title">{lab.confirming.title}</h2>
		<div id="confirm-detail">
			{#if lab.confirming.detail}<p>{lab.confirming.detail}</p>{/if}
			{#if lab.confirming.facts}
				<dl>
					{#each lab.confirming.facts as fact (fact.label)}
						<dt>{fact.label}</dt>
						<dd class:path={fact.path} title={fact.path ? fact.text : undefined}>{fact.path ? shortPath(fact.text) : fact.text}</dd>
					{/each}
				</dl>
			{/if}
		</div>
		<div class="sheet-foot">
			<button class="btn" bind:this={cancel} onclick={() => (lab.confirming = undefined)} disabled={working}>Cancel</button>
			<button class="btn" class:danger={lab.confirming.tone !== "plain"} class:primary={lab.confirming.tone === "plain"} onclick={go} disabled={working}>{working ? `${lab.confirming.action}…` : lab.confirming.action}</button>
		</div>
	{/if}
</dialog>

<style>
	.confirm {
		--sheet-width: 400px;
		padding-top: 20px;
	}
	h2 {
		margin: 0 0 6px;
		font-family: var(--font-display);
		font-size: 15px;
		font-weight: 650;
	}
	p {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	/* Each fact on its own line: what it is, then the plain answer. */
	dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 6px 14px;
		margin: 4px 0 0;
		font-size: 13px;
		line-height: 1.45;
	}
	dt {
		color: var(--text-faint);
	}
	dd {
		margin: 0;
		color: var(--text);
	}
	dd.path {
		font-family: var(--font-mono);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.danger {
		background: var(--danger-bg);
		border-color: transparent;
		color: var(--danger-fg);
	}
	.danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger-bg) 88%, #000);
	}
</style>
