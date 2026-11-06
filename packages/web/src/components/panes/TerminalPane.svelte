<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import "@xterm/xterm/css/xterm.css";
	import { lab } from "../../lib/store.svelte.ts";
	import { rpc } from "../../lib/rpc.ts";
	import { onThemeChange, tokenColor } from "../../lib/theme.ts";

	let { active }: { active: boolean } = $props();
	let host: HTMLDivElement | undefined = $state();
	let label = $state("");
	let ended = $state(false);
	let error = $state("");
	let cleanup: (() => void) | undefined;
	let restart: (() => Promise<void>) | undefined = $state();
	// Closed while still starting: whatever opened afterwards is closed at once.
	let gone = false;

	onMount(async () => {
		const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
		const colors = () => ({ background: tokenColor("--canvas", host), foreground: tokenColor("--text", host), cursor: tokenColor("--accent", host), selectionBackground: "rgba(128,128,128,0.3)" });
		const term = new Terminal({
			fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
			fontSize: 12.5,
			lineHeight: 1.25,
			cursorBlink: false,
			allowProposedApi: false,
			theme: colors(),
		});
		const stopTheme = onThemeChange(() => (term.options.theme = colors()));
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host!);
		// xterm's DOM renderer: its WebGL renderer drew nothing in Chromium on this hardware (headless and visible).
		fit.fit();
		let termId: string | undefined;
		// The shell's first output (its prompt) can arrive before term.open answers: listen first, keep it, replay it.
		const early: { termId: string; data: string }[] = [];
		const offOut = rpc.on("term.output", (m) => {
			if (termId === undefined) early.push(m);
			else if (m.termId === termId) term.write(m.data);
		});
		/** Open a shell for this pane; again after one ends, in the same pane. */
		async function start(): Promise<boolean> {
			termId = undefined;
			try {
				const opened = await rpc.call("term.open", { sessionId: lab.current, cols: term.cols, rows: term.rows });
				termId = opened.termId;
				label = opened.label;
				if (gone) {
					offOut();
					void rpc.call("term.close", { termId }).catch(() => undefined);
					term.dispose();
					return false;
				}
				for (const m of early) if (m.termId === termId) term.write(m.data);
				early.length = 0;
				error = "";
				return true;
			} catch (e) {
				error = (e as Error).message;
				return false;
			}
		}
		if (gone) return;
		restart = async () => {
			ended = false;
			term.reset();
			if (await start()) term.focus();
			else ended = true;
		};
		// A shell that didn't open keeps the pane, with Start Again beside the reason.
		if (!(await start())) {
			if (gone) return;
			ended = true;
		}
		const offExit = rpc.on("term.exit", (m) => {
			if (m.termId !== termId) return;
			ended = true;
			term.write("\r\n\x1b[2m(ended)\x1b[0m\r\n");
		});
		// The engine closes a window's shells when the window loses its connection: this one says so and offers to
		// start again, instead of taking keystrokes nothing receives.
		const lost = () => {
			if (ended || !termId) return;
			ended = true;
			termId = undefined;
			term.write("\r\n\x1b[2m(the connection to the engine dropped; this shell ended)\x1b[0m\r\n");
		};
		const input = term.onData((data) => {
			if (termId && !ended) void rpc.call("term.input", { termId, data }).catch(lost);
		});
		const resize = term.onResize(({ cols, rows }) => {
			if (termId && !ended) void rpc.call("term.resize", { termId, cols, rows }).catch(() => undefined);
		});
		const stopWatch = $effect.root(() => {
			$effect(() => {
				if (lab.lost) lost();
			});
		});
		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(host!);
		// Only the pane in front takes focus; a terminal restored behind others doesn't steal it.
		if (active) term.focus();
		cleanup = () => {
			stopWatch();
			stopTheme();
			observer.disconnect();
			input.dispose();
			resize.dispose();
			offOut();
			offExit();
			if (termId && !ended) void rpc.call("term.close", { termId }).catch(() => undefined);
			term.dispose();
		};
	});

	onDestroy(() => {
		gone = true;
		cleanup?.();
	});
</script>

<div class="terminal-pane" class:active>
	<div class="where">
		<span>{label}{ended ? " · ended" : ""}</span>
		{#if ended && restart}<button class="btn" onclick={() => restart?.()}>Start Again</button>{/if}
	</div>
	{#if error}
		<p class="error">{error}</p>
	{/if}
	<div class="host" bind:this={host}></div>
</div>

<style>
	.terminal-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--canvas);
	}
	.where {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 29px;
		padding: 2px 6px 2px 12px;
		font-size: 11.5px;
		color: var(--text-muted);
		border-bottom: 1px solid var(--rule);
	}
	.where .btn {
		height: 24px;
		padding: 0 10px;
		font-size: 12px;
	}
	.host {
		flex: 1;
		min-height: 0;
		padding: 8px 4px 4px 12px;
	}
	.error {
		margin: 16px;
		color: var(--text-muted);
		font-size: 13px;
	}
</style>
