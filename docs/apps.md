# Apps

An app is a web page that runs in a workbench pane beside the conversation, with tools behind it. The agent builds one
from a sentence ("make an app to compare yield by treatment"), the person uses it, and both keep changing it while it
runs: the pane reloads as files change, and errors the page hits reach the agent's next turn.

Apps speak the MCP Apps protocol (`io.modelcontextprotocol/ui`, specification 2026-01-26): the page is an MCP Apps
view, the workbench is its host, and the app's backend is an MCP server. So an app built here is an MCP App, and a view
any MCP server returns opens here too.

## Making one

- The agent: `app_create` scaffolds `apps/<name>/` in the project from a template (data, blank, shiny); it edits the
  files with its normal tools and calls `app_open`.
- The person: `enriched app new <name> [--template data|blank|shiny|shiny-python]`, then open it from the
  workbench's Apps menu or ⌘K.

## R, Python and other tools

An app that needs R, Python or anything else from conda-forge ships a `pixi.toml` listing its packages (the Shiny
templates do). The first time it opens, EnrichedLab builds that environment in the app's `.pixi` folder with pixi,
which it downloads once and checks against pinned hashes when it isn't installed. No administrator, the same on
macOS, Windows and Linux, and `pixi.lock` records exactly what was installed, so a lab can build the same
environment into a sandbox image. The consent card lists the packages. `command` and `serve` backends then run
inside that environment, contained; `$PORT` in a served app's command is its port.

## app.json

```json
{
  "name": "yield-explorer",
  "title": "Yield explorer",
  "version": "0.1.0",
  "entry": "index.html",
  "backend": { "runtime": "bun", "main": "backend.js" },
  "permissions": { "files": "read", "models": true, "labs": ["enrichedlab"], "network": ["https://api.example.org"] }
}
```

| Backend | What runs | Contained by |
| --- | --- | --- |
| `bun` | a module exporting `tools`, on the Bun runtime inside `enriched` (`BUN_BE_BUN=1`); nothing to install | OS sandbox: writes only to the app's data folder, no network unless `permissions.network` |
| `command` | any MCP server on stdio the person has (`uv run server.py`, `Rscript srv.R`) | the same |
| `container` | an MCP server on stdio in an image, built from the folder when `build` is set (Docker, Podman or nerdctl) | the container: `--network none` unless allowed, app folder read-only |
| `serve` | a web app on `$PORT` (R or Python Shiny, Streamlit, a dev server); the page is its address | OS sandbox with loopback only |

## What a page can call

Pages import `/app-sdk/lab.js` (EnrichedLab's helpers on the official MCP Apps `App` class, also served raw at
`/app-sdk/app.js`):

```js
import { connect, scatter } from "/app-sdk/lab.js";
const lab = await connect({ name: "yield-explorer", version: "0.1.0" });
const table = await lab.table("plots.csv");          // CSV, TSV, JSON, JSON Lines, Parquet
await scatter(element, { x, y, color, xLabel, yLabel }); // WebGPU, Canvas 2D fallback
await lab.call("summarize", { values });              // the app's backend tools
```

Host tools, each behind a permission: `lab_read_file`, `lab_list_files`, `lab_write_file` (files), `lab_run`
(commands, where the session works), `lab_ask` (models), `lab_cluster_run` (labs: a command in that lab's sandbox),
and always `lab_store_get/set` and `lab_session`. `lab.share(text)` tells the model what the app shows
(`ui/update-model-context`); `lab.say(text)` speaks in the session (`ui/message`).

## Safety

- A page gets an opaque origin from its CSP (`sandbox allow-scripts`): no access to the workbench, its storage or the
  engine. It reaches the host only through the bridge, and the network only at origins it declared.
- An app that asks for permissions, or runs a program of its own, shows the person what it asks before anything loads.
  The grant covers exactly that list; asking for more asks again.
- In a session bound to a lab that keeps data inside, pages get no network or links, and other labs are refused.
- An MCP server's view may call only its own server's tools marked for apps; app-only tools never reach the model.

## Sharing

`enriched app pack <folder>` writes `<name>-<version>.labapp`: the files, each file's SHA-256, and an Ed25519
signature with the person's key (made on first pack, `~/.enriched/keys`). `enriched app add <file>` checks every hash
and the signature and refuses a signer the person hasn't trusted unless given `--trust`. Bundles can carry apps in
`apps/<name>/`, so a lab grants apps to people by role the way it grants skills.

## Not yet

- App backends that run in a lab sandbox, and building images there, need the lab's attach and port endpoints
  (docs/labs.md). Today a page reaches a lab with `lab_cluster_run`.
