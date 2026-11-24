# opencode-fusion

A lead + sidekick setup for OpenCode, similar to Devin Fusion, plus subagents you can stop without losing their work.

There are three versions:

| Folder | For | Status |
|---|---|---|
| `package/` | OpenCode 2.x Desktop: agents, model list entries, tools **and the Settings > Fusion page** | Server part tested on 2.2.0 and 2.2.6; settings page render-tested against both versions' UI kits |
| `plugins/opencode-2.x/` | OpenCode 2.x, single file, no settings page or model entries | Tested on 2.2.6 |
| `plugins/opencode-1.x/` | The old 1.x CLI (`npm i -g opencode-ai`) | Tested on 1.19.4 |

The rest of this README covers `package/`. OpenCode 2.x already has background subagents, follow-ups by `sessionID` and completion notices. The plugin adds:

- **Fusion presets.** Each preset pairs a lead model with a sidekick model and becomes its own agent, next to Build and Plan.
- **Model list entries.** Each preset adds "<lead model> (Fusion)" under a Fusion provider that shares the lead provider's login (same integration). The entry calls the real lead model with your existing login and disappears when you disconnect it. Chatting with that entry turns on the fusion lead behaviour for whichever agent is selected.
  - If all your fusion leads use one login, the group is just "Fusion".
  - OpenCode looks up a model's login through its provider, never per model, so leads on different logins need separate groups: "Fusion · Kimi For Coding", "Fusion · Xiaomi Token Plan", and so on. One shared group would mean copying API keys into model settings, which the model list API exposes and which breaks expiring OAuth logins.
  - Saving in Settings > Fusion reloads providers, models and agents, so new entries appear without restarting the app.
- **Settings > Fusion.** Add, edit and delete presets in the Desktop app. Saving writes `~/.config/opencode/fusion.jsonc` and reloads agents and models right away. Comments in that file are not kept when the page saves it.
- **Sidekicks that keep their context**, also after a restart. A sidekick call without `sessionID` goes to a free sidekick of the session (the one briefed last). If all are busy, a new one starts, so the lead can run jobs in parallel; parallel calls in one step each get a different free sidekick. Agent `new-sidekick` always starts a fresh one. A call with the `sessionID` of a sidekick that is still working is refused, with a pointer to `subagent_message`, instead of OpenCode silently pushing it into the running task. When you change a preset's sidekick model, the existing sidekick switches to the new model on its next brief and keeps its context. OpenCode sessions otherwise stay on the model they were created with.
- **`subagent_status` / `subagent_cancel`**, plus **`/agents`** and **`/agents-stop`**: progress, and stopping with partial results.
- **`subagent_message`**: the lead (or any primary agent) sends a running background subagent a message without waiting, and picks when it is read:
  - `now`: interrupts the step it is on and reads the message right away. Finished tool calls and edits are kept. OpenCode tells the lead the subagent was "cancelled" (that is the interrupted step); the plugin then sends the lead the subagent's report once it has handled the message.
  - `next_step` (default): read after the step it is on finishes.
  - `after_turn`: read after it finishes its whole task, as a new turn.
  - Without `sessionID` it goes to the running sidekick; if several are running, it asks which one. It only works on running subagents; a finished one gets new work through `subagent` with its `sessionID`. A lead waiting on a foreground subagent can't send anything until it returns.
- **Delegation level** per preset, in Settings > Fusion or as `delegation` in `fusion.jsonc`. It picks the lead prompt:
  - `light`: the lead investigates, designs and implements itself, and hands off only bulk mechanical edits, long checks and broad searches.
  - `balanced` (default): the sidekick does the legwork, the lead does the thinking. The sidekick finds things (definitions, usages, affected files), makes edits once the design is fixed (pattern-following changes, wiring, boilerplate, tests) and runs builds and tests. The lead makes the design calls, writes the core logic and reads the few files that shape its design. Before each handoff the lead asks itself whether the sidekick would have to make a design decision. Large tasks are split into reviewed steps, one per brief, and the lead does the step that sets the shape itself.
  - `heavy`: the previous behaviour. Implementation, exploration and verification go to the sidekick by default, still one reviewed step per brief.
  - In every level the sidekick stops and asks when a brief leaves a design decision open, instead of guessing.
- **The sidekick replaces `explore` and `general`** for fusion agents. OpenCode leaves hidden agents out of the subagent list it shows the model, so the lead never saw its sidekick there and reached for the built-in ones instead, which start empty every time. The plugin now adds the sidekick to that list, and any `explore` or `general` call from a fusion lead is sent to the sidekick instead (on the sidekick model, in its persistent session). This also covers Build with a "(Fusion)" model. Your own subagents stay available for parallel jobs.
- **Direct-edit reminder** when a fusion lead edits a file itself. On by default only with `heavy`; `nudge_direct_edits` turns it on or off for any level.

## Settings › Agents

A second settings page changes any other agent: Build, Plan, Explore, General, your own agents from `agents/*.md` or `opencode.jsonc`, and the system agents (Title, Summary, Compaction). Fusion agents stay on the Fusion page.

