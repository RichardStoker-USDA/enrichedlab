# EnrichedLab

An AI workbench for research. You ask for something in plain words; an agent works on it with your files, a browser,
R and Python, and the models, tools and sandboxes of the lab you belong to. Results appear beside the conversation as
tables, plots, pages, and apps you can keep using.

It runs on macOS, Windows 11 and Linux, installs without administrator rights, and works the same from its window or
from a terminal.

## Install

Download the file for your computer from the [latest release](https://github.com/RichardStoker-USDA/enrichedlab/releases/latest)
and open it:

| Computer | File |
| --- | --- |
| Mac (Apple silicon or Intel) | `EnrichedLab-mac.pkg` (installs into your home folder) |
| Windows 11 | `EnrichedLab-Setup-x64.exe` (installs for you only) |
| Linux | `EnrichedLab-linux-x64.AppImage` or `-arm64` |

Terminal only, on macOS or Linux:

```sh
curl -fsSL https://github.com/RichardStoker-USDA/enrichedlab/releases/latest/download/install.sh | sh
```

Updates are signed and install themselves the same way: the app offers them, `enriched update` applies them.

## First run

- **Your lab sends an invite link.** Open it; EnrichedLab adds the lab and opens the lab's sign-in page. Its models,
  tools and sandbox appear once you're signed in.
- **Your own account.** Add an OpenAI, Anthropic, Google Gemini or OpenRouter key under *Add a service* in the model
  menu. Keys go to your computer's credential store.
- **On this computer.** Models running in Ollama or LM Studio appear on their own.

## What it does

- **Conversation and workbench.** Files, a terminal, tables, GPU-drawn plots and a browser open in panes beside the
  session.
- **Apps on request.** Ask for "an app to compare yield by treatment" and the agent builds one that runs in a pane.
  Apps can be web pages, R or Python Shiny apps, or containers, and you can share them as signed files
  ([docs/apps.md](docs/apps.md)).
- **The web and PDFs.** The agent can open pages in the built-in browser, where your sign-ins persist, and it can
  fill PDF forms.
- **Where work runs.** Each session works on this computer or in a lab sandbox, and can move between them, taking
  its git repository along. A lab that keeps its data inside pins its sessions there.
- **Contained by default.** On macOS and Linux the agent's commands can write only to the project, can't read your
  credentials, and have no network unless you allow it. On Windows they can write only to the project and ask
  before they run ([docs/security.md](docs/security.md)).

## Terminal

```sh
enriched                       # a session in this folder; the window opens when the agent shows something
enriched app                   # open the window
enriched run "task"            # one task, no interface; --allow lets it edit and run commands
enriched login <lab>           # sign in to a lab you've added
enriched service add gemini    # use your own key for a model service
enriched doctor                # check the setup
```

`enriched help` lists the rest.

## For labs and developers

- [docs/labs.md](docs/labs.md): serving models, MCP tools, sandboxes and apps to groups of people, with
  per-person access.
- [docs/architecture.md](docs/architecture.md): how the engine, the window and the terminal fit together.
- [docs/development.md](docs/development.md): building, testing, benchmarks and releases.

Build from source with [Bun](https://bun.com) 1.4: `bun install && bun scripts/build.ts`.

## License

[CC0 1.0](LICENSE): public domain. No permission needed to use, change or share it.
