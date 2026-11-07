<script lang="ts">
	// A lab's desktop sandbox (docs/research.md): a Linux desktop the person and the agent both use. Every click, key
	// and scroll here goes to the lab as one checked action marked as the person's. Where the lab streams the desktop,
	// the pane shows it live (changed bands of the screen, a few times a second); otherwise it asks for a picture when
	// it opens, just after the person acts, and on Refresh.
	import type { DesktopBand } from "@enrichedlab/protocol";
	import { untrack } from "svelte";
	import { mac, placeOf } from "../../lib/places.ts";
	import { lab } from "../../lib/store.svelte.ts";

	let { site, active }: { site: string; active: boolean } = $props();

	let stage: HTMLDivElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();
	let focused = $state(false);
	let target = $state("");
	let drawn = $state(false);

	const place = $derived(placeOf(lab.places, site));
	const info = $derived(place.site?.desktop);
	const frame = $derived(lab.desktops[site]);
	const busy = $derived(Boolean(lab.desktopBusy[site]));
	const live = $derived(Boolean(lab.desktopLive[site]?.live));
	/** Shown for a few seconds after the agent acts, so the person knows who moved the pointer. */
	let agentAt = $state(0);
	let now = $state(Date.now());
	const agentWorking = $derived(frame?.by === "agent" && now - agentAt < 4_000);

	// ── The picture ──────────────────────────────────────────────────────────────────────────────────────────────
	let image: ImageBitmap | OffscreenCanvas | undefined;
	/** The live view's screen, which bands are drawn onto. */
	let screen: OffscreenCanvas | undefined;
	let frameAsked = 0;
	function redraw() {
		if (frameAsked) return;
		frameAsked = requestAnimationFrame(() => {
			frameAsked = 0;
			draw();
		});
	}
	function onBand(band: DesktopBand) {
		const stream = lab.desktopLive[site];
		const width = stream?.width || band.x + band.w;
		const height = stream?.height || band.y + band.h;
		if (!screen || screen.width !== width || screen.height !== height) {
			const next = new OffscreenCanvas(width, height);
			// Keep what was shown until bands cover the new screen.
			if (image) next.getContext("2d")!.drawImage(image, 0, 0, width, height);
			screen = next;
		}
		const bytes = Uint8Array.from(atob(band.jpeg), (c) => c.charCodeAt(0));
		void createImageBitmap(new Blob([bytes], { type: "image/jpeg" }))
			.then((piece) => {
				screen?.getContext("2d")!.drawImage(piece, band.x, band.y, band.w, band.h);
				piece.close();
				if (image instanceof ImageBitmap) image.close();
				image = screen;
				drawn = true;
				redraw();
			})
			.catch(() => undefined);
	}
	let box = { x: 0, y: 0, w: 0, h: 0 };
	function draw() {
		if (!canvas || !stage || !image) return;
		const ratio = window.devicePixelRatio || 1;
		const width = stage.clientWidth;
		const height = stage.clientHeight;
		if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
		}
		// The whole screen fits the pane, centered, never drawn larger than it is.
		const scale = Math.min(width / image.width, height / image.height, 1);
		box = { w: image.width * scale, h: image.height * scale, x: (width - image.width * scale) / 2, y: (height - image.height * scale) / 2 };
		const g = canvas.getContext("2d")!;
		g.setTransform(ratio, 0, 0, ratio, 0, 0);
		g.clearRect(0, 0, width, height);
		g.imageSmoothingQuality = "high";
		g.drawImage(image, box.x, box.y, box.w, box.h);
	}

	let shownAt = "";
	$effect(() => {
		const f = frame;
		if (!f || f.at === shownAt) return;
		shownAt = f.at;
		if (f.by === "agent") agentAt = Date.now();
		const bytes = Uint8Array.from(atob(f.png), (c) => c.charCodeAt(0));
		void createImageBitmap(new Blob([bytes], { type: "image/png" }))
			.then((next) => {
				// While live, a full picture (from an action) is drawn onto the live screen, which bands keep current.
				if (screen && live && next.width === screen.width && next.height === screen.height) {
					screen.getContext("2d")!.drawImage(next, 0, 0);
					next.close();
					image = screen;
				} else {
					if (image instanceof ImageBitmap) image.close();
					image = next;
				}
				drawn = true;
				draw();
			})
			.catch(() => undefined);
	});

	$effect(() => {
		if (!active) return;
		const observer = new ResizeObserver(() => draw());
		if (stage) observer.observe(stage);
		const tick = setInterval(() => (now = Date.now()), 1_000);
		// A picture when the pane first shows; later ones come live, or with each action.
		untrack(() => (lab.desktops[site] ? draw() : void act({ action: "screenshot" })));
		const unwatch = lab.watchDesktop(site, onBand);
		return () => {
			observer.disconnect();
			clearInterval(tick);
			unwatch();
		};
	});

	const act = (action: Record<string, unknown>) => lab.desktopAct(site, action);
	/**
	 * The lab answers input without a picture, and programs answer a click a moment later (a menu opening): one
	 * picture after a short pause shows the result. Quick input in a row asks for one picture, after the last.
	 */
	let settle: ReturnType<typeof setTimeout> | undefined;
	async function actThenSettle(action: Record<string, unknown>, pause = 500) {
		clearTimeout(settle);
		await act(action);
		clearTimeout(settle);
		// A live view shows the result as it happens.
		if (!live) settle = setTimeout(() => void act({ action: "screenshot" }), pause);
	}

	// ── The person's pointer, in the desktop's own pixels ────────────────────────────────────────────────────────
	function point(e: MouseEvent): [number, number] | undefined {
		if (!canvas || !image || !box.w) return undefined;
		const r = canvas.getBoundingClientRect();
		const x = Math.round(((e.clientX - r.left - box.x) / box.w) * image.width);
		const y = Math.round(((e.clientY - r.top - box.y) / box.h) * image.height);
		return x < 0 || y < 0 || x >= image.width || y >= image.height ? undefined : [x, y];
	}
	let down: { at: [number, number]; button: number } | undefined;
	let single: ReturnType<typeof setTimeout> | undefined;
	function press(e: PointerEvent) {
		const at = point(e);
		if (!at) return;
		canvas?.focus({ preventScroll: true });
		down = { at, button: e.button };
	}
	function release(e: PointerEvent) {
		const at = point(e);
		const start = down;
		down = undefined;
		if (!at || !start) return;
		const moved = Math.hypot(at[0] - start.at[0], at[1] - start.at[1]);
		if (start.button === 0 && moved > 5) {
			dragged = true;
			return void actThenSettle({ action: "left_click_drag", start_coordinate: start.at, coordinate: at });
		}
		if (start.button === 2) return void actThenSettle({ action: "right_click", coordinate: at });
		if (start.button === 1) return void actThenSettle({ action: "middle_click", coordinate: at });
		if (start.button === 0) dragged = false;
	}
	/** Left clicks come from the click event, which counts them; a drag that just ended isn't one. */
	let dragged = false;
	function click(e: MouseEvent) {
		const at = point(e);
		if (!at || dragged) return;
		// A second click within the double-click time makes one double click, not two clicks and a double.
		clearTimeout(single);
		if (e.detail >= 3) return void actThenSettle({ action: "triple_click", coordinate: at });
		if (e.detail === 2) return void actThenSettle({ action: "double_click", coordinate: at });
		single = setTimeout(() => void actThenSettle({ action: "left_click", coordinate: at }), 250);
	}
	let wheelSum = { x: 0, y: 0, at: [0, 0] as [number, number] };
	let wheelTimer: ReturnType<typeof setTimeout> | undefined;
	function wheel(e: WheelEvent) {
		const at = point(e);
		if (!at) return;
		e.preventDefault();
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1;
		wheelSum = { x: wheelSum.x + e.deltaX * unit, y: wheelSum.y + e.deltaY * unit, at };
		if (wheelTimer) return;
		// Scrolling goes as one action every 150 ms, sized by how far the person scrolled.
		wheelTimer = setTimeout(() => {
			wheelTimer = undefined;
			const { x, y, at: where } = wheelSum;
			wheelSum = { x: 0, y: 0, at: where };
			const vertical = Math.abs(y) >= Math.abs(x);
			const amount = Math.max(1, Math.min(10, Math.round(Math.abs(vertical ? y : x) / 60)));
			const direction = vertical ? (y > 0 ? "down" : "up") : x > 0 ? "right" : "left";
			if (Math.abs(vertical ? y : x) >= 4) void act({ action: "scroll", coordinate: where, scroll_direction: direction, scroll_amount: amount });
		}, 150);
	}

	// ── The person's keyboard ────────────────────────────────────────────────────────────────────────────────────
	const NAMES: Record<string, string> = {
		Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", Delete: "Delete", Home: "Home", End: "End",
		PageUp: "Page_Up", PageDown: "Page_Down", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
		Insert: "Insert", " ": "space",
	};
	let typed = "";
	let typing: ReturnType<typeof setTimeout> | undefined;
	function flushTyping() {
		clearTimeout(typing);
		typing = undefined;
		if (!typed) return;
		const text = typed;
		typed = "";
		void actThenSettle({ action: "type", text });
	}
	let address: HTMLInputElement | undefined = $state();
	function leave() {
		flushTyping();
		(address ?? canvas)?.focus({ preventScroll: true });
	}
	function key(e: KeyboardEvent) {
		if (e.key === "F6" || ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "l")) {
			e.preventDefault();
			return leave();
		}
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
		e.preventDefault();
		// On a Mac, Command shortcuts are the Linux desktop's Control ones.
		const ctrl = e.ctrlKey || (mac && e.metaKey);
		const plain = e.key.length === 1 && !ctrl && !e.altKey && !(e.metaKey && !mac);
		if (plain) {
			typed += e.key;
			clearTimeout(typing);
			// Typing goes as one action once the person pauses, so a word isn't one action per letter.
			typing = setTimeout(flushTyping, 200);
			return;
		}
		if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
		flushTyping();
		const name = NAMES[e.key] ?? (/^F\d{1,2}$/.test(e.key) ? e.key : e.key.length === 1 ? e.key.toLowerCase() : undefined);
		if (!name) return;
		const chord = [ctrl && "ctrl", e.altKey && "alt", e.shiftKey && e.key.length !== 1 && "shift", e.metaKey && !mac && "super", name].filter(Boolean).join("+");
		void actThenSettle({ action: "key", text: chord });
	}
	function paste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData("text/plain");
		if (!text) return;
		e.preventDefault();
		flushTyping();
		if (text.length > 4_000) return lab.say("That's more than 4,000 characters: paste it in parts, or upload it as a file.");
		void actThenSettle({ action: "type", text });
	}

	function open(e: Event) {
		e.preventDefault();
		const value = target.trim();
		if (!value) return;
		const next = value.startsWith("/") || /^https:\/\//.test(value) ? value : `https://${value}`;
		target = "";
		// A program takes a moment to open its window.
		void lab.desktopOpen(site, next).then(() => {
			clearTimeout(settle);
			if (!live) settle = setTimeout(() => void act({ action: "screenshot" }), 1_500);
		});
	}
	const size = $derived(frame?.width ? `${frame.width} × ${frame.height}` : info?.width ? `${info.width} × ${info.height}` : "");
