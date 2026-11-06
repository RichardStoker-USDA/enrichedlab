<script lang="ts">
	// Add a lab: from an invite link (enrichedlab://join?url=…&name=…&title=…) or typed in. Adding a lab means using
	// its models and tools after signing in there, so the sheet shows exactly which address it is.
	import { lab } from "../lib/store.svelte.ts";
	import { rpc } from "../lib/rpc.ts";

	let dialog = $state<HTMLDialogElement>();
	let address = $state("");
	let name = $state("");
	let title = $state("");
	let isolated = $state(false);
	let busy = $state(false);
	let message = $state("");
	let failed = $state(false);
	const host = $derived.by(() => {
		try {
			return new URL(address).host;
		} catch {
			return "";
		}
	});

	$effect(() => {
		const invite = lab.join;
		if (!dialog || !invite) return;
		address = invite.url ?? "";
		name = invite.name ?? "";
		title = invite.title ?? "";
		isolated = invite.isolated === true;
		message = "";
		failed = false;
		if (!dialog.open) dialog.showModal();
	});

	function slug(text: string): string {
		return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "lab";
	}

	async function join(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		failed = false;
		message = "Adding the lab…";
		try {
			const id = name.trim() || slug(title || host.split(".")[0] || "lab");
			await rpc.call("site.add", { name: id, url: address.trim(), title: title.trim() || undefined, isolated: isolated || undefined });
			message = "Finish signing in in your browser. The first time, the lab may ask you to set up a passkey, a security key or an authenticator app.";
			await lab.login(id);
			dialog?.close();
		} catch (error) {
			failed = true;
			message = (error as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<dialog class="sheet" style:--sheet-width="460px" bind:this={dialog} onclose={() => (lab.join = undefined)} aria-labelledby="join-title">
	<form method="dialog" class="sheet-head">
		<h2 id="join-title">{title ? `Join ${title}` : "Add a lab"}</h2>
		<button class="icon-btn" aria-label="Close"><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
	</form>
	<p class="lead">
		A lab gives you its models, tools and a sandbox for your work, after you sign in with the account it invited. You can remove it any time.
	</p>
	<form onsubmit={join}>
		<label class="entry">Address <input type="url" bind:value={address} placeholder="https://gate.example.org" required spellcheck="false" /></label>
		{#if host}<p class="host">You'll sign in at <strong>{host}</strong>.</p>{/if}
		{#if isolated}<p class="host">This lab keeps its data inside: its sessions work in its sandbox with its models only.</p>{/if}
		<div class="actions">
			<p class="status" class:failed role="status" aria-live="polite">{message}</p>
			<button type="submit" class="primary" disabled={busy || !host}>{busy ? "Working…" : "Add and sign in"}</button>
		</div>
	</form>
</dialog>

<style>
	.lead,
	.host {
		margin: 6px 0 12px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.host strong {
		color: var(--text);
		font-family: var(--font-mono);
		font-weight: 500;
	}
	.entry {
		display: grid;
		gap: 4px;
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
</style>
