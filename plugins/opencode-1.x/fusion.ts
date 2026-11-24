/**
 * opencode-fusion: lead + sidekick agents and cancelable background subagents.
 *
 * - Presets in fusion.jsonc become selectable primary agents (the lead) with a
 *   hidden paired subagent (the sidekick), each on its own model.
 * - `sidekick`: one persistent helper per lead session. Its context survives
 *   across handoffs; a new brief sent while it works is injected mid-task.
 * - `agent_spawn` / `agent_read` / `agent_cancel` / `agent_list`: run any
 *   subagent in the background, read progress, or stop it and keep what it
 *   already did.
 */
import { tool, type Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------- config ---

type Preset = {
  description?: string
  /** Lead model, "provider/model". */
  lead: string
  /** Sidekick model, "provider/model". */
  sidekick: string
  /** Provider options for each side (e.g. reasoning effort), passed as agent options. */
  lead_options?: Record<string, unknown>
  sidekick_options?: Record<string, unknown>
  /** Replace the built-in prompts entirely, inline or from a file path. */
  lead_prompt?: string
  sidekick_prompt?: string
  lead_prompt_file?: string
  sidekick_prompt_file?: string
  /** Extra instructions appended to the built-in prompts. */
  lead_prompt_append?: string
  sidekick_prompt_append?: string
  color?: string
  /** Max agentic steps per turn for each side. */
  lead_steps?: number
  sidekick_steps?: number
  /** Remind the lead when it edits files itself. Default true. */
  nudge_direct_edits?: boolean
  /** Hide the built-in `task` tool from the lead so it uses cancelable agents. Default true. */
  disable_task_tool?: boolean
  /** How long a blocking handoff waits before moving to the background. Default 1800. */
  block_timeout_s?: number
}

type FusionConfig = {
  presets?: Record<string, Preset>
  /** Expose agent_spawn/agent_read/agent_cancel/agent_list to every primary agent. Default true. */
  background_agents?: boolean
  /** Max characters of a report returned to the lead. Default 30000. */
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

function readConfigFile(path: string): FusionConfig | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(stripJsonc(readFileSync(path, "utf8")))
  } catch (e) {
    throw new Error(`opencode-fusion: cannot parse ${path}: ${(e as Error).message}`)
  }
}

function loadConfig(directory: string, options?: Record<string, unknown>): FusionConfig {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const layers = [
    readConfigFile(join(configHome, "opencode", "fusion.jsonc")),
    readConfigFile(join(configHome, "opencode", "fusion.json")),
    readConfigFile(join(directory, ".opencode", "fusion.jsonc")),
    readConfigFile(join(directory, ".opencode", "fusion.json")),
    options as FusionConfig | undefined,
  ].filter(Boolean) as FusionConfig[]
  const merged: FusionConfig = { presets: {} }
  for (const layer of layers) {
    const { presets, ...rest } = layer
    Object.assign(merged, rest)
    for (const [name, p] of Object.entries(presets ?? {})) {
      merged.presets![name] = { ...merged.presets![name], ...p }
    }
  }
  return merged
}

function readPromptFile(path: string | undefined, directory: string): string | undefined {
  if (!path) return undefined
  const full = /^([a-zA-Z]:[\\/]|[\\/])/.test(path) ? path : join(directory, path)
  return readFileSync(full, "utf8")
}

// --------------------------------------------------------------- prompts ---

