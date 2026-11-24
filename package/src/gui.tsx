/**
 * opencode-fusion, Desktop GUI part: Settings > Fusion.
 * Reads and saves the fusion config through the server part's RPC.
 */
import { Plugin, SettingsPage } from "@opencode/plugin/gui"
import { createSignal, For, onMount, Show } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { AgentsSettings, agentsI18n } from "./agents-gui"
import { FusionRpc, type FusionConfig, type FusionState, type Preset } from "./rpc"
import { kit } from "./ui"

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
type Delegation = NonNullable<Preset["delegation"]>
const delegationOf = (p: Preset): Delegation => p.delegation ?? "balanced"
// Same default as the server part: the direct-edit reminder is on by default only with "heavy".
const nudgeDefault = (p: Preset) => delegationOf(p) === "heavy"

const en = {
  title: "Fusion",
  description:
    "Fusion agents pair a lead model that plans and reviews with a cheaper sidekick model that does the hands-on work. Each one appears in the agent picker and, as \"<model> (Fusion)\", in the model list.",
  save: "Save",
  saved: "Fusion settings saved",
  savedDetail: "Agents and models were reloaded.",
  saveFailed: "Could not save fusion settings",
  loadFailed: "Could not load fusion settings",
  retry: "Retry",
  unsaved: "Unsaved changes",
  empty: "No fusion agents yet. Add one below.",
  lead: "Lead model",
  leadHint: "Plans, briefs the sidekick, reviews its work and talks to you.",
  sidekick: "Sidekick model",
  sidekickHint: "Explores, implements and runs checks. Pick a cheaper model.",
  pick: "Choose a model",
  descriptionLabel: "Description",
  descriptionHint: "Shown in the agent picker.",
  modelEntry: "Show in model list",
  modelEntryHint:
    "Adds an entry under \"Fusion · <lead provider>\", using the lead's login. Choosing it turns on fusion for any agent.",
  modelName: "Model list name",
  modelNameHint: "Leave empty for \"<lead model> (Fusion)\".",
  leadAppend: "Extra instructions for the lead",
  sidekickAppend: "Extra instructions for the sidekick",
  appendHint: "Added to the built-in prompt.",
  steps: "Sidekick step limit",
  stepsHint: "Max tool steps per sidekick turn. Leave empty for no limit.",
  delegation: "Delegation",
  delegationHint: "How much of the work the lead hands to the sidekick.",
  delegationLight: "Light: lead does most of the work",
  delegationBalanced: "Balanced: lead designs, sidekick does bounded steps",
  delegationHeavy: "Heavy: hand off as much as possible",
  nudge: "Remind lead to delegate",
  nudgeHint: "When the lead edits a file itself, remind it to hand edits to the sidekick. On by default only with Heavy delegation.",
  remove: "Delete",
  addSection: "Add a fusion agent",
  newName: "Name",
  newNameHint: "Lowercase letters, digits and dashes, e.g. fusion-kimi.",
  add: "Add",
  badName: "Use lowercase letters, digits and dashes.",
  taken: "That name is already used.",
  file: "Saved to",
  warnings: "Problems",
  entry: "Model list entry",
}

