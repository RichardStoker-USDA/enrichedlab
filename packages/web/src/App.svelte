<script lang="ts">
	import { onMount } from "svelte";
	import { lab } from "./lib/store.svelte.ts";
	import { mac } from "./lib/places.ts";
	import Rail from "./components/Rail.svelte";
	import RunSheet from "./components/RunSheet.svelte";
	import Start from "./components/Start.svelte";
	import Workbench from "./components/Workbench.svelte";
	import Palette from "./components/Palette.svelte";
	import ModelServices from "./components/ModelServices.svelte";
	import DeviceRequest from "./components/DeviceRequest.svelte";
	import JoinLab from "./components/JoinLab.svelte";
	import Settings from "./components/Settings.svelte";
	import Confirm from "./components/Confirm.svelte";
	import ContextMenu from "./components/ContextMenu.svelte";
	import { groups } from "./lib/layout.ts";

	let railOpen = $state(false);
	const desktop = typeof window !== "undefined" && "labDesktop" in window;

	// The workbench's share of the width, dragged at its edge and remembered.
	let benchWidth = $state(46);
	onMount(() => {
		try {
			benchWidth = Number(localStorage.getItem("enrichedlab.benchWidth")) || 46;
		} catch {
			// Storage blocked: the default width.
		}
		if (desktop && window.labDesktop?.platform !== "linux") document.documentElement.classList.add("material");
		void lab.init();
		const offFull = window.labDesktop?.onFullscreen?.((on) => document.documentElement.classList.toggle("fullscreen", on));
		const offCommand = window.labDesktop?.onCommand?.(command);
		return () => {
			offFull?.();
			offCommand?.();
		};
	});

	/** The menu bar's commands (and the same shortcuts in a browser, below). */
	function command(id: string) {
		if (id === "new-session") (lab.newPlace = undefined), lab.startNew();
		else if (id === "palette") lab.palette = !lab.palette;
		else if (id === "settings") lab.settings = true;
		else if (id === "services") lab.services = true;
		else if (id === "add-lab") lab.join = {};
		else if (id === "toggle-sidebar") lab.sidebar = !lab.sidebar;
		else if (id === "toggle-workbench") lab.current && lab.toggleWorkbench();
		else if (id === "new-terminal") lab.current && lab.openPane("terminal");
		else if (id === "close-pane") {
			const active = groups(lab.layout).find((g) => g.tabs.length)?.active;
			if (lab.workbench && lab.current && active) lab.closePane(active);
			else window.labDesktop?.closeWindow?.();
		} else if (id.startsWith("theme-")) void lab.setTheme(id.slice(6) as "auto" | "light" | "dark");
		else if (id === "rename") lab.current && (lab.renaming = lab.current);
		else if (id === "stop") lab.busy && lab.cancel();
		else if (id === "compact") lab.current && void lab.compact();
		else if (id === "undo-files") lab.current && void lab.undo();
		else if (id === "reveal") lab.summary && lab.reveal(lab.summary.cwd);
	}

	function dragBench(e: PointerEvent) {
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => {
			benchWidth = Math.min(72, Math.max(28, ((window.innerWidth - ev.clientX) / window.innerWidth) * 100));
		};
		const up = () => {
			handle.removeEventListener("pointermove", move);
			try {
				localStorage.setItem("enrichedlab.benchWidth", String(Math.round(benchWidth)));
			} catch {
				// Not remembered.
			}
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up, { once: true });
	}

	// In the desktop app the menu bar owns these shortcuts; in a browser the page handles them.
	function keys(e: KeyboardEvent) {
		if (desktop) return;
		const mod = mac ? e.metaKey : e.ctrlKey;
		const key = e.key.toLowerCase();
		const run = (id: string) => (e.preventDefault(), command(id));
		if (mod && key === "k") run("palette");
		else if (mod && e.key === "\\") run("toggle-workbench");
		else if (mod && e.key === ",") run("settings");
		else if (mod && e.key === ".") run("stop");
		else if (e.ctrlKey && e.key === "`") run("new-terminal");
		else if (mod && e.shiftKey && key === "s") run("toggle-sidebar");
	}

	$effect(() => {
		const root = document.documentElement;
		if (lab.ui.theme === "auto") root.removeAttribute("data-theme");
		else root.setAttribute("data-theme", lab.ui.theme);
		window.labDesktop?.setTheme?.(lab.ui.theme);
	});

	$effect(() => {
		document.title = lab.summary ? `${lab.summary.title} · EnrichedLab` : "EnrichedLab";
	});

	const benchOpen = $derived(Boolean(lab.workbench && lab.current));
