// Every dependency EnrichedLab ships, from the lock files: the workspace's bun.lock and the desktop shell's npm lock.
//
//   bun scripts/deps.ts audit   check each one against OSV (osv.dev) for known vulnerabilities; exits 1 on any
//   bun scripts/deps.ts sbom    write a CycloneDX 1.6 SBOM to dist/sbom.cdx.json
//
// The build runs `sbom`; run `audit` before a release and on a schedule. See docs/security.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../packages/engine/src/util.ts";

const root = join(import.meta.dir, "..");

interface Dep {
	name: string;
	version: string;
	from: string;
}

function bunLock(): Dep[] {
	// bun.lock is JSON with trailing commas.
	const text = readFileSync(join(root, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1");
	const lock = JSON.parse(text) as { packages: Record<string, [string, ...unknown[]]> };
	return Object.values(lock.packages)
		.map(([spec]) => /^(@?[^@]+)@(?:npm:)?(\d[^\s]*)$/.exec(spec))
		.filter((m): m is RegExpExecArray => Boolean(m))
		.map((m) => ({ name: m[1]!, version: m[2]!, from: "bun.lock" }));
}

function npmLock(): Dep[] {
	const file = join(root, "apps", "desktop", "package-lock.json");
	if (!existsSync(file)) return [];
	const lock = JSON.parse(readFileSync(file, "utf8")) as { packages: Record<string, { version?: string }> };
	return Object.entries(lock.packages)
		.filter(([path, p]) => path.startsWith("node_modules/") && p.version)
		.map(([path, p]) => ({ name: path.slice(path.lastIndexOf("node_modules/") + 13), version: p.version!, from: "apps/desktop" }));
}

function all(): Dep[] {
	const seen = new Map<string, Dep>();
	for (const dep of [...bunLock(), ...npmLock()]) seen.set(`${dep.name}@${dep.version}`, dep);
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function audit(): Promise<number> {
	const deps = all();
	const found: { dep: Dep; ids: string[] }[] = [];
	for (let i = 0; i < deps.length; i += 500) {
		const batch = deps.slice(i, i + 500);
		const response = await fetch("https://api.osv.dev/v1/querybatch", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ queries: batch.map((d) => ({ package: { name: d.name, ecosystem: "npm" }, version: d.version })) }),
		});
		if (!response.ok) throw new Error(`OSV answered ${response.status}.`);
		const { results } = (await response.json()) as { results: { vulns?: { id: string }[] }[] };
		results.forEach((r, j) => r.vulns?.length && found.push({ dep: batch[j]!, ids: r.vulns.map((v) => v.id) }));
	}
	// Accepted findings (config/audit_accepted.json) pass until their review date; anything else fails the check.
	const accepted = JSON.parse(readFileSync(join(root, "config", "audit_accepted.json"), "utf8")) as Record<string, { packages: string[]; reason: string; review: string }>;
	const today = new Date().toISOString().slice(0, 10);
	let open = 0;
	console.log(`Checked ${deps.length} locked packages against OSV.`);
	for (const f of found) {
		const pending = f.ids.filter((id) => !(accepted[id]?.packages.includes(f.dep.name) && accepted[id]!.review >= today));
		open += pending.length ? 1 : 0;
		const label = pending.length ? `OPEN ${pending.join(", ")}` : `accepted until ${accepted[f.ids[0]!]!.review}: ${accepted[f.ids[0]!]!.reason}`;
		console.log(`  ${f.dep.name}@${f.dep.version} (${f.dep.from}): ${label}`);
	}
	if (!found.length) console.log("No known vulnerabilities.");
	return open ? 1 : 0;
}

function sbom(): void {
	const deps = all();
	const doc = {
		bomFormat: "CycloneDX",
		specVersion: "1.6",
		version: 1,
		metadata: { timestamp: new Date().toISOString(), component: { type: "application", name: "enrichedlab", version: VERSION } },
		components: deps.map((d) => ({ type: "library", name: d.name, version: d.version, purl: `pkg:npm/${d.name.replace(/^@/, "%40")}@${d.version}` })),
	};
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(root, "dist", "sbom.cdx.json"), `${JSON.stringify(doc, null, 2)}\n`);
	console.log(`Wrote dist/sbom.cdx.json: ${deps.length} components.`);
}

const command = process.argv[2];
if (command === "audit") process.exit(await audit());
else if (command === "sbom") sbom();
else {
	console.error("bun scripts/deps.ts audit | sbom");
	process.exit(2);
}
