/**
 * Translation coverage in the editor border.
 *
 * A widget by the editor is the right place for something that just happened;
 * it is the wrong place for a fact you glance at. That fact belongs in the
 * chrome you already read — and in pi, the chrome around the editor is drawn by
 * whichever extension owns the editor component, whose metadata set is closed.
 *
 * So this wraps the editor rather than replacing it: whatever component is
 * installed keeps rendering exactly as before, and coverage is placed into the
 * rule of the bottom border afterwards, consuming spare width rather than
 * adding any.
 *
 * The wrap happens at session start rather than at load, so it does not matter
 * whether the editor's owner loaded before or after this.
 *
 * Failure mode is deliberate: no custom editor, no border, or a frame this does
 * not recognise, and the editor renders untouched.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

/**
 * Derived from the API rather than imported: the type is part of pi's editor
 * contract but not re-exported from its entry point, and deriving it means this
 * follows the contract wherever it goes.
 */
type EditorFactory = NonNullable<ReturnType<NonNullable<ExtensionContext["ui"]["getEditorComponent"]>>>;
import { appendFileSync } from "node:fs";
import { getI18nStatus, setI18nPersistentSurface } from "../../integrations/pi/extension.ts";

/** Same switch as the widget's, so one run explains both halves. */
function debug(message: string, data?: unknown): void {
  const file = process.env.I18N_KIT_WIDGET_DEBUG;
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} [border] ${message} ${JSON.stringify(data ?? null)}\n`);
  } catch {
    // diagnostics never break the session
  }
}
import { injectIntoBorder, isBottomBorder } from "./border.ts";

/** Marks an instance whose render has already been patched. */
const PATCHED = Symbol.for("the-i18n-kit.border-patched");

/**
 * Make a component's bottom border carry `label()`.
 *
 * The component is patched in place and returned as itself, rather than wrapped
 * in a second object that delegates to it. An editor keeps its state in its own
 * fields and mutates them from its own methods, so a delegating wrapper ends up
 * owning half of that state: keystrokes land on the wrapper, rendering reads the
 * original, and the editor stops responding. One object, one state, one patched
 * method.
 */
function labelBottomBorder(editor: EditorComponent, label: () => string | undefined): EditorComponent {
  const target = editor as EditorComponent & { [PATCHED]?: boolean };
  if (target[PATCHED]) return editor;
  target[PATCHED] = true;

  const original = editor.render.bind(editor);
  editor.render = (width: number): string[] => {
    const lines = original(width);
    const text = label();
    if (!text) return lines;

    // Last border line, so a frame with autocomplete rows below the input is
    // still labelled on its own edge rather than in the middle of the list.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (!isBottomBorder(line)) continue;
      const labelled = injectIntoBorder(line, text);
      if (labelled === line) break;
      const next = [...lines];
      next[index] = labelled;
      return next;
    }
    return lines;
  };

  return editor;
}

/** Marks a factory as ours, so a re-check does not wrap a wrapper. */
const WRAPPED = Symbol.for("the-i18n-kit.border-wrapped");

/** How long to keep looking for an editor to wrap, and how often. */
const WRAP_RETRY_MS = 50;
const WRAP_TIMEOUT_MS = 3_000;

export default function i18nKitTheme(pi: ExtensionAPI): void {
  /**
   * Wrap the installed editor, if there is one and it is not already wrapped.
   *
   * Returns whether a wrapped editor is in place, so a caller can decide
   * whether to keep looking.
   */
  const ensureWrapped = (ctx: ExtensionContext): boolean => {
    const current: EditorFactory | undefined = ctx.ui.getEditorComponent?.();
    // Nothing to wrap: pi's own editor is not exposed as a factory, and taking
    // it over would mean reimplementing someone else's frame to add one label.
    if (!current) return false;
    if ((current as { [WRAPPED]?: boolean })[WRAPPED]) return true;

    // The label is read at render time, so no subscription is needed: every
    // change to it is already accompanied by a widget update from the kit
    // extension, and that is what asks the host for the next frame.
    const wrapped: EditorFactory = (tui, theme, keybindings) =>
      labelBottomBorder(current(tui, theme, keybindings), getI18nStatus);
    (wrapped as { [WRAPPED]?: boolean })[WRAPPED] = true;
    ctx.ui.setEditorComponent?.(wrapped);
    // The widget can stop announcing standing coverage now that the border has it.
    setI18nPersistentSurface(true);
    return true;
  };

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    debug("session_start", {
      hasUI: ctx.hasUI,
      hasFactory: Boolean(ctx.ui.getEditorComponent?.()),
      status: getI18nStatus(),
    });
    if (!ctx.hasUI) return;
    if (process.env.I18N_KIT_BORDER === "off") return;
    if (ensureWrapped(ctx)) {
      debug("wrapped at session_start");
      return;
    }

    /*
     * The editor this wraps is installed by another extension, in its own
     * session_start handler, and handlers run in load order — so whether one
     * exists yet depends on which package the settings happen to list first.
     * Rather than depend on that, keep looking for a short while.
     */
    const deadline = Date.now() + WRAP_TIMEOUT_MS;
    const timer = setInterval(() => {
      if (ensureWrapped(ctx)) {
        debug("wrapped after waiting");
        clearInterval(timer);
        return;
      }
      if (Date.now() > deadline) {
        debug("gave up waiting for an editor to wrap");
        clearInterval(timer);
      }
    }, WRAP_RETRY_MS);
    timer.unref?.();
  });

  // An editor installed later still gets wrapped: extensions re-install theirs
  // when their own settings change.
  pi.on("turn_start", (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI || process.env.I18N_KIT_BORDER === "off") return;
    ensureWrapped(ctx);
  });
}