const LEAD_PROMPT = `You are the lead of a two-model team. You talk to the user, plan the work, and direct one persistent helper through the \`sidekick\` tool. The sidekick runs on a much cheaper model, so hand it implementation, exploration and verification by default. Your own turns are expensive: spend them on design, briefs and review.

## The sidekick
- There is one sidekick for this whole session. It keeps its context between handoffs, so follow-up briefs can build on what it already knows. It shares your filesystem and repos.
- It never sees the user's messages or this conversation. It only knows what your briefs tell it.
- \`sidekick\` blocks by default and returns the sidekick's report. Use \`block: false\` only when you have real parallel work to do. The report is then delivered to you automatically when it finishes; don't poll. Use \`agent_read\` with id "sidekick" to check progress or wait (\`block: true\`).
- Calling \`sidekick\` while it is still working injects your new message into its running task. Use that to redirect or add information.
- \`agent_cancel\` with id "sidekick" stops it and returns what it has done so far. Its context stays intact, so a later brief can continue from there.
- For independent parallel jobs you can also start other subagents with \`agent_spawn\` (see \`agent_list\`).

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

// ----------------------------------------------------------------- state ---

type RunStatus = "running" | "done" | "error" | "canceled"

type Run = {
  id: string
  parentID: string
  sessionID: string
  agent: string
  status: RunStatus
  handoffs: number
  handoffStart: number
  startedAt: number
  /** A tool call is waiting on this run right now. */
  blocking: boolean
  /** Deliver the report to the parent automatically when the run finishes. */
  notify: boolean
  delivered: boolean
  cancelRequested: boolean
  error?: string
}

const FUSION_TOOLS = ["sidekick", "agent_spawn", "agent_read", "agent_cancel", "agent_list"]
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])
const BUILTIN_AGENTS = ["build", "plan", "general", "explore"]
const SIDEKICK_ID = "sidekick"
const SIDEKICK_TITLE = "fusion: sidekick"

// ---------------------------------------------------------------- plugin ---

export const FusionPlugin: Plugin = async ({ client, directory }, options) => {
  let config = loadConfig(directory, options)
  const presetOf = (agent?: string) => (agent ? config.presets?.[agent] : undefined)
  const maxReport = () => config.max_report_chars ?? 30000

  const runs = new Map<string, Map<string, Run>>() // parent session -> id -> run
  const bySession = new Map<string, Run>() // child session -> run
  const waiters = new Map<string, Set<() => void>>() // child session -> resolvers
  const sessionInfo = new Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>()
  const busy = new Set<string>()
  const pendingNotes = new Map<string, string[]>() // parent session -> reports
  const nudged = new Set<string>()
  let counter = 0

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: "fusion", level, message, extra } }).catch(() => {})

  // ---- helpers ----

  async function messagesSince(sessionID: string, since: number) {
    const res = await client.session.messages({ path: { id: sessionID } })
    const all = (res.data ?? []) as Array<{ info: any; parts: any[] }>
    return all.filter((m) => (m.info?.time?.created ?? 0) >= since - 2000)
  }

  async function isBusy(sessionID: string): Promise<boolean> {
    const res = await client.session.status({})
    const st = (res.data as Record<string, { type: string }> | undefined)?.[sessionID]
    return !!st && st.type !== "idle"
  }

  /** True when the child has an assistant reply for this handoff that finished. */
  async function handoffFinished(run: Run): Promise<boolean> {
    if (await isBusy(run.sessionID)) return false
    const msgs = await messagesSince(run.sessionID, run.handoffStart)
    const last = msgs[msgs.length - 1]
    if (!last) return false
    return last.info.role === "assistant" && !!last.info.time?.completed
  }

  const finalizing = new Set<Run>()
  async function finalize(run: Run) {
    if (run.status !== "running" || finalizing.has(run)) return
    finalizing.add(run)
    try {
      await finalizeInner(run)
    } finally {
      finalizing.delete(run)
    }
  }

  async function finalizeInner(run: Run) {
    const msgs = await messagesSince(run.sessionID, run.handoffStart).catch(() => [])
    const lastAssistant = [...msgs].reverse().find((m) => m.info.role === "assistant")
    const err = lastAssistant?.info?.error
    if (run.cancelRequested || err?.name === "MessageAbortedError") run.status = "canceled"
    else if (err) {
      run.status = "error"
      run.error = err.data?.message ?? err.name ?? "unknown error"
    } else run.status = "done"
    for (const resolve of waiters.get(run.sessionID) ?? []) resolve()
    waiters.delete(run.sessionID)
    if (run.notify && !run.blocking && !run.delivered && run.status !== "canceled") {
      run.delivered = true
      const note = `<agent-report id="${run.id}" agent="${run.agent}">\nA background agent finished. Its report:\n\n${await report(run)}\n</agent-report>`
      const list = pendingNotes.get(run.parentID) ?? []
      list.push(note)
      pendingNotes.set(run.parentID, list)
      await deliver(run.parentID)
    }
  }

  async function deliver(parentID: string) {
    const notes = pendingNotes.get(parentID)
    if (!notes?.length) return
    if (busy.has(parentID) || (await isBusy(parentID))) return // retried on the parent's next idle
    pendingNotes.delete(parentID)
    const info = sessionInfo.get(parentID)
    await client.session
      .promptAsync({
        path: { id: parentID },
        body: {
          agent: info?.agent,
          model: info?.model,
          parts: [{ type: "text", text: notes.join("\n\n"), synthetic: true }],
        },
      })
      .catch((e) => log("error", "failed to deliver agent report", { error: String(e) }))
  }

  async function onIdle(sessionID: string) {
    busy.delete(sessionID)
    const run = bySession.get(sessionID)
    if (run && run.status === "running" && (run.cancelRequested || (await handoffFinished(run)))) await finalize(run)
    if (pendingNotes.has(sessionID)) await deliver(sessionID)
  }

  /** Wait until the run leaves "running", the timeout passes, or the caller aborts. */
  async function waitFor(
    run: Run,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onTick?: () => Promise<void>,
  ): Promise<"finished" | "timeout" | "aborted"> {
    const deadline = Date.now() + timeoutMs
    while (run.status === "running") {
      if (signal?.aborted) return "aborted"
      if (Date.now() >= deadline) return "timeout"
      await new Promise<void>((resolve) => {
        const set = waiters.get(run.sessionID) ?? new Set()
        const done = () => {
          clearTimeout(timer)
          set.delete(done)
          signal?.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, Math.min(3000, Math.max(0, deadline - Date.now())))
        set.add(done)
        waiters.set(run.sessionID, set)
        signal?.addEventListener("abort", done)
      })
      // Polling fallback in case an event was missed.
      if (run.status === "running" && (await handoffFinished(run).catch(() => false))) await finalize(run)
      if (onTick) await onTick().catch(() => {})
    }
    return "finished"
  }

  function describeTool(part: any): string {
    const st = part.state ?? {}
    const input = st.input ?? {}
    const target = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.description ?? ""
    const label = st.title || (typeof target === "string" ? target : "")
    return `${part.tool}${label ? ` ${String(label).slice(0, 120)}` : ""} (${st.status ?? "?"})`
  }

  async function progress(run: Run) {
    const msgs = await messagesSince(run.sessionID, run.handoffStart)
    const tools: string[] = []
    const files = new Set<string>()
    let lastText = ""
    let cost = 0
    let model = ""
    for (const m of msgs) {
      if (m.info.role !== "assistant") continue
      cost += m.info.cost ?? 0
      model = `${m.info.providerID}/${m.info.modelID}`
      for (const p of m.parts) {
        if (p.type === "tool") {
          tools.push(describeTool(p))
          const fp = p.state?.input?.filePath
          if (EDIT_TOOLS.has(p.tool) && fp && p.state?.status === "completed") files.add(fp)
        } else if (p.type === "text" && p.text?.trim()) lastText = p.text
      }
    }
    return { tools, files: [...files], lastText, cost, model, msgs }
  }

  function header(run: Run, model: string, cost: number) {
    const secs = Math.round((Date.now() - run.handoffStart) / 1000)
    const time = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`
    return `[${run.id} · ${run.agent}${model ? ` · ${model}` : ""} · ${run.status} · ${time}${cost ? ` · $${cost.toFixed(4)}` : ""}]`
  }

  function clip(text: string) {
    const max = maxReport()
    return text.length > max ? text.slice(0, max) + `\n…[truncated ${text.length - max} chars]` : text
  }

  /** Final report for a finished run, or a progress snapshot for a running/canceled one. */
  async function report(run: Run): Promise<string> {
    const p = await progress(run)
    const head = header(run, p.model, p.cost)
    if (run.status === "done") {
      const lastAssistant = [...p.msgs].reverse().find((m) => m.info.role === "assistant")
      const text = (lastAssistant?.parts ?? [])
        .filter((x: any) => x.type === "text" && !x.synthetic)
        .map((x: any) => x.text)
        .join("\n")
        .trim()
      if (text) return clip(`${head}\n${text}`)
    }
    const lines = [head]
    if (run.status === "done") lines.push("Finished without a final text report. What it did:")
    if (run.status === "running") lines.push("Still working. Progress so far:")
    if (run.status === "canceled") lines.push("Stopped before finishing. Partial results:")
    if (run.status === "error") lines.push(`Failed: ${run.error}. Partial results:`)
    lines.push(`Tool calls (${p.tools.length}):`, ...p.tools.slice(-30).map((t) => `- ${t}`))
    if (p.tools.length > 30) lines.splice(lines.length - 30, 0, `- … ${p.tools.length - 30} earlier calls`)
    if (p.files.length) lines.push(`Files edited: ${p.files.join(", ")}`)
    if (p.lastText) lines.push("Latest message from the agent:", p.lastText.slice(-4000))
    if (run.status === "canceled" || run.status === "error")
      lines.push(`Its context is kept. Send it a new message (same id) to continue from here.`)
    return clip(lines.join("\n"))
  }

  function registry(parentID: string) {
    let m = runs.get(parentID)
    if (!m) runs.set(parentID, (m = new Map()))
    return m
  }

  async function findChild(parentID: string, title: string): Promise<string | undefined> {
    const res = await client.session.children({ path: { id: parentID } }).catch(() => undefined)
    const kids = ((res?.data ?? []) as Array<{ id: string; title?: string; time?: { updated?: number } }>)
      .filter((s) => s.title === title)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    return kids[0]?.id
  }

  const childTools = Object.fromEntries([...FUSION_TOOLS, "task"].map((t) => [t, false]))

  /**
   * Start or continue a run. If the run is already working, the message is
   * injected into its running task instead.
   */
  async function handoff(opts: {
    parentID: string
    id: string
    agent: string
    message: string
    title: string
    reuseByTitle: boolean
  }): Promise<{ run: Run; injected: boolean }> {
    const reg = registry(opts.parentID)
    let run = reg.get(opts.id)

    if (run && run.status === "running") {
      await client.session.prompt({
        path: { id: run.sessionID },
        body: {
          agent: run.agent,
          noReply: true,
          tools: childTools,
          parts: [
            {
              type: "text",
              text: `[New message from the lead while you were working. Fold it into your current task rather than starting over, and cover it in your report.]\n\n${opts.message}`,
            },
          ],
        },
      })
      return { run, injected: true }
    }

    let fresh = false
    if (!run) {
      let sessionID = opts.reuseByTitle ? await findChild(opts.parentID, opts.title) : undefined
      if (!sessionID) {
        const created = await client.session.create({ body: { parentID: opts.parentID, title: opts.title } })
        if (!created.data) throw new Error(`could not create a child session: ${JSON.stringify(created.error)}`)
        sessionID = created.data.id
        fresh = true
      }
      run = {
        id: opts.id,
        parentID: opts.parentID,
        sessionID,
        agent: opts.agent,
        status: "done",
        handoffs: 0,
        handoffStart: Date.now(),
        startedAt: Date.now(),
        blocking: false,
        notify: false,
        delivered: true,
        cancelRequested: false,
      }
      reg.set(opts.id, run)
      bySession.set(sessionID, run)
    }

    run.status = "running"
    run.handoffs++
    run.handoffStart = Date.now()
    run.cancelRequested = false
    run.delivered = false
    run.notify = false
    run.error = undefined

    const preface = fresh
      ? "This is your first handoff, so you start fresh."
      : "You are continuing from your previous context. Don't redo work you already finished."
    const res = await client.session.promptAsync({
      path: { id: run.sessionID },
      body: { agent: opts.agent, tools: childTools, parts: [{ type: "text", text: `${preface}\n\n${opts.message}` }] },
    })
    if (res.error) {
      run.status = "error"
      run.error = JSON.stringify(res.error)
      throw new Error(`could not start ${opts.agent}: ${run.error}`)
    }
    return { run, injected: false }
  }

  async function cancel(run: Run): Promise<string> {
    if (run.status !== "running") return await report(run)
    run.cancelRequested = true
    run.notify = false
    run.delivered = true
    await client.session.abort({ path: { id: run.sessionID } }).catch(() => {})
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && (await isBusy(run.sessionID).catch(() => false)))
      await new Promise((r) => setTimeout(r, 500))
    await finalize(run)
    return await report(run)
  }

  /** Shared body for blocking waits from `sidekick`, `agent_spawn` and `agent_read`. */
  async function waitAndReport(run: Run, timeoutS: number, ctx: { abort: AbortSignal; metadata: any }) {
    run.blocking = true
    try {
      const outcome = await waitFor(run, timeoutS * 1000, ctx.abort, async () => {
        const p = await progress(run)
        ctx.metadata({
          title: `${run.id}: ${p.tools.length} tool calls${p.tools.length ? ` · ${p.tools[p.tools.length - 1]}` : ""}`,
        })
      })
      if (outcome === "aborted") {
        // The user interrupted the caller: stop the agent too, keep its context.
        await cancel(run)
        return `Interrupted by the user. ${run.id} was stopped; its context is intact.\n\n${await report(run)}`
      }
      if (outcome === "timeout") {
        run.notify = true
        return `${run.id} is still working after ${timeoutS}s and continues in the background. Its report will be delivered to you when it finishes.\n\n${await report(run)}`
      }
      run.delivered = true
      return await report(run)
    } finally {
      run.blocking = false
    }
  }

  async function subagentNames(): Promise<Map<string, string>> {
    const res = await client.app.agents({})
    const list = (res.data ?? []) as Array<{ name: string; mode: string; description?: string }>
    return new Map(list.filter((a) => a.mode !== "primary").map((a) => [a.name, a.description ?? ""]))
  }

  // ---- hooks ----

  return {
    config: async (cfg: any) => {
      config = loadConfig(directory, options)
      cfg.agent ??= {}
      const presetNames = Object.keys(config.presets ?? {})
      const sidekickNames = new Set(presetNames.map((n) => `${n}-sidekick`))

      // Tool access is controlled through permission rules (the legacy `tools` map is ignored).
      const deny = (agent: any, toolIDs: string[]) => {
        const perm =
          agent.permission && typeof agent.permission === "object"
            ? agent.permission
            : agent.permission
              ? { "*": agent.permission }
              : {}
        for (const t of toolIDs) perm[t] = "deny"
        agent.permission = perm
        return agent
      }

      // Everyone except fusion leads loses `sidekick`; children get no fusion tools.
      for (const name of new Set([...BUILTIN_AGENTS, ...Object.keys(cfg.agent)])) {
        if (presetNames.includes(name) || sidekickNames.has(name)) continue
        const a = (cfg.agent[name] ??= {})
        const isSub = a.mode === "subagent" || ["general", "explore"].includes(name)
        deny(a, isSub || config.background_agents === false ? FUSION_TOOLS : ["sidekick"])
      }

      for (const [name, p] of Object.entries(config.presets ?? {})) {
        if (!p.lead || !p.sidekick) {
          log("warn", `preset ${name} needs both "lead" and "sidekick" models; skipped`)
          continue
        }
        const leadPrompt =
          (p.lead_prompt ?? readPromptFile(p.lead_prompt_file, directory) ?? LEAD_PROMPT) +
          (p.lead_prompt_append ? `\n\n${p.lead_prompt_append}` : "")
        const sidekickPrompt =
          (p.sidekick_prompt ?? readPromptFile(p.sidekick_prompt_file, directory) ?? SIDEKICK_PROMPT) +
          (p.sidekick_prompt_append ? `\n\n${p.sidekick_prompt_append}` : "")

        cfg.agent[name] = deny(
          {
            ...cfg.agent[name],
            mode: "primary",
            description: p.description ?? `Fusion: ${p.lead} leads, ${p.sidekick} executes`,
            model: p.lead,
            prompt: leadPrompt,
            ...(p.color ? { color: p.color } : {}),
            ...(p.lead_options ? { options: p.lead_options } : {}),
            ...(p.lead_steps ? { steps: p.lead_steps } : {}),
          },
          p.disable_task_tool === false ? [] : ["task"],
        )
        cfg.agent[`${name}-sidekick`] = deny(
          {
            ...cfg.agent[`${name}-sidekick`],
            mode: "subagent",
            hidden: true,
            description: `Fusion sidekick for ${name} (${p.sidekick}). Started only through the sidekick tool.`,
            model: p.sidekick,
            prompt: sidekickPrompt,
            ...(p.sidekick_options ? { options: p.sidekick_options } : {}),
            ...(p.sidekick_steps ? { steps: p.sidekick_steps } : {}),
          },
          [...FUSION_TOOLS, "task"],
        )
      }

      cfg.command ??= {}
      cfg.command["agents"] ??= {
        description: "Status of the sidekick and background agents in this session",
        template:
          "Call agent_list, then give me a short status of each agent it shows: what it is doing and how far along it is. Don't start or stop anything.",
      }
      cfg.command["agents-stop"] ??= {
        description: "Stop all running background agents and show what they did so far",
        template:
          'Call agent_cancel with id "all". Then summarize, per agent, what it had finished, what it was in the middle of, and which files it edited. Don\'t restart anything unless I ask.',
      }
    },

    "chat.message": async (input) => {
      sessionInfo.set(input.sessionID, { agent: input.agent, model: input.model })
      nudged.delete(input.sessionID)
    },

    event: async ({ event }) => {
      const e = event as any
      const sid: string | undefined = e.properties?.sessionID
      if (!sid) return
      if (e.type === "session.status") {
        if (e.properties.status?.type === "idle") await onIdle(sid)
        else busy.add(sid)
      } else if (e.type === "session.idle") {
        await onIdle(sid)
      } else if (e.type === "session.error") {
        const run = bySession.get(sid)
        if (run && e.properties.error) run.error = e.properties.error.data?.message ?? e.properties.error.name
      } else if (e.type === "session.deleted") {
        const run = bySession.get(sid)
        if (run) {
          bySession.delete(sid)
          runs.get(run.parentID)?.delete(run.id)
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!EDIT_TOOLS.has(input.tool)) return
      const agent = sessionInfo.get(input.sessionID)?.agent
      const preset = presetOf(agent)
      if (!preset || preset.nudge_direct_edits === false || nudged.has(input.sessionID)) return
      nudged.add(input.sessionID)
      output.output = `${output.output ?? ""}\n\n${DIRECT_EDIT_NUDGE}`
    },

    tool: {
      sidekick: tool({
        description:
          'Hand work to your persistent sidekick (a cheaper model with its own tools). There is one sidekick per session and its context persists across handoffs. block=true (default) waits and returns its report. block=false returns at once; the report is delivered to you automatically when it finishes. Calling this while the sidekick is working injects the message into its running task. Use agent_read / agent_cancel with id "sidekick" to check on it or stop it.',
        args: {
          message: tool.schema.string().describe("The brief: goal, files, decided change, constraints, done criteria, what to report"),
          block: tool.schema.boolean().optional().describe("Wait for the report (default true)"),
          timeout_s: tool.schema.number().optional().describe("Max seconds to wait before moving to the background"),
        },
        async execute(args, ctx) {
          const preset = presetOf(ctx.agent)
          if (!preset) {
            const names = Object.keys(config.presets ?? {})
            return `The sidekick tool only works in a fusion agent. Configured fusion agents: ${names.join(", ") || "none (add presets to fusion.jsonc)"}.`
          }
          const { run, injected } = await handoff({
            parentID: ctx.sessionID,
            id: SIDEKICK_ID,
            agent: `${ctx.agent}-sidekick`,
            message: args.message,
            title: SIDEKICK_TITLE,
            reuseByTitle: true,
          })
          ctx.metadata({ title: injected ? "sidekick: new message injected" : "sidekick: handoff started" })
          if (args.block === false) {
            run.notify = true
            return injected
              ? "The sidekick was already working, so your message was injected into its running task. Its report will be delivered to you when it finishes."
              : "Handoff started in the background. The report will be delivered to you when it finishes. Use agent_read (id \"sidekick\", block true) if you run out of other work."
          }
          const out = await waitAndReport(run, args.timeout_s ?? preset.block_timeout_s ?? 1800, ctx)
          return injected ? `(Your message was injected into the sidekick's running task.)\n\n${out}` : out
        },
      }),

      agent_spawn: tool({
        description:
          "Start a subagent in its own child session, by default in the background. Unlike the task tool, it can be checked (agent_read), stopped while keeping partial results (agent_cancel), and continued later by reusing its id, which keeps its context. Background reports are delivered to you automatically. Calling with the id of a running agent injects the prompt into its current task.",
        args: {
          agent: tool.schema.string().describe("Subagent name, e.g. explore, general, or one of your own"),
          prompt: tool.schema.string().describe("Self-contained task. The agent doesn't see this conversation"),
          id: tool.schema.string().optional().describe("Reuse an earlier agent's id to continue it with its context"),
          block: tool.schema.boolean().optional().describe("Wait for the report (default false)"),
          timeout_s: tool.schema.number().optional().describe("Max seconds to wait when blocking (default 1800)"),
        },
        async execute(args, ctx) {
          const existing = args.id ? runs.get(ctx.sessionID)?.get(args.id) : undefined
          const agent = existing?.agent ?? args.agent
          const names = await subagentNames()
          if (!existing && !names.has(agent))
            return `Unknown subagent "${agent}". Available: ${[...names.keys()].filter((n) => !n.endsWith("-sidekick")).join(", ")}`
          if (agent.endsWith("-sidekick")) return "Use the sidekick tool for the fusion sidekick."
          const id = args.id ?? `${agent}-${++counter}`
          const { run, injected } = await handoff({
            parentID: ctx.sessionID,
            id,
            agent,
            message: args.prompt,
            title: `agent: ${id}`,
            reuseByTitle: false,
          })
          if (args.block) return await waitAndReport(run, args.timeout_s ?? 1800, ctx)
          run.notify = true
          return injected
            ? `${id} was already running; your prompt was injected into its current task.`
            : `Started ${id} (${agent}) in the background. Its report will be delivered to you when it finishes.`
        },
      }),

      agent_read: tool({
        description:
          'Check a sidekick or background agent: its report if finished, otherwise a progress snapshot (tool calls, files edited, latest message). block=true waits for it to finish.',
        args: {
          id: tool.schema.string().describe('Agent id from agent_spawn or agent_list, or "sidekick"'),
          block: tool.schema.boolean().optional().describe("Wait until it finishes (default false)"),
          timeout_s: tool.schema.number().optional().describe("Max seconds to wait when blocking (default 1800)"),
        },
        async execute(args, ctx) {
          const run = runs.get(ctx.sessionID)?.get(args.id)
          if (!run) return `No agent "${args.id}" in this session. Use agent_list.`
          if (run.status === "running" && args.block) return await waitAndReport(run, args.timeout_s ?? 1800, ctx)
          if (run.status !== "running") run.delivered = true
          return await report(run)
        },
      }),

      agent_cancel: tool({
        description:
          'Stop a running sidekick or background agent and return what it did so far (tool calls, files edited, latest message). Its context is kept, so you can continue it later with the same id. id "all" stops every running agent in this session.',
        args: { id: tool.schema.string().describe('Agent id, "sidekick", or "all"') },
        async execute(args, ctx) {
          const reg = runs.get(ctx.sessionID)
          const targets =
            args.id === "all" ? [...(reg?.values() ?? [])].filter((r) => r.status === "running") : [reg?.get(args.id)]
          if (!targets.length || !targets[0]) return args.id === "all" ? "No agents are running." : `No agent "${args.id}" in this session.`
          const out: string[] = []
          for (const run of targets as Run[]) out.push(await cancel(run))
          return out.join("\n\n")
        },
      }),

      agent_list: tool({
        description: "List the sidekick and background agents of this session with their status, plus the subagents you can start.",
        args: {},
        async execute(_args, ctx) {
          const reg = [...(runs.get(ctx.sessionID)?.values() ?? [])]
          const names = await subagentNames()
          const lines = reg.length
            ? reg.map((r) => `- ${r.id} (${r.agent}): ${r.status}, ${r.handoffs} handoff(s)${r.error ? `, error: ${r.error}` : ""}`)
            : ["- none yet"]
          const avail = [...names.entries()]
            .filter(([n]) => !n.endsWith("-sidekick"))
            .map(([n, d]) => `- ${n}${d ? `: ${d.slice(0, 100)}` : ""}`)
          return ["Agents in this session:", ...lines, "", "Subagents you can start with agent_spawn:", ...avail].join("\n")
        },
      }),
    },
  }
}

