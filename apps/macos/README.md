# EnrichedLab for macOS

The native window: SwiftUI on macOS 26 and later, universal (Apple silicon and Intel). It is a client of the same
engine every EnrichedLab window uses (`docs/architecture.md`), so sessions, labs, models and tools behave the same here
as in the terminal and on Windows.

| Target | Owns |
| --- | --- |
| `EnrichedLabKit` | The Lab protocol in Swift, the connection to the engine, finding and starting the engine, and the run sheet's pure logic |
| `EnrichedLabUI` | The window: sidebar, run sheet, composer, workbench panes, Settings, menu commands |
| `EnrichedLab` | The app's entry point |

```sh
swift build                 # debug build: .build/debug/EnrichedLab
swift test                  # protocol shapes, run sheet logic, and a real engine from source in a scratch home
bun ../../scripts/dev_lab.ts --mac --shots /tmp/shots   # every scene, light and dark, against a stand-in lab
bun ../../scripts/build_mac_app.ts --adhoc              # dist/mac/EnrichedLab.app for a local check
```

Development runs need an engine: set `EL_ENGINE_COMMAND="bun <repo>/packages/cli/src/main.ts"` and a scratch
`EL_HOME` (with `EL_KEYSTORE=file`), or let `dev_lab.ts --mac` do it. The app finds a running engine through
`$EL_HOME/run/engine.json` and starts one with `el engine ensure` when there is none.
