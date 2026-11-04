// Places: where a session's files and commands act. This computer, or a lab's sandbox. Each place has a name people
// read and a marker color (docs/design.md, Places); the color never stands alone.

import type { SiteSummary } from "@enrichedlab/protocol";

export interface Place {
	id: string;
	/** "This Mac", or the lab's name. */
	title: string;
	/** Where work runs there, in a few words. */
	detail: string;
	/** CSS custom property holding the marker color. */
	color: string;
	/** Can sessions work there now? */
	ready: boolean;
	site?: SiteSummary;
}

const platform = typeof navigator === "undefined" ? "" : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform);

/** Shortcut labels use ⌘ on a Mac and Ctrl elsewhere. */
export const mac = /mac/i.test(platform);

/** What a lab sandbox is, said once for every surface that offers one. */
export const SANDBOX_NOTE = "Linux, no network; your git repository comes along";

export function computerName(): string {
	if (mac) return "This Mac";
	if (/win/i.test(platform)) return "This PC";
	return "This computer";
}

/** Marker colors in the order labs are listed; the first lab is EnrichedLab blue (gold in dark), then Redwood. */
const LAB_COLORS = ["--place-1", "--place-2", "--place-3", "--place-4"];

export function places(sites: SiteSummary[]): Place[] {
	const local: Place = { id: "local", title: computerName(), detail: "contained", color: "--place-local", ready: true };
	const labs = sites.map((site, i) => ({
		id: site.name,
		title: site.title || site.name,
		detail: site.signedIn ? (site.sandbox ? `sandbox · ${site.who ?? "signed in"}` : `${site.who ?? "signed in"} · no sandbox`) : site.error ? "can't connect" : "sign in",
		color: LAB_COLORS[i % LAB_COLORS.length]!,
		ready: site.signedIn && site.sandbox,
		site,
	}));
	return [local, ...labs];
}

export function placeOf(list: Place[], id: string | undefined): Place {
	return list.find((p) => p.id === (id ?? "local")) ?? list[0]!;
}

/** "Runs on This Mac", "Runs in the <lab> sandbox". */
export function runsOn(place: Place): string {
	return place.id === "local" ? `Runs on ${place.title}` : `Runs in the ${place.title} sandbox`;
}
