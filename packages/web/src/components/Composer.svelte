<script lang="ts" module>
	import type { Part as DraftPart } from "@enrichedlab/protocol";
	type DraftImage = { name: string; part: Extract<DraftPart, { type: "image" }>; url: string };
	const drafts = new Map<string, { text: string; images: DraftImage[] }>();
	function saveDraft(id: string, text: string, images: DraftImage[]) {
		drafts.set(id, { text, images });
		try {
			if (text) sessionStorage.setItem(`enrichedlab.draft.${id}`, text);
			else sessionStorage.removeItem(`enrichedlab.draft.${id}`);
		} catch {
			// Storage blocked: the draft lives while the window is open.
		}
	}
	import { adoptCarried } from "../lib/carried.ts";
	function loadDraft(id: string): { text: string; images: DraftImage[] } | undefined {
		adoptCarried();
		const kept = drafts.get(id);
		if (kept) return kept;
		try {
			const text = sessionStorage.getItem(`enrichedlab.draft.${id}`);
			return text ? { text, images: [] } : undefined;
		} catch {
			return undefined;
		}
	}
</script>

<script lang="ts">
	import Where from "./Where.svelte";
	import { byWhere, whereNote } from "../lib/where.ts";
	import type { Part } from "@enrichedlab/protocol";
	import { lab, USAGE_URL } from "../lib/store.svelte.ts";
	import { tick, untrack } from "svelte";
	import { tokens } from "../lib/format.ts";
	import PlaceSwitch from "./PlaceSwitch.svelte";
	import { allowedModels } from "../lib/places.ts";

	type Image = { name: string; part: Extract<Part, { type: "image" }>; url: string };
	let text = $state("");
	let images = $state<Image[]>([]);
	let field: HTMLTextAreaElement | undefined = $state();
	let menuOpen = $state(false);
	let menu: HTMLDivElement | undefined = $state();

	/** The context gauge, once the engine has counted the session (a session with no model has no count). */
	const gauge = $derived(typeof lab.status?.context?.used === "number" && lab.status.context.threshold ? lab.status.context : undefined);
	const left = $derived(gauge ? Math.max(0, Math.min(1, 1 - gauge.used / gauge.threshold)) : 1);
	// The ring appears once half the context is used, and fills as it does; before that the popover has the count.
	const leftPct = $derived(Math.round(left * 100));
	const CIRC = 2 * Math.PI * 9;
	let sweeping = $state(false);
	$effect(() => {
		if (!lab.compactedAt) return;
		sweeping = true;
		const timer = setTimeout(() => (sweeping = false), 450);
		return () => clearTimeout(timer);
	});

	// Only the models this session may use (a lab that keeps its data inside lends its models to its own sessions),
	// grouped by where they run: private places first, then cloud services.
	const groups = $derived(byWhere(allowedModels(lab.models, lab.sites, lab.summary?.site)));
	/** OpenAI asks apps to say when requests use the person's ChatGPT plan, with a way to manage it. */
	const onPlan = $derived(lab.model?.provider === "chatgpt");
	/** A model's name as its service gives it ("GPT-6.1 Sol · ChatGPT" shows as "GPT-6.1 Sol"). */
	const named = (m: { id: string; label: string }) => m.label.split(" · ")[0] || m.id;
	/** The session names a model that isn't offered now (its server stopped, or access changed). */
	const missing = $derived(!lab.model && Boolean(lab.status?.model));

	function resize() {
		if (!field) return;
		field.style.height = "auto";
		field.style.height = `${Math.min(field.scrollHeight, window.innerHeight * 0.4)}px`;
	}
	$effect(() => {
		void text;
		resize();
	});
	// Each session keeps its own draft: switching sessions saves this one and brings back the other's. Text also
	// survives a reload of the window (images stay only while the window is open).
	let shownFor: string | undefined;
	$effect(() => {
		const id = lab.current;
		if (shownFor === id) return;
		if (shownFor) saveDraft(shownFor, text, images);
		shownFor = id;
		const draft = id ? loadDraft(id) : undefined;
		text = draft?.text ?? "";
		images = draft?.images ?? [];
		field?.focus({ preventScroll: true });
	});
	$effect(() => {
		if (shownFor) saveDraft(shownFor, text, images);
	});
	// A task the new-session screen couldn't start comes back here, in the session it was written for.
	$effect(() => {
		const back = lab.returned;
		if (!back || back.sessionId !== lab.current) return;
		lab.returned = undefined;
		untrack(() => (text = text.trim() ? `${back.text}\n\n${text}` : back.text));
	});

	/** Why Send is off now, if it is. */
	const blocked = $derived(
		lab.lost
			? "Reconnecting to the engine…"
			: lab.moving
				? "The session is moving; send when it arrives."
				: lab.place.missing
					? `This session works in ${lab.place.title}, which isn't one of your labs now. Add it again to keep going here.`
					: missing || !lab.model
						? "Choose a model first: Models in the sidebar sets one up."
						: "",
	);

	async function send() {
		const value = text.trim();
		if ((!value && !images.length) || blocked) return;
		const sessionId = lab.current;
		const sent = images;
		text = "";
		images = [];
		try {
			await lab.send(value || "(see the attached image)", sent.length ? sent.map((i) => i.part) : undefined, sessionId);
			for (const i of sent) URL.revokeObjectURL(i.url);
		} catch (error) {
			lab.say((error as Error).message);
			// The message goes back into the session it was written for, attachments included, ahead of anything
			// written there since.
			if (sessionId === lab.current) {
				text = text.trim() ? `${value}\n\n${text}` : value;
				images = [...sent, ...images];
			} else if (sessionId) {
				const kept = loadDraft(sessionId);
				saveDraft(sessionId, kept?.text.trim() ? `${value}\n\n${kept.text}` : value, [...sent, ...(kept?.images ?? [])]);
			}
		}
	}

	function keydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void send();
		} else if (e.key === "Escape" && lab.busy) {
			e.preventDefault();
			lab.cancel();
		}
	}

	/** Attach images to the session they were dropped on, even when the person has moved on before they're read. */
	async function addFiles(files: Iterable<File>) {
		const sessionId = lab.current;
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			if (file.size > 12 * 1024 * 1024) {
				lab.say(`${file.name} is larger than 12 MB.`);
				continue;
			}
			const data = await new Promise<string | undefined>((resolve) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
				reader.onerror = () => resolve(undefined);
				reader.readAsDataURL(file);
			});
			if (data === undefined) {
				lab.say(`${file.name} couldn't be read.`);
				continue;
			}
			const image: Image = { name: file.name, part: { type: "image", mime: file.type, data }, url: URL.createObjectURL(file) };
			if (sessionId === lab.current) images = [...images, image];
			else if (sessionId) {
				const kept = loadDraft(sessionId);
				saveDraft(sessionId, kept?.text ?? "", [...(kept?.images ?? []), image]);
			}
		}
		if (images.length && lab.model && !lab.model.vision) lab.say(`${lab.model.id} can't see images; choose a vision model.`);
	}

	function paste(e: ClipboardEvent) {
		const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
		if (files.length) {
			e.preventDefault();
			void addFiles(files);
		}
	}

	function outside(e: MouseEvent) {
		if (menuOpen && menu && !menu.contains(e.target as Node)) menuOpen = false;
	}

	let chip: HTMLButtonElement | undefined = $state();
	/** The model popover: focus starts on the chosen model, Escape closes and returns to the chip, arrows move. */
	async function toggleModels() {
		menuOpen = !menuOpen;
		if (!menuOpen) return;
		await tick();
		(menu?.querySelector<HTMLButtonElement>("[role=radio][aria-checked=true]") ?? menu?.querySelector<HTMLButtonElement>("[role=radio]"))?.focus();
	}
	function closeModels() {
		menuOpen = false;
		chip?.focus();
	}
	function modelKeys(e: KeyboardEvent) {
		if (!menuOpen) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			closeModels();
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			const items = [...(menu?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? [])];
			const at = items.indexOf(document.activeElement as HTMLButtonElement);
			if (at < 0 && !items.length) return;
			e.preventDefault();
			items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
		}
	}
