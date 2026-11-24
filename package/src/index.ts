/**
 * opencode-fusion, server part (OpenCode 2.x)
 *
 * - Fusion presets (fusion.jsonc, or Settings > Fusion in the Desktop app): each becomes a
 *   primary "lead" agent plus a hidden "sidekick" subagent, each on its own model.
 * - Each preset also adds "<lead model> (Fusion)" to the model list, under a "Fusion · <lead provider>"
 *   provider that shares the lead provider's login. Chatting with that model turns on the fusion lead
 *   behaviour for any agent.
 * - One persistent sidekick per session: subagent calls to the sidekick reuse one child session.
 * - subagent_status / subagent_cancel, /agents and /agents-stop: progress and stopping with
 *   partial results.
 * - subagent_message: message a running subagent now (interrupting), after its current step, or after
 *   its current task.
 * - A reminder when a fusion lead edits files itself.
 * - Settings > Agents: overrides of any other agent (model, steps, description, extra instructions, on/off),
 *   globally and per project, in agent-overrides.jsonc files (see agents.ts).
 *
 * No runtime imports from OpenCode: every hook takes plain objects and JSON Schema.
 */
import {
  configPath,
  delegationOf,
  entryModelID,
  entryProviderID,
  loadConfig,
  nudgesEdits,
  parseModel,
  readPrompt,
  saveConfig,
  validate,
  wantsEntry,
} from "./config"
import { existsSync, statSync, unwatchFile, watchFile } from "node:fs"
import {
  applyOverrides,
  globalOverridesPath,
  loadOverrides,
  merged,
  projectOverridesPath,
  saveOverrides,
  validateOverrides,
} from "./agents"
import { DIRECT_EDIT_NUDGE, leadPrompt, SIDEKICK_PROMPT } from "./prompts"
import {
  FusionRpc,
  PLUGIN_ID,
  type AgentInfo,
  type AgentOverrides,
  type AgentsState,
  type FusionConfig,
  type FusionState,
  type ModelOption,
  type Preset,
} from "./rpc"

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])
const OWN_TOOLS = ["subagent_status", "subagent_cancel", "subagent_message"]
// Built-in subagents a fusion lead may not start: exploration and general work go to the sidekick.
const BUILTIN_SUBAGENTS = ["explore", "general"]
// Agent name a fusion lead passes to start a fresh sidekick even when one is free.
const NEW_SIDEKICK = "new-sidekick"
const sidekickDescription = (model?: string) =>
  `Your sidekick${model ? ` (${model})` : ""}. Use it for all exploration, code searches, edits, builds and tests. ` +
  `It keeps its context between calls, so later briefs build on what it already learned.`
const DELIVERIES = ["now", "next_step", "after_turn"] as const
type Delivery = (typeof DELIVERIES)[number]

type Ctx = any

