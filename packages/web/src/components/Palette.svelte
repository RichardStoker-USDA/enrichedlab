<script lang="ts">
	import { tick } from "svelte";
	import { lab } from "../lib/store.svelte.ts";
	import { folderName } from "../lib/format.ts";
	import { mac } from "../lib/places.ts";

	interface Item {
		id: string;
		label: string;
		hint?: string;
		/** A keyboard shortcut; hidden on touch screens. */
		shortcut?: string;
		group: string;
		run: () => void;
	}

	let query = $state("");
	let older = $state<{ id: string; title: string; cwd: string }[]>([]);
	let searchError = $state("");
	// With more history than the sidebar holds, typed words also search the rest.
	$effect(() => {
		const q = query.trim();
		if (!q || !lab.moreSessions) return void (older = []);
		let current = true;
		const timer = setTimeout(
			() =>
				void lab.searchSessions(q).then((result) => {
					if (!current) return;
					older = result.found;
					searchError = result.error ? `Older sessions couldn't be searched: ${result.error}` : "";
				}),
			160,
		);
		return () => ((current = false), clearTimeout(timer));
	});
	let index = $state(0);
	let input: HTMLInputElement | undefined = $state();

	const items = $derived.by(() => {
		const list: Item[] = [{ id: "new", label: "New Session", group: "Actions", run: () => lab.beginNew() }];
		if (lab.current) {
			list.push(
				{ id: "bench", label: lab.workbench ? "Close the workbench" : "Open the workbench", shortcut: mac ? "⌘\\" : "Ctrl \\", group: "Actions", run: () => lab.toggleWorkbench() },
				{ id: "files", label: "Open files", group: "Actions", run: () => lab.openPane("files") },
				{ id: "term", label: "Open a terminal", shortcut: mac ? "⌃`" : "Ctrl `", group: "Actions", run: () => lab.openPane("terminal") },
				{ id: "browser", label: "Open a browser", group: "Actions", run: () => lab.openPane("browser") },
				{ id: "compact", label: "Summarize older turns now", group: "Actions", run: () => void lab.compact() },
			);
			if (!lab.pinned && !lab.busy) {
				for (const place of lab.places) {
					if (place.id === lab.place.id || !place.ready || place.site?.isolated) continue;
					list.push({ id: `move-${place.id}`, label: place.id === "local" ? `Move this session to ${place.title}` : `Move this session to the ${place.title} sandbox`, group: "Places", run: () => void lab.requestMove(place.id) });
				}
			}
		}
		list.push(
			{ id: "services", label: "Model Services", hint: "ChatGPT plan, keys, models on this computer", group: "Actions", run: () => (lab.services = true) },
			{ id: "join", label: "Add a lab", group: "Actions", run: () => (lab.join = {}) },
			{ id: "settings", label: "Settings", shortcut: mac ? "⌘," : "Ctrl ,", group: "Actions", run: () => (lab.settings = true) },
			{ id: "sidebar", label: lab.sidebar ? "Hide the sidebar" : "Show the sidebar", shortcut: mac ? "⌃⌘S" : "Ctrl ⇧ S", group: "Actions", run: () => (lab.sidebar = !lab.sidebar) },
		);
		for (const theme of ["auto", "light", "dark"] as const) {
			if (lab.ui.theme !== theme) list.push({ id: `theme-${theme}`, label: theme === "auto" ? "Match the system's light or dark mode" : `Use ${theme} mode`, group: "Appearance", run: () => void lab.setTheme(theme) });
		}
		for (const app of lab.apps) list.push({ id: `app-${app.id}`, label: `Open ${app.title}`, hint: app.source === "project" ? "app" : app.source.replace(/^(bundle|mcp):/, ""), group: "Apps", run: () => lab.openApp(app) });
		for (const offer of lab.labOffers) {
			list.push({ id: `lab-app-${offer.site}-${offer.name}`, label: `${offer.installed ? "Update" : "Install"} ${offer.title}`, hint: `from ${offer.lab}`, group: "Apps", run: () => void lab.installLabApp(offer) });
		}
		for (const s of lab.sessions) list.push({ id: s.id, label: s.title, hint: folderName(s.cwd), group: "Sessions", run: () => lab.go(s.id) });
		// Older sessions the sidebar doesn't hold, from a search of all history.
		for (const s of older) if (!lab.sessions.some((x) => x.id === s.id)) list.push({ id: s.id, label: s.title, hint: folderName(s.cwd), group: "Sessions", run: () => lab.go(s.id) });
		const q = query.trim().toLowerCase();
		if (!q) return list.filter((i) => i.group !== "Sessions" && i.group !== "Apps").concat(list.filter((i) => i.group === "Apps").slice(0, 6), list.filter((i) => i.group === "Sessions").slice(0, 8));
		const words = q.split(/\s+/);
		return list.filter((i) => words.every((w) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(w))).slice(0, 80);
	});

	// Closing returns focus to what opened it, unless a command moved it on purpose.
	$effect(() => {
		if (!lab.palette) return;
		query = "";
		index = 0;
		const opener = document.activeElement as HTMLElement | null;
		void tick().then(() => input?.focus());
		return () => {
			requestAnimationFrame(() => {
				if (document.activeElement === document.body || !document.activeElement) opener?.focus?.();
			});
		};
	});
	$effect(() => {
		void query;
		index = 0;
	});
	// The highlighted result stays in sight as the arrows move through a long list.
	$effect(() => {
		const id = items[index]?.id;
		if (id) document.getElementById(`p-${id}`)?.scrollIntoView({ block: "nearest" });
	});

	function run(item: Item | undefined) {
		if (!item) return;
		lab.palette = false;
		item.run();
	}

	function keys(e: KeyboardEvent) {
		if (e.key === "ArrowDown") (e.preventDefault(), (index = Math.min(items.length - 1, index + 1)));
		else if (e.key === "ArrowUp") (e.preventDefault(), (index = Math.max(0, index - 1)));
		else if (e.key === "Enter") (e.preventDefault(), run(items[index]));
		else if (e.key === "Escape") (e.preventDefault(), (lab.palette = false));
		// Focus stays in the field (the combobox pattern); Tab doesn't wander into the page behind.
		else if (e.key === "Tab") (e.preventDefault(), input?.focus());
	}
