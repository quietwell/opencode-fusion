// Renders the settings page from dist/gui-experimental.cjs into jsdom with the browser build of Solid, once with the
// UI kit OpenCode Desktop 2.2.0 gives plugins (no Select, no Settings* components) and once with the 2.2.6 kit.
// Then edits a preset, adds one and saves through a fake RPC. Usage: node test/gui-render.cjs
const Module = require("module")
const path = require("path")
const { JSDOM } = require("jsdom")

const dom = new JSDOM("<!doctype html><html><body></body></html>")
for (const k of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "SVGElement", "Text", "DocumentFragment", "MutationObserver"])
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? dom.window, configurable: true, writable: true })
globalThis.window = dom.window

const solidDir = path.dirname(require.resolve("solid-js/package.json"))
const browser = {
  "solid-js": path.join(solidDir, "dist/solid.cjs"),
  "solid-js/web": path.join(solidDir, "web/dist/web.cjs"),
  "solid-js/store": path.join(solidDir, "store/dist/store.cjs"),
}
const host = { Plugin: { define: (d) => d }, SettingsPage: { kind: "SettingsPage" } }
const load = Module._load
Module._load = function (req, parent, isMain) {
  if (req === "@opencode/plugin/gui") return host
  if (req in browser) return load.call(this, browser[req], parent, isMain)
  return load.apply(this, arguments)
}
const web = require("solid-js/web")
const { createRenderEffect } = require("solid-js")

const el = (tag, ui, p, setup) => {
  const n = document.createElement(tag)
  n.dataset.ui = ui
  setup?.(n)
  if (p && "children" in p) web.insert(n, () => p.children)
  return n
}
const kit220 = {
  Icon: (p) => el("i", "Icon"),
  Button: (p) => el("button", "Button", p, (n) => {
    n.onclick = (e) => p.onClick?.(e)
    createRenderEffect(() => (n.disabled = !!(p.disabled || p.busy)))
  }),
  IconButton: (p) => el("button", "IconButton"),
  Tooltip: (p) => el("span", "Tooltip", p),
  Menu: (p) => el("div", "Menu"),
  Loader: (p) => el("div", "Loader"),
  Dialog: (p) => el("div", "Dialog", p),
  Switch: (p) => el("input", "Switch", null, (n) => {
    n.type = "checkbox"
    n.setAttribute("aria-label", p.label ?? "")
    createRenderEffect(() => (n.checked = !!p.checked))
    n.onchange = () => p.onChange(n.checked)
  }),
  TextInput: (p) => el("input", "TextInput", null, (n) => {
    n.setAttribute("aria-label", p.label ?? "")
    createRenderEffect(() => (n.value = p.value ?? ""))
    n.oninput = () => p.onInput(n.value)
  }),
  Keybind: () => el("kbd", "Keybind"),
  Markdown: () => el("div", "Markdown"),
  Code: () => el("pre", "Code"),
}
const kit226 = {
  ...kit220,
  Select: (p) => el("select", "Select", null, (n) => {
    n.setAttribute("aria-label", p.label ?? "")
    createRenderEffect(() => {
      n.replaceChildren(...p.options.map((o) => Object.assign(document.createElement("option"), { value: o.value, textContent: o.label })))
      n.value = p.value ?? ""
    })
    n.onchange = () => p.onChange(n.value)
  }),
  SettingsLayout: (p) => {
    const n = el("div", "SettingsLayout", p)
    const h = document.createElement("h1")
    h.textContent = p.title
    n.prepend(h)
    web.insert(n, () => p.actions, h.nextSibling)
    return n
  },
  SettingsSection: (p) => {
    const n = el("section", "SettingsSection", p)
    n.prepend(Object.assign(document.createElement("h2"), { textContent: p.title ?? "" }))
    return n
  },
  SettingsRow: (p) => {
    const n = el("div", "SettingsRow", p)
    const desc = document.createElement("small")
    createRenderEffect(() => (desc.textContent = p.description ?? ""))
    n.prepend(Object.assign(document.createElement("span"), { textContent: p.title ?? "" }), desc)
    return n
  },
}

