# Development

How the code is laid out for change, how to check it, and how to release it. Each seam below is an interface with one or more
implementations; adding a capability means adding an implementation, not editing the loop.

## Seams

| To add | Write | Register in |
|---|---|---|
| A model API (Responses API, Gemini, a new local server) | a `ModelAdapter` (`packages/engine/src/models/types.ts`) | `adapterFor` in `models/registry.ts` |
| A kind of lab (a research broker, a university gateway) | a `SiteAdapter` (`packages/engine/src/sites/adapter.ts`) | `SITE_KINDS` in the same file |
| A place tools act | a `Workspace` (`packages/engine/src/tools/workspace.ts`) | `Engine.createSession` |
| A built-in tool | a `Tool` (`packages/engine/src/tools/types.ts`) with its `kind`, and `touches` if it changes files | `BUILT_IN_TOOLS` in `engine.ts` |
| Something a window does for the agent (like the browser pane) | an op handled in the window, called with `ctx.surface.call(capability, op, args)` | the capability in the window's `hello` |
| An app template | files in `packages/engine/src/apps/templates.ts` | `TEMPLATES` there |
| A model service people add with a key | a preset in `packages/engine/src/models/providers.ts` | `PROVIDER_PRESETS` there |
| A surface (editor bridge, native client) | a client of the Lab protocol (`packages/protocol`) | nothing: it connects to the engine |
| A web search provider | a branch in `tools/search.ts` | `SearchConfig.provider` |
| An add-on for people (skills, instructions, MCP servers, hooks, apps) | a bundle folder (`docs/bundles.md`) | `enriched bundle add`, or a site's `bundles()` grant |
| A site that hands out add-ons by role | `bundles()` on its `SiteAdapter` | nothing: `Sites.connect` installs what it returns |

Tools the person adds without code: MCP servers (`mcpServers` in `~/.enriched/config.json`), skills (`~/.enriched/skills/<name>/SKILL.md`
or `.agents/skills` in a project) and hooks (`hooks.beforeTool` / `hooks.afterTool`).

## Rules that keep it changeable

- The session log is the only source of model context. A new feature that affects what the model sees adds an
  event type to `packages/protocol` and a case in `session/context.ts`; it never edits earlier events.
- The protocol is additive: new fields are optional, new methods are new names. Surfaces ignore what they don't know.
- Provider field names stay inside their adapter. Nothing above `models/` knows `reasoning_content` or `cache_control`.
- Permissions are decided in one place (`permissions.ts`). A tool declares what it is (`kind`, `ask`, `host`,
  `touches`); it doesn't prompt on its own.
- Comments say why, not what. If a comment restates the line below it, delete it.

## Checks

```sh
bun test tests                       # unit tests, including captured adapter requests
bunx tsc -p tsconfig.json --noEmit   # types across packages
(cd packages/web && bun run check)   # svelte-check for the window
bun scripts/bench.ts                 # fixed tasks end to end through a real model
bun scripts/deps.ts audit            # known vulnerabilities in every locked package
```

CI runs the tests and type checks on macOS, Linux and Windows for every push (`.github/workflows/test.yml`).

## Benchmarks

`bench/scenarios/*.json` are tasks with checks: a command that must pass, a file that must or mustn't change, words
the answer must contain, an app the agent must open. `bun scripts/bench.ts [--model <ref>] [name ...]` runs each in a
fresh git project through the engine, removes its sessions afterwards, and writes `dist/bench/<time>.json`. Add a
scenario with each feature, and compare runs before a change reaches people.

## Releases

On a Mac with the Developer ID identities in the keychain:

```sh
NOTARY_PROFILE=<notarytool profile> bun scripts/release.ts --publish
```

It builds the six binaries, the universal macOS app and its home-folder package (signed and notarized), the
per-user Windows setup, the Linux AppImages, an SBOM, and `manifest.json` signed with the release key
(`~/.secrets/enriched/release_signing.jwk`; its public half is `config/release_key.json`). `--publish` creates the
GitHub release that `enriched update` and `install.sh` read. `--security` marks a release as a security fix. The
version is `VERSION` in `packages/engine/src/util.ts` and the `version` in each `package.json`; the release notes are
`NEWS` beside it.

## Upgrading dependencies

Versions are pinned exactly in each `package.json`. To move one:

1. Read its release notes since the pinned version.
2. `bun update <name>@<version>` in the package that uses it, then `bun run check` and `bun test tests`.
3. For `@anthropic-ai/sdk`, recheck the beta names in `models/anthropic.ts` against the API reference; for
   `@earendil-works/pi-tui`, run `enriched` in a real terminal; for Electron, open the desktop app and a canvas window;
   for pixi, update the pinned version and hashes in `apps/environments.ts`.
4. Commit the version change alone, so it can be reverted alone.

Early capabilities go behind a seam first (a new adapter, an opt-in config key) and become the default after they
have run for a while.
