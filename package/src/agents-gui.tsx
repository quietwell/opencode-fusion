/**
 * Settings > Agents: change any agent's model, steps, description, extra instructions and on/off, for all
 * projects or for one project. Reads and saves through the server part's RPC; a project scope talks to that
 * project's plugin instance by passing its location.
 */
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { FusionRpc, type AgentInfo, type AgentOverride, type AgentsState } from "./rpc"
import { kit, PageStyles, TextArea } from "./ui"

const en = {
  "ag.title": "Agents",
  "ag.description":
    "Change the model and settings of any agent: Build, Plan, Explore, General, your own agents and the system agents. Project settings override global ones.",
  "ag.scope": "Applies to",
  "ag.scopeGlobal": "All projects",
  "ag.scopeProject": "Project",
  "ag.scopeGlobalHint": "Every project uses these, unless a project sets its own.",
  "ag.scopeProjectHint": "Only this project. Overrides the settings for all projects.",
  "ag.scopeLocked": "Save or revert your changes before switching.",
  "ag.primary": "Primary agents",
  "ag.subagents": "Subagents",
  "ag.system": "System agents",
  "ag.model": "Model",
  "ag.inherit": "Inherit",
  "ag.sessionModel": "the session's model",
  "ag.variant": "Variant",
  "ag.defaultVariant": "Default variant",
  "ag.enabled": "Enabled",
  "ag.enabledHint": "Turned off, the agent isn't available.",
  "ag.steps": "Max steps",
  "ag.stepsHint": "Tool steps per turn. Leave empty to inherit.",
  "ag.agentDescription": "Description",
  "ag.agentDescriptionHint": "Shown in pickers; other agents use it to decide when to call this one.",
  "ag.extra": "Extra instructions",
  "ag.extraHint": "Added to the agent's own prompt on every request.",
  "ag.more": "More settings",
  "ag.less": "Fewer settings",
  "ag.reset": "Reset",
  "ag.resetHint": "Remove what is set here for this agent.",
  "ag.fromDefault": "Default",
  "ag.fromGlobal": "From all-projects settings",
  "ag.setHere": "Set here",
  "ag.managed": "Fusion agents are set in Settings › Fusion:",
  "ag.save": "Save",
  "ag.revert": "Revert",
  "ag.saved": "Agent settings saved",
  "ag.savedDetail": "Agents were reloaded.",
  "ag.saveFailed": "Could not save agent settings",
  "ag.loadFailed": "Could not load agents",
  "ag.retry": "Retry",
  "ag.unsaved": "Unsaved changes",
  "ag.file": "Saved to",
  "ag.warnings": "Problems",
  "ag.empty": "No agents found.",
}

const de: typeof en = {
  "ag.title": "Agenten",
  "ag.description":
    "Ändere Modell und Einstellungen jedes Agenten: Build, Plan, Explore, General, deine eigenen Agenten und die System-Agenten. Projekteinstellungen haben Vorrang vor den globalen.",
  "ag.scope": "Gilt für",
  "ag.scopeGlobal": "Alle Projekte",
  "ag.scopeProject": "Projekt",
  "ag.scopeGlobalHint": "Gilt in jedem Projekt, außer ein Projekt legt eigene Werte fest.",
  "ag.scopeProjectHint": "Nur dieses Projekt. Hat Vorrang vor den Einstellungen für alle Projekte.",
  "ag.scopeLocked": "Speichere oder verwirf deine Änderungen, bevor du wechselst.",
  "ag.primary": "Primäre Agenten",
  "ag.subagents": "Subagenten",
  "ag.system": "System-Agenten",
  "ag.model": "Modell",
  "ag.inherit": "Übernehmen",
  "ag.sessionModel": "Modell der Sitzung",
  "ag.variant": "Variante",
  "ag.defaultVariant": "Standardvariante",
  "ag.enabled": "Aktiv",
  "ag.enabledHint": "Ausgeschaltet ist der Agent nicht verfügbar.",
  "ag.steps": "Max. Schritte",
  "ag.stepsHint": "Tool-Schritte pro Durchlauf. Leer lassen zum Übernehmen.",
  "ag.agentDescription": "Beschreibung",
  "ag.agentDescriptionHint": "Wird in der Auswahl angezeigt; andere Agenten entscheiden danach, wann sie diesen aufrufen.",
  "ag.extra": "Zusätzliche Anweisungen",
  "ag.extraHint": "Wird bei jeder Anfrage an den Prompt des Agenten angehängt.",
  "ag.more": "Weitere Einstellungen",
  "ag.less": "Weniger Einstellungen",
  "ag.reset": "Zurücksetzen",
  "ag.resetHint": "Entfernt, was hier für diesen Agenten festgelegt ist.",
  "ag.fromDefault": "Standard",
  "ag.fromGlobal": "Aus den Einstellungen für alle Projekte",
  "ag.setHere": "Hier festgelegt",
  "ag.managed": "Fusion-Agenten werden unter Einstellungen › Fusion festgelegt:",
  "ag.save": "Speichern",
  "ag.revert": "Verwerfen",
  "ag.saved": "Agenten-Einstellungen gespeichert",
  "ag.savedDetail": "Die Agenten wurden neu geladen.",
  "ag.saveFailed": "Agenten-Einstellungen konnten nicht gespeichert werden",
  "ag.loadFailed": "Agenten konnten nicht geladen werden",
  "ag.retry": "Erneut versuchen",
  "ag.unsaved": "Ungespeicherte Änderungen",
  "ag.file": "Gespeichert in",
  "ag.warnings": "Probleme",
  "ag.empty": "Keine Agenten gefunden.",
}

