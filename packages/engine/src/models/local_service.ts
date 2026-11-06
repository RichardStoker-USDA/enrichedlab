// Open models on this computer, for the window and the terminal: which servers run here, which suggested models fit
// its memory, and downloads through Ollama with progress that sums every layer.

import { totalmem } from "node:os";
import type { LocalModelsStatus, LocalPullProgress, SuggestedModel } from "@enrichedlab/protocol";
import { ollamaUsesMlx } from "./local.ts";
import { OLLAMA_MLX_DEFAULT, atLeast, pullModel, removeModel } from "./ollama.ts";
import type { ModelRegistry } from "./registry.ts";
import suggested from "./suggested_models.json";

/** A model fits when its download is at most this share of memory: the rest holds its context and everything else. */
const FIT_SHARE = 0.6;

/** Ollama model names: `name`, `namespace/name`, `hf.co/org/repo`, each with an optional `:tag`. */
const MODEL_NAME = /^[A-Za-z0-9][\w.-]*(?:\/[\w.-]+)*(?::[\w.-]+)?$/;

interface Pull {
	progress: LocalPullProgress;
	layers: Map<string, { completed: number; total: number }>;
	controller: AbortController;
	sentAt: number;
}

export class LocalModels {
	private pulls = new Map<string, Pull>();

	constructor(
		private registry: ModelRegistry,
		private emit: (progress: LocalPullProgress) => void,
		private memoryBytes = totalmem(),
	) {}

	private ollama() {
		return this.registry.servers.find((s) => s.kind === "ollama");
	}

	async status(): Promise<LocalModelsStatus> {
		await this.registry.refresh();
		const memoryGiB = Math.round(this.memoryBytes / 2 ** 30);
		const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
		const ollama = this.ollama();
		const installed = new Set(ollama?.models.map((m) => m.id) ?? []);
		const suggestions: SuggestedModel[] = suggested.models.map((m) => ({ ...m, fits: m.sizeGB <= memoryGiB * FIT_SHARE, installed: installed.has(m.model) }));
		return {
			memoryGiB,
			appleSilicon,
			servers: this.registry.servers.map((s) => ({ name: s.name, kind: s.kind, label: s.label, port: s.port, version: s.version, models: s.models.map((m) => m.id) })),
			ollama: ollama ? { name: ollama.name, version: ollama.version, mlx: ollamaUsesMlx(ollama.version), updateForMlx: appleSilicon && !atLeast(ollama.version ?? "0", OLLAMA_MLX_DEFAULT) } : undefined,
			suggestions,
			checked: suggested.checked,
			pulls: [...this.pulls.values()].map((p) => p.progress),
		};
	}

	/** Start a download; it runs on after this returns and reports through `emit`. */
	async pull(model: string): Promise<void> {
		if (!MODEL_NAME.test(model) || model.length > 200) throw new Error("That isn't an Ollama model name (like qwen3.8:27b).");
		if (this.pulls.has(model)) return;
		if (!this.ollama()) await this.registry.refresh();
		const ollama = this.ollama();
		if (!ollama) throw new Error("Ollama isn't running on this computer. Install it from https://ollama.com/download, open it, then try again.");
		const pull: Pull = { progress: { model, status: "starting" }, layers: new Map(), controller: new AbortController(), sentAt: 0 };
		this.pulls.set(model, pull);
		this.emit(pull.progress);
		void this.run(ollama.baseUrl, pull);
	}

	private async run(baseUrl: string, pull: Pull): Promise<void> {
		const { model } = pull.progress;
		try {
			for await (const step of pullModel(baseUrl, model, pull.controller.signal)) {
				const digest = /^pulling ([0-9a-f]{6,})/.exec(step.status)?.[1];
				if (digest && step.total) pull.layers.set(digest, { completed: step.completed ?? 0, total: step.total });
				const layers = [...pull.layers.values()];
				pull.progress = {
					model,
					status: digest ? "downloading" : step.status,
					completed: layers.reduce((n, l) => n + l.completed, 0) || undefined,
					total: layers.reduce((n, l) => n + l.total, 0) || undefined,
				};
				// At most four updates a second, but every change of step.
				const now = Date.now();
				if (!digest || now - pull.sentAt > 250) {
					pull.sentAt = now;
					this.emit(pull.progress);
				}
			}
			await this.registry.refresh();
			this.emit({ ...pull.progress, status: "ready", done: true });
		} catch (error) {
			const cancelled = pull.controller.signal.aborted;
			this.emit({ ...pull.progress, status: cancelled ? "cancelled" : "failed", done: true, error: cancelled ? undefined : error instanceof Error ? error.message : String(error) });
		} finally {
			this.pulls.delete(model);
		}
	}

	cancel(model: string): void {
		this.pulls.get(model)?.controller.abort();
	}

	async remove(model: string): Promise<void> {
		const ollama = this.ollama();
		if (!ollama) throw new Error("Ollama isn't running on this computer.");
		await removeModel(ollama.baseUrl, model);
		await this.registry.refresh();
	}
}
