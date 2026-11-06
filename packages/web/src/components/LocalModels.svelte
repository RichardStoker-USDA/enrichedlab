<script lang="ts">
	// Open models on this computer: the servers running here, and models to download through Ollama that fit this
	// computer's memory. A download shows its progress in place and can be stopped; a downloaded model joins the
	// model menu as soon as it's ready.
	import type { LocalModelsStatus, LocalPullProgress, SuggestedModel } from "@enrichedlab/protocol";
	import { lab } from "../lib/store.svelte.ts";
	import { rpc } from "../lib/rpc.ts";

	let { active }: { active: boolean } = $props();

	let status = $state<LocalModelsStatus>();
	let loading = $state(false);
	let pulls = $state<Record<string, LocalPullProgress>>({});
	let other = $state("");
	let message = $state("");
	let failed = $state(false);

	const FIT_SHARE = 0.6;
	const gb = (bytes?: number) => (bytes ? (bytes / 1e9).toFixed(bytes < 1e10 ? 1 : 0) : "0");
	const needs = (m: SuggestedModel) => Math.ceil(m.sizeGB / FIT_SHARE);
	/** Every suggestion calls tools, so only the traits that tell them apart are shown. */
	const traits = (m: SuggestedModel) => m.traits.filter((t) => t !== "tools").join(" · ");
	// The most capable models that fit lead; the rest wait behind "More open models".
	const picks = $derived(status ? [...status.suggestions].filter((m) => m.fits || m.installed).sort((a, b) => b.sizeGB - a.sizeGB).slice(0, 3) : []);
	const more = $derived(status ? status.suggestions.filter((m) => !picks.includes(m)) : []);

	async function load() {
		loading = true;
		try {
			status = await rpc.call("local.models", {});
			for (const p of status.pulls) pulls[p.model] = p;
		} catch (error) {
			failed = true;
			message = (error as Error).message;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (active) void load();
	});

	$effect(() =>
		rpc.on("local.pull.progress", (p) => {
			if (!p.done) {
				pulls[p.model] = p;
				return;
			}
			delete pulls[p.model];
			failed = Boolean(p.error);
			message = p.error ? `${p.model}: ${p.error}` : p.status === "cancelled" ? `Stopped downloading ${p.model}.` : `${p.model} is ready in the model menu.`;
			if (!p.error && p.status !== "cancelled") void lab.refreshModels().then(load);
		}),
	);

	async function get(model: string) {
		failed = false;
		message = "";
		pulls[model] = { model, status: "starting" };
		try {
			await rpc.call("local.pull", { model });
		} catch (error) {
			delete pulls[model];
			failed = true;
			message = (error as Error).message;
		}
	}

	async function remove(model: string) {
		try {
			await rpc.call("local.remove", { model });
			message = `Removed ${model}.`;
			failed = false;
		} catch (error) {
			message = `${model} wasn't removed: ${(error as Error).message}`;
			failed = true;
			return;
		}
		await lab.refreshModels();
		await load();
	}

	function getOther(event: SubmitEvent) {
		event.preventDefault();
		const name = other.trim();
		if (!name) return;
		other = "";
		void get(name);
	}
</script>

