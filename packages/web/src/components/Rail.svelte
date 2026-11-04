<script lang="ts">
	import type { SessionSummary } from "@enrichedlab/protocol";
	import { lab } from "../lib/store.svelte.ts";
	import { ago, folderName } from "../lib/format.ts";
	import { mac, placeOf } from "../lib/places.ts";

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let filter = $state("");
	let expanded = $state<Record<string, boolean>>({});

	/** A session's project: its repository for worktree sessions, else its folder. */
	function projectOf(cwd: string): string {
		const worktree = /^(.*?)[\\/]\.git[\\/]enrichedlab-worktrees[\\/]/.exec(cwd);
		return worktree ? worktree[1]! : cwd;
	}

	const projects = $derived.by(() => {
		const query = filter.trim().toLowerCase();
		const byProject = new Map<string, SessionSummary[]>();
		for (const s of lab.sessions) {
			if (query && !s.title.toLowerCase().includes(query) && !folderName(s.cwd).toLowerCase().includes(query)) continue;
			const key = projectOf(s.cwd);
			let list = byProject.get(key);
			if (!list) byProject.set(key, (list = []));
			list.push(s);
		}
		return [...byProject.entries()].map(([path, sessions]) => ({ path, name: folderName(path), sessions }));
	});

	const currentProject = $derived(lab.summary ? projectOf(lab.summary.cwd) : undefined);

	function pick(id: string) {
		lab.go(id);
		open = false;
	}

	function fresh() {
		lab.startNew();
		open = false;
	}

	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
</script>

