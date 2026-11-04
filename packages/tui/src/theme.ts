// Terminal colors for the UC Davis theme. Light terminals get Aggie Blue identity and blue-tinted grays; dark
// terminals follow BFI Index: neutral grays and Aggie Gold as the one live accent. Gold never marks small text on a
// light background. Status is carried by a shape and a word, never by color alone.

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

export type Appearance = "light" | "dark";

const rgb = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
const fg = (hex: string) => {
	const [r, g, b] = rgb(hex);
	return (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
};
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const italic = (text: string) => `\x1b[3m${text}\x1b[23m`;
const underline = (text: string) => `\x1b[4m${text}\x1b[24m`;
const strike = (text: string) => `\x1b[9m${text}\x1b[29m`;

export interface Theme {
	appearance: Appearance;
	prompt: (t: string) => string;
	promptMark: (t: string) => string;
	text: (t: string) => string;
	muted: (t: string) => string;
	faint: (t: string) => string;
	rule: (t: string) => string;
	accent: (t: string) => string;
	live: (t: string) => string;
	ok: (t: string) => string;
	bad: (t: string) => string;
	added: (t: string) => string;
	removed: (t: string) => string;
	verb: (t: string) => string;
	code: (t: string) => string;
	bold: (t: string) => string;
	italic: (t: string) => string;
	markdown: MarkdownTheme;
	editor: EditorTheme;
	select: SelectListTheme;
}

export function theme(appearance: Appearance): Theme {
	const dark = appearance === "dark";
	const c = dark
		? { prompt: "#FFFFFF", text: "#F2F2F2", muted: "#A3A3A3", faint: "#6B6B6B", rule: "#4C4C4C", accent: "#FFBF00", ok: "#7FC8A0", bad: "#FF8A80", added: "#8FD3A6", removed: "#FF9C93", code: "#FFD966", link: "#FFCC33" }
		: { prompt: "#022851", text: "#0B1A2E", muted: "#4F7094", faint: "#8198B2", rule: "#CDD6E0", accent: "#022851", ok: "#1E6B43", bad: "#B3261E", added: "#1E6B43", removed: "#B3261E", code: "#1D4776", link: "#1D4776" };
	const accent = fg(c.accent);
	const muted = fg(c.muted);
	const select: SelectListTheme = {
		selectedPrefix: (t) => accent(t),
		selectedText: (t) => bold(fg(c.prompt)(t)),
		description: (t) => muted(t),
		scrollInfo: (t) => fg(c.faint)(t),
		noMatch: (t) => muted(t),
	};
	return {
		appearance,
		prompt: (t) => bold(fg(c.prompt)(t)),
		promptMark: accent,
		text: fg(c.text),
		muted,
		faint: fg(c.faint),
		rule: fg(c.rule),
		accent,
		live: accent,
		ok: fg(c.ok),
		bad: fg(c.bad),
		added: fg(c.added),
		removed: fg(c.removed),
		verb: (t) => muted(t),
		code: fg(c.code),
		bold,
		italic,
		markdown: {
			heading: (t) => bold(fg(c.prompt)(t)),
			link: (t) => underline(fg(c.link)(t)),
			linkUrl: (t) => fg(c.faint)(t),
			code: fg(c.code),
			codeBlock: (t) => fg(c.text)(t),
			codeBlockBorder: (t) => fg(c.rule)(t),
			quote: (t) => italic(muted(t)),
			quoteBorder: (t) => fg(c.rule)(t),
			hr: (t) => fg(c.rule)(t),
			listBullet: (t) => muted(t),
			bold,
			italic,
			strikethrough: strike,
			underline,
		},
		editor: { borderColor: (t) => fg(c.rule)(t), selectList: select },
		select,
	};
}

export { dim };
