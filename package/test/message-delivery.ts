/**
 * Runs the "fusion-msg" lead against test/mock-llm.cjs on a running `opencode serve` and prints what the
 * sidekick and the lead saw, to check how subagent_message's delivery modes arrive.
 * Needs a "mock" provider (models "lead" and "side") pointing at the mock server, and a preset
 * "fusion-msg": { lead: "mock/lead", sidekick: "mock/side" }.
 * Usage: OC_PW=<server password> npx tsx test/message-delivery.ts http://127.0.0.1:4299 <directory> [seconds]
 * OC_AGENT=build OC_MODEL=<fusion provider>/<entry> runs the lead as Build with a "(Fusion)" model instead.
 */
import { OpenCode } from "@opencode/client"

const [baseUrl, directory, seconds = "25"] = process.argv.slice(2)
const pw = process.env.OC_PW
const headers = pw ? { authorization: "Basic " + Buffer.from(`opencode:${pw}`).toString("base64") } : undefined
const client: any = OpenCode.make({ baseUrl, headers } as any)
const data = (r: any) => r?.data ?? r

// OC_AGENT / OC_MODEL ("providerID/modelID") start the lead as another agent, e.g. Build with a "(Fusion)" model.
const agent = process.env.OC_AGENT || "fusion-msg"
const [providerID, ...modelID] = (process.env.OC_MODEL ?? "").split("/")
const model = process.env.OC_MODEL ? { providerID, id: modelID.join("/") } : undefined
const parent = data(await client.session.create({ agent, model, location: { directory }, title: "delivery test" } as any))
await client.session.prompt({ sessionID: parent.id, text: "go" })
await new Promise((r) => setTimeout(r, Number(seconds) * 1000))

const brief = (m: any) => {
  const parts = (m.content ?? []).map((c: any) =>
    c.type === "text"
      ? `text:${JSON.stringify(String(c.text).slice(0, 70))}`
      : c.type === "tool"
        ? `tool:${c.name}(${c.state?.status})${c.state?.output ? "→" + JSON.stringify(String(c.state.output).slice(0, 160)) : ""}${c.state?.error ? "!" + JSON.stringify(String(c.state.error).slice(0, 160)) : ""}`
        : c.type,
  )
  const own = m.text ?? m.payload?.text ?? ""
  return `${m.type}${m.outcome ? `(${m.outcome})` : ""}${m.delivery ? `[${m.delivery}]` : ""}${own ? ` ${JSON.stringify(String(own).slice(0, 110))}` : ""}${parts.length ? " " + parts.join(" | ") : ""}`
}
const show = async (label: string, id: string) => {
  const msgs = data(await client.session.context({ sessionID: id })) as any[]
  console.log(`--- ${label} ${id}`)
  for (const m of msgs) console.log("  " + brief(m))
}

await show("lead", parent.id)
const kids = data(await client.session.list({ parentID: parent.id, limit: 10 }))
for (const k of kids ?? []) await show(`child ${k.agent}`, k.id)
process.exit(0)
