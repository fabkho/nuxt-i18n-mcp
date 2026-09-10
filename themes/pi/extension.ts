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
import { getI18nStatus } from "../../integrations/pi/extension.ts";
import { injectIntoBorder, isBottomBorder } from "./border.ts";

/**
 * Wrap a component so its bottom border carries `label()`.
 *
 * Everything but `render` is forwarded by delegation rather than copied: the
 * wrapped component may implement input handling, disposal or anything else the
 * host expects, and none of that is this file's business.
 */
function withBorderLabel(inner: EditorComponent, label: () => string | undefined): EditorComponent {
  const wrapper = Object.create(inner) as EditorComponent;

  wrapper.render = (width: number): string[] => {
    const lines = inner.render(width);
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

  return wrapper;
}

export default function i18nKitTheme(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (process.env.I18N_KIT_BORDER === "off") return;

    const current: EditorFactory | undefined = ctx.ui.getEditorComponent?.();
    // Nothing to wrap: pi's own editor is not exposed as a factory, and taking
    // it over would mean reimplementing someone else's frame to add one label.
    if (!current) return;

    // The label is read at render time, so no subscription is needed: every
    // change to it is already accompanied by a widget update from the kit
    // extension, and that is what asks the host for the next frame.
    const wrapped: EditorFactory = (tui, theme, keybindings) =>
      withBorderLabel(current(tui, theme, keybindings), getI18nStatus);
    ctx.ui.setEditorComponent?.(wrapped);
  });
}
