// A lab invite: the app link (enrichedlab://join?url=…&name=…&title=…) a lab's /join page opens, or the lab's own
// https address. Only https labs are joined; the name becomes the lab's short name in commands and tool names.

export interface Invite {
	url: string;
	name: string;
	title?: string;
	isolated?: boolean;
}

/** A short lab name from an address: gate.whnrc.example.edu becomes whnrc, gate.enrichedlab.com enrichedlab. */
export function nameFromHost(host: string): string {
	const labels = host.toLowerCase().split(".").filter(Boolean);
	const meaningful = labels.slice(0, -1).filter((label) => !["gate", "lab", "www", "api", "app"].includes(label));
	return slug(meaningful[0] ?? labels[0] ?? "lab");
}

export function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40) || "lab"
	);
}

export function parseInvite(link: string): Invite | undefined {
	try {
		const given = new URL(link.trim());
		if (given.protocol === "enrichedlab:") {
			if (given.hostname !== "join") return undefined;
			const lab = new URL(given.searchParams.get("url") ?? "");
			if (lab.protocol !== "https:") return undefined;
			const title = given.searchParams.get("title")?.slice(0, 60) || undefined;
			const name = given.searchParams.get("name");
			return { url: lab.origin, name: name ? slug(name) : nameFromHost(lab.hostname), title, isolated: given.searchParams.get("isolated") === "1" || undefined };
		}
		if (given.protocol !== "https:") return undefined;
		return { url: given.origin, name: nameFromHost(given.hostname) };
	} catch {
		return undefined;
	}
}
