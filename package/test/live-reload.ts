/**
 * Saves a new preset through the settings RPC against a running `opencode serve`, the way the settings page
 * does, and checks that the server tells the app to refetch providers and models, and how the Fusion
 * provider groups are named. Restores the config at the end.
 * Usage: OC_PW=<server password> npx tsx test/live-reload.ts http://127.0.0.1:4299 <directory> <provider/model of new lead>
 */
import { OpenCode } from "@opencode/client"
import { FusionRpc } from "../src/rpc"

const [baseUrl, directory, newLead] = process.argv.slice(2)
const pw = process.env.OC_PW
const headers = pw ? { authorization: "Basic " + Buffer.from(`opencode:${pw}`).toString("base64") } : undefined
const client: any = OpenCode.make({ baseUrl, headers } as any)
const rpc = client.rpc(FusionRpc)
const location = { directory }

const groups = async () => {
  const providers = (await client.provider.list({ location })).data
  const models = (await client.model.list({ location })).data
  return providers
    .filter((p: any) => p.id.startsWith("fusion-"))
    .map((p: any) => `${p.name} [${p.id}]: ${models.filter((m: any) => m.providerID === p.id).map((m: any) => m.name).join(", ")}`)
}

const seen: string[] = []
const abort = new AbortController()
;(async () => {
  try {
    const stream = await client.event.subscribe(undefined, { signal: abort.signal })
    for await (const e of stream as any) if (/provider|model|agent/.test(e.type)) seen.push(e.type)
  } catch {}
})()

const before = (await rpc.state({}, { location })) as any
console.log("presets before:", Object.keys(before.config.presets).join(", "))
console.log("groups before:\n  " + (await groups()).join("\n  "))

await new Promise((r) => setTimeout(r, 1000))
const config = structuredClone(before.config)
config.presets["fusion-added"] = { lead: newLead, sidekick: newLead, description: "added by live-reload test" }
const after = (await rpc.save({ config }, { location })) as any
await new Promise((r) => setTimeout(r, 3000))
console.log("entries after save:", JSON.stringify(after.entries))
console.log("warnings:", JSON.stringify(after.warnings))
console.log("events after save:", [...new Set(seen)].join(", ") || "(none)")
console.log("groups after:\n  " + (await groups()).join("\n  "))

await rpc.save({ config: before.config }, { location })
console.log("restored:", Object.keys(((await rpc.state({}, { location })) as any).config.presets).join(", "))
abort.abort()
process.exit(0)
