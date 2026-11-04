<script lang="ts">
	// Add a model service with your own key. The key is checked against the service before it's kept, and it goes to
	// the operating system's credential store, never to a settings file.
	import type { ProviderPreset } from "@enrichedlab/protocol";
	import { lab } from "../lib/store.svelte.ts";
	import { rpc } from "../lib/rpc.ts";

	let { open = $bindable(false) }: { open: boolean } = $props();

	let dialog = $state<HTMLDialogElement>();
	let presets = $state<ProviderPreset[]>([]);
	let added = $state<{ name: string; label: string; baseUrl: string }[]>([]);
	let choice = $state("gemini");
	let key = $state("");
	let address = $state("");
	let busy = $state(false);
	let message = $state("");
	let failed = $state(false);
	const chosen = $derived(presets.find((p) => p.id === choice));

	async function load() {
		const list = await rpc.call("provider.list", {});
		presets = list.presets;
		added = list.added;
	}

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			message = "";
			key = "";
			void load();
			dialog.showModal();
		} else if (!open && dialog.open) dialog.close();
	});

	async function add(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		failed = false;
		message = `Checking the key with ${chosen?.label ?? "the service"}…`;
		try {
			const result = await rpc.call("provider.add", { preset: choice, key, baseUrl: choice === "custom" ? address : undefined });
			message = `Added. ${result.models} models are in the model menu.`;
			key = "";
			await lab.refreshModels();
			await load();
		} catch (error) {
			failed = true;
			message = (error as Error).message;
		} finally {
			busy = false;
		}
	}

	async function remove(name: string) {
		await rpc.call("provider.remove", { name });
		await lab.refreshModels();
		await load();
	}
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} aria-labelledby="services-title">
	<form method="dialog" class="head">
		<h2 id="services-title">Model services</h2>
		<button class="close" aria-label="Close">×</button>
	</form>
	<p class="lead">
		Your lab's models appear when you sign in to it. Models on this computer (Ollama, LM Studio) appear while they run; Gemma and Qwen run well
		in LM Studio on Apple silicon. To use a service with your own account, add its key here.
	</p>

	<form class="add" onsubmit={add}>
		<fieldset>
			<legend>Service</legend>
			<div class="choices">
				{#each presets as preset (preset.id)}
					<label class:on={choice === preset.id}>
						<input type="radio" name="service" value={preset.id} bind:group={choice} />
						{preset.label}
					</label>
				{/each}
			</div>
		</fieldset>
		{#if chosen}
			<p class="note">
				{chosen.note}
				{#if chosen.keyUrl}<a href={chosen.keyUrl} target="_blank" rel="noreferrer">Get a key</a>{/if}
			</p>
		{/if}
		{#if choice === "custom"}
			<label class="entry">Address <input type="url" bind:value={address} placeholder="https://models.example.org/v1" required spellcheck="false" /></label>
		{/if}
		<label class="entry">Key <input type="password" bind:value={key} autocomplete="off" spellcheck="false" required /></label>
		<div class="actions">
			<p class="status" class:failed role="status" aria-live="polite">{message}</p>
			<button type="submit" class="primary" disabled={busy || !key.trim()}>{busy ? "Checking…" : "Add"}</button>
		</div>
	</form>

	{#if added.length}
		<h3>Added</h3>
		<ul class="added">
			{#each added as service (service.name)}
				<li>
					<span>{service.label}</span>
					<span class="where">{new URL(service.baseUrl).host}</span>
					<button type="button" class="link" onclick={() => remove(service.name)}>Remove</button>
				</li>
			{/each}
		</ul>
	{/if}
</dialog>

<style>
	dialog {
		width: min(520px, calc(100vw - 32px));
		max-height: calc(100dvh - 48px);
		padding: 0 22px 20px;
		border: 1px solid var(--rule-strong);
		border-radius: 14px;
		background: var(--raised);
		color: var(--text);
		box-shadow: 0 24px 60px rgb(0 0 0 / 0.22);
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.32);
	}
	dialog[open] {
		animation: rise 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		dialog[open] {
			animation: none;
		}
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 0 4px;
	}
	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
	}
	h3 {
		margin: 18px 0 6px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text-muted);
	}
	.close {
		width: 32px;
		height: 32px;
		font-size: 20px;
		color: var(--text-muted);
		border-radius: 8px;
	}
	.close:hover {
		background: var(--hover);
	}
	.lead,
	.note {
		margin: 6px 0 12px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.note a {
		color: var(--link);
		margin-left: 4px;
	}
	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
	}
	legend {
		font-size: 12.5px;
		color: var(--text-muted);
		margin-bottom: 6px;
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.choices label {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		padding: 0 12px;
		border: 1px solid var(--rule-strong);
		border-radius: 8px;
		font-size: 13px;
		cursor: pointer;
	}
	.choices label.on {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.choices input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.choices label:has(input:focus-visible) {
		outline: 2px solid var(--focus-inner);
		outline-offset: 2px;
	}
	.entry {
		display: grid;
		gap: 4px;
		margin-top: 10px;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.entry input {
		font: 13px var(--font-mono);
		color: var(--text);
		padding: 8px 10px;
		border: 1px solid var(--rule-strong);
		border-radius: 8px;
		background: var(--canvas);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 14px;
	}
	.status {
		flex: 1;
		margin: 0;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.status.failed {
		color: var(--bad);
	}
	.primary {
		min-height: 34px;
		padding: 0 18px;
		border-radius: 8px;
		background: var(--primary-bg);
		color: var(--primary-fg);
		font-weight: 600;
		font-size: 13px;
	}
	.primary:disabled {
		opacity: 0.45;
	}
	.added {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.added li {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 8px 0;
		border-top: 1px solid var(--rule);
		font-size: 13px;
	}
	.where {
		flex: 1;
		color: var(--text-faint);
		font: 12px var(--font-mono);
	}
	.link {
		color: var(--link);
		font-size: 12.5px;
	}
</style>
