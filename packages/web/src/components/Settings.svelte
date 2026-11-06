<script lang="ts">
	// Settings: how the app looks, the places this person can work in, and where models come from. Opened with
	// ⌘, (Ctrl+, elsewhere), the sidebar's Settings button, or the palette.
	import { lab } from "../lib/store.svelte.ts";

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) return;
		if (lab.settings && !dialog.open) dialog.showModal();
		else if (!lab.settings && dialog.open) dialog.close();
	});

	const labs = $derived(lab.places.filter((p) => p.site));
	const counts = $derived({
		lab: lab.models.filter((m) => m.source === "site").length,
		own: lab.models.filter((m) => m.source === "config").length,
		local: lab.models.filter((m) => m.source === "local").length,
	});
</script>

<dialog class="sheet" bind:this={dialog} onclose={() => (lab.settings = false)} aria-labelledby="settings-title">
	<form method="dialog" class="sheet-head">
		<h2 id="settings-title">Settings</h2>
		<button class="icon-btn" aria-label="Close settings">
			<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></svg>
		</button>
	</form>

	<section class="sheet-section">
		<h3>Appearance</h3>
		<div class="segmented" role="radiogroup" aria-label="Appearance">
			{#each ["auto", "light", "dark"] as const as option}
				<button role="radio" aria-checked={lab.ui.theme === option} class:on={lab.ui.theme === option} onclick={() => lab.setTheme(option)}>
					{option === "auto" ? "Match System" : option === "light" ? "Light" : "Dark"}
				</button>
			{/each}
		</div>
		<label class="toggle">
			<input type="checkbox" checked={lab.ui.showReasoning} onchange={(e) => lab.setUi({ showReasoning: (e.currentTarget as HTMLInputElement).checked })} />
			<span>
				Show the model's thinking while it works
				<small>Finished thinking stays one click away under “Thought”.</small>
			</span>
		</label>
	</section>

	<section class="sheet-section">
		<h3>Labs</h3>
		{#each labs as place (place.id)}
			{@const site = place.site!}
			<div class="row">
				<span class="place-dot" style:--dot={`var(${place.color})`}></span>
				<span class="what">
					<span class="name">{place.title}</span>
					<span class="sub">{site.signedIn ? `Signed in as ${site.who ?? "you"} · ${site.models} ${site.models === 1 ? "model" : "models"} · ${site.tools} tools${site.sandbox ? " · sandbox" : ""}` : site.error ? `Can't connect: ${site.error}` : "Not signed in"}</span>
					<span class="url">{site.url}</span>
				</span>
				<span class="acts">
					{#if site.signedIn}
						<button class="btn" onclick={() => lab.logout(place.id)}>Sign Out</button>
					{:else}
						<button class="btn primary" onclick={() => lab.login(place.id)}>Sign In</button>
					{/if}
					<button class="btn quiet" onclick={() => ((lab.settings = false), lab.removeLab(place.id))}>Remove…</button>
				</span>
			</div>
		{:else}
			<p class="note">No labs yet. A lab gives you its models, tools and a sandbox next to its data.</p>
		{/each}
		<button class="btn" onclick={() => ((lab.settings = false), (lab.join = {}))}>Add a Lab…</button>
	</section>

	<section class="sheet-section">
		<h3>Models</h3>
		<p class="note">
			{counts.lab} from your labs · {counts.own} from your plans and keys · {counts.local} on this computer.
		</p>
		<button class="btn" onclick={() => ((lab.settings = false), (lab.services = true))}>Model Services…</button>
	</section>
</dialog>

<style>
	.toggle {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin-top: 14px;
		font-size: 13px;
	}
	.toggle input {
		margin: 3px 0 0;
		accent-color: var(--accent);
	}
	.toggle small {
		display: block;
		color: var(--text-muted);
		font-size: 12px;
	}
	.row {
		display: grid;
		grid-template-columns: 8px minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		padding: 8px 0 12px;
	}
	.what {
		display: grid;
		min-width: 0;
	}
	.acts {
		display: flex;
		gap: 6px;
	}
	.name {
		font-weight: 600;
		font-size: 13.5px;
	}
	.sub {
		font-size: 12px;
		color: var(--text-muted);
	}
	.url {
		font: 11.5px var(--font-mono);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.note {
		margin: 0 0 10px;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
