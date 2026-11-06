<script lang="ts">
	// A new session, as one composer: say what to do, then where (the project folder and the place its commands run)
	// and with which model, in one row under the text. Everything has a sensible default, so Enter starts.
	import { lab } from "../lib/store.svelte.ts";
	import { mac, SANDBOX_NOTE } from "../lib/places.ts";
	import { folderName, shortPath, tokens } from "../lib/format.ts";
	import { separator, showMenu, type MenuAction } from "../lib/menu.svelte.ts";

	let { onMenu }: { onMenu: () => void } = $props();

	const recent = $derived([...new Set(lab.sessions.map((s) => s.cwd.replace(/[\\/]\.git[\\/]enrichedlab-worktrees[\\/].*$/, "")))].slice(0, 8));
	let folder = $state("");
	let typingPath = $state(false);
	let place = $state(lab.newPlace ?? "local");
	let model = $state<string | undefined>();
	let worktree = $state(false);
	let task = $state("");
	let starting = $state(false);
	let field: HTMLTextAreaElement | undefined = $state();

	$effect(() => {
		if (!folder && recent[0]) folder = recent[0];
	});
	$effect(() => {
		if (lab.newPlace) place = lab.newPlace;
	});
	$effect(() => {
		field?.focus({ preventScroll: true });
	});

	const chosen = $derived(lab.places.find((p) => p.id === place) ?? lab.places[0]!);
	const isolated = $derived(Boolean(chosen?.site?.isolated));
	const chosenModel = $derived(lab.models.find((m) => m.ref === model));
	const named = (m: { id: string; label: string }) => m.label.split(" · ")[0] || m.id;

	async function pickFolder() {
		const path = await window.labDesktop?.pickFolder();
		if (path) folder = path;
	}

	function folderMenu(): MenuAction[] {
		return [
			...recent.map((path) => ({ label: folderName(path), checked: folder === path, run: () => ((folder = path), (typingPath = false)) })),
			separator,
			...(window.labDesktop ? [{ label: "Choose Folder…", run: pickFolder }] : []),
			{ label: "Type a Path…", run: () => (typingPath = true) },
		];
	}

	function modelMenu(): MenuAction[] {
		const labTitle = (provider: string) => lab.sites.find((s) => s.name === provider)?.title ?? provider;
		const sections: [string, typeof lab.models][] = [];
		for (const provider of new Set(lab.models.filter((m) => m.source === "site").map((m) => m.provider))) sections.push([`From ${labTitle(provider)}`, lab.models.filter((m) => m.source === "site" && m.provider === provider)]);
		sections.push(["Your plans and keys", lab.models.filter((m) => m.source === "config")], ["On this computer", lab.models.filter((m) => m.source === "local")]);
		const entries: MenuAction[] = [{ label: "Default model", checked: !model, run: () => (model = undefined) }];
		for (const [label, models] of sections) {
			if (!models.length) continue;
			entries.push(separator, { label, disabled: true });
			for (const m of models) entries.push({ label: `${named(m)}  ·  ${tokens(m.context)}`, checked: model === m.ref, run: () => (model = m.ref) });
		}
		entries.push(separator, { label: "Model Services…", run: () => (lab.services = true) });
		return entries;
	}

	async function start(e?: Event) {
		e?.preventDefault();
		if (!folder.trim() || starting) return;
		starting = true;
		lab.newPlace = undefined;
		// A lab that keeps data in place binds the session to it; other labs take the session (and its repository) along.
		const id = await lab.create(folder.trim(), isolated ? { site: place, worktree, model } : { place, worktree, model });
		if (id && task.trim()) await lab.send(task.trim());
		starting = false;
	}

	function keys(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) start(e);
	}

	/** The last two folders of a path: enough to recognize it; the whole path is on hover. */
	const tail = (path: string) => {
		const parts = shortPath(path).split(/[\\/]/).filter(Boolean);
		return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : shortPath(path);
	};
	const where = $derived(chosen.id === "local" ? `Works in ${folder ? tail(folder) : "the folder you choose"} on ${chosen.title}, with the operating system's containment.` : isolated ? `Works inside ${chosen.title}: code and data stay in the lab.` : `Works in the ${chosen.title} sandbox (${SANDBOX_NOTE.toLowerCase()}).`);