<section class="local" aria-labelledby="local-title" aria-busy={loading}>
	<h3 id="local-title">On this computer</h3>
	{#if !status}
		{#if loading}
			<p class="note">Looking for model servers here…</p>
		{:else if failed}
			<p class="status failed" role="status">{message}</p>
			<button type="button" class="link" onclick={load}>Try again</button>
		{/if}
	{:else}
		<p class="note">
			{status.memoryGiB} GB of memory{status.appleSilicon ? ", Apple silicon" : ""}.
			{#if status.servers.length}
				Running here: {status.servers.map((s) => `${s.label}${s.version ? ` ${s.version}` : ""} (${s.models.length} ${s.models.length === 1 ? "model" : "models"})`).join(", ")}.
			{:else}
				No model server is running here.
			{/if}
		</p>
		{#if !status.ollama}
			<p class="note">
				To download open models, install Ollama and open it, then
				<button type="button" class="link" onclick={load} disabled={loading}>look again</button>.
				<a href="https://ollama.com/download" target="_blank" rel="noreferrer">Get Ollama</a>
			</p>
		{:else if status.ollama.updateForMlx}
			<p class="note">
				Ollama {status.ollama.version} runs models with llama.cpp here. Ollama 0.40 or later runs them on Apple's MLX, which is faster on this Mac.
				<a href="https://ollama.com/download" target="_blank" rel="noreferrer">Update Ollama</a>
			</p>
		{:else if status.ollama.mlx}
			<p class="note">Ollama runs models on Apple's MLX here.</p>
		{/if}

		{#snippet progress(pull: LocalPullProgress, label: string)}
			<div class="progress" role="progressbar" aria-label={`Downloading ${label}`} aria-valuemin={0} aria-valuemax={pull.total ?? 100} aria-valuenow={pull.completed ?? 0}>
				<span style:width={pull.total ? `${Math.min(100, ((pull.completed ?? 0) / pull.total) * 100)}%` : "0%"}></span>
			</div>
			<span class="facts">{pull.total ? `${gb(pull.completed)} of ${gb(pull.total)} GB` : pull.status}</span>
		{/snippet}

		{#snippet row(m: SuggestedModel)}
			{@const pull = pulls[m.model]}
			<li class:dim={!m.fits && !m.installed}>
				<div class="what">
					<span class="line"><span class="name">{m.label}</span><span class="size">{[`${m.sizeGB} GB`, traits(m)].filter(Boolean).join(" · ")}</span></span>
					<span class="about">{m.about}</span>
					{#if pull}{@render progress(pull, m.label)}{/if}
				</div>
				<div class="act">
					{#if pull}
						<button type="button" class="link" onclick={() => rpc.call("local.pull.cancel", { model: m.model })}>Stop</button>
					{:else if m.installed}
						<span class="have">Downloaded</span>
						<button type="button" class="link" onclick={() => remove(m.model)}>Remove</button>
					{:else if m.fits}
						<button type="button" class="get" disabled={!status?.ollama} onclick={() => get(m.model)}>Get</button>
					{:else}
						<span class="have">Needs {needs(m)} GB</span>
					{/if}
				</div>
			</li>
		{/snippet}

		{#if picks.length}
			<p class="sub">For this computer</p>
			<ul class="models">
				{#each picks as m (m.model)}{@render row(m)}{/each}
			</ul>
		{/if}
		{#if more.length}
			<details class="more" open={!picks.length}>
				<summary>More open models ({more.length})</summary>
				<ul class="models">
					{#each more as m (m.model)}{@render row(m)}{/each}
				</ul>
			</details>
		{/if}

		<form class="other" onsubmit={getOther}>
			<label class="entry">
				Any Ollama model
				<span class="row">
					<input bind:value={other} placeholder="qwen3.8:27b" spellcheck="false" autocomplete="off" disabled={!status.ollama} />
					<button type="submit" class="get" disabled={!status.ollama || !other.trim()}>Get</button>
				</span>
			</label>
			<a href="https://ollama.com/search?c=tools" target="_blank" rel="noreferrer">Browse models that call tools</a>
		</form>
		{#if Object.values(pulls).some((p) => !status?.suggestions.some((s) => s.model === p.model))}
			<ul class="models">
				{#each Object.values(pulls).filter((p) => !status?.suggestions.some((s) => s.model === p.model)) as p (p.model)}
					<li>
						<div class="what">
							<span class="name">{p.model}</span>
							{@render progress(p, p.model)}
						</div>
						<div class="act"><button type="button" class="link" onclick={() => rpc.call("local.pull.cancel", { model: p.model })}>Stop</button></div>
					</li>
				{/each}
			</ul>
		{/if}
		<p class="status" class:failed role="status" aria-live="polite">{message}</p>
		<p class="checked">Suggestions checked {status.checked}. Each fits when its download is at most {Math.round(FIT_SHARE * 100)}% of memory.</p>
	{/if}
</section>

<style>
	h3 {
		margin: 18px 0 6px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text-muted);
	}
	.note {
		margin: 6px 0 10px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.note a {
		color: var(--link);
		margin-left: 4px;
		font-size: 12.5px;
	}
	.other a {
		justify-self: start;
		color: var(--link);
		font-size: 12.5px;
	}
	.sub {
		margin: 12px 0 2px;
		font-size: 12px;
		color: var(--text-faint);
	}
	.models {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: 10px;
	}
	.line .name {
		white-space: nowrap;
	}
	.size {
		font: 11.5px var(--font-mono);
		color: var(--text-faint);
		white-space: nowrap;
	}
	.more {
		margin-top: 8px;
	}
	.more summary {
		min-height: 32px;
		display: flex;
		align-items: center;
		font-size: 12.5px;
		color: var(--link);
		cursor: pointer;
		list-style: none;
	}
	.more summary::-webkit-details-marker {
		display: none;
	}
	.more summary::before {
		content: "";
		width: 6px;
		height: 6px;
		margin-right: 8px;
		border-right: 1.5px solid currentColor;
		border-bottom: 1.5px solid currentColor;
		transform: rotate(-45deg);
		transition: transform 140ms ease-out;
	}
	.more[open] summary::before {
		transform: rotate(45deg);
	}
	@media (prefers-reduced-motion: reduce) {
		.more summary::before {
			transition: none;
		}
	}
	.more summary:focus-visible {
		outline: 2px solid var(--focus-inner);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.models li {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 10px 0;
		border-top: 1px solid var(--rule);
	}
	/* Too large for this computer: the name steps back, the reason stays readable. */
	.models li.dim .name {
		color: var(--text-muted);
	}
	.what {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
	}
	.name {
		font-size: 13.5px;
		font-weight: 600;
	}
	.facts {
		font: 11.5px var(--font-mono);
		color: var(--text-faint);
	}
	.about {
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--text-muted);
	}
	.act {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 32px;
	}
	.have {
		font-size: 12px;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.get {
		min-height: 32px;
		min-width: 64px;
		padding: 0 14px;
		border: 1px solid var(--edge);
		border-radius: 8px;
		font-size: 13px;
		font-weight: 500;
		transition: background-color 120ms ease-out, border-color 120ms ease-out;
	}
	.get:hover:not(:disabled) {
		background: var(--hover);
		border-color: var(--accent);
	}
	.get:disabled {
		opacity: 0.45;
	}
	.progress {
		height: 4px;
		margin-top: 6px;
		border-radius: 2px;
		background: var(--rule);
		overflow: hidden;
	}
	.progress span {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 240ms ease-out;
	}
	@media (prefers-reduced-motion: reduce) {
		.progress span {
			transition: none;
		}
	}
	.other {
		margin-top: 12px;
		display: grid;
		gap: 6px;
	}
	.entry {
		display: grid;
		gap: 4px;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.row {
		display: flex;
		gap: 8px;
	}
	.row input {
		flex: 1;
		min-width: 0;
		font: 13px var(--font-mono);
		color: var(--text);
		padding: 7px 10px;
		border: 1px solid var(--edge);
		border-radius: 8px;
		background: var(--canvas);
	}
	.status {
		margin: 10px 0 0;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.status:empty {
		display: none;
	}
	.status.failed {
		color: var(--bad);
	}
	.checked {
		margin: 10px 0 0;
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.link {
		color: var(--link);
		font-size: 12.5px;
	}
</style>