{#if open}
	<button class="scrim" aria-label="Close" onclick={() => (open = false)}></button>
{/if}
<nav class="rail" class:open aria-label="Places and sessions">
	<div class="top">
		<span class="wordmark">EnrichedLab</span>
		<button class="icon-btn" onclick={fresh} title="New session" aria-label="New session">
			<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" /></svg>
		</button>
	</div>
	<button class="search" onclick={() => (lab.palette = true)}>
		<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3 3" /></svg>
		<span>Search and commands</span>
		<kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
	</button>

	<div class="scroll">
		<section aria-labelledby="places-label">
			<h2 id="places-label">Places</h2>
			{#each lab.places as place (place.id)}
				<div class="place" class:here={lab.current && lab.place.id === place.id}>
					<span class="place-dot" class:local={place.id === "local"} style:--dot={`var(${place.color})`}></span>
					<span class="name">{place.title}</span>
					{#if place.site && !place.site.signedIn}
						<button class="sign-in" onclick={() => lab.login(place.id)}>Sign in</button>
					{:else}
						<span class="detail" title={place.site?.warning ?? place.site?.error ?? ""}>{place.detail}</span>
					{/if}
				</div>
			{/each}
			<button class="add-lab" onclick={() => (lab.join = {})}>Add a lab</button>
		</section>

		<section aria-labelledby="projects-label">
			<h2 id="projects-label">Projects</h2>
			<input class="filter" placeholder="Filter" bind:value={filter} aria-label="Filter sessions" />
			{#each projects as project (project.path)}
				{@const showAll = expanded[project.path] || filter}
				{@const shown = showAll ? project.sessions : project.sessions.slice(0, project.path === currentProject ? 8 : 3)}
				<div class="project">
					<div class="project-name" title={project.path}>{project.name}</div>
					{#each shown as s (s.id)}
						{@const place = s.place && s.place !== "local" ? placeOf(lab.places, s.place) : undefined}
						<button class="session" class:current={s.id === lab.current} aria-current={s.id === lab.current ? "page" : undefined} onclick={() => pick(s.id)}>
							<span class="title">{s.title}</span>
							{#if s.running}
								<span class="live" aria-label="running"></span>
							{:else if place}
								<span class="place-dot" style:--dot={`var(${place.color})`} title={`Works in the ${place.title} sandbox`}></span>
							{:else}
								<span class="when">{ago(s.updated, now)}</span>
							{/if}
						</button>
					{/each}
					{#if !showAll && project.sessions.length > shown.length}
						<button class="more" onclick={() => (expanded[project.path] = true)}>{project.sessions.length - shown.length} more</button>
					{/if}
				</div>
			{:else}
				<p class="empty">{filter ? "No sessions match." : "Sessions you start appear here, by project."}</p>
			{/each}
		</section>
	</div>

	<div class="foot" role="radiogroup" aria-label="Appearance">
		{#each ["auto", "light", "dark"] as const as option}
			<button role="radio" aria-checked={lab.ui.theme === option} class:on={lab.ui.theme === option} onclick={() => lab.setTheme(option)}>
				{option === "auto" ? "Auto" : option === "light" ? "Light" : "Dark"}
			</button>
		{/each}
	</div>
</nav>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--rail);
		backdrop-filter: blur(24px) saturate(1.2);
		font-size: 13.5px;
	}
	:global(.shell.mac.desktop) .top {
		padding-top: 38px;
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 12px 8px 18px;
		-webkit-app-region: drag;
	}
	.top button {
		-webkit-app-region: no-drag;
	}
	.wordmark {
		font-family: var(--font-display);
		font-weight: 650;
		font-size: 15px;
		letter-spacing: -0.012em;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 2px 12px 10px;
		height: 32px;
		padding: 0 10px;
		border-radius: var(--radius-small);
		border: 1px solid var(--rule);
		background: var(--canvas);
		color: var(--text-faint);
		text-align: left;
	}
	.search:hover {
		border-color: var(--rule-strong);
	}
	.search span {
		flex: 1;
	}
	.search svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0 8px 12px;
	}
	h2 {
		margin: 14px 10px 6px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text-faint);
	}
	.place {
		display: grid;
		grid-template-columns: 8px 1fr auto;
		align-items: center;
		gap: 10px;
		height: var(--row);
		padding: 0 10px;
		border-radius: var(--radius-small);
	}
	.place.here {
		background: var(--selected);
	}
	.place .name {
		font-weight: 500;
	}
	.place .detail {
		color: var(--text-faint);
		font-size: 12px;
		white-space: nowrap;
	}
	.sign-in {
		font-size: 12px;
		color: var(--accent-text);
		font-weight: 500;
	}
	.filter {
		width: calc(100% - 20px);
		margin: 0 10px 6px;
		height: 26px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-small);
		background: var(--hover);
		font-size: 12.5px;
		outline: none;
	}
	.filter:focus {
		box-shadow: 0 0 0 1.5px var(--accent);
	}
	.project + .project {
		margin-top: 6px;
	}
	.project-name {
		padding: 6px 10px 2px;
		font-weight: 600;
		font-size: 12.5px;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.session {
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 30px;
		padding: 0 10px 0 18px;
		border-radius: var(--radius-small);
		text-align: left;
	}
	.session:hover {
		background: var(--hover);
	}
	.session.current {
		background: var(--selected);
	}
	.session .title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.when {
		font-size: 11.5px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.live {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--live);
	}
	.more {
		padding: 2px 18px 4px;
		font-size: 12px;
		color: var(--text-faint);
	}
	.more:hover {
		color: var(--text);
	}
	.empty {
		margin: 4px 10px;
		color: var(--text-faint);
		font-size: 12.5px;
	}
	.foot {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 2px;
		margin: 8px 12px 12px;
		padding: 2px;
		border-radius: var(--radius-small);
		background: var(--hover);
	}
	.foot button {
		height: 24px;
		border-radius: 4px;
		font-size: 12px;
		color: var(--text-muted);
	}
	.foot button.on {
		background: var(--raised);
		color: var(--text);
		box-shadow: 0 1px 2px var(--shadow-color);
	}
	.scrim {
		display: none;
	}
	@media (max-width: 860px) {
		.rail {
			position: fixed;
			inset: 0 auto 0 0;
			z-index: 50;
			width: min(320px, 86vw);
			transform: translateX(-102%);
			transition: transform 220ms var(--ease-out);
			background: var(--canvas);
			border-right: 1px solid var(--rule);
		}
		.rail.open {
			transform: none;
		}
		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 49;
			background: rgb(0 0 0 / 0.28);
		}
	}
	.add-lab {
		margin: 2px 0 0 8px;
		min-height: 28px;
		font-size: 12.5px;
		color: var(--text-faint);
	}
	.add-lab:hover {
		color: var(--link);
	}
</style>