async function setup(ctx: Ctx) {
  let loaded = loadConfig(ctx.options)
  let config: FusionConfig = loaded.config
  let warnings: string[] = loaded.error ? [loaded.error] : []

  const presets = (): Record<string, Preset> => config.presets ?? {}

  // Settings > Agents: overrides of any agent, global and for this location's project.
  const directory: string = ctx.location?.directory ?? process.cwd()
  const overridePaths = { global: globalOverridesPath(), project: projectOverridesPath(directory) }
  let overrideLayers: AgentOverrides[] = []
  let overrideErrors: string[] = []
  const loadOverrideLayers = () => {
    const g = loadOverrides(overridePaths.global)
    const p = loadOverrides(overridePaths.project)
    overrideLayers = [g.data, p.data]
    overrideErrors = [g.error, p.error].filter(Boolean) as string[]
  }
  loadOverrideLayers()
  /** Agents Settings > Fusion manages; Settings > Agents leaves them alone. */
  const managed = () => Object.keys(presets()).flatMap((n) => [n, `${n}-sidekick`])
  const maxChars = () => config.max_report_chars ?? 30000
  const sidekickOf = (lead: string) => `${lead}-sidekick`

  /** "provider/id" of each preset's model list entry. */
  function entryKeys(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [name, p] of Object.entries(presets())) {
      if (!wantsEntry(p) || !p.lead) continue
      try {
        out.set(`${entryProviderID(parseModel(p.lead).providerID)}/${entryModelID(name)}`, name)
      } catch {}
    }
    return out
  }

  /** Session -> preset whose lead behaviour is active there (by agent or by model). */
  const active = new Map<string, string>()
  const presetFor = (agent: string | undefined, sessionID?: string) => {
    if (agent && presets()[agent]) return agent
    const name = sessionID ? active.get(sessionID) : undefined
    return name && presets()[name] ? name : undefined
  }
  const leadSystem = (name: string) => {
    const p = presets()[name]
    return (
      (p.lead_prompt ?? readPrompt(p.lead_prompt_file) ?? leadPrompt(sidekickOf(name), delegationOf(p))) +
      (p.lead_prompt_append ? `\n\n${p.lead_prompt_append}` : "")
    )
  }
  const nudged = new Set<string>()

  // ------------------------------------------------------------ children ---

  async function messages(sessionID: string): Promise<any[]> {
    return ((await ctx.session.context({ sessionID })) ?? []) as any[]
  }

  async function children(parentID: string): Promise<any[]> {
    const res = await ctx.session.list({ parentID, limit: 100 })
    return (res?.data ?? []) as any[]
  }

  function describeTool(t: any): string {
    const input = t.state?.input && typeof t.state.input === "object" ? t.state.input : {}
    const target = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.description ?? ""
    const s = String(target)
    const short = s.length > 120 ? `…${s.slice(-119)}` : s
    return `${t.name}${target ? ` ${short}` : ""} (${t.state?.status ?? "?"})`
  }

  async function snapshot(sessionID: string) {
    const all = await messages(sessionID)
    let start = 0
    for (let i = all.length - 1; i >= 0; i--)
      if (all[i].type === "user" || all[i].type === "synthetic") {
        start = i
        break
      }
    const tools: string[] = []
    const files = new Set<string>()
    let lastText = ""
    let cost = 0
    let model = ""
    let agent = ""
    for (const m of all.slice(start)) {
      if (m.type !== "assistant") continue
      cost += Number(m.cost ?? 0) || 0
      if (m.model) model = `${m.model.providerID}/${m.model.id}`
      agent = m.agent ?? agent
      for (const f of m.snapshot?.files ?? []) files.add(f)
      for (const c of m.content ?? []) {
        if (c.type === "tool") {
          tools.push(describeTool(c))
          const fp = c.state?.input?.filePath ?? c.state?.input?.path
          if (EDIT_TOOLS.has(c.name) && fp && c.state?.status === "completed") files.add(fp)
        } else if (c.type === "text" && c.text?.trim()) lastText = c.text
      }
    }
    const last = all[all.length - 1]
    const state =
      last?.type === "idle"
        ? last.outcome === "interrupted"
          ? "stopped"
          : last.outcome === "failed"
            ? "failed"
            : "finished"
        : "running"
    return { tools, files: [...files], lastText, cost, model, agent, state }
  }

  async function report(sessionID: string, heading: string): Promise<string> {
    const s = await snapshot(sessionID)
    const lines = [
      `[${sessionID}${s.agent ? ` · ${s.agent}` : ""}${s.model ? ` · ${s.model}` : ""} · ${s.state}${s.cost ? ` · $${s.cost.toFixed(4)}` : ""}]`,
      heading,
      `Tool calls (${s.tools.length}):`,
    ]
    if (s.tools.length > 30) lines.push(`- … ${s.tools.length - 30} earlier calls`)
    lines.push(...s.tools.slice(-30).map((t) => `- ${t}`))
    if (s.files.length) lines.push(`Files changed: ${s.files.join(", ")}`)
    if (s.lastText) lines.push("Latest message from the subagent:", s.lastText.slice(-4000))
    const text = lines.join("\n")
    return text.length > maxChars() ? text.slice(0, maxChars()) + "\n…[truncated]" : text
  }

  async function stop(sessionID: string): Promise<string> {
    await ctx.session.interrupt({ sessionID }).catch(() => {})
    for (let i = 0; i < 30; i++) {
      if ((await snapshot(sessionID)).state !== "running") break
      await new Promise((r) => setTimeout(r, 500))
    }
    return report(
      sessionID,
      `Stopped. Partial results below. Its context is kept: call subagent with sessionID "${sessionID}" to continue it.`,
    )
  }

  async function running(parentID: string) {
    const out: any[] = []
    for (const k of await children(parentID)) if ((await snapshot(k.id)).state === "running") out.push(k)
    return out
  }

  // A lead can have several sidekicks: a call without sessionID goes to a free one (the one briefed last,
  // so its context carries over), and starts a new one when all are busy.
  const lastUsed = new Map<string, number>()
  // Sidekicks a subagent call was just routed to. Covers the moment before its brief shows up in the
  // session, so two calls at once don't both pick the same free sidekick.
  const claimed = new Map<string, number>()
  const isClaimed = (id: string) => Date.now() - (claimed.get(id) ?? 0) < 5_000
  const used = (id: string) => {
    lastUsed.set(id, Date.now())
    claimed.set(id, Date.now())
  }

  const picking = new Map<string, Promise<unknown>>()
  function pick(sessionID: string, fn: () => Promise<void>) {
    const next = (picking.get(sessionID) ?? Promise.resolve()).then(fn, fn)
    picking.set(sessionID, next.catch(() => {}))
    return next
  }

  /** The session's sidekicks, most recently briefed first. */
  async function sidekicksOf(sessionID: string, name: string): Promise<any[]> {
    const kids = (await children(sessionID).catch(() => [])).filter((k: any) => k.agent === sidekickOf(name))
    const at = (k: any) => lastUsed.get(k.id) ?? Number(k.time?.updated ?? k.time?.created ?? 0)
    return kids.sort((a: any, b: any) => at(b) - at(a))
  }

  async function freeSidekick(sessionID: string, name: string): Promise<string | undefined> {
    for (const k of await sidekicksOf(sessionID, name)) {
      if ((await snapshot(k.id)).state === "running") {
        claimed.delete(k.id) // its brief has arrived; the running state covers it from here
        continue
      }
      if (!isClaimed(k.id)) return k.id
    }
  }

  async function runningSidekicks(sessionID: string, name: string): Promise<any[]> {
    const out: any[] = []
    for (const k of await sidekicksOf(sessionID, name)) if ((await snapshot(k.id)).state === "running") out.push(k)
    return out
  }

  /**
   * Sends a message into a running subagent, through OpenCode's session inbox:
   * - next_step ("steer"): read before its next model step; the current step finishes first.
   * - after_turn ("queue"): read after its current task is done, as a new turn.
   * - now: steer, then interrupt the step in progress so the message is read right away.
   */
  async function message(parentID: string, agent: string | undefined, input: any): Promise<string> {
    const delivery: Delivery = DELIVERIES.includes(input?.delivery) ? input.delivery : "next_step"
    const text = String(input?.message ?? "").trim()
    if (!text) return "Error: message is empty."
    let target: string | undefined = input?.sessionID
    if (!target) {
      const name = presetFor(agent, parentID)
      if (!name) return "Error: pass the subagent's sessionID (see subagent_status)."
      const busy = await runningSidekicks(parentID, name)
      if (busy.length === 0)
        return "Not sent: none of your sidekicks is running. Give one new work with the subagent tool instead, so you get its report."
      if (busy.length > 1)
        return [
          `Not sent: ${busy.length} sidekicks are running. Pass the sessionID of the one you mean:`,
          ...busy.map((k) => `- ${k.id} · ${k.title ?? ""}`),
        ].join("\n")
      target = busy[0].id as string
    }
    const session = await ctx.session.get({ sessionID: target }).catch(() => undefined)
    if (!session) return `Error: subagent session ${target} was not found.`
    if (session.parentID !== parentID) return `Error: session ${target} is not a subagent of this session.`
    const s = await snapshot(target)
    if (s.state !== "running")
      return `Not sent: subagent ${target} is ${s.state}, not running. Send new work with the subagent tool and sessionID "${target}" instead, so you get its report.`
    const header =
      delivery === "now"
        ? "[Message from the lead. It interrupted the step you were on: read it before you continue.]"
        : delivery === "after_turn"
          ? "[Follow-up from the lead, sent while you were working. Start on it now that the previous task is done.]"
          : "[Message from the lead, sent while you were working. Take it into account from here on.]"
    const body = `${header}\n\n${text}`
    if (delivery === "now") {
      // Steer first without waking, then interrupt with resume: OpenCode restarts the run on the pending message.
      const sent = await ctx.session.prompt({ sessionID: target, text: body, delivery: "steer", resume: false })
      await ctx.session.interrupt({ sessionID: target, resume: true })
      // The interrupt ends OpenCode's background tracking of it (the lead gets a "cancelled" notice), so the
      // plugin reports back itself once it has handled the message.
      reportWhenDone(parentID, target, sent?.id)
      return `Sent to subagent ${target} (now). It was interrupted and is reading your message. Tool calls and edits it already finished are kept; only the step it was on was cut short. OpenCode will notify you that it was "cancelled": that refers to the interrupted step only. It keeps working, and its report arrives here when it finishes. Don't poll.`
    }
    await ctx.session.prompt({ sessionID: target, text: body, delivery: delivery === "after_turn" ? "queue" : "steer" })
    const when =
      delivery === "after_turn"
        ? "It reads it after it finishes its current task, as a new turn."
        : "It reads it after the step it is on finishes."
    return `Sent to subagent ${target} (${delivery}). ${when} Its report still arrives the usual way; don't poll.`
  }

  /** Subagent -> id of the latest "now" message whose outcome the lead still has to get. */
  const watching = new Map<string, string | undefined>()

  function reportWhenDone(parentID: string, target: string, sentID: string | undefined) {
    const already = watching.has(target)
    watching.set(target, sentID)
    if (already) return
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    ;(async () => {
      const until = Date.now() + 12 * 60 * 60 * 1000
      await sleep(1000)
      while (Date.now() < until) {
        const all = await messages(target)
        const id = watching.get(target)
        const at = id ? all.findIndex((m) => m.id === id) : -1
        // Done once the latest message was handled and the subagent went idle after it.
        if ((at >= 0 || !id) && all[all.length - 1]?.type === "idle" && all.length - 1 > at) break
        await sleep(2000)
      }
      watching.delete(target)
      const s = await snapshot(target)
      const state = s.state === "finished" ? "completed" : s.state
      await ctx.session.synthetic({
        sessionID: parentID,
        description: "Subagent finished",
        text: `<subagent sessionID="${target}" state="${state}" description="after your message">\n${await report(target, "It finished working on your message.")}\n</subagent>`,
      })
    })().catch(() => watching.delete(target))
  }

  // -------------------------------------------------- model list entries ---

  // The Desktop model picker shows, by default, only the newest model of each family per provider, and only
  // if it came out in the last ~6 months. Entries get their own family and the time the plugin loaded, so
  // they are shown until the user hides them under "Manage models".
  const listedAt = Date.now()

  // Presets that ended up without a model list entry (lead provider or model not found). Their agents use
  // the lead model directly; an agent pointing at a missing entry would silently run on the default model.
  // The agent editor can't see models, so agents are reloaded when this set changes after they were built.
  const providerMissing = new Set<string>()
  const modelMissing = new Set<string>()
  const noEntry = () => new Set([...providerMissing, ...modelMissing])
  let agentsBuiltWith: string | undefined
  // "provider/id" of every model, from the model transform; undefined until it ran. Agent overrides check
  // their model against it, so agents are rebuilt once it is known.
  let knownModels: Set<string> | undefined
  const noEntryKey = () => [...noEntry()].sort().join(",") + (knownModels ? "|models" : "")
  const syncAgents = () => {
    if (agentsBuiltWith !== undefined && agentsBuiltWith !== noEntryKey())
      setTimeout(() => ctx.agent.reload().catch(() => {}), 0)
  }

  await ctx.provider.transform((editor: any) => {
    providerMissing.clear()
    // Lead provider -> entries for its "Fusion · <provider>" provider.
    const additions = new Map<string, any[]>()
    for (const [name, p] of Object.entries(presets())) {
      if (!wantsEntry(p) || !p.lead) continue
      let lead
      try {
        lead = parseModel(p.lead)
      } catch (e) {
        warnings.push(`${name}: ${(e as Error).message}`)
        continue
      }
      const record = editor.get(lead.providerID)
      if (!record) {
        providerMissing.add(name)
        warnings.push(`${name}: lead provider ${lead.providerID} was not found, so it has no model list entry`)
        continue
      }
      // Models defined in opencode.jsonc arrive after provider transforms. Start from a placeholder then;
      // the model transform below fills it from the final lead model, or removes it if there is none.
      const base = record.models?.get(lead.id) ?? {
        id: lead.id,
        modelID: lead.id,
        providerID: lead.providerID,
        name: lead.id,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        time: { released: listedAt },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 200_000, output: 32_000 },
      }
      const list = additions.get(lead.providerID) ?? []
      list.push({
        ...structuredClone(base),
        id: entryModelID(name),
        modelID: base.modelID ?? base.id,
        providerID: entryProviderID(lead.providerID),
        // Requests are built as for the lead provider (SDK provider name, provider options).
        canonical: base.canonical ?? record.provider.canonical ?? lead.providerID,
        package: base.package ?? record.provider.package,
        family: `fusion-${name}`,
        time: { ...base.time, released: listedAt },
        enabled: true,
        name: p.model_name?.trim() || `${base.name} (Fusion)`,
      })
      additions.set(lead.providerID, list)
    }
    // OpenCode finds a model's login through its provider, so entries whose leads use different logins
    // can't share one provider. With one login the group is just "Fusion"; otherwise "Fusion · <provider>",
    // without a trailing "(…)" unless two providers would then look the same.
    const fullName = (id: string) => String(editor.get(id)?.provider?.name ?? id)
    const shortName = (id: string) => fullName(id).replace(/\s*\([^)]*\)\s*$/, "") || fullName(id)
    const shorts = [...additions.keys()].map(shortName)
    const label = (id: string) =>
      additions.size === 1
        ? "Fusion"
        : `Fusion · ${shorts.filter((s) => s === shortName(id)).length > 1 ? fullName(id) : shortName(id)}`
    for (const [leadProviderID, models] of additions) {
      const record = editor.get(leadProviderID)
      const info = structuredClone(record.provider)
      editor.add({
        info: {
          ...info,
          id: entryProviderID(leadProviderID),
          name: label(leadProviderID),
          canonical: info.canonical ?? leadProviderID,
          // Same login as the lead provider: credentials are looked up by integration.
          integrationID: info.integrationID ?? leadProviderID,
        },
        models,
        ...(record.sourceConnection ? { sourceConnection: record.sourceConnection } : {}),
      })
    }
    syncAgents()
  })

  // Config overrides (base URL, headers, settings, names) apply after provider transforms. Copy the lead
  // model's final request setup onto its entry, so the entry calls exactly what the lead calls.
  await ctx.model.transform((editor: any) => {
    modelMissing.clear()
    knownModels = new Set((editor.list?.() ?? []).map((m: any) => `${m.providerID}/${m.id}`))
    for (const [name, p] of Object.entries(presets())) {
      if (!wantsEntry(p) || !p.lead) continue
      let lead
      try {
        lead = parseModel(p.lead)
      } catch {
        continue
      }
      const base = editor.get(lead.providerID, lead.id)
      const providerID = entryProviderID(lead.providerID)
      const id = entryModelID(name)
      if (!editor.get(providerID, id)) continue
      if (!base) {
        modelMissing.add(name)
        editor.remove(providerID, id)
        warnings.push(`${name}: lead model ${lead.providerID}/${lead.id} was not found, so it has no model list entry`)
        continue
      }
      // The lead provider's final settings (after config), which the entry's own provider copy may lack.
      const leadProvider = editor.provider?.get?.(lead.providerID)?.provider ?? {}
      editor.update(providerID, id, (m: any) => {
        for (const key of ["package", "compatibility", "capabilities", "variants", "limit", "cost"])
          if (base[key] !== undefined) m[key] = structuredClone(base[key])
        for (const key of ["settings", "headers", "body"]) {
          const merged = { ...(leadProvider[key] ?? {}), ...(base[key] ?? {}) }
          if (Object.keys(merged).length) m[key] = structuredClone(merged)
        }
        if (!m.package && leadProvider.package) m.package = leadProvider.package
        m.modelID = base.modelID ?? base.id
        m.canonical = base.canonical ?? lead.providerID
        m.enabled = base.enabled !== false
        if (!p.model_name?.trim() && base.name) m.name = `${base.name} (Fusion)`
      })
    }
    syncAgents()
  })

  // --------------------------------------------------------------- agents ---

  // Settings > Agents. Runs before the fusion transform below, so fusion agents are never touched.
  // `baseAgents` is each agent as OpenCode defines it, which the page shows as the default value.
  let baseAgents: AgentInfo[] = []
  let overrideWarnings: string[] = []
  await ctx.agent.transform((editor: any) => {
    const skip = new Set(managed())
    baseAgents = (editor.list() as any[])
      .filter((a) => !skip.has(a.id))
      .map((a) => ({
        id: a.id,
        name: a.name ?? a.id,
        mode: a.mode,
        hidden: !!a.hidden,
        base: {
          ...(a.model ? { model: `${a.model.providerID}/${a.model.id}${a.model.variant ? `#${a.model.variant}` : ""}` } : {}),
          ...(a.steps ? { steps: a.steps } : {}),
          ...(a.description ? { description: a.description } : {}),
        },
      }))
    overrideWarnings = []
    applyOverrides(
      editor,
      overrideLayers,
      (id) => skip.has(id),
      (providerID, id) => (knownModels ? knownModels.has(`${providerID}/${id}`) : undefined),
      (w) => overrideWarnings.push(w),
    )
  })

  await ctx.agent.transform((editor: any) => {
    const leads = Object.keys(presets())
    const sidekicks = leads.map(sidekickOf)
    const missing = noEntry()
    agentsBuiltWith = noEntryKey()

    // Subagents can't start fusion sidekicks or use the fusion tools.
    for (const a of editor.list()) {
      if (leads.includes(a.id) || sidekicks.includes(a.id) || a.mode !== "subagent") continue
      editor.update(a.id, (item: any) => {
        for (const s of sidekicks) item.permissions.push({ action: "subagent", resource: s, effect: "deny" })
        for (const t of OWN_TOOLS) item.permissions.push({ action: t, resource: "*", effect: "deny" })
      })
    }

    for (const [name, p] of Object.entries(presets())) {
      if (!p.lead || !p.sidekick) continue
      let lead, sidekick
      try {
        lead = parseModel(p.lead)
        sidekick = parseModel(p.sidekick)
      } catch (e) {
        warnings.push(`${name}: ${(e as Error).message}`)
        continue
      }
      const sk = sidekickOf(name)
      editor.update(name, (a: any) => {
        a.name = name
        a.mode = "primary"
        a.hidden = false
        a.description = p.description || `Fusion: ${p.lead} leads, ${p.sidekick} executes`
        // Point the agent at its "(Fusion)" model entry, so the model picker shows that name.
        a.model = wantsEntry(p) && !missing.has(name)
          ? {
              providerID: entryProviderID(lead.providerID),
              id: entryModelID(name),
              ...(lead.variant ? { variant: lead.variant } : {}),
            }
          : { providerID: lead.providerID, id: lead.id, ...(lead.variant ? { variant: lead.variant } : {}) }
        a.system = leadSystem(name)
        if (p.color) a.color = p.color
        if (p.lead_steps) a.steps = p.lead_steps
        if (p.lead_options) a.request.settings = { ...a.request.settings, ...p.lead_options }
        a.permissions.push({ action: "subagent", resource: sk, effect: "allow" })
        for (const builtin of BUILTIN_SUBAGENTS) a.permissions.push({ action: "subagent", resource: builtin, effect: "deny" })
      })
      editor.update(sk, (a: any) => {
        a.name = sk
        a.mode = "subagent"
        a.hidden = true
        a.description = sidekickDescription(p.sidekick)
        a.model = { providerID: sidekick.providerID, id: sidekick.id, ...(sidekick.variant ? { variant: sidekick.variant } : {}) }
        a.system =
          (p.sidekick_prompt ?? readPrompt(p.sidekick_prompt_file) ?? SIDEKICK_PROMPT) +
          (p.sidekick_prompt_append ? `\n\n${p.sidekick_prompt_append}` : "")
        if (p.sidekick_steps) a.steps = p.sidekick_steps
        if (p.sidekick_options) a.request.settings = { ...a.request.settings, ...p.sidekick_options }
        a.permissions.push({ action: "subagent", resource: "*", effect: "deny" })
        for (const t of OWN_TOOLS) a.permissions.push({ action: t, resource: "*", effect: "deny" })
      })
    }
  })

  // OpenCode lists the subagents the agent may start in the subagent tool's description, but skips
  // hidden ones, so the sidekick never shows up there and the lead reaches for explore/general instead.
  const listSidekick = (event: any, name: string) => {
    const tool = event.tools?.subagent
    if (!tool || typeof tool.description !== "string") return
    const sk = sidekickOf(name)
    if (tool.description.includes(`- ${sk}:`)) return
    tool.description +=
      `\n\nYour sidekick (prefer it over every other subagent):\n- ${sk}: ${sidekickDescription(presets()[name]?.sidekick)} ` +
      `Without sessionID the call goes to a free sidekick, or starts a new one when all are busy. ` +
      `Agent ${NEW_SIDEKICK} starts a fresh one with an empty context.`
  }

  await ctx.session.hook("context", async (event: any) => {
    // Settings > Agents "extra instructions": added to the request, so built-in prompts stay as they are.
    const extra = event.agent && !managed().includes(event.agent) ? merged(overrideLayers, event.agent).prompt_append : undefined
    if (extra) event.system.push({ type: "text", text: extra })

    if (presets()[event.agent]) {
      active.set(event.sessionID, event.agent)
      listSidekick(event, event.agent)
      return
    }
    // A "(Fusion)" model picked with another agent: add the lead prompt to that request.
    const name = entryKeys().get(`${event.model?.providerID}/${event.model?.id}`)
    if (!name) {
      active.delete(event.sessionID)
      return
    }
    active.set(event.sessionID, name)
    event.system.push({ type: "text", text: leadSystem(name) })
    listSidekick(event, name)
  })

  // ---------------------------------------------------------------- tools ---

  await ctx.tool.transform((tools: any) => {
    tools.add({
      name: "subagent_status",
      options: { codemode: false },
      description:
        "Show what a subagent is doing or did: state (running, finished, stopped, failed), tool calls, files changed and its latest message. Without sessionID, lists every subagent of this session.",
      input: {
        type: "object",
        properties: { sessionID: { type: "string", description: "Subagent sessionID. Omit to list all subagents of this session." } },
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        if (input?.sessionID) return { content: await report(input.sessionID, "Progress since its latest brief:") }
        const kids = await children(context.sessionID)
        if (!kids.length) return { content: "This session has no subagents." }
        const lines: string[] = []
        for (const k of kids) {
          const s = await snapshot(k.id)
          lines.push(`- ${k.id} · ${k.agent ?? s.agent ?? "?"} · ${s.state} · ${s.tools.length} tool calls · ${k.title ?? ""}`)
        }
        return { content: ["Subagents of this session:", ...lines].join("\n") }
      },
    })
    tools.add({
      name: "subagent_cancel",
      options: { codemode: false },
      description:
        'Stop a running subagent and return what it did so far (tool calls, files changed, latest message). Its context is kept, so you can continue it later by calling subagent with the same sessionID. sessionID "all" stops every running subagent of this session.',
      input: {
        type: "object",
        properties: { sessionID: { type: "string", description: 'Subagent sessionID, or "all"' } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        if (input.sessionID !== "all") return { content: await stop(input.sessionID) }
        const kids = await running(context.sessionID)
        if (!kids.length) return { content: "No subagents are running." }
        const out: string[] = []
        for (const k of kids) out.push(await stop(k.id))
        return { content: out.join("\n\n") }
      },
    })
    tools.add({
      name: "subagent_message",
      options: { codemode: false },
      description: [
        "Send a message to a running subagent (for example a background sidekick) without waiting for it. You choose when it reads it:",
        '- "now": interrupt the step it is on and read the message right away. Use it when its current direction is wrong and further work would be wasted. Finished tool calls and edits are kept.',
        '- "next_step" (default): read it after the step it is on. Use it for corrections and extra context.',
        '- "after_turn": read it after it finishes its current task. Use it for follow-up work.',
        "Only for running subagents. To give a finished one new work, call subagent with its sessionID.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", description: "Subagent sessionID. Omit to message your running sidekick (required when several are running)." },
          message: { type: "string", description: "What to tell it" },
          delivery: { type: "string", enum: [...DELIVERIES], description: 'When it reads the message. Default "next_step".' },
        },
        required: ["message"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => ({ content: await message(context.sessionID, context.agent, input) }),
    })
  })

  // Route sidekick calls: to a free sidekick, a new one when all are busy, or a fresh one on request.
  await ctx.tool.hook("execute.before", async (event: any) => {
    if (event.tool !== "subagent") return
    const name = presetFor(event.agent, event.sessionID)
    if (!name) return
    const input = { ...(event.input ?? {}) }
    const sk = sidekickOf(name)
    const fresh = input.agent === NEW_SIDEKICK
    // Also catches Build with a "(Fusion)" model, which keeps Build's own access to explore/general:
    // that work goes to a sidekick, on the sidekick model, and stays in its context.
    if (input.agent === "sidekick" || fresh || BUILTIN_SUBAGENTS.includes(input.agent)) input.agent = sk
    if (input.agent !== sk) return
    if (input.sessionID) {
      // OpenCode would push the brief into the task it is working on. Make that an explicit choice.
      if ((await snapshot(input.sessionID)).state === "running")
        throw new Error(
          `Sidekick ${input.sessionID} is still working on its current task. To add to that task, use subagent_message ` +
            `(choose when it reads it). To run this as a separate job, call subagent without sessionID: it goes to a ` +
            `free sidekick or starts a new one.`,
        )
      used(input.sessionID)
    } else if (!fresh) {
      // Parallel calls in one step pick one at a time, so each gets a different free sidekick.
      await pick(event.sessionID, async () => {
        const free = await freeSidekick(event.sessionID, name)
        if (free) {
          input.sessionID = free
          used(free)
        }
      })
    }
    // A session keeps the model it was created with, and continuing it only switches the model when one
    // is passed. So after the preset's sidekick model changes, move the persistent sidekick to the new one.
    const wanted = presets()[name]?.sidekick
    if (input.sessionID && wanted && !input.model) {
      const current = (await ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined))?.model
      try {
        const want = parseModel(wanted)
        if (current && (current.providerID !== want.providerID || current.id !== want.id || (want.variant && current.variant !== want.variant)))
          input.model = wanted
      } catch {}
    }
    input.description ??= "sidekick"
    event.input = input
  })

  await ctx.tool.hook("execute.after", async (event: any) => {
    const name = presetFor(event.agent, event.sessionID)

    if (event.tool === "subagent" && name) {
      const id = event.result?.metadata?.sessionID ?? (event.input as any)?.sessionID
      if (id && (event.input as any)?.agent === sidekickOf(name)) {
        lastUsed.set(id, Date.now())
        // A blocking call that returned means that sidekick is free again right away. A background one
        // keeps its claim until its brief shows up as running.
        if (event.status !== "completed" || event.result?.metadata?.status === "completed") claimed.delete(id)
        else claimed.set(id, Date.now())
      }
    }

    // A cancelled blocking subagent: attach its partial results.
    if (event.tool === "subagent" && event.status === "error") {
      const m = /Subagent cancelled \(sessionID: ([^)]+)\)/.exec(event.error?.message ?? "")
      if (m) {
        const partial = await report(m[1], "It was cancelled before finishing. Partial results:").catch(() => "")
        if (partial) {
          try {
            event.error.message = `${event.error.message}\n\n${partial}`
          } catch {}
        }
      }
    }

    // Remind a fusion lead that edits files itself, once per user message.
    if (event.status === "completed" && EDIT_TOOLS.has(event.tool) && name) {
      if (!nudgesEdits(presets()[name]) || nudged.has(event.sessionID)) return
      nudged.add(event.sessionID)
      const content = event.result?.content
      event.result = {
        ...event.result,
        content:
          typeof content === "string" || content === undefined
            ? `${content ?? ""}\n\n${DIRECT_EDIT_NUDGE}`
            : [...content, { type: "text", text: DIRECT_EDIT_NUDGE }],
      }
    }
  })

  await ctx.session.hook("prompt", async (event: any) => {
    nudged.delete(event.sessionID)
  })

  // ------------------------------------------------------------- commands ---

  await ctx.command.transform((editor: any) => {
    editor.add({
      name: "agents",
      description: "Show the subagents of this session and what each one has done",
      execute: async ({ sessionID }: any) => {
        const kids = await children(sessionID)
        const parts = kids.length ? await Promise.all(kids.map((k: any) => report(k.id, k.title ?? ""))) : ["This session has no subagents."]
        await ctx.session.synthetic({ sessionID, description: "Subagent status", text: parts.join("\n\n"), resume: false })
      },
    })
    editor.add({
      name: "agents-stop",
      description: "Stop all running subagents of this session and keep their partial results",
      execute: async ({ sessionID }: any) => {
        const kids = await running(sessionID)
        const parts = kids.length ? await Promise.all(kids.map((k: any) => stop(k.id))) : ["No subagents were running."]
        await ctx.session.synthetic({ sessionID, description: "Stopped subagents", text: parts.join("\n\n"), resume: false })
      },
    })
  })

  // ------------------------------------------------- settings page (RPC) ---

  /** Models the user can pick (tool-capable, enabled, no Fusion entries), and every "provider/id" that exists. */
  async function modelList() {
    const keys = entryKeys()
    const fusionProviders = new Set([...keys.keys()].map((k) => k.slice(0, k.indexOf("/"))))
    const [models, providers] = await Promise.all([
      ctx.model.list().catch(() => ({ data: [] })),
      ctx.provider.list().catch(() => ({ data: [] })),
    ])
    const all = (models?.data ?? []) as any[]
    const exists = new Set(all.map((m) => `${m.providerID}/${m.id}`))
    const providerName = new Map<string, string>(((providers?.data ?? []) as any[]).map((p) => [p.id, p.name ?? p.id]))
    const options = all
      .filter((m) => m.enabled !== false && m.capabilities?.tools !== false && !fusionProviders.has(m.providerID))
      .map((m) => ({
        value: `${m.providerID}/${m.id}`,
        label: `${providerName.get(m.providerID) ?? m.providerID} · ${m.name ?? m.id}`,
        variants: ((m.variants ?? []) as any[]).map((v) => String(v?.id ?? v)).filter(Boolean),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return { options, exists, keys }
  }

  async function state(): Promise<FusionState> {
    const { options, exists, keys } = await modelList()
    return {
      config,
      models: options.map(({ value, label }): ModelOption => ({ value, label })),
      path: configPath(),
      // Only entries that really are in the model list.
      entries: Object.fromEntries([...keys].filter(([key]) => exists.has(key)).map(([key, name]) => [name, key])),
      warnings: [...new Set(warnings)],
    }
  }

  async function agentsState(): Promise<AgentsState> {
    const { options, exists } = await modelList()
    // The transform fills baseAgents when agents first load; make sure they have.
    if (!baseAgents.length) await ctx.agent.list?.().catch(() => undefined)
    const problems = [...overrideErrors, ...overrideWarnings]
    // Same wording as the transform's warning, so the two collapse into one.
    for (const layer of overrideLayers)
      for (const [id, o] of Object.entries(layer.agents ?? {}))
        if (o.model && !exists.has(o.model.split("#")[0]) && !managed().includes(id))
          problems.push(`${id}: model ${o.model} isn't in the model list, so it keeps its own model`)
    return {
      agents: [...baseAgents].sort((a, b) => a.id.localeCompare(b.id)),
      global: overrideLayers[0],
      project: overrideLayers[1],
      models: options,
      paths: overridePaths,
      directory,
      managed: managed(),
      warnings: [...new Set(problems)],
    }
  }

  /** Re-reads fusion.jsonc and reloads providers, then models (entries live in both), then agents. */
  async function reloadFusion() {
    loaded = loadConfig(ctx.options)
    config = loaded.config
    warnings = loaded.error ? [loaded.error] : []
    // Each reload tells the app to refetch that list, so new entries show up without restarting it.
    await ctx.provider.reload()
    await ctx.model.reload?.()
    await ctx.agent.reload()
  }

  // A save made in one project only reloads that project's plugin instance. Every instance watches the
  // shared files, so the others follow. Its own writes are skipped by their modification time.
  const ownWrites = new Map<string, number>()
  const mtime = (path: string) => {
    try {
      return existsSync(path) ? statSync(path).mtimeMs : 0
    } catch {
      return 0
    }
  }
  const wrote = (path: string) => ownWrites.set(path, mtime(path))
  const watchers: [string, (cur: any, prev: any) => void][] = []
  const watch = (path: string, onChange: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const listener = (cur: any, prev: any) => {
      if (cur.mtimeMs === prev.mtimeMs) return
      if (ownWrites.get(path) === cur.mtimeMs) return
      clearTimeout(timer)
      timer = setTimeout(() => void onChange().catch(() => {}), 300)
    }
    watchFile(path, { interval: 1000, persistent: false }, listener)
    watchers.push([path, listener])
  }
  const reloadOverrides = async () => {
    loadOverrideLayers()
    await ctx.agent.reload()
  }
  watch(overridePaths.global, reloadOverrides)
  watch(overridePaths.project, reloadOverrides)
  watch(configPath(), reloadFusion)

  await ctx.rpc.register(FusionRpc, {
    state: async () => state(),
    save: async (input: any, rc: any) => {
      const next = input?.config as FusionConfig
      const problem = next && typeof next === "object" ? validate(next) : "missing config"
      if (problem) return rc.error("invalid", problem, { message: problem })
      saveConfig(next)
      wrote(configPath())
      await reloadFusion()
      return state()
    },
    agentsState: async () => agentsState(),
    agentsSave: async (input: any, rc: any) => {
      const next = input?.overrides as AgentOverrides
      const problem = validateOverrides(next)
      if (problem) return rc.error("invalid", problem, { message: problem })
      const path = input?.scope === "project" ? overridePaths.project : overridePaths.global
      saveOverrides(path, next)
      wrote(path)
      await reloadOverrides()
      return agentsState()
    },
  })

  return () => {
    for (const [path, listener] of watchers) unwatchFile(path, listener)
  }
}

export default { id: PLUGIN_ID, setup }
