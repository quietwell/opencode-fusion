/**
 * Drives the plugin's tools against a running `opencode serve`, without a
 * lead model in the loop, so each mechanic can be checked deterministically.
 *
 *   npx tsx test/harness.ts <baseUrl> <projectDir> <leadAgent> <step...>
 */
import { createOpencodeClient } from "@opencode-ai/sdk"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { FusionPlugin } from "../plugins/opencode-1.x/fusion.ts"

const [baseUrl, dir, leadAgent, ...steps] = process.argv.slice(2)
const client = createOpencodeClient({ baseUrl, directory: dir })
const hooks: any = await FusionPlugin({ client, directory: dir } as any, {})

// Feed server events into the plugin, like OpenCode does.
const sub = await client.event.subscribe()
;(async () => {
  for await (const e of sub.stream as any) await hooks.event({ event: e }).catch((x: any) => console.error("event err", x))
})()

const lead = (await client.session.create({ body: { title: "harness lead" } })).data!
const [providerID, ...rest] = "ollama/qwen3.5:4b".split("/")
await hooks["chat.message"]({ sessionID: lead.id, agent: leadAgent, model: { providerID, modelID: rest.join("/") } }, {})
console.log("lead session", lead.id)

function ctx(signal?: AbortSignal) {
  return {
    sessionID: lead.id,
    messageID: "msg_harness",
    agent: leadAgent,
    directory: dir,
    worktree: dir,
    abort: signal ?? new AbortController().signal,
    metadata: (m: any) => m?.title && console.log("  · meta:", m.title),
    ask: async () => {},
  }
}
const call = (name: string, args: any, signal?: AbortSignal) => hooks.tool[name].execute(args, ctx(signal))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const show = (label: string, out: string) => console.log(`\n=== ${label}\n${out}\n`)
const file = (f: string) => (existsSync(join(dir, f)) ? JSON.stringify(readFileSync(join(dir, f), "utf8")) : "(missing)")

const tests: Record<string, () => Promise<void>> = {
  async agents() {
    const res = await client.app.agents({})
    for (const a of (res.data ?? []) as any[])
      if (a.name.startsWith("fusion") || ["build", "general"].includes(a.name))
        console.log(a.name, a.mode, a.model, "hidden=" + a.hidden, "tools=" + JSON.stringify(a.tools), "options=" + JSON.stringify(a.options))
  },
  async notlead() {
    const out = await hooks.tool.sidekick.execute({ message: "x" }, { ...ctx(), agent: "build" })
    show("sidekick from non-fusion agent", out)
  },
  async block() {
    show("blocking handoff", await call("sidekick", { message: "Use the write tool to create the file hello.txt containing exactly: hi from sidekick. Then reply with one line: done." }))
    console.log("hello.txt =", file("hello.txt"))
  },
  async persist() {
    show("persistence", await call("sidekick", { message: "Without using any tools: which file did you create in your previous handoff? Reply with only the file name." }))
  },
  async cancel() {
    show("background start", await call("sidekick", { block: false, message: "Create the files n1.txt, n2.txt, n3.txt, n4.txt, n5.txt, n6.txt, n7.txt, n8.txt one at a time with the write tool. Each file contains only its number. Use one write tool call per file, in order. Before each write, run the shell command: sleep 6" }))
    await sleep(25000)
    show("progress (agent_read)", await call("agent_read", { id: "sidekick" }))
    show("cancel (agent_cancel)", await call("agent_cancel", { id: "sidekick" }))
    console.log("files:", [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `n${n}=${file(`n${n}.txt`)}`).join(" "))
    show("list", await call("agent_list", {}))
  },
  async inject() {
    show("background start", await call("sidekick", { block: false, message: "Create the files m1.txt, m2.txt, m3.txt, m4.txt one at a time with the write tool, each containing only its number. One write call per file. Before each write, run the shell command: sleep 6" }))
    await sleep(15000)
    show("inject", await call("sidekick", { block: false, message: "Additionally, after the m files, create zz.txt containing exactly: injected." }))
    show("wait (agent_read block)", await call("agent_read", { id: "sidekick", block: true, timeout_s: 300 }))
    console.log("zz.txt =", file("zz.txt"), " m4 =", file("m4.txt"))
  },
  async abort() {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 12000)
    show("blocking handoff aborted by user", await call("sidekick", { message: "Create the files k1.txt to k6.txt one at a time with the write tool, each containing only its number. One write call per file. Before each write, run the shell command: sleep 6" }, ac.signal))
    console.log("child busy after abort:", JSON.stringify((await client.session.status({})).data))
  },
  async spawn() {
    show("spawn general in background", await call("agent_spawn", { agent: "general", prompt: "Use the write tool to create bg.txt containing exactly: from background agent. Then reply: done." }))
    // Wait until the plugin delivers the report into the lead session.
    for (let i = 0; i < 60; i++) {
      await sleep(3000)
      const msgs = ((await client.session.messages({ path: { id: lead.id } })).data ?? []) as any[]
      const note = msgs.flatMap((m) => m.parts).find((p: any) => p.type === "text" && p.text?.includes("<agent-report"))
      if (note) {
        show("report delivered to lead session", note.text.slice(0, 1500))
        break
      }
      if (i === 59) console.log("no report delivered within 3 minutes")
    }
    console.log("bg.txt =", file("bg.txt"))
    await call("agent_cancel", { id: "all" })
    await client.session.abort({ path: { id: lead.id } })
  },
}

for (const s of steps) {
  console.log(`\n##### ${s}`)
  const t0 = Date.now()
  try {
    await tests[s]()
  } catch (e) {
    console.log("ERROR in", s, e)
  }
  console.log(`(${s}: ${Math.round((Date.now() - t0) / 1000)}s)`)
}
process.exit(0)