</script>

<div class="desktop-pane">
	<div class="bar">
		<span class="lane" title={`A desktop in your ${place.title} sandbox. It has no shell; the agent and you use it through ${place.title}'s checked actions.`}><span class="place-dot" style:--dot={`var(${place.color})`}></span>{place.title} desktop</span>
		{#if info?.open}
			<form class="open" onsubmit={open}>
				<input class="field" bind:this={address} bind:value={target} placeholder="Open an https address or a /sandbox file" aria-label="Open on the desktop" spellcheck="false" />
			</form>
		{:else}
			<span class="spacer"></span>
		{/if}
		{#if agentWorking}<span class="who" role="status">The agent is using it</span>{:else if size}<span class="who" title={live ? "The desktop shows live" : "The picture updates after each action"}>{live ? "Live · " : ""}{size}</span>{/if}
		<button type="button" class="icon-btn" onclick={() => void act({ action: "screenshot" })} disabled={busy} aria-label="Refresh the picture" title="Refresh the picture">
			<svg viewBox="0 0 16 16"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" /></svg>
		</button>
	</div>
	<div class="stage" bind:this={stage} class:busy>
		<canvas
			bind:this={canvas}
			class:hidden={!drawn}
			tabindex="0"
			aria-label={`The ${place.title} desktop. Clicks and typing go to it; press F6 to leave it.`}
			onpointerdown={press}
			onpointerup={release}
			onclick={click}
			onwheel={wheel}
			onkeydown={key}
			onpaste={paste}
			oncontextmenu={(e) => e.preventDefault()}
			onfocus={() => (focused = true)}
			onblur={() => ((focused = false), flushTyping())}
		></canvas>
		{#if !drawn}
			<div class="blank">
				<p>{busy ? `Starting the ${place.title} desktop. The first start can take half a minute.` : `The ${place.title} desktop shows here.`}</p>
				{#if !busy}<button type="button" class="btn" onclick={() => void act({ action: "screenshot" })}>Start Desktop</button>{/if}
			</div>
		{/if}
	</div>
	{#if lab.lost && drawn}
		<p class="hint lost" role="status">Not connected to the engine: this is the last picture of the desktop.</p>
	{:else if focused}
		<p class="hint">
			<span>Clicks and typing go to the desktop · <kbd>F6</kbd> or <kbd>{mac ? "⌘L" : "Ctrl+L"}</kbd> to leave it</span>
			<button type="button" class="btn" onmousedown={(e) => e.preventDefault()} onclick={leave}>Release Keyboard</button>
		</p>
	{/if}
</div>

<style>
	.desktop-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 4px;
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
	.open,
	.spacer {
		flex: 1;
		min-width: 0;
	}
	.open .field {
		width: 100%;
		height: 28px;
		font-size: 12.5px;
	}
	.who {
		padding: 0 6px;
		font-size: 11.5px;
		color: var(--text-faint);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.who[role="status"] {
		color: var(--accent-text);
	}
	.hint {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: 0;
		padding: 5px 12px;
		border-top: 1px solid var(--rule);
		font-size: 11.5px;
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
	/* While an action is on its way, a still line along the top edge. */
	.stage.busy::before {
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
		place-content: center;
		justify-items: center;
		gap: 12px;
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
		.who {
			display: none;
		}
	}
</style>
