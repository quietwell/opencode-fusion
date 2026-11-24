/**
 * Calls the plugin's RPC the way the settings page does, against a running
 * `opencode serve`. Usage: npx tsx test/rpc-check.ts http://127.0.0.1:4299 <directory>
 */
import { OpenCode } from "@opencode/client"
import { FusionRpc } from "../src/rpc"

const [baseUrl, directory] = process.argv.slice(2)
const pw = process.env.OC_PW
const headers = pw ? { authorization: "Basic " + Buffer.from(`opencode:${pw}`).toString("base64") } : undefined
const client: any = OpenCode.make({ baseUrl, headers } as any)
const rpc = client.rpc(FusionRpc)

const show = (label: string, s: any) => {
  console.log(`\n== ${label}`)
  console.log("presets:", Object.keys(s.config.presets ?? {}).join(", ") || "(none)")
  console.log("entries:", JSON.stringify(s.entries))
  console.log("warnings:", JSON.stringify(s.warnings))
  console.log("models:", s.models.length, s.models.slice(0, 5).map((m: any) => `${m.value} = ${m.label}`).join(" | "))
  console.log("path:", s.path)
}

const plugins = await client.plugin.list({ location: { directory } })
console.log("== plugins")
for (const p of plugins.data ?? []) console.log(JSON.stringify(p).slice(0, 400))
try {
  const gui = await client.plugin.gui({ id: "fusion-agents", location: { directory } })
  console.log("== gui bundle:", JSON.stringify(gui.data).slice(0, 200))
} catch (e: any) {
  console.log("== gui bundle error:", e?.message ?? String(e))
}

const before = await rpc.state({})
show("state", before)

const config = structuredClone(before.config)
config.presets["fusion-second"] = {
  description: "added from rpc-check",
  lead: "ollama/qwen3.5:4b",
  sidekick: "ollama/qwen3.5:4b",
  model_name: "Qwen Fusion Two",
  sidekick_steps: 25,
}
show("after save", await rpc.save({ config }))

const models = await client.model.list()
console.log("\n== model list (ollama)")
for (const m of models.data ?? []) if (m.providerID === "ollama") console.log(`${m.id} -> ${m.modelID} : ${m.name}`)
const agents = await client.agent.list()
console.log("\n== agents (fusion)")
for (const a of agents.data ?? agents ?? []) if (String(a.id).startsWith("fusion")) console.log(a.id, a.mode, JSON.stringify(a.model))

try {
  await rpc.save({ config: { presets: { "Bad Name": { lead: "x", sidekick: "y" } } } })
  console.log("\nERROR: invalid config was accepted")
} catch (e: any) {
  console.log("\n== invalid save rejected:", e?.data?.message ?? e?.message ?? String(e))
}

// Put the original config back.
show("restored", await rpc.save({ config: before.config }))
process.exit(0)