- **Applies to:** *All projects*, or one project. The current session's project is listed first. Project settings override the all-projects settings, which override the agent's own definition.
- Per agent:
  - **Model**, plus **Variant** when the model has variants. *Inherit* shows the model it would otherwise get.
  - **Enabled:** off removes the agent.
  - **Max steps.**
  - **Description:** the lead uses it to decide when to call a subagent.
  - **Extra instructions:** added to the agent's prompt on every request, so the built-in prompt stays intact.
  - Each field says where its value comes from. **Reset** removes what the current scope sets for that agent.
- **Save** applies the changes right away. Other open projects pick up an all-projects change within about a second, because every project's plugin instance watches the shared files. Fusion's `fusion.jsonc` is watched the same way.
- **Files:**
  - All projects: `~/.config/opencode/agent-overrides.jsonc`.
  - One project: `<project>/.opencode/agent-overrides.jsonc`, which you can commit for a team that also uses the plugin.
  - See `agent-overrides.example.jsonc` for the format. A file is removed when nothing in it is set.
- **Unknown models:** if an override names a model that isn't in the model list, it is skipped with a warning on the page, and the agent keeps its own model. Otherwise OpenCode would silently fall back to the default model.

## Install (OpenCode 2.x Desktop)

1. Build: `cd package && npm install && npx vite build`.
2. Copy `package.json`, `src/` and `dist/` to `~/.config/opencode/fusion-plugin/`.
3. Add `"plugins": ["./fusion-plugin"]` to `~/.config/opencode/opencode.jsonc`. The Desktop app only loads settings pages of plugins listed there.
4. Optional: copy `fusion.example.jsonc` to `~/.config/opencode/fusion.jsonc`, or create presets in Settings > Fusion.
5. Quit and reopen OpenCode Desktop.

## Choosing a fusion agent

Either way works:

- **Model list:** pick "<lead model> (Fusion)" from the "Fusion · …" provider, with any agent. The Desktop picker shows it by default; if you hid it, turn it back on under "Manage models".
- **Agent picker:** pick the preset's agent. In the Desktop app, first turn on Settings > General > "Show agent" ("Agent anzeigen"). The agent uses its "(Fusion)" model entry, so the model picker keeps showing that name.

The sidekick is hidden from both pickers.

## Defining fusion agents

```jsonc
{
  "presets": {
    "fusion-kimi": { "lead": "opencode-go/kimi-k3-1-pro", "sidekick": "xiaomi-token-plan-ams/mimo-v2.6-pro" },
    "fusion-opus": { "lead": "anthropic/claude-opus-5-5", "sidekick": "xiaomi-token-plan-ams/mimo-v2.6-pro" }
  }
}
```

For each preset `X`, the plugin creates:

- `X`: a primary agent on the lead model, with the lead prompt.
- `X-sidekick`: a hidden subagent on the sidekick model, with the sidekick prompt. It can't start subagents, and no agent except `X` may start it.

Optional settings per preset: `description`, `color`, `delegation`, `lead_options`, `sidekick_options`, `lead_prompt_append`, `sidekick_prompt_append`, `lead_prompt` / `lead_prompt_file`, `sidekick_prompt` / `sidekick_prompt_file`, `lead_steps`, `sidekick_steps`, `nudge_direct_edits`. See `fusion.example.jsonc`.

## Stopping agents as the user

- **Esc** while the lead waits on a subagent stops both. The subagent's context is kept. Afterwards, ask "what did it get done?" and the lead calls `subagent_status`.
- **`/agents-stop`** stops every running subagent of the session and posts what each one did.
- **`/agents`** posts the status of every subagent of the session.

## Limits

- The prompts follow Fusion's published approach but are not tuned for a specific model pair. How well the lead briefs and reviews depends on the lead model.
- `/agents` and `/agents-stop` are registered, but I couldn't run them headlessly. Try them once in the app.
- A lead whose provider is defined only in your `opencode.jsonc` (not a built-in provider) gets no model list entry, because such providers don't exist yet when plugins run. The settings page lists a warning, and the preset's agent uses the lead model directly. Extra models you add to a built-in provider in `opencode.jsonc` do work.
- The follow-up report after a `now` message is sent by the plugin while the server runs. If the server restarts before the subagent finishes, that report is lost; `subagent_status` still shows what it did.
- OpenCode Desktop 2.2.0 gives plugins no `Select` and no settings components (added in 2.2.6). There the settings page uses its own simple stand-ins, styled with the app's theme colours; on 2.2.6 it uses the app's components.
- The Kimi model ID in the example is from a third-party listing. Check it with `opencode models`.

## Development

```bash
npm install
npx tsc -p .
```

In `package/`, `npx tsx test/live-reload.ts <server url> <directory> <provider/model>` adds a preset through the settings RPC on a running `opencode serve`, checks the reload events and Fusion group names, and restores the config. `test/message-delivery.ts` with `test/mock-llm.cjs` (a scripted fake model server, no real model) checks where each `subagent_message` delivery mode lands in the sidekick's conversation and what the lead is told; both files describe the config they need. `node test/gui-render.cjs` renders the built settings page in jsdom with the 2.2.0 and 2.2.6 UI kits, then edits, adds and saves a preset through a fake RPC.

`test/harness.ts` drives the 1.x plugin's tools against a running 1.x `opencode serve`. The 2.x plugin was tested with `opencode run --standalone` against an isolated config and data folder, using a local Ollama model.

## License

MIT, see [LICENSE](LICENSE).
