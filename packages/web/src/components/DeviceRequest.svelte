<script lang="ts">
	// Another computer signed in to a lab as this person and asks to use the sign-in. Only the person knows whether
	// that was them, so the window asks; nothing approves on its own. "Not mine" revokes the request at once.
	import { lab } from "../lib/store.svelte.ts";
	import { rpc } from "../lib/rpc.ts";

	let dialog = $state<HTMLDialogElement>();
	let busy = $state(false);
	let message = $state("");
	let failed = $state(false);
	const request = $derived(lab.deviceRequests[0]);
	const when = $derived.by(() => {
		const at = request ? new Date(request.created) : undefined;
		return at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "just now";
	});

	$effect(() => {
		if (!dialog || !request) return;
		message = "";
		failed = false;
		if (!dialog.open) dialog.showModal();
	});

	async function answer(approve: boolean) {
		if (!request) return;
		busy = true;
		failed = false;
		message = approve ? "Approving…" : "Revoking…";
		try {
			await rpc.call(approve ? "lab.device.approve" : "lab.device.revoke", { name: request.site, id: request.id });
			lab.say(approve ? `Approved ${request.name} for ${request.lab}.` : `Revoked ${request.name}; it can't use your ${request.lab} sign-in.`);
			dialog?.close();
		} catch (error) {
			failed = true;
			message = (error as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<dialog bind:this={dialog} onclose={() => lab.deviceRequests.length && (lab.deviceRequests = lab.deviceRequests.slice(1))} aria-labelledby="device-title">
	{#if request}
		<form method="dialog" class="head">
			<h2 id="device-title">A new device wants your {request.lab} sign-in</h2>
			<button class="close" aria-label="Decide later">×</button>
		</form>
		<p class="lead">
			<strong>{request.name}</strong> signed in at {when}. Approve it only if you just signed in there. If you didn't, revoke it: someone else may
			have your sign-in.
		</p>
		<div class="actions">
			<p class="status" class:failed role="status" aria-live="polite">{message}</p>
			<button class="btn" disabled={busy} onclick={() => answer(false)}>Not mine, revoke</button>
			<button class="primary" disabled={busy} onclick={() => answer(true)}>Approve</button>
		</div>
	{/if}
</dialog>

<style>
	dialog {
		width: min(460px, calc(100vw - 32px));
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
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px 0 4px;
	}
	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
	}
	.close {
		flex: none;
		width: 32px;
		height: 32px;
		font-size: 20px;
		color: var(--text-muted);
		border-radius: 8px;
	}
	.close:hover {
		background: var(--hover);
	}
	.lead {
		margin: 6px 0 12px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.lead strong {
		color: var(--text);
		font-weight: 600;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 14px;
	}
	.status {
		flex: 1 1 100%;
		margin: 0;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.status:empty {
		display: none;
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
	.primary:disabled,
	.btn:disabled {
		opacity: 0.45;
	}
</style>