const de: typeof en = {
  title: "Fusion",
  description:
    "Fusion-Agenten kombinieren ein Lead-Modell, das plant und prüft, mit einem günstigeren Sidekick-Modell, das die eigentliche Arbeit macht. Jeder erscheint in der Agentenauswahl und als \"<Modell> (Fusion)\" in der Modellliste.",
  save: "Speichern",
  saved: "Fusion-Einstellungen gespeichert",
  savedDetail: "Agenten und Modelle wurden neu geladen.",
  saveFailed: "Fusion-Einstellungen konnten nicht gespeichert werden",
  loadFailed: "Fusion-Einstellungen konnten nicht geladen werden",
  retry: "Erneut versuchen",
  unsaved: "Ungespeicherte Änderungen",
  empty: "Noch keine Fusion-Agenten. Unten einen hinzufügen.",
  lead: "Lead-Modell",
  leadHint: "Plant, brieft den Sidekick, prüft dessen Arbeit und spricht mit dir.",
  sidekick: "Sidekick-Modell",
  sidekickHint: "Erkundet, implementiert und führt Prüfungen aus. Wähle ein günstigeres Modell.",
  pick: "Modell wählen",
  descriptionLabel: "Beschreibung",
  descriptionHint: "Wird in der Agentenauswahl angezeigt.",
  modelEntry: "In der Modellliste anzeigen",
  modelEntryHint:
    "Fügt einen Eintrag unter \"Fusion · <Lead-Anbieter>\" hinzu, mit dem Login des Lead-Modells. Damit wird Fusion für jeden Agenten aktiv.",
  modelName: "Name in der Modellliste",
  modelNameHint: "Leer lassen für \"<Lead-Modell> (Fusion)\".",
  leadAppend: "Zusätzliche Anweisungen für den Lead",
  sidekickAppend: "Zusätzliche Anweisungen für den Sidekick",
  appendHint: "Wird an den eingebauten Prompt angehängt.",
  steps: "Schrittlimit des Sidekicks",
  stepsHint: "Maximale Tool-Schritte pro Sidekick-Durchlauf. Leer lassen für kein Limit.",
  delegation: "Delegieren",
  delegationHint: "Wie viel der Arbeit der Lead an den Sidekick abgibt.",
  delegationLight: "Wenig: Lead macht den Großteil selbst",
  delegationBalanced: "Ausgewogen: Lead entwirft, Sidekick erledigt klar umrissene Schritte",
  delegationHeavy: "Viel: so viel wie möglich abgeben",
  nudge: "Lead ans Delegieren erinnern",
  nudgeHint:
    "Wenn der Lead selbst eine Datei bearbeitet, wird er erinnert, Änderungen dem Sidekick zu geben. Standardmäßig nur bei „Viel“ aktiv.",
  remove: "Löschen",
  addSection: "Fusion-Agent hinzufügen",
  newName: "Name",
  newNameHint: "Kleinbuchstaben, Ziffern und Bindestriche, z. B. fusion-kimi.",
  add: "Hinzufügen",
  badName: "Nur Kleinbuchstaben, Ziffern und Bindestriche.",
  taken: "Dieser Name ist schon vergeben.",
  file: "Gespeichert in",
  warnings: "Probleme",
  entry: "Eintrag in der Modellliste",
}

export default Plugin.define({
  i18n: { en: { ...en, ...agentsI18n.en }, de: { ...de, ...agentsI18n.de } },
  setup(ctx: any) {
    ctx.add(SettingsPage, {
      id: "agents",
      icon: "brain",
      get title() {
        return ctx.t("ag.title")
      },
      get entries() {
        return [
          { id: "agents-list", title: ctx.t("ag.title"), keywords: "agents model explore general build plan worker subagent steps prompt" },
          { id: "agents-scope", title: ctx.t("ag.scope"), keywords: "agents project global override" },
        ]
      },
      render: () => <AgentsSettings ctx={ctx} />,
    })
    ctx.add(SettingsPage, {
      id: "fusion",
      icon: "fork",
      get title() {
        return ctx.t("title")
      },
      get entries() {
        return [
          { id: "fusion-presets", title: ctx.t("title"), keywords: "fusion sidekick lead agent model kimi mimo opus" },
          { id: "fusion-add", title: ctx.t("addSection"), keywords: "fusion add new agent" },
        ]
      },
      render: () => <FusionSettings ctx={ctx} />,
    })
  },
})

