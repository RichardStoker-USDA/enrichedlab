---
name: lab-desktop
description: Use a lab's desktop sandbox (a Linux or macOS desktop in the lab) well: read its state before clicking, launch and focus apps by name, act by element, and check each step with a screenshot. Use whenever a task needs a desktop app at the lab, such as a PDF form app, a browser on the lab's network, or a program with no command line.
---

# The lab's desktop

The desktop tools are `<lab>_desktop` (one action per call), `<lab>_desktop_open` (open an address or a desktop
`/sandbox` file, optionally `with` an app) and `<lab>_desktop_copy` (a file from the workspace sandbox onto the
desktop). The person may be watching and using the same desktop.

1. **Look before acting.** Take a `screenshot` first; where the lab offers `state`, read it: the windows, the focused
   window and its accessibility tree (roles, names, values, bounds). Act on elements from the tree, using the center
   of their bounds as the coordinate, rather than guessing pixels.
2. **Open things directly.** Use `launch` with an app from the desktop's list, or `<lab>_desktop_open` for an address or
   file, instead of hunting through menus. Use `focus_window` to bring a window forward.
3. **One action, then check.** Each action answers with a picture taken just after it; confirm the action worked
   before the next. Dialogs and menus take a moment to draw: `wait` one second when the picture looks unchanged.
4. **Typing** goes to the focused field: click the field first, then `type`. Use `key` for Return, Tab, Escape and
   chords such as ctrl+s.
5. **No shell on desktops.** Desktops refuse commands by design. Run commands in the lab's workspace sandbox. The
   desktop has its own files: copy one onto it with `<lab>_desktop_copy`, then open the path that returns.
6. **If stuck** (an error dialog repeats, or nothing changes after two tries), stop, describe what the screen shows,
   and ask the person instead of clicking further.
