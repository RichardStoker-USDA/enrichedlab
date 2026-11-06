<script lang="ts">
	import { computerName } from "../lib/places.ts";
	import { lab } from "../lib/store.svelte.ts";
	import LayoutNode from "./workbench/LayoutNode.svelte";

	const empty = $derived(!lab.layout || (lab.layout.type === "group" && lab.layout.tabs.length === 0));
	let appsOpen = $state(false);
	let browserOpen = $state(false);
	// Labs that run a browser in the person's sandbox: the Browser button then asks which browser.
	const browserLabs = $derived(lab.places.filter((p) => p.site?.signedIn && p.site.browser));
	function toggleApps() {
		appsOpen = !appsOpen;
		if (appsOpen) void lab.refreshApps();
	}
	// Installed apps say where they came from; a lab's offers are grouped under the lab.
	const source = (s: string) =>
		s === "project"
			? "project"
			: s.startsWith("bundle:")
				? s.slice(7)
				: s.startsWith("mcp:")
					? s.slice(4)
					: s.startsWith("lab:")
						? (lab.sites.find((x) => x.name === s.slice(4))?.title ?? s.slice(4))
						: "installed";
	const offersByLab = $derived.by(() => {
		const groups = new Map<string, typeof lab.labOffers>();
		for (const offer of lab.labOffers) groups.set(offer.lab, [...(groups.get(offer.lab) ?? []), offer]);
		return [...groups];
	});
	// The local terminal is the person's own shell, with their rights: the agent's containment doesn't apply to it.
	const terminalNote = $derived(lab.place.id === "local" ? "Your own shell in the project folder, with your usual rights" : `A command console in the ${lab.place.title} sandbox`);
</script>

<aside class="workbench" aria-label="Workbench" hidden={!lab.workbench}>
	<div class="bar toolbar">
		<span class="label">Workbench</span>
		<div class="actions">
			<button class="btn quiet" onclick={() => lab.openPane("files")} title="The session's folder">Files</button>
			<button class="btn quiet" onclick={() => lab.openPane("terminal")} title={terminalNote}>Terminal</button>
			{#if browserLabs.length}
				<div class="apps">
					<button class="btn quiet" onclick={() => (browserOpen = !browserOpen)} aria-expanded={browserOpen} aria-haspopup="menu">Browser</button>
					{#if browserOpen}
						<button class="scrim" aria-label="Close" onclick={() => (browserOpen = false)}></button>
						<div class="menu apps-menu" role="menu">
							<button class="menu-item" role="menuitem" onclick={() => ((browserOpen = false), lab.openPane("browser"))}>
								<span class="app-title"><span class="place-dot local"></span>{computerName()}</span>
								<span class="app-meta">your sign-ins</span>
							</button>
							{#each browserLabs as place (place.id)}
								<button class="menu-item" role="menuitem" onclick={() => ((browserOpen = false), lab.openPane("screen", place.id, `${place.title} browser`))}>
									<span class="app-title"><span class="place-dot" style:--dot={`var(${place.color})`}></span>{place.title} sandbox</span>
									<span class="app-meta">no sign-ins</span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{:else}
				<button class="btn quiet" onclick={() => lab.openPane("browser")} title="A browser the agent's apps open in">Browser</button>
			{/if}
			<div class="apps">
				<button class="btn quiet" onclick={toggleApps} aria-expanded={appsOpen} aria-haspopup="menu">Apps</button>
				{#if appsOpen}
					<button class="scrim" aria-label="Close" onclick={() => (appsOpen = false)}></button>
					<div class="menu apps-menu" role="menu">
						{#each lab.apps as app (app.id)}
							<button class="menu-item" role="menuitem" onclick={() => ((appsOpen = false), lab.openApp(app))}>
								<span class="app-title">{app.title}</span>
								<span class="app-meta">{source(app.source)}</span>
							</button>
						{:else}
							{#if !lab.labOffers.length}
								<p class="none">No apps yet. Ask the agent to build one, such as "make an app to explore plots.csv".</p>
							{/if}
						{/each}
						{#each offersByLab as [labTitle, offers] (labTitle)}
							<p class="menu-label">From {labTitle}</p>
							{#each offers as offer (`${offer.site}/${offer.name}`)}
								{@const busy = lab.installing.has(`${offer.site}/${offer.name}`)}
								<button class="menu-item" role="menuitem" disabled={busy} title={offer.description || offer.title} onclick={() => void lab.installLabApp(offer)}>
									<span class="app-title">{offer.title}</span>
									<span class="app-meta">{busy ? "Installing…" : offer.installed ? `Update to ${offer.version}` : "Install"}</span>
								</button>
							{/each}
						{/each}
					</div>
				{/if}
			</div>
			<button class="icon-btn" onclick={() => lab.toggleWorkbench(false)} aria-label="Close the workbench" title="Close">
				<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></svg>
			</button>
		</div>
	</div>
	<div class="body">
		{#if empty}
			<div class="empty">
				<p class="empty-title">Nothing on the workbench yet</p>
				<p>Tables, plots, figures and apps the agent shows open here. You can also open the session's files, a terminal or a browser.</p>
				<div class="empty-actions">
					<button class="btn" onclick={() => lab.openPane("files")}>Files</button>
					<button class="btn" onclick={() => lab.openPane("terminal")}>Terminal</button>
				</div>
			</div>
		{:else}
			<LayoutNode node={lab.layout} />
		{/if}
	</div>
</aside>

<style>
	.apps {
		position: relative;
	}
	.apps-menu {
		right: 0;
		top: calc(100% + 6px);
		width: 280px;
	}
	.apps-menu .menu-item {
		display: flex;
		justify-content: space-between;
		gap: 10px;
	}
	.app-title {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.app-meta {
		font-size: 12px;
		color: var(--text-faint);
	}
	.none {
		margin: 8px 10px;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 39;
		cursor: default;
	}
	.workbench {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--surface);
		border-left: 1px solid var(--rule);
		animation: slide 220ms var(--ease-out);
	}
	@keyframes slide {
		from {
			transform: translateX(24px);
			opacity: 0;
		}
	}
	.workbench[hidden] {
		display: none;
	}
	.bar {
		justify-content: space-between;
		padding: 0 8px 0 16px;
		border-bottom: 1px solid var(--rule);
		background: var(--canvas);
	}
	.label {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 13.5px;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.actions .btn {
		height: 28px;
		padding: 0 10px;
	}
	.actions .btn:hover {
		color: var(--text);
	}
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.empty {
		margin: auto;
		max-width: 340px;
		padding: 24px;
		text-align: center;
		font-size: 13.5px;
		color: var(--text-muted);
	}
	.empty-title {
		margin: 0 0 6px;
		font-weight: 600;
		color: var(--text);
	}
	.empty-actions {
		display: flex;
		justify-content: center;
		gap: 8px;
		margin-top: 14px;
	}
	@media (max-width: 1179px) {
		.workbench {
			position: fixed;
			z-index: 45;
			inset: 0 0 0 auto;
			width: min(640px, 92vw);
			box-shadow: var(--shadow);
		}
	}
	@media (max-width: 860px) {
		.workbench {
			width: 100vw;
			border-left: 0;
		}
		/* Full width, its bar is the window's title bar: room for the traffic lights. */
		:global(.shell.mac.desktop) .bar {
			padding-left: var(--traffic-inset, 84px);
		}
	}
</style>
