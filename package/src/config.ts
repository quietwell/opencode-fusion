import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import type { FusionConfig, Preset } from "./rpc"

export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
export const configPath = () => join(configDir(), "fusion.jsonc")

export function stripJsonc(s: string): string {
  let out = ""
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const n = s[i + 1]
    if (inStr) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i++
      } else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
    } else if (c === "/" && n === "/") {
      while (i < s.length && s[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && n === "*") {
      i += 2
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/** fusion.jsonc (or fusion.json) merged with the plugin's options. */
export function loadConfig(options?: Record<string, unknown>): { config: FusionConfig; error?: string } {
  const merged: FusionConfig = { presets: {} }
  let error: string | undefined
  const layers: FusionConfig[] = []
  for (const file of ["fusion.jsonc", "fusion.json"]) {
    const path = join(configDir(), file)
    if (!existsSync(path)) continue
    try {
      layers.push(JSON.parse(stripJsonc(readFileSync(path, "utf8"))))
    } catch (e) {
      error = `Cannot parse ${path}: ${(e as Error).message}`
    }
    break
  }
  if (options && Object.keys(options).length) layers.push(options as FusionConfig)
  for (const { presets, ...rest } of layers) {
    Object.assign(merged, rest)
    for (const [name, p] of Object.entries(presets ?? {})) merged.presets![name] = { ...merged.presets![name], ...p }
  }
  return { config: merged, error }
}

const HEADER = `// Fusion agents for OpenCode. Edit here or in Settings > Fusion in OpenCode Desktop.
// Each preset becomes an agent (lead + hidden sidekick) and, unless "model_entry"
// is false, an entry "<lead model> (Fusion)" in the model list.
`

export function saveConfig(config: FusionConfig) {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, HEADER + JSON.stringify(config, null, 2) + "\n", "utf8")
  renameSync(tmp, path)
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const MODEL_RE = /^[^/\s]+\/[^\s]+$/

export function validate(config: FusionConfig): string | undefined {
  for (const [name, p] of Object.entries(config.presets ?? {})) {
    if (!NAME_RE.test(name)) return `"${name}": use lowercase letters, digits and dashes`
    if (!p || typeof p !== "object") return `"${name}": invalid preset`
    if (!MODEL_RE.test(p.lead ?? "")) return `"${name}": pick a lead model`
    if (!MODEL_RE.test(p.sidekick ?? "")) return `"${name}": pick a sidekick model`
    if (p.delegation !== undefined && !DELEGATIONS.includes(p.delegation))
      return `"${name}": delegation must be one of ${DELEGATIONS.join(", ")}`
    for (const k of ["lead_steps", "sidekick_steps"] as const)
      if (p[k] !== undefined && !(Number.isInteger(p[k]) && (p[k] as number) > 0)) return `"${name}": ${k} must be a positive whole number`
  }
}

export function readPrompt(path: string | undefined): string | undefined {
  if (!path) return undefined
  return readFileSync(isAbsolute(path) ? path : join(configDir(), path), "utf8")
}

/** "provider/model" or "provider/model#variant" -> parts */
export function parseModel(spec: string) {
  const [main, variant] = spec.split("#")
  const slash = main.indexOf("/")
  if (slash < 1) throw new Error(`model "${spec}" must look like provider/model`)
  return { providerID: main.slice(0, slash), id: main.slice(slash + 1), variant: variant || undefined }
}

/** Model id of a preset's model list entry, inside its Fusion provider. */
export const entryModelID = (preset: string) => (preset.startsWith("fusion") ? preset : `fusion-${preset}`)

/**
 * The "Fusion · <provider>" provider that holds the model list entries of every preset whose lead uses
 * `leadProviderID`. It shares that provider's login (integration), so it can't be one provider for all leads.
 */
export const entryProviderID = (leadProviderID: string) => `fusion-${leadProviderID}`

export const wantsEntry = (p: Preset) => p.model_entry !== false

export const DELEGATIONS = ["light", "balanced", "heavy"] as const
export type Delegation = (typeof DELEGATIONS)[number]
export const delegationOf = (p: Preset): Delegation => (DELEGATIONS.includes(p.delegation as Delegation) ? p.delegation! : "balanced")
/** The direct-edit reminder pushes towards delegating, so by default it is only on with "heavy". */
export const nudgesEdits = (p: Preset) => p.nudge_direct_edits ?? delegationOf(p) === "heavy"
