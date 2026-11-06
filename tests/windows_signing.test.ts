// The Windows signer drives jsign with Azure Artifact Signing; stand-in az and jsign record what they were given.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe.skipIf(process.platform === "win32")("Windows signing", () => {
	test("signs through jsign with the token in its environment only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "winsign-"));
		const saved = { ...process.env };
		try {
			writeFileSync(join(dir, "az"), "#!/bin/sh\necho stand-in-token\n");
			writeFileSync(join(dir, "jsign"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\nprintf '%s' "$EL_WINDOWS_SIGNING_TOKEN" > "${dir}/token"\n`);
			chmodSync(join(dir, "az"), 0o755);
			chmodSync(join(dir, "jsign"), 0o755);
			Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, EL_WINDOWS_SIGNING_ENDPOINT: "https://wus2.codesigning.azure.net/", EL_WINDOWS_SIGNING_ACCOUNT: "acct", EL_WINDOWS_SIGNING_PROFILE: "prof" });
			const signing = (await import("../scripts/windows_signing.cjs")).default;
			expect(signing.enabled()).toBe(true);
			await signing({ path: "/tmp/EnrichedLab.exe" });
			const args = readFileSync(join(dir, "args"), "utf8").trim().split("\n");
			expect(args).toContain("TRUSTEDSIGNING");
			expect(args[args.indexOf("--keystore") + 1]).toBe("wus2.codesigning.azure.net");
			expect(args[args.indexOf("--alias") + 1]).toBe("acct/prof");
			expect(args[args.indexOf("--storepass") + 1]).toBe("env:EL_WINDOWS_SIGNING_TOKEN");
			expect(args[args.indexOf("--tsmode") + 1]).toBe("RFC3161");
			expect(args.at(-1)).toBe("/tmp/EnrichedLab.exe");
			expect(args.join(" ")).not.toContain("stand-in-token");
			expect(readFileSync(join(dir, "token"), "utf8")).toBe("stand-in-token");
		} finally {
			process.env = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