function FusionSettings(props: { ctx: any }) {
  const ctx = props.ctx
  const ui = kit(ctx.ui)
  const t = (key: keyof typeof en) => ctx.t(key) as string
  const rpc = () => ctx.client.rpc(FusionRpc)

  const [server, setServer] = createSignal<FusionState | undefined>()
  const [loadError, setLoadError] = createSignal<string | undefined>()
  const [draft, setDraft] = createStore<{ presets: Record<string, Preset> }>({ presets: {} })
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [newName, setNewName] = createSignal("")

  const adopt = (state: FusionState) => {
    setServer(state)
    setDraft("presets", reconcile(structuredClone(state.config.presets ?? {})))
    setDirty(false)
  }

  const load = async () => {
    setLoadError(undefined)
    try {
      adopt((await rpc().state({})) as FusionState)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }
  onMount(load)

  const update = (name: string, patch: Partial<Preset>) => {
    setDraft("presets", name, (p) => {
      const next: any = { ...p, ...patch }
      for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k]
      return next
    })
    setDirty(true)
  }

  const remove = (name: string) => {
    setDraft("presets", (all) => {
      const next = { ...all }
      delete next[name]
      return reconcile(next)(all)
    })
    setDirty(true)
  }

  const nameProblem = () => {
    const name = newName().trim()
    if (!name) return undefined
    if (!NAME_RE.test(name)) return t("badName")
    if (draft.presets[name]) return t("taken")
    return undefined
  }

  const add = () => {
    const name = newName().trim()
    if (!name || nameProblem()) return
    const models = server()?.models ?? []
    setDraft("presets", name, { lead: models[0]?.value ?? "", sidekick: models[0]?.value ?? "" })
    setNewName("")
    setDirty(true)
  }

  const save = async () => {
    setBusy(true)
    try {
      const base: FusionConfig = { ...(server()?.config ?? {}) }
      const config: FusionConfig = { ...base, presets: structuredClone(unwrap(draft.presets)) }
      adopt((await rpc().save({ config })) as FusionState)
      ctx.toast.show({ title: t("saved"), description: t("savedDetail"), variant: "success" })
    } catch (e: any) {
      const message = e?.data?.message ?? e?.message ?? String(e)
      ctx.toast.show({ title: t("saveFailed"), description: message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const modelOptions = (current: string | undefined) => {
    const list = server()?.models ?? []
    // Keep a configured model selectable even if it isn't connected right now.
    return current && !list.some((m) => m.value === current) ? [{ value: current, label: current }, ...list] : list
  }

  const ModelSelect = (p: { label: string; value: string | undefined; onChange: (v: string) => void }) => (
    <ui.Select label={p.label} placeholder={t("pick")} options={modelOptions(p.value)} value={p.value} onChange={p.onChange} />
  )

  return (
    <ui.SettingsLayout
      title={t("title")}
      description={t("description")}
      actions={
        <ui.Button variant="contrast" icon="check" busy={busy()} disabled={!dirty() || !server()} onClick={save}>
          {dirty() ? t("save") : t("save")}
        </ui.Button>
      }
    >
      <Show when={loadError()}>
        <ui.SettingsSection
          title={t("loadFailed")}
          footer={
            <ui.Button variant="neutral" onClick={load}>
              {t("retry")}
            </ui.Button>
          }
        >
          <ui.SettingsRow title={loadError()!} />
        </ui.SettingsSection>
      </Show>

      <Show when={!server() && !loadError()}>
        <ui.Loader size="large" />
      </Show>

      <Show when={server()}>
        <Show when={(server()?.warnings ?? []).length > 0}>
          <ui.SettingsSection title={t("warnings")}>
            <For each={server()!.warnings}>{(w) => <ui.SettingsRow title={w} />}</For>
          </ui.SettingsSection>
        </Show>

        <Show when={Object.keys(draft.presets).length === 0}>
          <ui.SettingsSection>
            <ui.SettingsRow id="fusion-presets" title={t("empty")} />
          </ui.SettingsSection>
        </Show>

        <For each={Object.keys(draft.presets)}>
          {(name) => {
            const p = () => draft.presets[name] ?? ({} as Preset)
            return (
              <ui.SettingsSection
                title={name}
                footer={
                  <Show when={server()?.entries[name]}>
                    <span>
                      {t("entry")}: {server()!.entries[name]}
                    </span>
                  </Show>
                }
              >
                <ui.SettingsRow id="fusion-presets" title={t("lead")} description={t("leadHint")}>
                  <ModelSelect label={t("lead")} value={p().lead} onChange={(v) => update(name, { lead: v })} />
                </ui.SettingsRow>
                <ui.SettingsRow title={t("sidekick")} description={t("sidekickHint")}>
                  <ModelSelect label={t("sidekick")} value={p().sidekick} onChange={(v) => update(name, { sidekick: v })} />
                </ui.SettingsRow>
                <ui.SettingsRow title={t("delegation")} description={t("delegationHint")}>
                  <ui.Select
                    label={t("delegation")}
                    options={[
                      { value: "light", label: t("delegationLight") },
                      { value: "balanced", label: t("delegationBalanced") },
                      { value: "heavy", label: t("delegationHeavy") },
                    ]}
                    value={delegationOf(p())}
                    onChange={(v: string) => {
                      const next = { ...p(), delegation: v as Delegation }
                      // Drop an explicit reminder choice that now matches the new default.
                      const nudge = p().nudge_direct_edits === nudgeDefault(next) ? undefined : p().nudge_direct_edits
                      update(name, { delegation: v === "balanced" ? undefined : (v as Delegation), nudge_direct_edits: nudge })
                    }}
                  />
                </ui.SettingsRow>
                <ui.SettingsRow title={t("descriptionLabel")} description={t("descriptionHint")}>
                  <ui.TextInput
                    label={t("descriptionLabel")}
                    value={p().description ?? ""}
                    onInput={(v: string) => update(name, { description: v })}
                  />
                </ui.SettingsRow>
                <ui.SettingsRow title={t("modelEntry")} description={t("modelEntryHint")}>
                  <ui.Switch
                    label={t("modelEntry")}
                    hideLabel
                    checked={p().model_entry !== false}
                    onChange={(v: boolean) => update(name, { model_entry: v ? undefined : false })}
                  />
                </ui.SettingsRow>
                <Show when={p().model_entry !== false}>
                  <ui.SettingsRow title={t("modelName")} description={t("modelNameHint")}>
                    <ui.TextInput
                      label={t("modelName")}
                      value={p().model_name ?? ""}
                      onInput={(v: string) => update(name, { model_name: v })}
                    />
                  </ui.SettingsRow>
                </Show>
                <ui.SettingsRow title={t("leadAppend")} description={t("appendHint")}>
                  <ui.TextInput
                    label={t("leadAppend")}
                    value={p().lead_prompt_append ?? ""}
                    onInput={(v: string) => update(name, { lead_prompt_append: v })}
                  />
                </ui.SettingsRow>
                <ui.SettingsRow title={t("sidekickAppend")} description={t("appendHint")}>
                  <ui.TextInput
                    label={t("sidekickAppend")}
                    value={p().sidekick_prompt_append ?? ""}
                    onInput={(v: string) => update(name, { sidekick_prompt_append: v })}
                  />
                </ui.SettingsRow>
                <ui.SettingsRow title={t("steps")} description={t("stepsHint")}>
                  <ui.TextInput
                    label={t("steps")}
                    value={p().sidekick_steps ? String(p().sidekick_steps) : ""}
                    invalid={!!p().sidekick_steps && !(Number.isInteger(p().sidekick_steps) && p().sidekick_steps! > 0)}
                    onInput={(v: string) => {
                      const n = v.trim() === "" ? undefined : Number(v)
                      update(name, { sidekick_steps: n === undefined || Number.isNaN(n) ? undefined : n })
                    }}
                  />
                </ui.SettingsRow>
                <ui.SettingsRow title={t("nudge")} description={t("nudgeHint")}>
                  <ui.Switch
                    label={t("nudge")}
                    hideLabel
                    checked={p().nudge_direct_edits ?? nudgeDefault(p())}
                    onChange={(v: boolean) => update(name, { nudge_direct_edits: v === nudgeDefault(p()) ? undefined : v })}
                  />
                </ui.SettingsRow>
                <ui.SettingsRow title={t("remove")}>
                  <ui.Button variant="danger" icon="trash" onClick={() => remove(name)}>
                    {t("remove")}
                  </ui.Button>
                </ui.SettingsRow>
              </ui.SettingsSection>
            )
          }}
        </For>

        <ui.SettingsSection
          title={t("addSection")}
          footer={
            <span>
              {t("file")}: {server()!.path}
            </span>
          }
        >
          <ui.SettingsRow id="fusion-add" title={t("newName")} description={nameProblem() ?? t("newNameHint")}>
            <ui.TextInput
              label={t("newName")}
              placeholder="fusion-kimi"
              value={newName()}
              invalid={!!nameProblem()}
              onInput={setNewName}
              onSubmit={add}
            />
            <ui.Button variant="neutral" icon="plus" disabled={!newName().trim() || !!nameProblem()} onClick={add}>
              {t("add")}
            </ui.Button>
          </ui.SettingsRow>
        </ui.SettingsSection>

        <Show when={dirty()}>
          <ui.SettingsSection>
            <ui.SettingsRow title={t("unsaved")}>
              <ui.Button variant="contrast" icon="check" busy={busy()} onClick={save}>
                {t("save")}
              </ui.Button>
            </ui.SettingsRow>
          </ui.SettingsSection>
        </Show>
      </Show>
    </ui.SettingsLayout>
  )
}