export const agentsI18n = { en, de }

type Key = keyof typeof en
type Project = { directory: string; name: string }
const GLOBAL = "global"

const splitModel = (m?: string) => {
  if (!m) return { model: undefined as string | undefined, variant: undefined as string | undefined }
  const [model, variant] = m.split("#")
  return { model, variant: variant || undefined }
}
const baseName = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir

export function AgentsSettings(props: { ctx: any }) {
  const ctx = props.ctx
  const ui = kit(ctx.ui)
  const t = (key: Key) => ctx.t(key) as string
  const rpc = () => ctx.client.rpc(FusionRpc)

  const [projects, setProjects] = createSignal<Project[]>([])
  const [scope, setScope] = createSignal(GLOBAL)
  const [server, setServer] = createSignal<AgentsState | undefined>()
  const [loadError, setLoadError] = createSignal<string | undefined>()
  const [draft, setDraft] = createStore<{ agents: Record<string, AgentOverride> }>({ agents: {} })
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [open, setOpen] = createSignal<Record<string, boolean>>({})

  const isProject = () => scope() !== GLOBAL
  const callOptions = () => (isProject() ? { location: { directory: scope() } } : undefined)
  const layerOf = (s: AgentsState) => (isProject() ? s.project : s.global) ?? { agents: {} }

  const adopt = (s: AgentsState) => {
    setServer(s)
    setDraft("agents", reconcile(structuredClone(layerOf(s).agents ?? {})))
    setDirty(false)
  }

  const load = async () => {
    setLoadError(undefined)
    setServer(undefined)
    try {
      adopt((await rpc().agentsState({}, callOptions())) as AgentsState)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  const loadProjects = async () => {
    const out: Project[] = []
    const add = (p: any) => {
      const directory = p?.worktree ?? p?.canonical ?? p?.directory
      if (!directory || out.some((x) => x.directory === directory)) return
      out.push({ directory, name: p?.name || baseName(directory) })
    }
    try {
      add(ctx.sessions?.current?.()?.project)
    } catch {}
    try {
      const res = await ctx.client?.project?.list?.()
      for (const p of (res?.data ?? res ?? []) as any[]) if (!p?.time?.archived && !p?.archived) add(p)
    } catch {}
    setProjects(out)
  }

  onMount(() => {
    void loadProjects()
    void load()
  })

  const changeScope = (next: string) => {
    if (dirty() || next === scope()) return
    setScope(next)
    setOpen({})
    void load()
  }

  const update = (id: string, patch: Partial<AgentOverride>) => {
    setDraft("agents", id, (o) => {
      const next: any = { ...(o ?? {}), ...patch }
      for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k]
      return next
    })
    setDirty(true)
  }

  const reset = (id: string) => {
    setDraft("agents", (all) => {
      const next = { ...all }
      delete next[id]
      return reconcile(next)(all)
    })
    setDirty(true)
  }

  const save = async () => {
    setBusy(true)
    try {
      const overrides = { agents: structuredClone(unwrap(draft.agents)) }
      adopt((await rpc().agentsSave({ scope: isProject() ? "project" : "global", overrides }, callOptions())) as AgentsState)
      ctx.toast.show({ title: t("ag.saved"), description: t("ag.savedDetail"), variant: "success" })
    } catch (e: any) {
      const message = e?.data?.message ?? e?.message ?? String(e)
      ctx.toast.show({ title: t("ag.saveFailed"), description: message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const revert = () => {
    const s = server()
    if (s) adopt(s)
  }

  /** What an agent gets from the layers below the one being edited. */
  const inherited = (a: AgentInfo): AgentOverride => {
    const below = isProject() ? (server()?.global.agents?.[a.id] ?? {}) : {}
    return { ...a.base, ...below }
  }
  const sourceOf = (a: AgentInfo, key: keyof AgentOverride) => {
    if (draft.agents[a.id]?.[key] !== undefined) return t("ag.setHere")
    if (isProject() && server()?.global.agents?.[a.id]?.[key] !== undefined) return t("ag.fromGlobal")
    return t("ag.fromDefault")
  }

  const models = () => server()?.models ?? []
  const modelLabel = (value?: string) => {
    const { model, variant } = splitModel(value)
    if (!model) return t("ag.sessionModel")
    const label = models().find((m) => m.value === model)?.label ?? model
    return variant ? `${label} · ${variant}` : label
  }
  const modelOptions = (a: AgentInfo, current?: string) => {
    const list = models().map(({ value, label }) => ({ value, label }))
    const withCurrent = current && !list.some((m) => m.value === current) ? [{ value: current, label: current }, ...list] : list
    return [{ value: "", label: `${t("ag.inherit")} (${modelLabel(inherited(a).model)})` }, ...withCurrent]
  }
  const variantsOf = (model?: string) => models().find((m) => m.value === model)?.variants ?? []

  const groups = createMemo(() => {
    const agents = server()?.agents ?? []
    return [
      { title: t("ag.primary"), agents: agents.filter((a) => a.mode !== "subagent" && !a.hidden) },
      { title: t("ag.subagents"), agents: agents.filter((a) => a.mode === "subagent") },
      { title: t("ag.system"), agents: agents.filter((a) => a.mode !== "subagent" && a.hidden) },
    ].filter((g) => g.agents.length)
  })

  const hasOverride = (id: string) => Object.keys(draft.agents[id] ?? {}).length > 0
  const isOpen = (id: string) => open()[id] ?? ["steps", "description", "prompt_append"].some((k) => (draft.agents[id] as any)?.[k] !== undefined)

  const AgentSection = (p: { agent: AgentInfo }) => {
    const a = p.agent
    const o = () => draft.agents[a.id] ?? {}
    const chosen = () => splitModel(o().model)
    const lowerDisabled = () => !!inherited(a).disabled
    return (
      <ui.SettingsSection title={a.name}>
        <ui.SettingsRow id="agents-list" title={t("ag.model")} description={sourceOf(a, "model")}>
          <ui.Select
            label={`${a.name}: ${t("ag.model")}`}
            options={modelOptions(a, chosen().model)}
            value={chosen().model ?? ""}
            onChange={(v: string) => update(a.id, { model: v || undefined })}
          />
          <Show when={chosen().model && variantsOf(chosen().model).length > 0}>
            <ui.Select
              label={`${a.name}: ${t("ag.variant")}`}
              options={[{ value: "", label: t("ag.defaultVariant") }, ...variantsOf(chosen().model).map((v) => ({ value: v, label: v }))]}
              value={chosen().variant ?? ""}
              onChange={(v: string) => update(a.id, { model: v ? `${chosen().model}#${v}` : chosen().model })}
            />
          </Show>
        </ui.SettingsRow>
        <ui.SettingsRow title={t("ag.enabled")} description={`${t("ag.enabledHint")} ${sourceOf(a, "disabled")}.`}>
          <ui.Switch
            label={`${a.name}: ${t("ag.enabled")}`}
            hideLabel
            checked={!(o().disabled ?? lowerDisabled())}
            onChange={(on: boolean) => update(a.id, { disabled: !on === lowerDisabled() ? undefined : !on })}
          />
        </ui.SettingsRow>
        <Show when={isOpen(a.id)}>
          <ui.SettingsRow title={t("ag.steps")} description={`${t("ag.stepsHint")} ${sourceOf(a, "steps")}.`}>
            <ui.TextInput
              label={`${a.name}: ${t("ag.steps")}`}
              placeholder={inherited(a).steps ? String(inherited(a).steps) : ""}
              value={o().steps ? String(o().steps) : ""}
              invalid={!!o().steps && !(Number.isInteger(o().steps) && o().steps! > 0)}
              onInput={(v: string) => {
                const n = v.trim() === "" ? undefined : Number(v)
                update(a.id, { steps: n === undefined || Number.isNaN(n) ? undefined : n })
              }}
            />
          </ui.SettingsRow>
          <ui.SettingsRow title={t("ag.agentDescription")} description={`${t("ag.agentDescriptionHint")} ${sourceOf(a, "description")}.`}>
            <TextArea
              label={`${a.name}: ${t("ag.agentDescription")}`}
              placeholder={inherited(a).description ?? ""}
              value={o().description ?? ""}
              onInput={(v) => update(a.id, { description: v })}
            />
          </ui.SettingsRow>
          <ui.SettingsRow title={t("ag.extra")} description={`${t("ag.extraHint")} ${sourceOf(a, "prompt_append")}.`}>
            <TextArea
              label={`${a.name}: ${t("ag.extra")}`}
              placeholder={inherited(a).prompt_append ?? ""}
              value={o().prompt_append ?? ""}
              onInput={(v) => update(a.id, { prompt_append: v })}
            />
          </ui.SettingsRow>
        </Show>
        <ui.SettingsRow title={a.id} description={hasOverride(a.id) ? t("ag.resetHint") : undefined}>
          <ui.Button variant="neutral" onClick={() => setOpen({ ...open(), [a.id]: !isOpen(a.id) })}>
            {isOpen(a.id) ? t("ag.less") : t("ag.more")}
          </ui.Button>
          <ui.Button variant="neutral" disabled={!hasOverride(a.id)} onClick={() => reset(a.id)}>
            {t("ag.reset")}
          </ui.Button>
        </ui.SettingsRow>
      </ui.SettingsSection>
    )
  }

  const scopeOptions = () => [
    { value: GLOBAL, label: t("ag.scopeGlobal") },
    ...projects().map((p) => ({ value: p.directory, label: `${t("ag.scopeProject")}: ${p.name}` })),
  ]
  const filePath = () => (isProject() ? server()?.paths.project : server()?.paths.global)

  return (
    <ui.SettingsLayout
      title={t("ag.title")}
      description={t("ag.description")}
      actions={
        <ui.Button variant="contrast" icon="check" busy={busy()} disabled={!dirty() || !server()} onClick={save}>
          {t("ag.save")}
        </ui.Button>
      }
    >
      <PageStyles />
      <ui.SettingsSection>
        <ui.SettingsRow
          id="agents-scope"
          title={t("ag.scope")}
          description={dirty() ? t("ag.scopeLocked") : isProject() ? t("ag.scopeProjectHint") : t("ag.scopeGlobalHint")}
        >
          <ui.Select label={t("ag.scope")} options={scopeOptions()} value={scope()} disabled={dirty()} onChange={changeScope} />
        </ui.SettingsRow>
      </ui.SettingsSection>

      <Show when={loadError()}>
        <ui.SettingsSection
          title={t("ag.loadFailed")}
          footer={
            <ui.Button variant="neutral" onClick={load}>
              {t("ag.retry")}
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
        <Show when={server()!.warnings.length > 0}>
          <ui.SettingsSection title={t("ag.warnings")}>
            <For each={server()!.warnings}>{(w) => <ui.SettingsRow title={w} />}</For>
          </ui.SettingsSection>
        </Show>

        <Show when={groups().length === 0}>
          <ui.SettingsSection>
            <ui.SettingsRow title={t("ag.empty")} />
          </ui.SettingsSection>
        </Show>

        <For each={groups()}>
          {(g) => (
            <>
              <h3 class="ocf-group" style={{ margin: "8px 0 0", "font-size": "14px", "font-weight": 600, color: "var(--text-strong)" }}>
                {g.title}
              </h3>
              <For each={g.agents}>{(a) => <AgentSection agent={a} />}</For>
            </>
          )}
        </For>

        <Show when={server()!.managed.length > 0}>
          <ui.SettingsSection>
            <ui.SettingsRow title={`${t("ag.managed")} ${server()!.managed.filter((m) => !m.endsWith("-sidekick")).join(", ")}`} />
          </ui.SettingsSection>
        </Show>

        <ui.SettingsSection
          footer={
            <span>
              {t("ag.file")}: {filePath()}
            </span>
          }
        >
          <ui.SettingsRow title={dirty() ? t("ag.unsaved") : t("ag.file")} description={filePath()}>
            <ui.Button variant="neutral" disabled={!dirty()} onClick={revert}>
              {t("ag.revert")}
            </ui.Button>
            <ui.Button variant="contrast" icon="check" busy={busy()} disabled={!dirty()} onClick={save}>
              {t("ag.save")}
            </ui.Button>
          </ui.SettingsRow>
        </ui.SettingsSection>
      </Show>
    </ui.SettingsLayout>
  )
}
