// Where a model runs, in words people can act on: private (this computer, their network, a lab's own servers) or a
// cloud service. The engine decides it (ModelWhere); this only words it.

import type { ModelInfo, ModelWhere } from "@enrichedlab/protocol";
import { computerName } from "./places.ts";

export const isPrivate = (where: ModelWhere): boolean => where.kind !== "cloud";

/** The place in a few words: "EnrichedLab", "This Mac", "gpu-box.lan", "ChatGPT". */
export function whereName(where: ModelWhere): string {
	return where.kind === "device" ? computerName() : where.name;
}

/** Where what the person sends goes, in a sentence; `alone` starts it with "Private:" or "Cloud:" (a tooltip). */
export function whereNote(where: ModelWhere, alone = true): string {
	const sentence = {
		device: "Runs on this computer, and what you send stays on it.",
		network: `Runs on ${where.name}, on your network, and what you send stays there.`,
		lab: `Runs on ${where.name}'s own servers, and what you send stays in the lab.`,
		cloud: `What you send goes to ${where.name}. Whether it's kept or used for training depends on that service's terms and your account settings.`,
	}[where.kind];
	return alone ? `${isPrivate(where) ? "Private" : "Cloud"}: ${sentence[0]!.toLowerCase()}${sentence.slice(1)}` : sentence;
}

/** Models grouped by where they run, private places first: the model menus' sections. */
export function byWhere<M extends Pick<ModelInfo, "where">>(models: M[]): { where: ModelWhere; label: string; models: M[] }[] {
	const order = { lab: 0, device: 1, network: 2, cloud: 3 } as const;
	const groups = new Map<string, { where: ModelWhere; label: string; models: M[] }>();
	for (const m of models) {
		const key = `${m.where.kind}:${m.where.name}`;
		const group = groups.get(key) ?? { where: m.where, label: `${isPrivate(m.where) ? "Private" : "Cloud"} · ${whereName(m.where)}`, models: [] };
		group.models.push(m);
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => order[a.where.kind] - order[b.where.kind]);
}
