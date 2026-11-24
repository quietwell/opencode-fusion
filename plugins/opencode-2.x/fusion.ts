/**
 * opencode-fusion for OpenCode 2.x
 *
 * OpenCode 2.x already has background subagents, follow-ups by sessionID and
 * completion notices. This plugin adds what is missing:
 *
 * - Fusion presets (fusion.jsonc): each becomes a primary "lead" agent plus a
 *   hidden "sidekick" subagent, each on its own model.
 * - One persistent sidekick per lead session: subagent calls to the sidekick
 *   are routed to the same child session, so its context carries over.
 * - subagent_status / subagent_cancel: progress of a running subagent, and
 *   stopping it while keeping what it did (tool calls, files, last message).
 *   A cancelled blocking subagent call also reports its partial results.
 * - /agents and /agents-stop commands that work without the model.
 * - A reminder when a fusion lead edits files itself.
 *
 * No runtime imports: OpenCode accepts plain objects and JSON Schema inputs.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

// ---------------------------------------------------------------- config ---

type Preset = {
  description?: string
  lead: string
  sidekick: string
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
  nudge_direct_edits?: boolean
}

type FusionConfig = {
  presets?: Record<string, Preset>
  max_report_chars?: number
}

function stripJsonc(s: string): string {
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

const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")

function loadConfig(options: Record<string, unknown> | undefined): FusionConfig {
  const merged: FusionConfig = { presets: {} }
  const layers: FusionConfig[] = []
  for (const file of ["fusion.jsonc", "fusion.json"]) {
    const path = join(configDir(), file)
    if (!existsSync(path)) continue
    try {
      layers.push(JSON.parse(stripJsonc(readFileSync(path, "utf8"))))
    } catch (e) {
      console.error(`[opencode-fusion] cannot parse ${path}: ${(e as Error).message}`)
    }
  }
  if (options && Object.keys(options).length) layers.push(options as FusionConfig)
  for (const { presets, ...rest } of layers) {
    Object.assign(merged, rest)
    for (const [name, p] of Object.entries(presets ?? {})) merged.presets![name] = { ...merged.presets![name], ...p }
  }
  return merged
}

function readPrompt(path: string | undefined): string | undefined {
  if (!path) return undefined
  return readFileSync(isAbsolute(path) ? path : join(configDir(), path), "utf8")
}

/** "provider/model" or "provider/model#variant" -> Model.Ref */
function modelRef(spec: string) {
  const [main, variant] = spec.split("#")
  const slash = main.indexOf("/")
  if (slash < 1) throw new Error(`model "${spec}" must look like provider/model`)
  return { providerID: main.slice(0, slash), id: main.slice(slash + 1), ...(variant ? { variant } : {}) }
}

// --------------------------------------------------------------- prompts ---

const leadPrompt = (sidekick: string) => `You are the lead of a two-model team. You talk to the user, plan the work, and direct one persistent helper: the \`${sidekick}\` subagent. It runs on a much cheaper model, so hand it implementation, exploration and verification by default. Your own turns are expensive: spend them on design, briefs and review.

## The sidekick
- Start it with the \`subagent\` tool, agent \`${sidekick}\`. There is one sidekick for this whole session: every call reaches the same subagent, and it keeps its context between handoffs, so follow-up briefs can build on what it already knows. It shares your filesystem and repos.
- It never sees the user's messages or this conversation. It only knows what your briefs tell it.
- Calls block by default and return its report. Use \`background: true\` only when you have real parallel work to do; you are notified when it finishes, so don't poll. Calling it again while it runs sends your message into its running task.
- \`subagent_status\` shows what a running subagent has done so far. \`subagent_cancel\` stops it and returns its partial results; its context is kept, so a later brief continues from there.
- Other subagents are available through the same \`subagent\` tool for independent parallel jobs.

## What you keep for yourself
- Talking to the user. Present all results as your own work, and don't mention the sidekick unless the user asks about it.
- Planning and design decisions. Commits, pushes, PRs, and anything that needs the user's authority.
- Correctness-critical writing: queries against real data, prompts, rubrics, eval or grading code, and pipeline or threshold config. Write these yourself, to a file or word for word in the brief. The sidekick runs them; it never writes them.
- Tiny changes you can make and confirm in one or two of your own turns.

## Before you brief
- Investigate until you are confident in the plan. Hold it to a higher bar than if you were doing the work yourself, because the sidekick will carry out what you wrote, including your mistakes.
- Every claim the plan depends on is either verified, or marked in the brief as a hypothesis for the sidekick to check.
- Don't send a warm-up handoff (environment checks, baselines) while you are still designing. Settle the plan, then hand off the whole step in one call.
- For a broad search where you only need the conclusion, brief the sidekick. For a single lookup where you already know the file, do it yourself.

## Writing a brief
1. Goal and why.
2. Exact files, functions and paths to work on.
3. The decided change. Where you know the edit, write it as code. Don't leave alternatives for it to choose between, because it will guess.
4. Hard edge cases and constraints, including what not to touch.
5. Done criteria: each verification command as a runnable line, plus what result counts as passing. Ask for narrow checks. Run a full test suite at most once, at the end.
6. What to report: files changed, commands run with their results, decisions it made, open questions.

## After a handoff
- Read the full diff and give it a verdict before your next action. Don't redo verification it already showed evidence for unless something looks wrong.
- Collect all your feedback and send it as one rework brief, not several small ones.
- If it reports an environment blocker, tell it how to get unblocked rather than fixing it yourself, unless the fix needs your authority.
- If it fails the same brief twice or goes in circles, take the task over and do it yourself.
- Because the sidekick did the hands-on work, you may be asked about details you're unsure of. Check the code instead of guessing.`

