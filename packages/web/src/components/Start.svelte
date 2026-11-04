<script lang="ts">
	import { lab } from "../lib/store.svelte.ts";
	import { mac, SANDBOX_NOTE } from "../lib/places.ts";
	import { folderName, shortPath } from "../lib/format.ts";

	let { onMenu }: { onMenu: () => void } = $props();

	const recent = $derived([...new Set(lab.sessions.map((s) => s.cwd.replace(/[\\/]\.git[\\/]enrichedlab-worktrees[\\/].*$/, "")))].slice(0, 6));
	let folder = $state("");
	let place = $state("local");
	let worktree = $state(false);
	let task = $state("");
	let starting = $state(false);
	$effect(() => {
		if (!folder && recent[0]) folder = recent[0];
	});

	const chosen = $derived(lab.places.find((p) => p.id === place));
	const isolated = $derived(Boolean(chosen?.site?.isolated));

	async function pick() {
		const path = await window.labDesktop?.pickFolder();
		if (path) folder = path;
	}

	async function start(e: Event) {
		e.preventDefault();
		if (!folder.trim() || starting) return;
		starting = true;
		// A lab that keeps data in place binds the session to it; other labs take the session (and its repository) along.
		const id = await lab.create(folder.trim(), isolated ? { site: place, worktree } : { place, worktree });
		if (id && task.trim()) await lab.send(task.trim());
		starting = false;
	}

	function keys(e: KeyboardEvent) {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start(e);
	}
</script>

<header class="head">
	<button class="icon-btn menu-toggle" onclick={onMenu} aria-label="Places and sessions">
		<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></svg>
	</button>
</header>
<form class="start" onsubmit={start}>
	<h1>New session</h1>

	<fieldset>
		<legend>Project folder</legend>
		<div class="folder">
			<input class="field" bind:value={folder} placeholder="/path/to/project" spellcheck="false" aria-label="Project folder" />
			{#if window.labDesktop}<button type="button" class="btn" onclick={pick}>Choose…</button>{/if}
		</div>
		{#if recent.length}
			<div class="recent">
				{#each recent as path (path)}
					<button type="button" class:on={folder === path} onclick={() => (folder = path)} title={path}>{folderName(path)}</button>
				{/each}
			</div>
		{/if}
		<p class="hint">{folder ? shortPath(folder) : "Your files stay where they are; the agent works inside this folder."}</p>
	</fieldset>

	<fieldset>
		<legend>Runs on</legend>
		<div class="places" role="radiogroup" aria-label="Runs on">
			{#each lab.places as p (p.id)}
				<button type="button" role="radio" aria-checked={place === p.id} class="place" class:on={place === p.id} disabled={!p.ready} onclick={() => (place = p.id)}>
					<span class="place-dot" class:local={p.id === "local"} style:--dot={`var(${p.color})`}></span>
					<span class="text">
						<span class="title">{p.id === "local" ? p.title : `${p.title} sandbox`}</span>
						<span class="sub">
							{#if p.id === "local"}Contained by the operating system{:else if !p.ready}{p.site?.signedIn ? "No sandbox for you" : "Sign in from the rail first"}{:else if p.site?.isolated}Code and data stay in {p.title}{:else}{SANDBOX_NOTE}{/if}
						</span>
					</span>
				</button>
			{/each}
		</div>
		<label class="check"><input type="checkbox" bind:checked={worktree} /> Work on its own git branch, away from your checkout</label>
	</fieldset>

	<fieldset>
		<legend>First task <span class="optional">optional</span></legend>
		<textarea class="field task" bind:value={task} onkeydown={keys} rows="4" placeholder="What should the agent do?"></textarea>
	</fieldset>

	<div class="go">
		<button class="btn primary" type="submit" disabled={!folder.trim() || starting}>{starting ? "Starting…" : task.trim() ? "Start" : "Open session"}</button>
		<kbd>{mac ? "⌘" : "Ctrl"} Enter</kbd>
	</div>
</form>

<style>
	.head {
		display: none;
		padding: 8px;
	}
	.start {
		width: 100%;
		max-width: 640px;
		margin: 0 auto;
		padding: 10vh 32px 48px;
		overflow-y: auto;
	}
	h1 {
		margin: 0 0 22px;
		font-family: var(--font-display);
		font-size: 22px;
		font-weight: 650;
		letter-spacing: -0.015em;
	}
	fieldset {
		margin: 0 0 22px;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 8px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text-muted);
	}
	.optional {
		font-weight: 400;
		color: var(--text-faint);
	}
	.folder {
		display: flex;
		gap: 8px;
	}
	.folder .field {
		flex: 1;
		height: 36px;
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.folder .btn {
		height: 36px;
	}
	.recent {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}
	.recent button {
		height: 26px;
		padding: 0 10px;
		border-radius: 13px;
		border: 1px solid var(--rule);
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.recent button:hover {
		color: var(--text);
		border-color: var(--rule-strong);
	}
	.recent button.on {
		color: var(--text);
		border-color: var(--accent);
	}
	.hint {
		margin: 6px 0 0;
		font-size: 12px;
		color: var(--text-faint);
	}
	.places {
		display: grid;
		gap: 6px;
	}
	.place {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
		border-radius: var(--radius);
		border: 1px solid var(--rule);
		text-align: left;
	}
	.place:hover:not(:disabled) {
		border-color: var(--rule-strong);
	}
	.place.on {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.place:disabled {
		opacity: 0.55;
	}
	.text {
		display: flex;
		flex-direction: column;
	}
	.title {
		font-weight: 500;
	}
	.sub {
		font-size: 12px;
		color: var(--text-faint);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 12px;
		font-size: 13px;
		color: var(--text-muted);
	}
	.task {
		width: 100%;
		height: auto;
		padding: 10px 12px;
		resize: vertical;
		line-height: 1.5;
	}
	.go {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.go .btn {
		height: 36px;
		padding: 0 18px;
	}
	@media (max-width: 860px) {
		.head {
			display: block;
		}
		.start {
			padding: 12px 18px 40px;
		}
	}
</style>