</script>

<svelte:window onkeydown={keys} />

<div class="shell" class:desktop class:mac class:bench={benchOpen} class:no-rail={!lab.sidebar} style:--bench={`${benchWidth}%`}>
	<Rail bind:open={railOpen} />
	<main class="main">
		{#if lab.current}
			<RunSheet onMenu={() => (railOpen = true)} />
		{:else}
			<Start onMenu={() => (railOpen = true)} />
		{/if}
	</main>
	{#if benchOpen}
		<div class="gutter" role="separator" aria-orientation="vertical" aria-label="Resize the workbench" onpointerdown={dragBench}></div>
		<Workbench />
	{/if}
	<Palette />
	<ModelServices bind:open={lab.services} />
	<DeviceRequest />
	<JoinLab />
	<Settings />
	<Confirm />
	<ContextMenu />
	{#if lab.lost}
		<p class="status" role="status">Reconnecting to the engine…</p>
	{:else if lab.flash}
		<p class="status" role="status">{lab.flash}{#if lab.flashUrl}&nbsp;<a href={lab.flashUrl} target="_blank" rel="noopener noreferrer">Open</a>{/if}</p>
	{/if}
</div>

<style>
	.shell {
		display: grid;
		grid-template-columns: var(--rail-width) minmax(0, 1fr);
		grid-template-rows: 100%;
		height: 100%;
		overflow: hidden;
		background: var(--canvas);
	}
	.shell.bench {
		grid-template-columns: var(--rail-width) minmax(360px, 1fr) 0 minmax(360px, var(--bench));
	}
	/* The hidden sidebar leaves the grid, so the columns start at the session. */
	.shell.no-rail {
		grid-template-columns: minmax(0, 1fr);
	}
	.shell.no-rail.bench {
		grid-template-columns: minmax(360px, 1fr) 0 minmax(360px, var(--bench));
	}
	.shell.no-rail .main {
		border-left: 0;
	}
	:global(html.material) .shell {
		background: transparent;
	}
	.main {
		min-width: 0;
		display: flex;
		flex-direction: column;
		background: var(--canvas);
		border-left: 1px solid var(--rule);
	}
	.gutter {
		position: relative;
		z-index: 5;
		cursor: col-resize;
		touch-action: none;
	}
	.gutter::after {
		content: "";
		position: absolute;
		inset: 0 -4px;
	}
	.status {
		position: fixed;
		left: 50%;
		bottom: 24px;
		z-index: 60;
		max-width: min(560px, calc(100vw - 32px));
		margin: 0;
		padding: 9px 14px;
		transform: translateX(-50%);
		border-radius: var(--radius);
		border: 1px solid var(--rule);
		background: var(--raised);
		box-shadow: var(--shadow);
		font-size: 13px;
		animation: rise 180ms var(--ease-out);
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translate(-50%, 6px);
		}
	}
	/* Narrower: the workbench floats over the run sheet as a sheet (see Workbench.svelte). */
	@media (max-width: 1179px) {
		.shell.bench {
			grid-template-columns: var(--rail-width) minmax(0, 1fr);
		}
		.shell.no-rail.bench {
			grid-template-columns: minmax(0, 1fr);
		}
		.gutter {
			display: none;
		}
	}
	@media (max-width: 860px) {
		.shell,
		.shell.bench,
		.shell.no-rail,
		.shell.no-rail.bench {
			grid-template-columns: minmax(0, 1fr);
		}
		.main {
			border-left: 0;
		}
	}
</style>
