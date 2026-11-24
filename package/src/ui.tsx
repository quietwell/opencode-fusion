/**
 * Shared settings-page components. The app's UI kit differs between versions: 2.2.0 has no Select and no
 * Settings* components (added in 2.2.6), and no version has a multi-line text field. Use the app's component
 * when it exists, else a small stand-in styled with the app's theme variables.
 */
import { For, Show } from "solid-js"

const CSS = `
.ocf-page{display:flex;flex-direction:column;gap:24px;padding:24px 32px 48px;max-width:760px;width:100%;margin:0 auto;box-sizing:border-box;color:var(--text-base)}
.ocf-head{display:flex;align-items:flex-start;gap:16px}
.ocf-head-text{flex:1;min-width:0}
.ocf-title{margin:0;font-size:18px;font-weight:600;color:var(--text-strong)}
.ocf-desc{margin:6px 0 0;font-size:13px;line-height:1.5;color:var(--text-weak)}
.ocf-section{display:flex;flex-direction:column;gap:8px}
.ocf-section-title{margin:0;font-size:13px;font-weight:500;color:var(--text-strong)}
.ocf-list{border:1px solid var(--border-weak-base);border-radius:8px;background:var(--surface-raised-base,transparent)}
.ocf-row{display:flex;align-items:center;gap:16px;padding:12px 16px}
.ocf-row+.ocf-row{border-top:1px solid var(--border-weak-base)}
.ocf-row-text{flex:1;min-width:0}
.ocf-row-title{font-size:13px;color:var(--text-strong);overflow-wrap:anywhere}
.ocf-row-desc{margin-top:2px;font-size:12px;line-height:1.4;color:var(--text-weak)}
.ocf-row-control{display:flex;align-items:center;gap:8px;flex-shrink:0;max-width:60%}
.ocf-footer{font-size:12px;color:var(--text-weak);overflow-wrap:anywhere}
.ocf-select,.ocf-input{font:inherit;font-size:13px;color:var(--text-strong);background:var(--surface-base,transparent);border:1px solid var(--border-base);border-radius:6px;padding:5px 8px;min-width:200px;max-width:280px}
.ocf-input[aria-invalid=true]{border-color:var(--border-critical-selected,#d33)}
.ocf-button{font:inherit;font-size:13px;color:var(--text-strong);background:var(--surface-base,transparent);border:1px solid var(--border-base);border-radius:6px;padding:5px 12px;cursor:pointer}
.ocf-button:disabled{opacity:.5;cursor:default}
`

/** Styles every page needs, also next to the app's own settings components. */
const ALWAYS_CSS = `
.ocf-textarea{font:inherit;font-size:13px;line-height:1.45;color:var(--text-strong);background:var(--surface-base,transparent);border:1px solid var(--border-base);border-radius:6px;padding:6px 8px;width:280px;max-width:100%;min-height:64px;resize:vertical;box-sizing:border-box}
.ocf-textarea::placeholder{color:var(--text-weak)}
.ocf-textarea:focus{outline:none;border-color:var(--border-selected,var(--border-strong-base,var(--border-base)))}
.ocf-muted{font-size:12px;color:var(--text-weak)}
`
export const PageStyles = () => <style>{ALWAYS_CSS}</style>

function FallbackLayout(p: { title?: string; description?: string; actions?: any; children?: any }) {
  return (
    <div class="ocf-page">
      <style>{CSS}</style>
      <div class="ocf-head">
        <div class="ocf-head-text">
          <h2 class="ocf-title">{p.title}</h2>
          <Show when={p.description}>
            <p class="ocf-desc">{p.description}</p>
          </Show>
        </div>
        {p.actions}
      </div>
      {p.children}
    </div>
  )
}

function FallbackSection(p: { title?: string; footer?: any; children?: any }) {
  return (
    <section class="ocf-section">
      <Show when={p.title}>
        <h3 class="ocf-section-title">{p.title}</h3>
      </Show>
      <div class="ocf-list">{p.children}</div>
      <Show when={p.footer}>
        <div class="ocf-footer">{p.footer}</div>
      </Show>
    </section>
  )
}

function FallbackRow(p: { id?: string; title?: string; description?: string; children?: any }) {
  return (
    <div class="ocf-row" data-setting-id={p.id}>
      <div class="ocf-row-text">
        <div class="ocf-row-title">{p.title}</div>
        <Show when={p.description}>
          <div class="ocf-row-desc">{p.description}</div>
        </Show>
      </div>
      <Show when={p.children}>
        <div class="ocf-row-control">{p.children}</div>
      </Show>
    </div>
  )
}

function FallbackSelect(p: {
  label?: string
  placeholder?: string
  options: { value: string; label: string }[]
  value?: string
  disabled?: boolean
  onChange: (v: string) => void
}) {
  return (
    <select
      class="ocf-select"
      aria-label={p.label}
      value={p.value ?? ""}
      disabled={p.disabled}
      onChange={(e) => p.onChange(e.currentTarget.value)}
    >
      <Show when={!p.value && !p.options.some((o) => o.value === "")}>
        <option value="" disabled>
          {p.placeholder}
        </option>
      </Show>
      <For each={p.options}>{(o) => <option value={o.value} selected={o.value === (p.value ?? "")}>{o.label}</option>}</For>
    </select>
  )
}

function FallbackTextInput(p: any) {
  return (
    <input
      class="ocf-input"
      type="text"
      aria-label={p.label}
      aria-invalid={p.invalid ? "true" : undefined}
      placeholder={p.placeholder}
      value={p.value ?? ""}
      onInput={(e) => p.onInput?.(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.isComposing && p.onSubmit) {
          e.preventDefault()
          p.onSubmit(e.currentTarget.value)
        }
      }}
    />
  )
}

function FallbackSwitch(p: any) {
  return (
    <input type="checkbox" aria-label={p.label} checked={!!p.checked} onChange={(e) => p.onChange?.(e.currentTarget.checked)} />
  )
}

function FallbackButton(p: any) {
  return (
    <button class="ocf-button" type="button" disabled={p.disabled || p.busy} onClick={(e) => p.onClick?.(e)}>
      {p.children}
    </button>
  )
}

function FallbackLoader() {
  return <div class="ocf-desc">…</div>
}

/** Multi-line text. No app version has one, so it is always this; `PageStyles` styles it. */
export function TextArea(p: { label: string; value: string; placeholder?: string; onInput: (v: string) => void }) {
  return (
    <textarea
      class="ocf-textarea"
      aria-label={p.label}
      placeholder={p.placeholder}
      value={p.value}
      onInput={(e) => p.onInput(e.currentTarget.value)}
    />
  )
}

export function kit(ui: any = {}) {
  const has = (name: string) => typeof ui[name] === "function"
  // Without the app's settings frame, the app's other settings styles aren't there either; keep the stand-ins together.
  const settings = has("SettingsLayout") && has("SettingsSection") && has("SettingsRow")
  return {
    SettingsLayout: settings ? ui.SettingsLayout : FallbackLayout,
    SettingsSection: settings ? ui.SettingsSection : FallbackSection,
    SettingsRow: settings ? ui.SettingsRow : FallbackRow,
    Select: has("Select") ? ui.Select : FallbackSelect,
    TextInput: has("TextInput") ? ui.TextInput : FallbackTextInput,
    Switch: has("Switch") ? ui.Switch : FallbackSwitch,
    Button: has("Button") ? ui.Button : FallbackButton,
    Loader: has("Loader") ? ui.Loader : FallbackLoader,
  }
}