</script>

<header class="head toolbar" class:inset={!lab.sidebar}>
	<button class="icon-btn menu-toggle" onclick={onMenu} aria-label="Show places and sessions">
		<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></svg>
	</button>
	{#if !lab.sidebar}
		<button class="icon-btn" onclick={() => (lab.sidebar = true)} title={`Show the sidebar (${mac ? "⌃⌘S" : "Ctrl+Shift+S"})`} aria-label="Show the sidebar">
			<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M6 2.5v11" /></svg>
		</button>
	{/if}
</header>

<form class="start" onsubmit={start}>
	<h1>What should we work on?</h1>

	<div class="card">
		<label class="visually-hidden" for="task-field">Task</label>
		<textarea id="task-field" bind:this={field} bind:value={task} onkeydown={keys} rows="3" placeholder="Describe a task, or leave this empty to open the session"></textarea>
		<div class="row">
			{#if typingPath}
				<!-- svelte-ignore a11y_autofocus -->
				<input class="path" bind:value={folder} placeholder="/path/to/project" spellcheck="false" autofocus aria-label="Project folder" onkeydown={(e) => (e.key === "Enter" || e.key === "Escape") && (e.preventDefault(), (typingPath = false))} onblur={() => (typingPath = false)} />
			{:else}
				<button type="button" class="chip" onclick={(e) => (recent.length || !window.labDesktop ? showMenu(folderMenu(), e.currentTarget as HTMLElement) : pickFolder())} title={folder || "Choose the project folder"}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.6l1.4 1.5h4A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5Z" /></svg>
					<span class="label">{folder ? folderName(folder) : "Choose a folder"}</span>
					<svg class="caret" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
				</button>
			{/if}

			<div class="segmented places" role="radiogroup" aria-label="Runs on">
				{#each lab.places as p (p.id)}
					<button type="button" role="radio" aria-checked={place === p.id} class:on={place === p.id} disabled={!p.ready} onclick={() => (place = p.id)} title={p.ready ? "" : p.site?.signedIn ? `${p.title} has no sandbox for you yet` : `Sign in to ${p.title} first`}>
						<span class="place-dot" class:local={p.id === "local"} style:--dot={`var(${p.color})`}></span>
						{p.title}
					</button>
				{/each}
			</div>

			<button type="button" class="chip" onclick={(e) => showMenu(modelMenu(), e.currentTarget as HTMLElement)} title="Choose the model">
				<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2.5" /><path d="M6 6.5h4M6 9.5h2.5" /></svg>
				<span class="label">{chosenModel ? named(chosenModel) : "Default model"}</span>
				<svg class="caret" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
			</button>

			<span class="spacer"></span>
			<button class="go" type="submit" disabled={!folder.trim() || starting} aria-label={task.trim() ? "Start" : "Open session"} title={`${task.trim() ? "Start" : "Open session"} (Return)`}>
				{#if starting}
					<span class="spin" aria-hidden="true"></span>
				{:else}
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
				{/if}
			</button>
		</div>
	</div>

	<p class="where" title={folder}>{where}</p>
	<label class="check"><input type="checkbox" bind:checked={worktree} /> Work on its own git branch, away from your checkout</label>

	{#if !lab.models.length}
		<div class="no-model" role="note">
			<p><strong>No model yet.</strong> Sign in to a lab, use your ChatGPT plan or a key, or run an open model on this computer.</p>
			<button type="button" class="btn primary" onclick={() => (lab.services = true)}>Set Up a Model</button>
		</div>
	{/if}

	{#if lab.places.some((p) => p.site && !p.site.signedIn)}
		<p class="signin">
			{#each lab.places.filter((p) => p.site && !p.site.signedIn) as p (p.id)}
				<button type="button" class="link" onclick={() => lab.login(p.id)}>Sign in to {p.title}</button> to work in its sandbox or use its models.
			{/each}
		</p>
	{/if}
</form>

<style>
	.head {
		display: flex;
		border-bottom: 0;
	}
	:global(.shell.mac.desktop) .head.inset {
		padding-left: var(--traffic-inset, 84px);
	}
	.menu-toggle {
		display: none;
	}
	.start {
		flex: 1;
		min-height: 0;
		width: 100%;
		max-width: 720px;
		margin: 0 auto;
		padding: 12vh 32px 48px;
		overflow-y: auto;
	}
	h1 {
		margin: 0 0 18px;
		font-family: var(--font-display);
		font-size: 24px;
		font-weight: 650;
		letter-spacing: -0.018em;
		text-align: center;
	}
	.card {
		border: 1px solid var(--edge);
		border-radius: 16px;
		background: var(--raised);
		box-shadow: 0 1px 2px var(--shadow-color), 0 8px 24px var(--shadow-color);
		padding: 14px 10px 10px 16px;
		transition: border-color 150ms ease-out;
	}
	.card:focus-within {
		border-color: var(--focus-inner);
	}
	textarea {
		display: block;
		width: 100%;
		border: 0;
		outline: none;
		resize: none;
		background: transparent;
		font-size: 15px;
		line-height: 1.5;
		padding: 0 4px 10px 0;
	}
	textarea:focus-visible {
		box-shadow: none;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.spacer {
		flex: 1;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		max-width: 220px;
		padding: 0 9px;
		border-radius: 8px;
		background: var(--fill);
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text);
		transition: background-color 120ms ease-out;
	}
	.chip:hover {
		background: var(--hover);
	}
	.chip svg {
		width: 14px;
		height: 14px;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linejoin: round;
		color: var(--text-muted);
	}
	.chip svg.caret {
		width: 11px;
		height: 11px;
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.path {
		height: 30px;
		width: 260px;
		padding: 0 9px;
		border: 0;
		border-radius: 8px;
		background: var(--canvas);
		box-shadow: inset 0 0 0 2px var(--focus-inner);
		font: 12.5px var(--font-mono);
		outline: none;
	}
	.places button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-width: 0;
	}
	.places button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.go {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--primary-bg);
		color: var(--primary-fg);
		transition: opacity 120ms ease-out, transform 80ms ease-out;
	}
	.go:disabled {
		opacity: 0.3;
	}
	.go:not(:disabled):active {
		transform: scale(0.94);
	}
	.go svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.spin {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid currentColor;
		border-right-color: transparent;
		animation: spin 700ms linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.where {
		margin: 12px 4px 4px;
		font-size: 12.5px;
		color: var(--text-muted);
		text-align: center;
	}
	.check {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin: 0 4px;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.check input {
		accent-color: var(--accent);
	}
	.no-model {
		display: flex;
		align-items: center;
		gap: 16px;
		margin: 28px 0 0;
		padding: 14px 0;
		border-top: 1px solid var(--rule);
		border-bottom: 1px solid var(--rule);
	}
	.no-model p {
		flex: 1;
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}
	.no-model strong {
		color: var(--text);
		font-weight: 600;
	}
	.signin {
		margin: 22px 0 0;
		font-size: 12.5px;
		color: var(--text-muted);
		text-align: center;
	}
	.link {
		color: var(--link);
		font-weight: 500;
	}
	@media (max-width: 860px) {
		.menu-toggle {
			display: inline-grid;
		}
		.start {
			padding: 6vh 16px 32px;
		}
		h1 {
			font-size: 20px;
		}
		.no-model {
			flex-direction: column;
			align-items: flex-start;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation: none;
		}
	}
</style>
