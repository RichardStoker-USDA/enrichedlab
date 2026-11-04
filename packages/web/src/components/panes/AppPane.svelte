<script lang="ts">
	import { onDestroy } from "svelte";
	import type { AppBridge, McpUiHostContext, McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
	import type { AppToolResult, Result } from "@enrichedlab/protocol";
	import { lab } from "../../lib/store.svelte.ts";
	import { rpc } from "../../lib/rpc.ts";

	let { id, active }: { id: string; active: boolean } = $props();

	type Opened = Result<"app.open">;
	let opened = $state.raw<Opened | undefined>();
	let error = $state("");
	/** The last error the page reported; the agent hears about it too. */
	let fault = $state("");
	let frame: HTMLIFrameElement | undefined = $state();
	let generation = $state(0);
	let bridge: AppBridge | undefined;
	let token: string | undefined;

	const app = $derived(opened?.app ?? lab.apps.find((a) => a.id === id));
	/** The app's folder in its project, such as "fieldtrial/apps/yield-explorer". */
	const where = (dir: string) => dir.split(/[\\/]/).filter(Boolean).slice(-3).join("/");

	async function open() {
		error = "";
		try {
			const next = await rpc.call("app.open", { sessionId: lab.current, id });
			if (token) void rpc.call("app.close", { token }).catch(() => undefined);
			token = next.token;
			opened = next;
			generation++;
			fault = "";
		} catch (e) {
			error = (e as Error).message;
		}
	}

	$effect(() => {
		void id;
		void lab.current;
		void open();
	});

	async function decide(allow: boolean) {
		await rpc.call("app.grant", { id, allow });
		void lab.refreshApps();
		if (allow) await open();
		else error = "Not allowed. Reopen the app to decide again.";
	}

	// ── Theme for the page, in the MCP Apps standard variable names ──────────────────────────────────────────────

	function dark(): boolean {
		const theme = lab.ui.theme;
		return theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
	}

	function hostContext(): McpUiHostContext {
		const css = getComputedStyle(document.documentElement);
		const v = (name: string) => css.getPropertyValue(name).trim() || undefined;
		const rect = frame?.getBoundingClientRect();
		return {
			theme: dark() ? ("dark" as const) : ("light" as const),
			styles: {
				variables: {
					"--color-background-primary": v("--canvas"),
					"--color-background-secondary": v("--surface"),
					"--color-background-tertiary": v("--raised"),
					"--color-text-primary": v("--text"),
					"--color-text-secondary": v("--text-muted"),
					"--color-text-tertiary": v("--text-faint"),
					"--color-border-primary": v("--rule-strong"),
					"--color-border-secondary": v("--rule"),
					"--color-ring-primary": v("--focus-inner"),
					"--font-sans": v("--font-ui"),
					"--font-mono": v("--font-mono"),
					"--border-radius-sm": v("--radius-small"),
					"--border-radius-md": v("--radius"),
				} as McpUiStyles,
			},
			displayMode: "inline" as const,
			availableDisplayModes: ["inline"],
			platform: window.labDesktop ? ("desktop" as const) : ("web" as const),
			locale: navigator.language,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			containerDimensions: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : undefined,
		};
	}

	// ── The bridge (MCP Apps host side) ─────────────────────────────────────────────────────────────────────────

	const textOf = (blocks: { type: string; text?: string }[] | undefined) =>
		(blocks ?? [])
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n");

	/** Attach the bridge to an empty frame, then load the page: the page's first message (ui/initialize) is sent
	 * while it loads, so the host must be listening before it starts. */
	function load(node: HTMLIFrameElement) {
		const current = opened;
		if (!current?.url) return;
		if (current.kind === "page") {
			node.src = current.url;
			return;
		}
		void connect(node).then(
			() => (node.src = current.url),
			(e: Error) => (error = `The app's bridge didn't start: ${e.message}`),
		);
	}

	async function connect(node: HTMLIFrameElement) {
		const current = opened;
		if (!node.contentWindow || !current?.url || !token) return;
		const window_ = node.contentWindow;
		const ownToken = token;
		const { AppBridge, PostMessageTransport } = await import("@modelcontextprotocol/ext-apps/app-bridge");
		await bridge?.close().catch(() => undefined);
		const b = new AppBridge(
			null,
			{ name: "EnrichedLab", version: "0.1.0" },
			{ openLinks: {}, serverTools: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} } },
			{ hostContext: hostContext() },
		);
		b.oncalltool = async (params) => (await rpc.call("app.call", { token: ownToken, name: params.name, arguments: (params.arguments ?? {}) as Record<string, unknown> })) as never;
		b.onmessage = async (params) => {
			await rpc.call("app.message", { token: ownToken, text: textOf(params.content as { type: string; text?: string }[]) });
			return {};
		};
		b.onopenlink = async ({ url }) => {
			// A lab that keeps data inside gives its apps no way out, links included.
			if (lab.pinned) throw new Error("This lab keeps its data inside; apps here can't open links.");
			lab.openPane("browser", url);
			return {};
		};
		b.onupdatemodelcontext = async (params) => {
			const structured = params.structuredContent ? JSON.stringify(params.structuredContent).slice(0, 4_000) : "";
			await rpc.call("app.context", { token: ownToken, text: [textOf(params.content as { type: string; text?: string }[]), structured].filter(Boolean).join("\n") });
			return {};
		};
		b.onloggingmessage = (message) => {
			if (message.level !== "error" && message.level !== "critical") return console.debug(`[${current.app.title}]`, message.data);
			const text = typeof message.data === "string" ? message.data : JSON.stringify(message.data);
			fault = text.split("\n")[0]!.slice(0, 300);
			void rpc.call("app.context", { token: ownToken, text: `The app reported an error: ${text.slice(0, 1_500)}` }).catch(() => undefined);
		};
		b.oninitialized = () => {
			if (current.toolInput) void b.sendToolInput({ arguments: current.toolInput });
			if (current.toolResult) void b.sendToolResult(current.toolResult as AppToolResult as never);
		};
		await b.connect(new PostMessageTransport(window_, window_));
		bridge = b;
	}

	// Theme changes reach the page as they happen.
	$effect(() => {
		void lab.ui.theme;
		const media = matchMedia("(prefers-color-scheme: dark)");
		const send = () => void bridge?.sendHostContextChange(hostContext());
		send();
		media.addEventListener("change", send);
		return () => media.removeEventListener("change", send);
	});

	// Files changed: tell the page it's going, then load the new one.
	$effect(() =>
		rpc.on("app.changed", async (changed) => {
			if (changed.id !== opened?.app.id) return;
			await Promise.race([bridge?.teardownResource({}).catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
			generation++;
		}),
	);

	async function reload() {
		await bridge?.teardownResource({}).catch(() => undefined);
		await open();
	}

	onDestroy(() => {
		void bridge?.close().catch(() => undefined);
		if (token) void rpc.call("app.close", { token }).catch(() => undefined);
	});
</script>

<div class="app-pane" class:active>
	<div class="bar">
		<span class="title">{app?.title ?? "App"}</span>
		<span class="meta">
			{#if app}
				{app.source.startsWith("mcp:") ? `from ${app.source.slice(4)}` : app.source === "project" ? "in this project" : app.source.startsWith("bundle:") ? `from ${app.source.slice(7)}` : "installed"}{app.backend ? ` · ${app.backend} backend` : ""}{app.signer ? ` · signed ${app.signer}` : ""}
			{/if}
		</span>
		<button class="icon-btn" onclick={reload} aria-label="Reload the app" title="Reload">
			<svg viewBox="0 0 16 16"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" /></svg>
		</button>
	</div>
	{#if fault}
		<p class="fault" role="status">The app hit an error: {fault}</p>
	{/if}
	{#if error}
		<p class="state">{error}</p>
	{:else if opened && !opened.app.granted}
		<div class="consent" role="dialog" aria-labelledby="consent-title">
			<h2 id="consent-title">{opened.app.title} asks to</h2>
			<ul>
				{#each opened.asks as line}<li>{line}</li>{/each}
			</ul>
			<p class="where">{opened.app.description || where(opened.app.dir)}{opened.app.signer ? ` · signed by ${opened.app.signer}` : ""}</p>
			<div class="actions">
				<button class="btn primary" onclick={() => decide(true)}>Allow</button>
				<button class="btn" onclick={() => decide(false)}>Not now</button>
			</div>
		</div>
	{:else if opened?.url}
		{#key generation}
			{#if opened.kind === "view"}
				<iframe bind:this={frame} use:load class="frame" title={opened.app.title} sandbox="allow-scripts allow-modals"></iframe>
			{:else}
				<iframe bind:this={frame} use:load class="frame" title={opened.app.title} sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
			{/if}
		{/key}
	{:else}
		<p class="state">Starting…</p>
	{/if}
</div>

<style>
	.app-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 6px 4px 14px;
		border-bottom: 1px solid var(--rule);
		font-size: 12.5px;
	}
	.title {
		font-weight: 600;
	}
	.meta {
		flex: 1;
		min-width: 0;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.fault {
		margin: 0;
		padding: 6px 14px;
		border-bottom: 1px solid var(--rule);
		font: 12px/1.4 var(--font-mono);
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.frame {
		flex: 1;
		min-height: 0;
		border: 0;
		background: var(--canvas);
	}
	.state {
		margin: auto;
		color: var(--text-muted);
		font-size: 13px;
		max-width: 420px;
		text-align: center;
		white-space: pre-wrap;
	}
	.consent {
		margin: auto;
		width: min(420px, calc(100% - 32px));
		padding: 20px 22px;
		border-radius: var(--radius);
		border: 1px solid var(--rule);
		background: var(--raised);
		box-shadow: var(--shadow);
	}
	.consent h2 {
		margin: 0 0 10px;
		font-size: 15px;
		font-weight: 600;
	}
	.consent ul {
		margin: 0 0 12px;
		padding-left: 18px;
		font-size: 13.5px;
		line-height: 1.6;
	}
	.where {
		margin: 0 0 16px;
		font-size: 12px;
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
</style>