</script>

{#if lab.palette}
	<button class="scrim" aria-label="Close" onclick={() => (lab.palette = false)}></button>
	<div class="palette" role="dialog" aria-modal="true" aria-label="Search and commands" tabindex="-1" onkeydown={keys}>
		<input bind:this={input} bind:value={query} placeholder="Search sessions, or type a command" aria-label="Search sessions, or type a command" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[index] ? `p-${items[index].id}` : undefined} />
		<div class="list" id="palette-list" role="listbox">
			{#each items as item, i (item.id)}
				{#if i === 0 || items[i - 1]!.group !== item.group}<p class="group">{item.group}</p>{/if}
				<button id={`p-${item.id}`} class="item" class:on={i === index} role="option" tabindex="-1" aria-selected={i === index} onclick={() => run(item)} onpointermove={() => (index = i)}>
					<span>{item.label}</span>
					{#if item.hint}<span class="hint">{item.hint}</span>{/if}
					{#if item.shortcut}<kbd class="hint key">{item.shortcut}</kbd>{/if}
				</button>
			{:else}
				<p class="none">{searchError || "Nothing matches."}</p>
			{/each}
		</div>
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 70;
		background: rgb(0 0 0 / 0.18);
	}
	.palette {
		position: fixed;
		z-index: 71;
		top: 12vh;
		left: 50%;
		width: min(600px, calc(100vw - 32px));
		transform: translateX(-50%);
		border-radius: 14px;
		border: 1px solid var(--rule);
		background: var(--raised);
		box-shadow: var(--shadow);
		overflow: hidden;
		animation: in 140ms var(--ease-out);
	}
	@keyframes in {
		from {
			opacity: 0;
			transform: translateX(-50%) scale(0.98);
		}
	}
	input {
		width: 100%;
		height: 50px;
		padding: 0 18px;
		border: 0;
		border-bottom: 1px solid var(--rule);
		background: transparent;
		font-size: 15px;
		outline: none;
	}
	.list {
		max-height: min(420px, 60vh);
		overflow-y: auto;
		padding: 6px;
	}
	.group {
		margin: 8px 10px 4px;
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
		min-height: 34px;
		padding: 0 12px;
		border-radius: var(--radius-small);
		text-align: left;
		font-size: 13.5px;
	}
	.item.on {
		background: var(--selected);
	}
	.item span:first-child {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.hint {
		flex: none;
		font-size: 12px;
		color: var(--text-faint);
	}
	.item.on .hint {
		color: var(--text-muted);
	}
	.none {
		margin: 14px;
		color: var(--text-faint);
		font-size: 13px;
	}
	kbd.key {
		font: inherit;
	}
	@media (pointer: coarse) {
		.key {
			display: none;
		}
	}
</style>
