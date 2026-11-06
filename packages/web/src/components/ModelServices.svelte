<script lang="ts">
	/** One section at a time: the person's ChatGPT plan, open models on this computer, or keys for a service. */
	let tab = $state<"plan" | "local" | "keys">("plan");
	// Model services: your ChatGPT plan through ChatGPT's own sign-in, or a service with your own key. A key is checked
	// against the service before it's kept, and goes to the operating system's credential store, never to a settings
	// file. ChatGPT tokens stay in the engine; this dialog sees the account's email and whether plan use is on.
	import type { ProviderPreset, ServiceAccount } from "@enrichedlab/protocol";
	import { lab, USAGE_URL } from "../lib/store.svelte.ts";
	import { rpc } from "../lib/rpc.ts";
	import ChatGptMark from "./ChatGptMark.svelte";
	import LocalModels from "./LocalModels.svelte";

	let { open = $bindable(false) }: { open: boolean } = $props();

	let dialog = $state<HTMLDialogElement>();
	let welcomeDialog = $state<HTMLDialogElement>();
	let presets = $state<ProviderPreset[]>([]);
	let added = $state<{ name: string; label: string; baseUrl: string }[]>([]);
	let accounts = $state<ServiceAccount[]>([]);
	let signing = $state(false);
	let planMessage = $state("");
	let planFailed = $state(false);
	let choice = $state("gemini");
	let key = $state("");
	let address = $state("");
	let busy = $state(false);
	let message = $state("");
	let failed = $state(false);
	const chosen = $derived(presets.find((p) => p.id === choice));

	let loadError = $state("");
	async function load() {
		try {
			const list = await rpc.call("provider.list", {});
			presets = list.presets;
			added = list.added;
			accounts = list.accounts;
			loadError = "";
		} catch (error) {
			loadError = `Couldn't read your model services: ${(error as Error).message}`;
		}
	}

	/** ChatGPT's page opens in the browser; the engine waits for it to come back. `account` signs in again. */
	async function continueWithChatGpt(account?: string) {
		signing = true;
		planFailed = false;
		planMessage = "Finish in your browser. EnrichedLab is waiting for ChatGPT.";
		try {
			const result = await rpc.call("provider.signin", { service: "chatgpt", account });
			planMessage = result.account.plan
				? `Signed in as ${result.account.label}. ${result.models} models on your plan are in the model menu.`
				: `Signed in as ${result.account.label}, but plan use wasn't allowed. Continue with ChatGPT again and allow it.`;
			await lab.refreshModels();
			await load();
			if (result.welcome) welcomeDialog?.showModal();
		} catch (error) {
			planFailed = true;
			planMessage = (error as Error).message;
		} finally {
			signing = false;
		}
	}

	async function signOut(account: ServiceAccount) {
		try {
			const { revoked } = await rpc.call("provider.signout", { service: "chatgpt", account: account.id });
			planFailed = !revoked;
			planMessage = revoked ? `Signed out of ${account.label}.` : `Signed out here. ChatGPT didn't confirm the session ended; you can disconnect EnrichedLab in ChatGPT settings.`;
			await lab.refreshModels();
			await load();
		} catch (error) {
			planFailed = true;
			planMessage = `Couldn't sign out of ${account.label}: ${(error as Error).message}`;
		}
	}

	async function use(account: ServiceAccount) {
		try {
			await rpc.call("provider.use", { service: "chatgpt", account: account.id });
			planFailed = false;
			planMessage = `Using ${account.label}.`;
			await lab.refreshModels();
			await load();
		} catch (error) {
			planFailed = true;
			planMessage = `Couldn't switch to ${account.label}: ${(error as Error).message}`;
		}
	}

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			message = "";
			key = "";
			if (lab.servicesTab) tab = lab.servicesTab;
			lab.servicesTab = undefined;
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
		try {
			await rpc.call("provider.remove", { name });
			failed = false;
			message = `Removed ${added.find((a) => a.name === name)?.label ?? name}.`;
			await lab.refreshModels();
			await load();
		} catch (error) {
			failed = true;
			message = `Couldn't remove it: ${(error as Error).message}`;
		}
	}
</script>

