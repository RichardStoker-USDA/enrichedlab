<script lang="ts">
	// The browser in a lab's sandbox: the page arrives as pictures (a screencast) while this pane shows, and the
	// person's clicks, scrolling and typing go back to it. It has none of the person's sign-ins; the marker and name
	// in the bar say whose sandbox it runs in.
	import type { BrowserFrame, BrowserInput } from "@enrichedlab/protocol";
	import { normalize } from "../../lib/address.ts";
	import { mac, placeOf } from "../../lib/places.ts";
	import { lab } from "../../lib/store.svelte.ts";

	let { site, active }: { site: string; active: boolean } = $props();

	let stage: HTMLDivElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();
	let address = $state("");
	let editing = $state(false);
	let drawn = $state(false);
	let focused = $state(false);

	const place = $derived(placeOf(lab.places, site));
	const page = $derived(lab.screen?.site === site ? lab.screen : undefined);
	const reach = $derived(
		page?.network === "none"
			? "No web access: pages served inside the sandbox (localhost) open"
			: page?.network === "allowlist"
				? `Reaches only ${page.hosts?.length ? page.hosts.join(", ") : "the hosts the lab allows"}`
				: "",
	);
	$effect(() => {
		if (page && !editing) address = page.url === "about:blank" ? "" : page.url;
	});

	// The newest picture, drawn to fit the pane's width (never larger than the page), top-aligned like a page.
	let shown: { image: ImageBitmap; frame: BrowserFrame } | undefined;
	let box = { x: 0, y: 0, w: 0, h: 0 };
	function draw() {
		if (!canvas || !stage || !shown) return;
		const ratio = window.devicePixelRatio || 1;
		const width = stage.clientWidth;
		const height = stage.clientHeight;
		if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
		}
		const scale = Math.min(width / shown.frame.width, height / shown.frame.height, 1);
		box = { w: shown.frame.width * scale, h: shown.frame.height * scale, x: (width - shown.frame.width * scale) / 2, y: 0 };
		const g = canvas.getContext("2d")!;
		g.setTransform(ratio, 0, 0, ratio, 0, 0);
		g.clearRect(0, 0, width, height);
		g.imageSmoothingQuality = "high";
		g.drawImage(shown.image, box.x, box.y, box.w, box.h);
	}

	// Pictures can come faster than they decode: keep only the newest waiting one.
	let decoding = false;
	let waiting: BrowserFrame | undefined;
	async function take(frame: BrowserFrame) {
		if (decoding) return void (waiting = frame);
		decoding = true;
		try {
			const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
			const image = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
			shown?.image.close();
			shown = { image, frame };
			drawn = true;
			draw();
		} catch {
			// A picture that doesn't decode is skipped; the next one replaces it.
		} finally {
			decoding = false;
			const next = waiting;
			waiting = undefined;
			if (next) void take(next);
		}
	}

	// The page lays out to the pane's size, so it fills the pane at full sharpness; resizing settles first.
	let sized: ReturnType<typeof setTimeout> | undefined;
	function resized() {
		draw();
		clearTimeout(sized);
		sized = setTimeout(() => stage && lab.screenResize(stage.clientWidth, stage.clientHeight), 200);
	}

	$effect(() => {
		if (!active) return;
		const off = lab.onFrame(take);
		void lab.watchScreen(true).then(resized);
		const observer = new ResizeObserver(resized);
		if (stage) observer.observe(stage);
		return () => {
			off();
			observer.disconnect();
			void lab.watchScreen(false);
		};
	});

	// ── The person's input, in the page's own pixels ──────────────────────────────────────────────────────────
	const modifiers = (e: MouseEvent | KeyboardEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
	function point(e: MouseEvent): { x: number; y: number } | undefined {
		if (!canvas || !shown || !box.w) return undefined;
		const r = canvas.getBoundingClientRect();
		const x = ((e.clientX - r.left - box.x) / box.w) * shown.frame.width;
		const y = ((e.clientY - r.top - box.y) / box.h) * shown.frame.height;
		return x < 0 || y < 0 || x > shown.frame.width || y > shown.frame.height ? undefined : { x, y };
	}
	const BUTTONS = ["left", "middle", "right"] as const;
	let pressed = false;
	let moved = 0;
	function mouse(e: PointerEvent, type: "mousePressed" | "mouseReleased" | "mouseMoved") {
		const at = point(e);
		if (!at) return;
		if (type === "mousePressed") {
			canvas?.focus();
			pressed = true;
		}
		if (type === "mouseReleased") pressed = false;
		if (type === "mouseMoved") {
			// Moves go at most every 40 ms: enough for hover menus and dragging, without flooding the lab.
			if (Date.now() - moved < 40) return;
			moved = Date.now();
		}
		const button = type === "mouseMoved" ? (pressed ? "left" : "none") : (BUTTONS[e.button] ?? "left");
		send({ kind: "mouse", type, x: at.x, y: at.y, button, clickCount: type === "mouseMoved" ? 0 : Math.max(1, e.detail), modifiers: modifiers(e) });
	}
	function wheel(e: WheelEvent) {
		const at = point(e);
		if (!at) return;
		e.preventDefault();
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1;
		send({ kind: "wheel", x: at.x, y: at.y, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit });
	}
	let addressField: HTMLInputElement | undefined = $state();
	/** Hand the keyboard back to the window: to the address bar, as F6 and Cmd/Ctrl+L do in a browser. */
	function release() {
		addressField?.focus();
		addressField?.select();
	}
	function key(e: KeyboardEvent, type: "keyDown" | "keyUp") {
		// F6 and Cmd/Ctrl+L always leave the page; every other key, Escape included, goes to it.
		if (e.key === "F6" || ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "l")) {
			e.preventDefault();
			if (type === "keyDown") release();
			return;
		}
		// Paste goes through the paste event, with the text.
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
		e.preventDefault();
		send({ kind: "key", type, key: e.key, code: e.code, modifiers: modifiers(e) });
	}
	function paste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData("text/plain");
		if (!text) return;
		e.preventDefault();
		send({ kind: "text", text });
	}
	const send = (event: BrowserInput) => lab.screenInput(event);

	function go(e: Event) {
		e.preventDefault();
		const next = normalize(address);
		editing = false;
		if (next) void lab.screenNavigate(site, { url: next });
	}