</script>

<svelte:window onclick={outside} />

<div class="dock">
	<form
		class="composer"
		class:busy={lab.busy}
		onsubmit={(e) => {
			e.preventDefault();
			void send();
		}}
		ondragover={(e) => e.preventDefault()}
		ondrop={(e) => {
			e.preventDefault();
			if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
		}}
	>
		{#if images.length}
			<div class="attachments">
				{#each images as image, i (image.url)}
					<figure>
						<img src={image.url} alt={image.name} />
						<button type="button" aria-label={`Remove ${image.name}`} onclick={() => (images = images.filter((_, j) => j !== i))}>×</button>
					</figure>
				{/each}
			</div>
		{/if}
		{#if lab.place.missing}<p class="held">{blocked}</p>{/if}
		<label class="visually-hidden" for="composer-field">Message</label>
		<textarea
			id="composer-field"
			bind:this={field}
			bind:value={text}
			onkeydown={keydown}
			onpaste={paste}
			rows="1"
			placeholder={lab.busy ? "Add to the current turn" : "Ask for anything"}
		></textarea>
		<div class="row">
			<PlaceSwitch />
			<span class="divider" aria-hidden="true"></span>
			<div class="model" bind:this={menu} onkeydown={modelKeys} role="none">
				<button type="button" class="chip" class:missing bind:this={chip} onclick={toggleModels} aria-expanded={menuOpen} aria-haspopup="dialog" title={missing ? `${lab.status?.model} isn't offered now. Choose another model.` : gauge ? `${leftPct}% of context left before older turns are summarized (${tokens(gauge.used)} of ${tokens(gauge.threshold)})` : "Choose the model"}>
					{#if left < 0.5}
						<svg class="ring" class:sweeping viewBox="0 0 22 22" aria-hidden="true">
							<circle cx="11" cy="11" r="9" class="track" />
							<circle cx="11" cy="11" r="9" class="arc" class:low={leftPct < 15} stroke-dasharray={CIRC} stroke-dashoffset={CIRC * left} />
						</svg>
					{/if}
					<span class="model-name">{lab.model ? named(lab.model) : missing ? "Model unavailable: choose one" : "Choose a model"}</span>
					{#if lab.model}<span class="origin"><Where where={lab.model.where} /></span>{/if}
					{#if lab.status?.effort && lab.model}<span class="effort">{lab.status.effort}</span>{/if}
					<svg class="caret" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 7.5 3-3 3 3" /></svg>
				</button>
				{#if menuOpen}
					<div class="menu" role="dialog" aria-label="Model and reasoning">
						{#if missing}
							<p class="menu-missing">{lab.status?.model} isn't offered now: its server may have stopped, or your access changed.</p>
						{/if}
						{#each groups as group (group.label)}
							<p class="menu-label where-label"><Where where={group.where} named={false} />{group.label}</p>
							<p class="menu-note">{whereNote(group.where, false)}</p>
							{#each group.models as m (m.ref)}
								<button
									type="button"
									role="radio"
									aria-checked={m.ref === lab.status?.model}
									class="menu-item"
									onclick={() => {
										void lab.setModel(m.ref);
										menuOpen = false;
										chip?.focus();
									}}
								>
									<span class="check" aria-hidden="true">{m.ref === lab.status?.model ? "✓" : ""}</span>
									<span class="menu-name">{named(m)}</span>
									<span class="menu-meta meta">{tokens(m.context)} context{m.vision ? " · sees images" : ""}{m.efforts.length ? " · reasons" : ""}</span>
								</button>
							{/each}
						{:else}
							<p class="menu-empty">No models yet. Sign in to a lab, use your ChatGPT plan or a key, or run an open model on this computer.</p>
						{/each}
						{#if lab.model?.efforts.length}
							<p class="menu-label">Reasoning</p>
							<div class="efforts" role="radiogroup" aria-label="Reasoning level">
								{#each lab.model.efforts as level}
									<button type="button" role="radio" aria-checked={level === lab.status?.effort} class:on={level === lab.status?.effort} onclick={() => lab.setModel(undefined, level)}>{level}</button>
								{/each}
							</div>
						{/if}
						{#if onPlan}
							<p class="menu-plan">Using ChatGPT plan · <a href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a></p>
						{/if}
						<div class="menu-foot">
							<span>{gauge ? `${tokens(gauge.used)} of ${tokens(gauge.threshold)} used before older turns are summarized` : ""}</span>
							<span class="foot-actions">
								<button type="button" class="link" onclick={() => ((lab.services = true), (menuOpen = false))}>Model Services</button>
								<button type="button" class="link" onclick={() => lab.compact()} disabled={lab.busy}>Summarize now</button>
							</span>
						</div>
					</div>
				{/if}
			</div>
			{#if onPlan}
				<span class="plan">Using ChatGPT plan · <a href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a></span>
			{/if}
			{#if lab.status?.rate}<span class="rate">{lab.status.rate} tok/s</span>{/if}
			<span class="spacer"></span>
			{#if lab.busy}
				<button type="button" class="send stop" onclick={() => lab.cancel()} aria-label="Stop">
					<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>
				</button>
			{/if}
			<button type="submit" class="send" disabled={(!text.trim() && !images.length) || Boolean(blocked)} aria-label={lab.busy ? "Add to this turn" : "Send"} title={blocked || (lab.busy ? "Add to this turn" : "Send")}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
			</button>
		</div>
	</form>
</div>

<style>
	/* The composer fits its column, not the window: beside an open workbench it narrows the same way. */
	.dock {
		container-type: inline-size;
		padding: 0 20px 18px;
		padding-bottom: max(18px, env(safe-area-inset-bottom));
		background: linear-gradient(to bottom, transparent, var(--canvas) 30%);
	}
	.composer {
		max-width: calc(var(--measure) - 16px);
		margin: 0 auto;
		border: 1px solid var(--edge);
		border-radius: 12px;
		background: var(--raised);
		padding: 12px 10px 8px 14px;
		transition: border-color 150ms;
	}
	.composer:focus-within {
		border-color: var(--focus-inner);
	}
	.held {
		margin: 0 0 6px;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--text-muted);
	}
	textarea {
		width: 100%;
		border: 0;
		outline: none;
		resize: none;
		background: transparent;
		font-size: 15px;
		line-height: 1.5;
		max-height: 40vh;
		padding: 2px 0 6px;
		display: block;
	}
	textarea:focus-visible {
		outline: none;
		box-shadow: none;
	}
	textarea::placeholder {
		color: var(--text-faint);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.spacer {
		flex: 1;
	}
	.model {
		position: relative;
	}
	.chip {
		display: flex;
		align-items: center;
		gap: 7px;
		height: 30px;
		padding: 0 9px 0 5px;
		border-radius: 999px;
		font-size: 12.5px;
		color: var(--text-muted);
		transition: background 120ms;
		max-width: 340px;
	}
	.chip:hover,
	.chip[aria-expanded="true"] {
		background: var(--hover);
		color: var(--text);
	}
	.ring {
		width: 22px;
		height: 22px;
		transform: rotate(-90deg);
		flex: none;
	}
	.ring circle {
		fill: none;
		stroke-width: 2;
	}
	.track {
		stroke: var(--rule);
	}
	.arc {
		stroke: var(--text-muted);
		stroke-linecap: round;
		transition: stroke-dashoffset 400ms var(--ease-out);
	}
	.arc.low {
		stroke: var(--bad);
	}
	.ring.sweeping .arc {
		transition-duration: 400ms;
	}
	.model-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}
	.effort,
	.origin {
		display: inline-flex;
		min-width: 0;
		margin-left: 2px;
	}
	.where-label {
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.menu-note {
		margin: -2px 0 4px;
		padding: 0 10px 0 27px;
		font-size: 11.5px;
		line-height: 1.4;
		color: var(--text-muted);
		max-width: 340px;
	}
	.chip.missing {
		color: var(--bad);
	}
	.caret {
		width: 11px;
		height: 11px;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
	}
	.divider {
		width: 1px;
		height: 16px;
		background: var(--rule-strong);
	}
	.rate {
		font-size: 12px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.plan {
		font-size: 12px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.plan a {
		color: var(--link);
	}
	.send {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--primary-bg);
		color: var(--primary-fg);
		transition: opacity 120ms, transform 80ms;
	}
	.send:disabled {
		opacity: 0.28;
		cursor: default;
	}
	.send:not(:disabled):active {
		transform: scale(0.94);
	}
	.send svg {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		stroke-width: 2;
		fill: none;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.send.stop {
		background: var(--hover);
		color: var(--text);
	}
	.send.stop svg {
		fill: currentColor;
		stroke: none;
	}
	.menu {
		bottom: calc(100% + 10px);
		left: -6px;
		width: min(420px, 86vw);
		max-height: 60vh;
		overflow-y: auto;
		z-index: 20;
		transform-origin: bottom left;
	}
	.menu-item {
		grid-template-columns: 14px minmax(0, 1fr);
		gap: 0 8px;
		min-height: 40px;
	}
	.check {
		grid-row: span 2;
		font-size: 12px;
	}
	.menu-missing {
		margin: 4px 9px 6px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--rule);
		font-size: 12px;
		line-height: 1.45;
		color: var(--bad);
	}
	.menu-name {
		font-size: 13.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.menu-meta {
		font-size: 11.5px;
		color: var(--text-muted);
	}
	.menu-empty {
		padding: 10px;
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}
	.efforts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 0 8px 6px;
	}
	.efforts button {
		font-size: 12.5px;
		padding: 4px 10px;
		border-radius: 999px;
		background: var(--hover);
		color: var(--text-muted);
	}
	.efforts button.on {
		background: var(--primary-bg);
		color: var(--primary-fg);
	}
	.menu-plan {
		margin: 4px 10px 0;
		font-size: 12px;
		color: var(--text-muted);
	}
	.menu-plan a {
		color: var(--link);
	}
	.menu-foot {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 4px 8px;
		border-top: 1px solid var(--rule);
		margin-top: 6px;
		padding: 8px 10px 4px;
		font-size: 12px;
		color: var(--text-faint);
	}
	.foot-actions {
		display: flex;
		gap: 14px;
		margin-left: auto;
		white-space: nowrap;
	}
	.link {
		color: var(--link);
		font-size: 12.5px;
	}
	.link:disabled {
		color: var(--text-faint);
	}
	.attachments {
		display: flex;
		gap: 8px;
		margin-bottom: 8px;
	}
	figure {
		margin: 0;
		position: relative;
	}
	figure img {
		width: 56px;
		height: 56px;
		object-fit: cover;
		border-radius: 8px;
		border: 1px solid var(--rule);
	}
	figure button {
		position: absolute;
		top: -6px;
		right: -6px;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: var(--text);
		color: var(--canvas);
		font-size: 13px;
		line-height: 1;
	}
	@container (max-width: 600px) {
		.origin,
		.rate,
		.plan {
			display: none;
		}
		.chip {
			max-width: 190px;
		}
	}
	@container (max-width: 420px) {
		.effort,
		.divider {
			display: none;
		}
		.chip {
			max-width: 150px;
		}
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: translateY(4px) scale(0.98);
		}
	}
	@media (max-width: 820px) {
		.dock {
			padding: 0 10px 10px;
		}
		.rate {
			display: none;
		}
		/* The menu says it on narrow screens. */
		.plan {
			display: none;
		}
		.chip {
			max-width: 200px;
		}
		/* Narrow: the glyph alone still says private or cloud; its title has the sentence. */
		.origin :global(.where > span) {
			display: none;
		}
	}
</style>
