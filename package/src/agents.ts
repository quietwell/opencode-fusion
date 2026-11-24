/**
 * Agent overrides (Settings > Agents): per-agent model, steps, description, extra instructions and on/off,
 * globally in ~/.config/opencode/agent-overrides.jsonc and per project in <project>/.opencode/agent-overrides.jsonc.
 * Applied on top of OpenCode's own agents (built-ins, opencode.jsonc, agents/*.md): global, then project.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { configDir, parseModel, stripJsonc } from "./config"
import type { AgentOverride, AgentOverrides } from "./rpc"

export const OVERRIDES_FILE = "agent-overrides.jsonc"
export const globalOverridesPath = () => join(configDir(), OVERRIDES_FILE)
export const projectOverridesPath = (directory: string) => join(directory, ".opencode", OVERRIDES_FILE)

export function loadOverrides(path: string): { data: AgentOverrides; error?: string } {
  if (!existsSync(path)) return { data: { agents: {} } }
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8")))
    return { data: { agents: parsed?.agents && typeof parsed.agents === "object" ? parsed.agents : {} } }
  } catch (e) {
    return { data: { agents: {} }, error: `Cannot parse ${path}: ${(e as Error).message}` }
  }
}

const HEADER = `// Agent overrides for OpenCode (opencode-fusion plugin). Edit here or in Settings > Agents.
// Keys are agent ids. Fields: model ("provider/model" or "provider/model#variant"), steps, disabled,
// description, prompt_append (added to the agent's prompt). Project files override the global one.
`

/** Writes the file, or removes it when nothing is overridden. */
export function saveOverrides(path: string, data: AgentOverrides) {
  const agents = Object.fromEntries(Object.entries(clean(data).agents ?? {}).filter(([, o]) => Object.keys(o).length))
  if (!Object.keys(agents).length) {
    if (existsSync(path)) unlinkSync(path)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, HEADER + JSON.stringify({ agents }, null, 2) + "\n", "utf8")
  renameSync(tmp, path)
}

/** Drops empty fields, so "inherit" never ends up in the file. */
export function clean(data: AgentOverrides): AgentOverrides {
  const agents: Record<string, AgentOverride> = {}
  for (const [id, o] of Object.entries(data.agents ?? {})) {
    const out: AgentOverride = {}
    if (typeof o?.model === "string" && o.model.trim()) out.model = o.model.trim()
    if (o?.steps !== undefined && o.steps !== null) out.steps = o.steps
    if (typeof o?.disabled === "boolean") out.disabled = o.disabled
    if (typeof o?.description === "string" && o.description.trim()) out.description = o.description.trim()
    if (typeof o?.prompt_append === "string" && o.prompt_append.trim()) out.prompt_append = o.prompt_append.trim()
    agents[id] = out
  }
  return { agents }
}

const MODEL_RE = /^[^/\s]+\/[^\s#]+(#[^\s#]+)?$/

export function validateOverrides(data: AgentOverrides): string | undefined {
  if (!data || typeof data !== "object" || typeof data.agents !== "object") return "missing agents"
  for (const [id, o] of Object.entries(data.agents)) {
    if (!o || typeof o !== "object") return `"${id}": invalid override`
    if (o.model !== undefined && !MODEL_RE.test(o.model)) return `"${id}": model must look like provider/model`
    if (o.steps !== undefined && !(Number.isInteger(o.steps) && o.steps > 0)) return `"${id}": max steps must be a positive whole number`
    if (o.disabled !== undefined && typeof o.disabled !== "boolean") return `"${id}": disabled must be true or false`
    for (const k of ["description", "prompt_append"] as const)
      if (o[k] !== undefined && typeof o[k] !== "string") return `"${id}": ${k} must be text`
  }
}

/** Global, then project: later layers win per field. */
export function merged(layers: AgentOverrides[], id: string): AgentOverride {
  return Object.assign({}, ...layers.map((l) => l.agents?.[id] ?? {}))
}

/**
 * Applies the merged overrides to the agent editor. `exists` says whether a model is in the model list;
 * an override with an unknown model is skipped with a warning, because an agent pointing at a missing
 * model would silently run on the default model.
 */
export function applyOverrides(
  editor: any,
  layers: AgentOverrides[],
  skip: (id: string) => boolean,
  exists: (providerID: string, id: string) => boolean | undefined,
  warn: (message: string) => void,
) {
  const ids = new Set(layers.flatMap((l) => Object.keys(l.agents ?? {})))
  for (const id of ids) {
    if (skip(id)) continue
    if (!editor.get(id)) {
      warn(`Agent "${id}" has overrides but doesn't exist here`)
      continue
    }
    const o = merged(layers, id)
    if (o.disabled) {
      editor.remove(id)
      continue
    }
    editor.update(id, (a: any) => {
      if (o.model) {
        try {
          const m = parseModel(o.model)
          if (exists(m.providerID, m.id) === false) warn(`${id}: model ${o.model} isn't in the model list, so it keeps its own model`)
          else a.model = { providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) }
        } catch (e) {
          warn(`${id}: ${(e as Error).message}`)
        }
      }
      if (o.steps) a.steps = o.steps
      if (o.description) a.description = o.description
    })
  }
}