</script>

<div class="screen-pane">
	<form class="bar" onsubmit={go}>
		<span class="lane" title={`This browser runs in the ${place.title} sandbox, without your sign-ins`}><span class="place-dot" style:--dot={`var(${place.color})`}></span>{place.title} sandbox</span>
		<button type="button" class="icon-btn" onclick={() => void lab.screenNavigate(site, { step: "back" })} disabled={!page?.canBack} aria-label="Back">
			<svg viewBox="0 0 16 16"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
		</button>
		<button type="button" class="icon-btn" onclick={() => void lab.screenNavigate(site, { step: "forward" })} disabled={!page?.canForward} aria-label="Forward">
			<svg viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
		</button>
		<button type="button" class="icon-btn" onclick={() => void lab.screenNavigate(site, { step: "reload" })} disabled={!page} aria-label="Reload">
			<svg viewBox="0 0 16 16"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" /></svg>
		</button>
		<input class="field address" bind:this={addressField} bind:value={address} onfocus={() => (editing = true)} onblur={() => (editing = false)} placeholder="Address, or a page served in the sandbox such as localhost:8000" aria-label="Address" spellcheck="false" />
	</form>
	{#if reach}<p class="reach">{reach}</p>{/if}
	<div class="stage" bind:this={stage} class:loading={page?.loading}>
		<canvas
			bind:this={canvas}
			class:hidden={!drawn}
			tabindex="0"
			aria-label={`${page?.title || "Page"} in the ${place.title} sandbox browser. Clicks and typing go to the page; press F6 to leave it.`}
			onpointerdown={(e) => mouse(e, "mousePressed")}
			onpointerup={(e) => mouse(e, "mouseReleased")}
			onpointermove={(e) => mouse(e, "mouseMoved")}
			onwheel={wheel}
			onkeydown={(e) => key(e, "keyDown")}
			onkeyup={(e) => key(e, "keyUp")}
			onpaste={paste}
			oncontextmenu={(e) => e.preventDefault()}
			onfocus={() => (focused = true)}
			onblur={() => (focused = false)}
		></canvas>
		{#if !drawn}
			<div class="blank">
				<p>{page ? "Loading the page…" : `Pages the agent opens in the ${place.title} sandbox show here. You can also type an address.`}</p>
			</div>
		{/if}
	</div>
	{#if lab.lost && drawn}
		<p class="hint lost" role="status">Not connected to the engine: this is the last picture of the page.</p>
	{:else if focused}
		<p class="hint">
			<span>Typing goes to the page · <kbd>F6</kbd> or <kbd>{mac ? "⌘L" : "Ctrl+L"}</kbd> to leave it</span>
			<button type="button" class="btn" onmousedown={(e) => e.preventDefault()} onclick={release}>Release Keyboard</button>
		</p>
	{/if}
</div>

<style>
	.screen-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--rule);
	}
	.lane {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 8px 0 4px;
		font-size: 12px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.address {
		flex: 1;
		min-width: 0;
		height: 28px;
		margin-left: 4px;
		font-size: 12.5px;
	}
	.reach,
	.hint {
		margin: 0;
		padding: 5px 12px;
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.reach {
		border-bottom: 1px solid var(--rule);
	}
	.hint {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		border-top: 1px solid var(--rule);
		color: var(--text-muted);
	}
	.hint .btn {
		height: 24px;
		padding: 0 10px;
		font-size: 12px;
	}
	.hint.lost {
		color: var(--text);
		font-weight: 500;
	}
	.hint kbd {
		font: 11px var(--font-mono);
	}
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: var(--surface);
	}
	/* While the page loads, a still line along the top edge; no motion needed to say it. */
	.stage.loading::before {
		content: "";
		position: absolute;
		inset: 0 0 auto;
		height: 2px;
		background: var(--accent);
		z-index: 1;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
		outline: none;
		cursor: default;
	}
	canvas:focus-visible {
		box-shadow: inset 0 0 0 2px var(--focus-inner);
	}
	canvas.hidden {
		position: absolute;
		opacity: 0;
	}
	.blank {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 16px;
	}
	.blank p {
		max-width: 320px;
		margin: 0;
		text-align: center;
		color: var(--text-faint);
		font-size: 13px;
	}
	@media (max-width: 520px) {
		.lane {
			font-size: 0;
			gap: 0;
		}
	}
</style>