const SIDEKICK_PROMPT = `You are the sidekick in a two-model team. A lead agent plans the work and sends you briefs; you carry them out: exploring the codebase, implementing changes and verifying results. You share the lead's filesystem and repos. You never talk to the user, and you don't commit, push or open PRs unless the brief says to.

You keep your context across handoffs. Don't redo or re-verify work you already finished. The lead may send a new message while you work: fold it into what you're doing rather than starting over.

## Following the brief
- Treat the brief, and any values or files it points to, as authoritative. Don't recompute or re-verify them unless they are clearly inconsistent.
- Make sensible calls on small mismatches (a wrong line number, a renamed symbol) and note them in your report. Stop and ask only if the brief's core approach can't work with the code as it is, or you are truly blocked. Put all questions in one list at the end.
- Stay in scope. Don't refactor or "improve" things the brief didn't ask for.

## Investigations
Code that could cause a symptom is not proof that it did. Before ranking a cause, check that its code path actually runs in the reported scenario, and make at least one attempt to disprove your top candidate. Only say "confirmed" with evidence for every link in the chain; mark links you didn't check as unverified.

## Verification
- Finish all planned edits first, then run one combined verification pass. Don't run tests, lint or git status between small edits.
- Use the narrowest command that covers your change. Don't re-run a check that already passed unless a later edit could have broken it.
- Before reporting, compare your diff against the brief and fix gaps yourself.
- If the same failure survives two or three attempts and you have no clear next step, stop and escalate with what you tried and your best guess at the cause.
- If the environment blocks verification, try reasonable workarounds first. If you still can't verify, say so plainly ("implemented, can't verify because X") with the exact command and error.

## Report format
1. Status: done, partly done, or blocked.
2. Files changed, one line each on what changed.
3. Verification: commands run and the key output (pass/fail counts, errors).
4. Decisions you made yourself, and anything left unverified.
5. Questions for the lead, if any.
Keep it short. The lead reads the diff itself.`

const DIRECT_EDIT_NUDGE = `<fusion-reminder>You edited a file yourself instead of handing it to the sidekick. Delegate implementation and verification by default. Only make an edit yourself when it is trivially small (one or two turns including checking it) or correctness-critical. For anything else, put the effort into a brief the sidekick can carry out exactly.</fusion-reminder>`

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])
const OWN_TOOLS = ["subagent_status", "subagent_cancel"]

// ---------------------------------------------------------------- plugin ---

type Ctx = any