<dialog class="sheet services" bind:this={dialog} onclose={() => (open = false)} aria-labelledby="services-title">
	<form method="dialog" class="sheet-head">
		<h2 id="services-title">Model Services</h2>
		<button class="icon-btn" aria-label="Close">
			<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></svg>
		</button>
	</form>
	<p class="lead">Models come from three places besides your labs, which add theirs when you sign in.</p>
	{#if loadError}
		<p class="load-error" role="alert">{loadError} <button type="button" class="link" onclick={load}>Try again</button></p>
	{/if}
	<div class="segmented tabs" role="tablist" aria-label="Where models come from">
		{#each [["plan", "ChatGPT Plan"], ["local", "This Computer"], ["keys", "Your Keys"]] as const as [id, label] (id)}
			<button role="tab" id={`svc-${id}`} aria-selected={tab === id} aria-controls={`svc-panel-${id}`} class:on={tab === id} onclick={() => (tab = id)}>{label}</button>
		{/each}
	</div>

	{#if tab === "plan"}
	<div class="plan" id="svc-panel-plan" role="tabpanel" aria-labelledby="svc-plan">
		<h3 id="plan-title">Your ChatGPT plan</h3>
		<p class="note">Requests in EnrichedLab can use the usage included in your ChatGPT plan. No key, and nothing billed by EnrichedLab.</p>
		{#if accounts.length}
			<ul class="accounts">
				{#each accounts as account (account.id)}
					<li>
						<span class="who">{account.label}</span>
						<span class="state">{account.active && account.plan ? "In use" : account.signedIn ? (account.plan ? "Signed in" : "Plan use not allowed") : "Signed out"}</span>
						{#if account.signedIn && account.plan && !account.active}
							<button type="button" class="link" onclick={() => use(account)}>Use</button>
						{/if}
						{#if account.signedIn}
							<button type="button" class="link" onclick={() => signOut(account)}>Sign out</button>
						{:else}
							<button type="button" class="link" disabled={signing} onclick={() => continueWithChatGpt(account.id)}>Sign in</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<div class="actions">
			<button type="button" class="chatgpt" data-oai-siwc-button disabled={signing} onclick={() => continueWithChatGpt()}>
				<ChatGptMark />
				<span>{accounts.length ? "Add another ChatGPT account" : "Continue with ChatGPT"}</span>
			</button>
			{#if accounts.some((a) => a.signedIn)}<a class="usage" href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>{/if}
		</div>
		<p class="status" class:failed={planFailed} role="status" aria-live="polite">{planMessage}</p>
	</div>
	{:else if tab === "local"}
	<div id="svc-panel-local" role="tabpanel" aria-labelledby="svc-local">
		<LocalModels active={open && tab === "local"} />
	</div>
	{:else}
	<div id="svc-panel-keys" role="tabpanel" aria-labelledby="svc-keys">
	<h3>Add a key</h3>
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
		<h3>Keys added</h3>
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
	</div>
	{/if}
</dialog>

<dialog bind:this={welcomeDialog} class="welcome" aria-labelledby="welcome-title">
	<ChatGptMark size={28} />
	<h2 id="welcome-title">You're using your ChatGPT plan</h2>
	<p>Eligible requests in EnrichedLab now use the usage included in your ChatGPT plan. You can review and limit it in ChatGPT settings.</p>
	<div class="welcome-actions">
		<a href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
		<form method="dialog"><button class="primary">Got it</button></form>
	</div>
</dialog>

<style>
	.load-error {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--bad);
	}
	/* The sheet fits the tab shown; it opens from the top, so a change of height never moves the tabs. */
	.services {
		--sheet-width: 560px;
	}
	.tabs {
		display: grid;
		width: 100%;
		margin: 4px 0 8px;
	}
	.welcome {
		width: min(400px, calc(100vw - 32px));
		padding: 22px;
		border: 0;
		border-radius: 14px;
		background: var(--raised);
		color: var(--text);
		box-shadow: var(--shadow);
	}
	.welcome::backdrop {
		background: light-dark(rgb(2 40 81 / 0.22), rgb(0 0 0 / 0.55));
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
		border: 1px solid var(--edge);
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
		border: 1px solid var(--edge);
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
	.plan {
		padding-bottom: 6px;
	}
	.plan h3 {
		margin-top: 4px;
	}
	.plan .note {
		margin-bottom: 10px;
	}
	.plan .actions {
		margin-top: 4px;
	}
	.plan .status:empty {
		display: none;
	}
	.plan .status {
		margin-top: 10px;
	}
	/* OpenAI's "Continue with ChatGPT" formats: black on light surfaces, white on dark. */
	.chatgpt {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		min-height: 40px;
		padding: 0 18px 0 14px;
		border-radius: 999px;
		background: light-dark(#000, #fff);
		color: light-dark(#fff, #000);
		font-size: 14px;
		font-weight: 500;
		transition: background-color 120ms ease-out;
	}
	.chatgpt:hover:not(:disabled) {
		background: light-dark(#262626, #e3e3e3);
	}
	.chatgpt:disabled {
		opacity: 0.5;
	}
	.usage {
		color: var(--link);
		font-size: 13px;
	}
	.accounts {
		list-style: none;
		margin: 0 0 12px;
		padding: 0;
	}
	.accounts li {
		display: flex;
		align-items: baseline;
		gap: 12px;
		padding: 8px 0;
		border-top: 1px solid var(--rule);
		font-size: 13px;
	}
	.accounts .who {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.accounts .state {
		color: var(--text-muted);
		font-size: 12.5px;
	}
	.welcome {
		width: min(400px, calc(100vw - 32px));
		padding: 26px 24px 20px;
		text-align: center;
	}
	.welcome h2 {
		margin: 12px 0 8px;
	}
	.welcome p {
		margin: 0 0 18px;
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.welcome-actions {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 18px;
		font-size: 13px;
	}
	.welcome-actions a {
		color: var(--link);
	}
	.welcome-actions form {
		margin: 0;
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