const STATE = {
  config: {
    presets: {
      "fusion-kimi": { lead: "kimi/k3.1-pro", sidekick: "xiaomi/mimo-v2.6-pro", description: "Kimi lead" },
    },
  },
  models: [
    { value: "kimi/k3.1-pro", label: "Kimi · K3.1 Pro" },
    { value: "xiaomi/mimo-v2.6-pro", label: "Xiaomi · MiMo 2.6 Pro" },
    { value: "opencode/claude-opus-5-5", label: "OpenCode · Claude Opus 5.5" },
  ],
  path: "C:/fake/fusion.jsonc",
  entries: { "fusion-kimi": "kimi/fusion-kimi" },
  warnings: [],
}

const tick = () => new Promise((r) => setTimeout(r, 20))
const def = require(path.resolve(process.argv[2] ?? path.join(__dirname, "../dist/gui-experimental.cjs"))).default
let failed = false
const check = (ok, label) => {
  console.log((ok ? "  ok   " : "  FAIL ") + label)
  if (!ok) failed = true
}

async function run(name, ui) {
  console.log(`== ${name}`)
  const added = []
  let saved
  const toasts = []
  const ctx = {
    ui,
    t: (k) => def.i18n.en[k] ?? k,
    add: (_reg, item) => added.push(item),
    toast: { show: (t) => toasts.push(t) },
    client: {
      rpc: () => ({
        state: async () => structuredClone(STATE),
        save: async ({ config }) => {
          saved = config
          return { ...structuredClone(STATE), config: structuredClone(config) }
        },
      }),
    },
  }
  def.setup(ctx)
  const root = document.createElement("div")
  document.body.replaceChildren(root)
  let dispose
  try {
    dispose = web.render(() => added.find((i) => i.id === "fusion").render(), root)
  } catch (e) {
    check(false, "renders without throwing: " + (e?.stack ?? e))
    return
  }
  await tick()
  const text = root.textContent
  check(text.includes("fusion-kimi") && text.includes("Lead model"), "shows the preset and its rows")
  const selects = [...root.querySelectorAll("select")]
  check(selects.length === 3, `two model dropdowns and a delegation dropdown (found ${selects.length})`)
  check(selects[0]?.value === "kimi/k3.1-pro", `lead dropdown shows the configured model (${selects[0]?.value})`)
  check(selects[2]?.value === "balanced", `delegation defaults to balanced (${selects[2]?.value})`)
  const nudge = () => [...root.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "Remind lead to delegate")
  check(nudge()?.checked === false, "direct-edit reminder is off by default with balanced")

  selects[0].value = "opencode/claude-opus-5-5"
  selects[0].dispatchEvent(new window.Event("change", { bubbles: true }))
  selects[2].value = "light"
  selects[2].dispatchEvent(new window.Event("change", { bubbles: true }))
  await tick()
  selects[2].value = "heavy"
  selects[2].dispatchEvent(new window.Event("change", { bubbles: true }))
  await tick()
  check(nudge()?.checked === true, "direct-edit reminder turns on by default with heavy")
  selects[2].value = "light"
  selects[2].dispatchEvent(new window.Event("change", { bubbles: true }))
  const nameInput = [...root.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "Name")
  check(!!nameInput, "has the new-agent name field")
  nameInput.value = "fusion-opus"
  nameInput.dispatchEvent(new window.Event("input", { bubbles: true }))
  await tick()
  const button = (label) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label && !b.disabled)
  button("Add")?.click()
  await tick()
  check(root.textContent.includes("fusion-opus"), "added preset appears")
  const save = button("Save")
  check(!!save, "Save is enabled after changes")
  save?.click()
  await tick()
  check(saved?.presets?.["fusion-kimi"]?.lead === "opencode/claude-opus-5-5", "saved the changed lead")
  check(saved?.presets?.["fusion-kimi"]?.delegation === "light", `saved the delegation (${saved?.presets?.["fusion-kimi"]?.delegation})`)
  check(saved?.presets?.["fusion-kimi"]?.nudge_direct_edits === undefined, "saved no explicit reminder choice")
  check(!!saved?.presets?.["fusion-opus"], "saved the added preset")
  check(toasts[0]?.variant === "success", "showed the saved toast")
  dispose()
}

