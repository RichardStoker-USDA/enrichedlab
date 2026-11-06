// Sign Windows executables with Azure Artifact Signing from this Mac, through jsign (https://ebourg.github.io/jsign/).
// Off unless all three are set:
//   EL_WINDOWS_SIGNING_ENDPOINT  the account's region endpoint, such as wus2.codesigning.azure.net
//   EL_WINDOWS_SIGNING_ACCOUNT   the Artifact Signing account name
//   EL_WINDOWS_SIGNING_PROFILE   its certificate profile
// The Azure CLI supplies an access token for the signed-in identity (`az login`; it needs the "Artifact Signing
// Certificate Profile Signer" role). The token reaches jsign through its environment, never its command line, and is
// never printed. Certificates last three days, so every signature carries an RFC 3161 timestamp.
//
// electron-builder calls this module for each executable it makes (the app, the installer, the uninstaller); the
// release script calls `signFile` for the standalone `el` binaries.

const { execFileSync } = require("node:child_process");

const RESOURCE = "https://codesigning.azure.net";
const TIMESTAMP = "http://timestamp.acs.microsoft.com";

function settings() {
	const endpoint = process.env.EL_WINDOWS_SIGNING_ENDPOINT;
	const account = process.env.EL_WINDOWS_SIGNING_ACCOUNT;
	const profile = process.env.EL_WINDOWS_SIGNING_PROFILE;
	if (!endpoint && !account && !profile) return undefined;
	if (!endpoint || !account || !profile) throw new Error("Windows signing needs EL_WINDOWS_SIGNING_ENDPOINT, EL_WINDOWS_SIGNING_ACCOUNT and EL_WINDOWS_SIGNING_PROFILE together.");
	return { endpoint: endpoint.replace(/^https?:\/\//, "").replace(/\/$/, ""), account, profile, jsign: process.env.JSIGN ?? "jsign" };
}

let token;
/** An access token, reused for ten minutes (Azure's last about an hour). */
function accessToken() {
	if (token && Date.now() - token.at < 10 * 60_000) return token.value;
	let value;
	try {
		value = execFileSync("az", ["account", "get-access-token", "--resource", RESOURCE, "--query", "accessToken", "--output", "tsv"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch {
		throw new Error("Couldn't get an Azure access token for signing: run `az login` with an identity that has the Certificate Profile Signer role on the signing account.");
	}
	if (!value) throw new Error("The Azure CLI returned no access token for signing.");
	token = { value, at: Date.now() };
	return value;
}

/** Whether Windows signing is set up for this release. */
function enabled() {
	return Boolean(settings());
}

/** Sign one file in place. */
function signFile(path) {
	const s = settings();
	if (!s) throw new Error("Windows signing isn't set up.");
	const args = [
		"--storetype", "TRUSTEDSIGNING",
		"--keystore", s.endpoint,
		"--storepass", "env:EL_WINDOWS_SIGNING_TOKEN",
		"--alias", `${s.account}/${s.profile}`,
		"--alg", "SHA-256",
		"--tsaurl", TIMESTAMP,
		"--tsmode", "RFC3161",
		"--name", "EnrichedLab",
		"--url", "https://github.com/RichardStoker-USDA/enrichedlab-harness",
		path,
	];
	try {
		execFileSync(s.jsign, args, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, EL_WINDOWS_SIGNING_TOKEN: accessToken() } });
	} catch (error) {
		if (error && error.code === "ENOENT") throw new Error("jsign isn't installed: `brew install jsign` (it brings a Java runtime), or set JSIGN to its path.");
		throw new Error(`jsign couldn't sign ${path}.`);
	}
}

/** electron-builder's custom signer: called with each executable's path. */
async function sign(configuration) {
	signFile(configuration.path);
}

module.exports = sign;
module.exports.default = sign;
module.exports.signFile = signFile;
module.exports.enabled = enabled;
