// Loads dist/gui-experimental.cjs with stand-in host modules and runs setup().
const Module = require("module")
const path = require("path")
const added = []
function inert() {
  const f = function () { return inert() }
  return new Proxy(f, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : inert()), apply: () => inert(), construct: () => inert() })
}
const stubs = {
  "@opencode/plugin/gui": { Plugin: { define: (d) => d }, SettingsPage: { kind: "SettingsPage" } },
  "solid-js": require("solid-js"),
  "solid-js/store": require("solid-js/store"),
  "solid-js/web": inert(),
}
const orig = Module._load
Module._load = function (req, parent, isMain) {
  if (req in stubs) return stubs[req]
  return orig.apply(this, arguments)
}
const mod = require(path.resolve(__dirname, "../dist/gui-experimental.cjs"))
const def = mod.default ?? mod
console.log("i18n locales:", Object.keys(def.i18n), "keys:", Object.keys(def.i18n.en).length, "de keys:", Object.keys(def.i18n.de).length)
const ctx = { t: (k) => def.i18n.en[k] ?? k, add: (reg, item) => added.push([reg.kind, item]) }
def.setup(ctx)
for (const [kind, item] of added) console.log("registered:", kind, "id=" + item.id, "title=" + item.title, "icon=" + item.icon, "entries=" + item.entries.length, "render=" + typeof item.render)