const AGENTS = {
  agents: [
    { id: "build", name: "build", mode: "primary", hidden: false, base: { description: "Default agent" } },
    { id: "explore", name: "explore", mode: "subagent", hidden: false, base: { description: "Fast agent specialized for exploring codebases" } },
    { id: "title", name: "title", mode: "primary", hidden: true, base: {} },
  ],
  global: { agents: { explore: { model: "opencode/claude-opus-5-5" } } },
  project: { agents: {} },
  models: [
    { value: "kimi/k3.1-pro", label: "Kimi · K3.1 Pro", variants: [] },
    { value: "opencode/claude-opus-5-5", label: "OpenCode · Claude Opus 5.5", variants: ["high", "max"] },
  ],
  paths: { global: "C:/fake/agent-overrides.jsonc", project: "C:/proj/.opencode/agent-overrides.jsonc" },
  directory: "C:/proj",
  managed: ["fusion-kimi", "fusion-kimi-sidekick"],
  warnings: [],
}

// Settings > Agents: scopes, inherit labels, variants, save per scope, reset.
async function runAgents(name, ui) {
  console.log(`== ${name}`)
  const added = []
  const calls = []
  const toasts = []
  const layers = { global: structuredClone(AGENTS.global), project: structuredClone(AGENTS.project) }
  const stateFor = () => ({ ...structuredClone(AGENTS), global: structuredClone(layers.global), project: structuredClone(layers.project) })
  const ctx = {
    ui,
    t: (k) => def.i18n.en[k] ?? k,
    add: (_reg, item) => added.push(item),
    toast: { show: (t) => toasts.push(t) },
    sessions: { current: () => ({ project: { worktree: "C:/proj", name: "proj" } }) },
    client: {
      project: { list: async () => ({ data: [{ canonical: "C:/proj", name: "proj" }, { canonical: "C:/other", name: "other" }] }) },
      rpc: () => ({
        agentsState: async (_i, opts) => (calls.push(["state", opts?.location?.directory]), stateFor()),
        agentsSave: async (input, opts) => {
          calls.push(["save", opts?.location?.directory, input.scope, structuredClone(input.overrides)])
          layers[input.scope] = structuredClone(input.overrides)
          return stateFor()
        },
      }),
    },
  }
  def.setup(ctx)
  const page = added.find((i) => i.id === "agents")
  check(!!page, "registers the Agents page")
  const root = document.createElement("div")
  document.body.replaceChildren(root)
  let dispose
  try {
    dispose = web.render(() => page.render(), root)
  } catch (e) {
    check(false, "renders without throwing: " + (e?.stack ?? e))
    return
  }
  await tick()
  await tick()
  const text = () => root.textContent
  const fields = () => [...root.querySelectorAll("select,input,textarea")]
  const byLabel = (label) => fields().find((s) => s.getAttribute("aria-label") === label)
  const scope = () => byLabel("Applies to")
  const button = (label) => [...root.querySelectorAll("button")].filter((b) => b.textContent.trim() === label && !b.disabled)
  const set = async (el, value, ev = "change") => {
    el.value = value
    el.dispatchEvent(new window.Event(ev, { bubbles: true }))
    await tick()
  }

  check(text().includes("Primary agents") && text().includes("Subagents") && text().includes("System agents"), "groups primary, subagents and system agents")
  check(!text().includes("fusion-kimi-sidekick") && text().includes("Settings › Fusion"), "leaves Fusion agents to the Fusion page")
  check(scope()?.value === "global", `scope starts at all projects (${scope()?.value})`)
  const scopes = () => [...(scope()?.options ?? [])].map((o) => o.value).join(",")
  check(scopes() === "global,C:/proj,C:/other", `scope lists the current project first (${scopes()})`)
  const exploreModel = () => byLabel("explore: Model")
  check(exploreModel()?.value === "opencode/claude-opus-5-5", `explore shows its global model (${exploreModel()?.value})`)
  check(!!byLabel("explore: Variant"), "explore shows a variant picker for a model with variants")
  const buildInherit = byLabel("build: Model")?.options[0]?.textContent ?? ""
  check(buildInherit === "Inherit (the session's model)", `build inherits the session's model (${buildInherit})`)

  await set(byLabel("build: Model"), "kimi/k3.1-pro")
  await set(byLabel("explore: Variant"), "max")
  button("Save")[0]?.click()
  await tick()
  const s1 = calls.filter((c) => c[0] === "save")[0]
  check(s1?.[2] === "global" && s1?.[1] === undefined, `saves all-projects scope without a project location (${s1?.[2]}, ${s1?.[1]})`)
  check(
    s1?.[3]?.agents?.build?.model === "kimi/k3.1-pro" && s1?.[3]?.agents?.explore?.model === "opencode/claude-opus-5-5#max",
    `saves model and variant (${JSON.stringify(s1?.[3])})`,
  )

  await set(scope(), "C:/proj")
  await tick()
  check(calls.some((c) => c[0] === "state" && c[1] === "C:/proj"), "project scope loads that project's agents")
  check(exploreModel()?.value === "", `project scope starts with nothing set (${exploreModel()?.value})`)
  const exploreInherit = exploreModel()?.options[0]?.textContent ?? ""
  check(exploreInherit === "Inherit (OpenCode · Claude Opus 5.5 · max)", `project inherit label shows the global model (${exploreInherit})`)
  check(text().includes("From all-projects settings"), "shows where an inherited value comes from")

  button("More settings")[1]?.click() // build is first, explore second
  await tick()
  check(!!byLabel("explore: Max steps"), "More settings shows max steps")
  await set(byLabel("explore: Max steps"), "12", "input")
  await set(byLabel("explore: Extra instructions"), "Be brief.", "input")
  const enabled = byLabel("explore: Enabled")
  enabled.checked = false
  enabled.dispatchEvent(new window.Event("change", { bubbles: true }))
  await tick()
  button("Save")[0]?.click()
  await tick()
  const s2 = calls.filter((c) => c[0] === "save")[1]
  check(s2?.[2] === "project" && s2?.[1] === "C:/proj", `saves project scope at the project's location (${s2?.[2]}, ${s2?.[1]})`)
  const ex = JSON.stringify(s2?.[3]?.agents?.explore)
  check(ex === JSON.stringify({ steps: 12, prompt_append: "Be brief.", disabled: true }), `saves steps, instructions and off (${ex})`)

  // explore's Reset is the enabled one: build has nothing set in this project.
  const resets = button("Reset")
  check(resets.length === 1, `only agents with settings here can be reset (${resets.length})`)
  resets[0]?.click()
  await tick()
  button("Save")[0]?.click()
  await tick()
  const s3 = calls.filter((c) => c[0] === "save")[2]
  check(!!s3 && !s3[3].agents.explore, `reset removes the agent's project settings (${JSON.stringify(s3?.[3])})`)
  check(toasts.length === 3 && toasts.every((t) => t.variant === "success"), `showed saved toasts (${toasts.map((t) => t.variant)})`)
  dispose()
}

;(async () => {
  await run("OpenCode Desktop 2.2.0 UI kit", kit220)
  await run("OpenCode Desktop 2.2.6 UI kit", kit226)
  await runAgents("Agents page, 2.2.0 UI kit", kit220)
  await runAgents("Agents page, 2.2.6 UI kit", kit226)
  process.exit(failed ? 1 : 0)
})()
