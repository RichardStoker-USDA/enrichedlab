<script lang="ts">
	import type { Part } from "@enrichedlab/protocol";
	import { lab, USAGE_URL } from "../lib/store.svelte.ts";
	import { tokens } from "../lib/format.ts";

	let text = $state("");
	let images = $state<{ name: string; part: Extract<Part, { type: "image" }>; url: string }[]>([]);
	let field: HTMLTextAreaElement | undefined = $state();
	let menuOpen = $state(false);
	let menu: HTMLDivElement | undefined = $state();

	const gauge = $derived(lab.status?.context);
	const left = $derived(gauge ? Math.max(0, Math.min(1, 1 - gauge.used / gauge.threshold)) : 1);
	const leftPct = $derived(Math.round(left * 100));
	const CIRC = 2 * Math.PI * 9;
	let sweeping = $state(false);
	$effect(() => {
		if (!lab.compactedAt) return;
		sweeping = true;
		const timer = setTimeout(() => (sweeping = false), 450);
		return () => clearTimeout(timer);
	});

	const groups = $derived.by(() => {
		const plan = (m: { provider: string }) => m.provider === "chatgpt";
		return [
			{ label: "From your labs", models: lab.models.filter((m) => m.source === "site") },
			{ label: "Your ChatGPT plan", models: lab.models.filter((m) => m.source === "config" && plan(m)) },
			{ label: "Your keys", models: lab.models.filter((m) => m.source === "config" && !plan(m)) },
			{ label: "On this computer", models: lab.models.filter((m) => m.source === "local") },
		].filter((g) => g.models.length);
	});
	/** OpenAI asks apps to say when requests use the person's ChatGPT plan, with a way to manage it. */
	const onPlan = $derived(lab.model?.provider === "chatgpt");
	/** A model's name as its service gives it ("GPT-6.1 Sol · ChatGPT" shows as "GPT-6.1 Sol"). */
	const named = (m: { id: string; label: string }) => m.label.split(" · ")[0] || m.id;

	function resize() {
		if (!field) return;
		field.style.height = "auto";
		field.style.height = `${Math.min(field.scrollHeight, window.innerHeight * 0.4)}px`;
	}
	$effect(() => {
		void text;
		resize();
	});
	$effect(() => {
		void lab.current;
		field?.focus({ preventScroll: true });
	});

	async function send() {
		const value = text.trim();
		if (!value && !images.length) return;
		const parts = images.map((i) => i.part);
		text = "";
		for (const i of images) URL.revokeObjectURL(i.url);
		images = [];
		try {
			await lab.send(value || "(see the attached image)", parts.length ? parts : undefined);
		} catch (error) {
			lab.say((error as Error).message);
			text = value;
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

	async function addFiles(files: Iterable<File>) {
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			if (file.size > 12 * 1024 * 1024) {
				lab.say(`${file.name} is larger than 12 MB.`);
				continue;
			}
			const data = await new Promise<string>((resolve) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
				reader.readAsDataURL(file);
			});
			images = [...images, { name: file.name, part: { type: "image", mime: file.type, data }, url: URL.createObjectURL(file) }];
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
			<div class="model" bind:this={menu}>
				<button type="button" class="chip" onclick={() => (menuOpen = !menuOpen)} aria-expanded={menuOpen} aria-haspopup="menu" title={gauge ? `${leftPct}% of context left before older turns are summarized (${tokens(gauge.used)} of ${tokens(gauge.threshold)})` : ""}>
					<svg class="ring" class:sweeping viewBox="0 0 22 22" aria-hidden="true">
						<circle cx="11" cy="11" r="9" class="track" />
						<circle cx="11" cy="11" r="9" class="arc" class:low={leftPct < 15} stroke-dasharray={CIRC} stroke-dashoffset={CIRC * (1 - left)} />
					</svg>
					<span class="model-name">{lab.model ? named(lab.model) : lab.status?.model || "Choose a model"}</span>
					{#if lab.status?.effort}<span class="effort">{lab.status.effort}</span>{/if}
				</button>
				{#if menuOpen}
					<div class="menu" role="menu">
						{#each groups as group (group.label)}
							<p class="menu-label">{group.label}</p>
							{#each group.models as m (m.ref)}
								<button
									type="button"
									role="menuitemradio"
									aria-checked={m.ref === lab.status?.model}
									class="menu-item"
									onclick={() => {
										void lab.setModel(m.ref);
										menuOpen = false;
									}}
								>
									<span class="check" aria-hidden="true">{m.ref === lab.status?.model ? "✓" : ""}</span>
									<span class="menu-name">{named(m)}</span>
									<span class="menu-meta">{m.provider === "chatgpt" ? "plan" : m.provider} · {tokens(m.context)}{m.vision ? " · vision" : ""}</span>
								</button>
							{/each}
						{:else}
							<p class="menu-empty">No models yet. Sign in to your lab, start Ollama or LM Studio, or add a service.</p>
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
							<span>{gauge ? `${leftPct}% context left · ${tokens(gauge.used)} of ${tokens(gauge.threshold)}` : ""}</span>
							<span class="foot-actions">
								<button type="button" class="link" onclick={() => ((lab.services = true), (menuOpen = false))}>Model services</button>
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
			<button type="submit" class="send" disabled={!text.trim() && !images.length} aria-label={lab.busy ? "Add to this turn" : "Send"}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
			</button>
		</div>
	</form>
</div>

<style>
	.dock {
		padding: 0 20px 18px;
		padding-bottom: max(18px, env(safe-area-inset-bottom));
		background: linear-gradient(to bottom, transparent, var(--canvas) 30%);
	}
	.composer {
		max-width: calc(var(--measure) - 16px);
		margin: 0 auto;
		border: 1px solid var(--rule-strong);
		border-radius: 14px;
		background: var(--raised);
		box-shadow: var(--shadow);
		padding: 10px 10px 8px 14px;
		transition: border-color 150ms;
	}
	.composer:focus-within {
		border-color: var(--focus-inner);
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
		padding: 4px 9px 4px 5px;
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
		stroke-width: 2.2;
	}
	.track {
		stroke: var(--rule);
	}
	.arc {
		stroke: var(--live);
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
	.effort {
		color: var(--text-faint);
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
		position: absolute;
		bottom: calc(100% + 10px);
		left: -6px;
		width: min(420px, 86vw);
		max-height: 60vh;
		overflow-y: auto;
		background: var(--raised);
		border: 1px solid var(--rule-strong);
		border-radius: 12px;
		box-shadow: var(--shadow);
		padding: 6px;
		z-index: 20;
		animation: pop 140ms var(--ease-out);
		transform-origin: bottom left;
	}
	.menu-label {
		margin: 8px 10px 4px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text-faint);
	}
	.menu-item {
		width: 100%;
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr);
		gap: 2px 8px;
		padding: 7px 10px;
		border-radius: 8px;
		text-align: left;
	}
	.menu-item:hover {
		background: var(--hover);
	}
	.check {
		color: var(--live);
		grid-row: span 2;
	}
	.menu-name {
		font-size: 13.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.menu-meta {
		font-size: 12px;
		color: var(--text-faint);
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
			max-width: 220px;
		}
	}
</style>
