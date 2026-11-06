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
	// Closed while still starting: whatever opened afterwards is closed at once.
	let gone = false;

	/** WebGL2 on a real GPU: a software rasterizer names itself in the unmasked renderer string. */
	function hardwareWebgl(): boolean {
		try {
			const gl = document.createElement("canvas").getContext("webgl2");
			if (!gl) return false;
			const info = gl.getExtension("WEBGL_debug_renderer_info");
			const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
			gl.getExtension("WEBGL_lose_context")?.loseContext();
			return !/swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(renderer);
		} catch {
			return false;
		}
	}

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
		// The GPU renderer where WebGL2 runs on a hardware GPU; xterm's DOM renderer otherwise. On a software GPU
		// (SwiftShader, llvmpipe: virtual machines, remote desktops) WebGL is slower than the DOM and can draw nothing.
		if (hardwareWebgl()) {
			try {
				const { WebglAddon } = await import("@xterm/addon-webgl");
				const gl = new WebglAddon();
				gl.onContextLoss(() => gl.dispose());
				term.loadAddon(gl);
			} catch {
				// DOM renderer.
			}
		}
		fit.fit();
		let termId: string | undefined;
		// The shell's first output (its prompt) can arrive before term.open answers: listen first, keep it, replay it.
		const early: { termId: string; data: string }[] = [];
		const offOut = rpc.on("term.output", (m) => {
			if (termId === undefined) early.push(m);
			else if (m.termId === termId) term.write(m.data);
		});
		try {
			const opened = await rpc.call("term.open", { sessionId: lab.current, cols: term.cols, rows: term.rows });
			termId = opened.termId;
			label = opened.label;
			if (gone) {
				offOut();
				void rpc.call("term.close", { termId }).catch(() => undefined);
				term.dispose();
				return;
			}
			for (const m of early) if (m.termId === termId) term.write(m.data);
			early.length = 0;
		} catch (e) {
			offOut();
			error = (e as Error).message;
			term.dispose();
			return;
		}
		const offExit = rpc.on("term.exit", (m) => {
			if (m.termId !== termId) return;
			ended = true;
			term.write("\r\n\x1b[2m(ended)\x1b[0m\r\n");
		});
		const input = term.onData((data) => termId && void rpc.call("term.input", { termId, data }));
		const resize = term.onResize(({ cols, rows }) => termId && void rpc.call("term.resize", { termId, cols, rows }));
		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(host!);
		term.focus();
		cleanup = () => {
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
	<div class="where">{label}{ended ? " · ended" : ""}</div>
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
		padding: 6px 12px;
		font-size: 11.5px;
		color: var(--text-faint);
		border-bottom: 1px solid var(--rule);
	}
	.where:empty {
		display: none;
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
