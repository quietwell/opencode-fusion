/**
 * RPC contract between the server part and the settings page.
 * A plain object: Rpc.define only validates and returns its input.
 */
export const PLUGIN_ID = "fusion-agents"

export const FusionRpc = {
  id: PLUGIN_ID,
  methods: {
    /** Current config plus the models the user can pick. */
    state: {
      input: { type: "object" },
      output: { type: "object" },
      errors: {},
    },
    /** Replace the whole config, write fusion.jsonc and reload agents and models. */
    save: {
      input: {
        type: "object",
        properties: { config: { type: "object" } },
        required: ["config"],
      },
      output: { type: "object" },
      errors: {
        invalid: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    },
    /** Agents of this location with their default, global and project values (Settings > Agents). */
    agentsState: {
      input: { type: "object" },
      output: { type: "object" },
      errors: {},
    },
    /** Replace one scope's overrides, write its file and reload agents. */
    agentsSave: {
      input: {
        type: "object",
        properties: { scope: { type: "string", enum: ["global", "project"] }, overrides: { type: "object" } },
        required: ["scope", "overrides"],
      },
      output: { type: "object" },
      errors: {
        invalid: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    },
  },
  events: {},
} as const

/** What Settings > Agents can change per agent. Missing fields inherit. */
export type AgentOverride = {
  /** "provider/model" or "provider/model#variant" */
  model?: string
  steps?: number
  /** true removes the agent */
  disabled?: boolean
  description?: string
  /** Added to the agent's prompt on every request. */
  prompt_append?: string
}

export type AgentOverrides = { agents: Record<string, AgentOverride> }

export type AgentInfo = {
  id: string
  name: string
  mode: "primary" | "subagent" | "all"
  hidden: boolean
  /** The agent as OpenCode defines it, before any override. */
  base: { model?: string; steps?: number; description?: string }
}

export type AgentsState = {
  agents: AgentInfo[]
  global: AgentOverrides
  /** Undefined when this location is not a project directory. */
  project?: AgentOverrides
  /** Models with their variants. */
  models: (ModelOption & { variants: string[] })[]
  paths: { global: string; project?: string }
  directory: string
  /** Agents Settings > Fusion manages. */
  managed: string[]
  warnings: string[]
}

export type Preset = {
  description?: string
  /** "provider/model" or "provider/model#variant" */
  lead: string
  sidekick: string
  /** Add "<lead name> (Fusion)" to the model list. Default true. */
  model_entry?: boolean
  /** Name of that model list entry. Default "<lead model name> (Fusion)". */
  model_name?: string
  lead_options?: Record<string, unknown>
  sidekick_options?: Record<string, unknown>
  lead_prompt?: string
  sidekick_prompt?: string
  lead_prompt_file?: string
  sidekick_prompt_file?: string
  lead_prompt_append?: string
  sidekick_prompt_append?: string
  color?: string
  lead_steps?: number
  sidekick_steps?: number
  /** How much the lead hands to the sidekick. Default "balanced". */
  delegation?: "light" | "balanced" | "heavy"
  /** Remind the lead when it edits files itself. Default: only with delegation "heavy". */
  nudge_direct_edits?: boolean
}

export type FusionConfig = {
  presets?: Record<string, Preset>
  max_report_chars?: number
}

export type ModelOption = { value: string; label: string }

export type FusionState = {
  config: FusionConfig
  models: ModelOption[]
  path: string
  /** Preset name -> "provider/id" of its model list entry, when it has one. */
  entries: Record<string, string>
  /** Problems found while applying the config, such as a lead model that doesn't exist. */
  warnings: string[]
}
