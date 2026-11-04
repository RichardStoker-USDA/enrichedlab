// Code blocks in answers and file previews: a language label, a copy button, and syntax colors from Shiki
// (TextMate grammars, the same ones editors use). The highlighter and each language load on first use, so a session
// without code never pays for them. Colors come from two restrained themes switched by the app's own theme.

import type { HighlighterCore } from "shiki/core";

const LANGS: Record<string, () => Promise<unknown>> = {
	python: () => import("shiki/langs/python.mjs"),
	r: () => import("shiki/langs/r.mjs"),
	typescript: () => import("shiki/langs/typescript.mjs"),
	javascript: () => import("shiki/langs/javascript.mjs"),
	bash: () => import("shiki/langs/bash.mjs"),
	json: () => import("shiki/langs/json.mjs"),
	sql: () => import("shiki/langs/sql.mjs"),
	yaml: () => import("shiki/langs/yaml.mjs"),
	toml: () => import("shiki/langs/toml.mjs"),
	rust: () => import("shiki/langs/rust.mjs"),
	go: () => import("shiki/langs/go.mjs"),
	html: () => import("shiki/langs/html.mjs"),
	css: () => import("shiki/langs/css.mjs"),
	diff: () => import("shiki/langs/diff.mjs"),
	markdown: () => import("shiki/langs/markdown.mjs"),
};

const ALIASES: Record<string, string> = { py: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", sh: "bash", shell: "bash", zsh: "bash", console: "bash", yml: "yaml", rs: "rust", md: "markdown", rscript: "r" };

/** The language for a code fence or a file name, if Shiki has it here. */
export function languageOf(name: string): string | undefined {
	const key = name.toLowerCase().replace(/^.*\./, "");
	const lang = ALIASES[key] ?? key;
	return lang in LANGS ? lang : undefined;
}

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();

async function get(lang: string): Promise<HighlighterCore> {
	highlighter ??= (async () => {
		const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
			import("shiki/core"),
			import("shiki/engine/javascript"),
			import("shiki/themes/min-light.mjs"),
			import("shiki/themes/min-dark.mjs"),
		]);
		return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
	})();
	const h = await highlighter;
	if (!loaded.has(lang)) {
		const mod = (await LANGS[lang]!()) as { default: Parameters<HighlighterCore["loadLanguage"]>[0] };
		await h.loadLanguage(mod.default);
		loaded.add(lang);
	}
	return h;
}

/** Highlighted HTML for code (Shiki escapes it), with both themes as CSS variables. */
export async function highlight(code: string, lang: string): Promise<string> {
	const h = await get(lang);
	return h.codeToHtml(code, { lang, themes: { light: "min-light", dark: "min-dark" }, defaultColor: false });
}

/**
 * A Svelte action for rendered Markdown: gives every code block a header with its language and a copy button, and
 * highlights it once its language has loaded. Re-runs when the HTML changes.
 */
export function codeBlocks(node: HTMLElement, _changed?: unknown) {
	const enhance = () => {
		for (const pre of node.querySelectorAll<HTMLPreElement>("pre:not([data-enhanced])")) {
			const code = pre.querySelector("code");
			if (!code) continue;
			pre.dataset.enhanced = "1";
			const fence = /language-([\w+-]+)/.exec(code.className)?.[1] ?? "";
			const lang = languageOf(fence);
			const text = code.textContent ?? "";
			const frame = document.createElement("div");
			frame.className = "code";
			const head = document.createElement("div");
			head.className = "code-head";
			const label = document.createElement("span");
			label.textContent = fence || "text";
			const copy = document.createElement("button");
			copy.type = "button";
			copy.textContent = "Copy";
			copy.addEventListener("click", () => {
				void navigator.clipboard.writeText(text).then(() => {
					copy.textContent = "Copied";
					setTimeout(() => (copy.textContent = "Copy"), 1400);
				});
			});
			head.append(label, copy);
			pre.replaceWith(frame);
			frame.append(head, pre);
			if (lang && text.length < 200_000) {
				void highlight(text.replace(/\n$/, ""), lang).then((html) => {
					const holder = document.createElement("div");
					holder.innerHTML = html;
					const shiki = holder.firstElementChild;
					if (shiki && frame.isConnected) pre.replaceWith(shiki);
				});
			}
		}
	};
	enhance();
	return { update: enhance };
}
