// Environments for apps that need R, Python or other tools. An app that ships a pixi.toml (and, once installed, a
// pixi.lock) gets exactly that environment, built per user from conda-forge into the app's .pixi folder: no
// administrator, the same on macOS, Linux and Windows, and the same lock a lab sandbox builds its image from.
// pixi comes from PATH, or is downloaded once into ~/.enriched/tools and checked against the hashes below.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PIXI_VERSION = "0.82.0";

/** Release file and SHA-256 for each platform, from github.com/prefix-dev/pixi/releases/tag/v0.82.0. */
const PIXI_BUILDS: Record<string, [string, string]> = {
	"darwin-arm64": ["pixi-aarch64-apple-darwin", "92aa551c67a56ec0ba105fa20c3f48094b02586de523e24b96974ba1f092455b"],
	"darwin-x64": ["pixi-x86_64-apple-darwin", "db4bd6dc3a5f88f2d94cf2e1f8a377b53d3aaac95b45b058854fbf53919d6d36"],
	"linux-arm64": ["pixi-aarch64-unknown-linux-musl", "c6e3c4d98bb41560b5cfdebbe6cbf766f3547603a0fb96e1450a6ccff74b5e14"],
	"linux-x64": ["pixi-x86_64-unknown-linux-musl", "1dff1db704884f078c44b4c7fb3c5bc6f946fc3d1fa679edf214ad79187a9c64"],
	"win32-arm64": ["pixi-aarch64-pc-windows-msvc.exe", "d205d144618bdc83e25dba1a10c8cff8f39e9da85c06e142a9ec0d0c8f6d3559"],
	"win32-x64": ["pixi-x86_64-pc-windows-msvc.exe", "89c7455923dac401c1853310894d87fa06602911b838e389a46c7bc8df00171e"],
};

/** The pixi program: on PATH, else the pinned build under `tools`, downloaded and checked the first time. */
export async function pixi(tools: string, log: (line: string) => void = () => undefined): Promise<string> {
	const found = Bun.which("pixi");
	if (found) return found;
	const build = PIXI_BUILDS[`${process.platform}-${process.arch}`];
	if (!build) throw new Error(`No pixi build for ${process.platform} ${process.arch}.`);
	const file = join(tools, `pixi-${PIXI_VERSION}${process.platform === "win32" ? ".exe" : ""}`);
	if (existsSync(file)) return file;
	mkdirSync(tools, { recursive: true });
	log(`Getting pixi ${PIXI_VERSION}, which builds app environments without administrator rights`);
	const response = await fetch(`https://github.com/prefix-dev/pixi/releases/download/v${PIXI_VERSION}/${build[0]}`, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error(`Downloading pixi failed (${response.status}).`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== build[1]) throw new Error("The pixi download doesn't match its pinned SHA-256; nothing was kept.");
	await Bun.write(`${file}.part`, bytes);
	chmodSync(`${file}.part`, 0o755);
	renameSync(`${file}.part`, file);
	return file;
}

/** True when the app folder declares an environment. */
export const hasEnvironment = (dir: string): boolean => existsSync(join(dir, "pixi.toml"));

/**
 * Build (or check) the app's environment and return the command wrapped to run inside it. Installing reaches
 * conda-forge, so it runs before the contained launch; the app itself then runs offline in its sandbox.
 */
export async function inEnvironment(dir: string, command: string[], tools: string, log: (line: string) => void): Promise<string[]> {
	const program = await pixi(tools, log);
	const manifest = join(dir, "pixi.toml");
	log(existsSync(join(dir, "pixi.lock")) ? "Checking the app's environment" : "Building the app's environment (first run takes a few minutes)");
	// From a scratch folder: some packages' install scripts write test files where they run, and the app's folder
	// is watched for edits.
	const install = Bun.spawn([program, "install", "--manifest-path", manifest], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe", env: { ...process.env, PIXI_NO_PATH_UPDATE: "1" } });
	const lines = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream) for (const line of new TextDecoder().decode(chunk).split(/\r|\n/)) if (line.trim()) log(line.trim());
	};
	await Promise.all([lines(install.stdout), lines(install.stderr), install.exited]);
	if (install.exitCode !== 0) throw new Error(`Building the app's environment failed; the app's log has pixi's output.`);
	return [program, "run", "--manifest-path", manifest, "--frozen", "--", ...command];
}

/** The packages an environment lists, for the consent card ("installs r-shiny, r-ggplot2 from conda-forge"). */
export function environmentSummary(dir: string): string | undefined {
	if (!hasEnvironment(dir)) return undefined;
	const text = readFileSync(join(dir, "pixi.toml"), "utf8");
	const deps = /\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(text)?.[1] ?? "";
	const names = [...deps.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]);
	return names.length ? names.join(", ") : undefined;
}
