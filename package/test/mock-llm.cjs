// Scripted OpenAI-compatible chat server for test/message-delivery.ts. No real model is called.
// Model "lead": starts the sidekick in the background, then sends it "STEER_MSG" with subagent_message
// (delivery from MOCK_DELIVERY), then waits. Model "side": step 1 streams a slow answer (about 8 s) that
// ends in a tool call, step 2 answers STEP2_DONE, and it answers GOT_STEER as soon as the latest input is
// the lead's message. So "next_step" arrives between the steps, "after_turn" after STEP2_DONE, and "now"
// cuts step 1 short.
// Usage: MOCK_DELIVERY=now node test/mock-llm.cjs <port> <log file>
const http = require("http")
const fs = require("fs")
const [port = "11998", log = "mock-llm.log"] = process.argv.slice(2)
const delivery = process.env.MOCK_DELIVERY || "next_step"
const write = (line) => fs.appendFileSync(log, `${new Date().toISOString()} ${line}\n`)

const text = (m) =>
  typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("")

function chunk(res, model, delta, finish = null) {
  res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
}
function end(res, model, finish) {
  chunk(res, model, {}, finish)
  res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
  res.end("data: [DONE]\n\n")
}
function toolCall(res, model, name, args) {
  chunk(res, model, { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
  end(res, model, "tool_calls")
}
function say(res, model, s) {
  chunk(res, model, { role: "assistant", content: s })
  end(res, model, "stop")
}

http
  .createServer((req, res) => {
    const body = []
    req.on("data", (c) => body.push(c))
    req.on("end", async () => {
      let j = {}
      try {
        j = JSON.parse(Buffer.concat(body).toString("utf8"))
      } catch {}
      const msgs = j.messages ?? []
      const model = String(j.model ?? "")
      const nonAssistant = msgs.filter((m) => m.role !== "assistant" && m.role !== "system")
      const last = nonAssistant[nonAssistant.length - 1]
      const tools = msgs.filter((m) => m.role === "tool").length
      write(`${model} msgs=${msgs.length} tools=${tools} last=${last?.role}:${JSON.stringify(text(last ?? {}).slice(0, 80))}`)
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      if (!/chat\/completions/.test(req.url)) return res.end()
      // Title and other tool-less requests.
      if (!j.tools?.length) return say(res, model, "Mock title")

      if (model === "lead") {
        if (tools === 0)
          return toolCall(res, model, "subagent", { agent: "fusion-msg-sidekick", description: "child task", prompt: "CHILD_TASK: write a long answer", background: true })
        if (tools === 1) {
          await new Promise((r) => setTimeout(r, 2000))
          return toolCall(res, model, "subagent_message", { message: "STEER_MSG", delivery })
        }
        return say(res, model, tools === 2 ? "LEAD_WAITING" : "LEAD_ACK")
      }

      // Sidekick: step 1 is a slow answer ending in a tool call, step 2 a short answer.
      if (/STEER_MSG/.test(text(last ?? {}))) return say(res, model, "GOT_STEER")
      if (tools > 0) return say(res, model, "STEP2_DONE")
      const names = (j.tools ?? []).map((t) => t.function?.name)
      const tool = names.includes("glob") ? ["glob", { pattern: "*.nothing" }] : ["read", { filePath: "nothing.txt" }]
      let closed = false
      res.on("close", () => {
        if (!res.writableEnded) {
          closed = true
          write(`${model} stream aborted by client`)
        }
      })
      chunk(res, model, { role: "assistant", content: "" })
      for (let i = 1; i <= 20 && !closed; i++) {
        chunk(res, model, { content: `working ${i}. ` })
        await new Promise((r) => setTimeout(r, 400))
      }
      if (closed) return
      chunk(res, model, { content: "STEP1_DONE" })
      chunk(res, model, { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] })
      end(res, model, "tool_calls")
      write(`${model} finished slow step 1 (${tool[0]})`)
    })
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`mock llm on ${port}, delivery=${delivery}`))