async function setup(ctx: Ctx) {
  const config = loadConfig(ctx.options)
  const presets = config.presets ?? {}
  const maxChars = config.max_report_chars ?? 30000
  const sidekickOf = (lead: string) => `${lead}-sidekick`
  const leadOf = (agent: string | undefined) => (agent && presets[agent] ? presets[agent] : undefined)
  /** lead session -> its sidekick child session */
  const sidekickSession = new Map<string, string>()
  const nudged = new Set<string>()

  // ---- reading a child session ----

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

  /** Progress snapshot of a child since its latest prompt. */
  async function snapshot(sessionID: string) {
    const all = await messages(sessionID)
    let start = 0
    for (let i = all.length - 1; i >= 0; i--)
      if (all[i].type === "user" || all[i].type === "synthetic") {
        start = i
        break
      }
    const recent = all.slice(start)
    const tools: string[] = []
    const files = new Set<string>()
    let lastText = ""
    let cost = 0
    let model = ""
    let agent = ""
    for (const m of recent) {
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
      last?.type === "idle" ? (last.outcome === "interrupted" ? "stopped" : last.outcome === "failed" ? "failed" : "finished") : "running"
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
    return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text
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
    const kids = await children(parentID)
    const out: any[] = []
    for (const k of kids) if ((await snapshot(k.id)).state === "running") out.push(k)
    return out
  }

  // ---- agents ----

  await ctx.agent.transform((editor: any) => {
    const leads = Object.keys(presets)
    const sidekicks = leads.map(sidekickOf)

    // Nobody but the matching lead may start a fusion sidekick.
    for (const a of editor.list()) {
      if (leads.includes(a.id) || sidekicks.includes(a.id)) continue
      editor.update(a.id, (item: any) => {
        for (const s of sidekicks) item.permissions.push({ action: "subagent", resource: s, effect: "deny" })
        if (item.mode === "subagent") for (const t of OWN_TOOLS) item.permissions.push({ action: t, resource: "*", effect: "deny" })
      })
    }

    for (const [name, p] of Object.entries(presets)) {
      if (!p.lead || !p.sidekick) {
        console.error(`[opencode-fusion] preset ${name} needs "lead" and "sidekick"; skipped`)
        continue
      }
      const sk = sidekickOf(name)
      editor.update(name, (a: any) => {
        a.name = name
        a.mode = "primary"
        a.hidden = false
        a.description = p.description ?? `Fusion: ${p.lead} leads, ${p.sidekick} executes`
        a.model = modelRef(p.lead)
        a.system =
          (p.lead_prompt ?? readPrompt(p.lead_prompt_file) ?? leadPrompt(sk)) +
          (p.lead_prompt_append ? `\n\n${p.lead_prompt_append}` : "")
        if (p.color) a.color = p.color
        if (p.lead_steps) a.steps = p.lead_steps
        if (p.lead_options) a.request.settings = { ...a.request.settings, ...p.lead_options }
        for (const other of sidekicks)
          if (other !== sk) a.permissions.push({ action: "subagent", resource: other, effect: "deny" })
        a.permissions.push({ action: "subagent", resource: sk, effect: "allow" })
      })
      editor.update(sk, (a: any) => {
        a.name = sk
        a.mode = "subagent"
        a.hidden = true
        a.description = `Fusion sidekick for ${name} (${p.sidekick}).`
        a.model = modelRef(p.sidekick)
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

  // ---- tools ----

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
  })

  // Route sidekick calls of a fusion lead to its one persistent sidekick session.
  await ctx.tool.hook("execute.before", async (event: any) => {
    if (event.tool !== "subagent" || !leadOf(event.agent)) return
    const input = { ...(event.input ?? {}) }
    const sk = sidekickOf(event.agent)
    if (input.agent === "sidekick") input.agent = sk
    if (input.agent !== sk) return
    if (!input.sessionID) {
      let existing = sidekickSession.get(event.sessionID)
      if (!existing) {
        // After a restart: find the sidekick child by its agent.
        const kids = await children(event.sessionID).catch(() => [])
        existing = kids.find((k: any) => k.agent === sk)?.id
      }
      if (existing) input.sessionID = existing
    }
    input.description ??= "sidekick"
    event.input = input
  })

  await ctx.tool.hook("execute.after", async (event: any) => {
    // Remember the sidekick session.
    if (event.tool === "subagent" && leadOf(event.agent)) {
      const id = event.status === "completed" ? event.result?.metadata?.sessionID : undefined
      const agent = (event.input as any)?.agent
      if (id && agent === sidekickOf(event.agent)) sidekickSession.set(event.sessionID, id)
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

    // Remind a fusion lead that edits files itself, once per user turn.
    if (event.status === "completed" && EDIT_TOOLS.has(event.tool)) {
      const p = leadOf(event.agent)
      if (!p || p.nudge_direct_edits === false || nudged.has(event.sessionID)) return
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

  // ---- commands (run without the model) ----

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
}

export default { id: "opencode-fusion", setup }
