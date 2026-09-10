/**
 * The editor this wraps belongs to another extension, which installs it in its
 * own session_start handler. Handlers run in load order, so whether an editor
 * exists when this one looks is decided by the order packages happen to be
 * listed in — which is to say, not by anything this package controls.
 *
 * These tests pin both orders.
 */

import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

// Hoisted, because the module under test binds this import at load: mocking it
// afterwards would leave the real one in place.
const { statusRef, persistentSurface } = vi.hoisted(() => ({
  statusRef: { current: undefined as string | undefined },
  persistentSurface: { declared: false },
}));
vi.mock("../../integrations/pi/extension.ts", () => ({
  getI18nStatus: () => statusRef.current,
  setI18nPersistentSurface: (present: boolean) => {
    persistentSurface.declared = present;
  },
}));

import extension from "./extension.ts";

const BOTTOM = "╰─ main * ──────────────────────────────────────────── the-i18n-kit ─╯";

/**
 * An editor in the shape the host expects: state in its own fields, mutated by
 * its own methods, rendered from those same fields.
 *
 * That shape is the point. A wrapper that delegates instead of patching ends up
 * holding half the state — input lands on the wrapper, rendering reads the
 * original — and the editor stops responding to typing, which is what shipped.
 */
class FakeEditor implements Component {
  private text = "";
  private autocompleteOpen = false;

  render(): string[] {
    return [
      "╭─ 1m ────────────────────────────────────────────────────────────╮",
      `│ ${this.text}${this.autocompleteOpen ? " [suggestions]" : ""}`,
      BOTTOM,
    ];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    this.text += data;
    if (data === "/") this.autocompleteOpen = true;
  }

  getText(): string {
    return this.text;
  }
}

function fakeEditor(): Component {
  return new FakeEditor();
}

function harness(status: string | undefined = "🌐 4 missing") {
  const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
  let installed: ((...args: never[]) => Component) | undefined;

  const ctx = {
    hasUI: true,
    cwd: "/project",
    ui: {
      getEditorComponent: () => installed,
      setEditorComponent: (factory: (...args: never[]) => Component) => {
        installed = factory;
      },
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };

  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      (handlers[name] ??= []).push(fn);
    },
    registerCommand: vi.fn(),
    exec: vi.fn(),
  };

  // The status the border reads comes from the kit extension's module state.
  statusRef.current = status;

  return {
    pi,
    ctx,
    fire: async (name: string, event: unknown = {}) => {
      for (const handler of handlers[name] ?? []) await handler(event, ctx);
    },
    /** What the editor renders now, through whatever wrapping is in place. */
    renderEditor: () => installed?.(...([{}, {}, {}] as never[])).render(120) ?? [],
    /** The component the installed factory builds, as the host would get it. */
    editorInstance: () => installed?.(...([{}, {}, {}] as never[])),
    installEditor: (factory: (...args: never[]) => Component) => {
      installed = factory;
    },
    isInstalled: () => installed !== undefined,
  };
}

describe("keeping the editor working", () => {
  it("still types, and still opens autocomplete", async () => {
    const { pi, fire, installEditor, editorInstance } = harness();
    installEditor(fakeEditor);
    extension(pi as never);
    await fire("session_start");

    const editor = editorInstance() as unknown as FakeEditor;
    editor.handleInput("/");
    editor.handleInput("m");

    // The input must reach the same object that renders, or the editor freezes.
    expect(editor.getText()).toBe("/m");
    const lines = editor.render();
    expect(lines[1]).toContain("/m");
    expect(lines[1]).toContain("[suggestions]");
  });

  it("returns the editor itself, so the host keeps every method it had", async () => {
    const { pi, fire, installEditor, editorInstance } = harness();
    installEditor(fakeEditor);
    extension(pi as never);
    await fire("session_start");

    expect(editorInstance()).toBeInstanceOf(FakeEditor);
  });

  it("patches an instance once, however often it is wrapped", async () => {
    const { pi, fire, installEditor, editorInstance } = harness();
    installEditor(fakeEditor);
    extension(pi as never);
    await fire("session_start");
    await fire("turn_start");

    const line = (editorInstance()?.render(120) ?? []).at(-1) ?? "";
    expect(line.match(/🌐/gu) ?? []).toHaveLength(1);
  });
});

describe("wrapping the editor", () => {
  it("labels the border when an editor is already installed", async () => {
    const { pi, fire, installEditor, renderEditor } = harness();
    installEditor(fakeEditor);
    extension(pi as never);

    await fire("session_start");

    expect(renderEditor().at(-1)).toContain("🌐 4 missing");
  });

  it("waits for an editor installed after it, by an extension loaded later", async () => {
    const { pi, fire, installEditor, renderEditor } = harness();
    extension(pi as never);

    // Nothing to wrap yet: this is the order that broke it in a real session.
    await fire("session_start");
    expect(renderEditor()).toEqual([]);

    installEditor(fakeEditor);
    await vi.waitFor(() => expect(renderEditor().at(-1)).toContain("🌐 4 missing"), { timeout: 3_000 });
  });

  it("wraps an editor that appears only once a turn starts", async () => {
    const { pi, fire, installEditor, renderEditor } = harness();
    extension(pi as never);
    await fire("session_start");

    installEditor(fakeEditor);
    await fire("turn_start");

    expect(renderEditor().at(-1)).toContain("🌐 4 missing");
  });

  it("tells the widget that coverage now has a permanent home", async () => {
    const { pi, fire, installEditor } = harness();
    persistentSurface.declared = false;
    installEditor(fakeEditor);
    extension(pi as never);

    await fire("session_start");

    expect(persistentSurface.declared).toBe(true);
  });

  it("does not wrap a wrapper", async () => {
    const { pi, fire, installEditor, renderEditor } = harness();
    installEditor(fakeEditor);
    extension(pi as never);

    await fire("session_start");
    await fire("turn_start");
    await fire("turn_start");

    const line = renderEditor().at(-1) ?? "";
    expect(line.match(/🌐/gu) ?? []).toHaveLength(1);
  });

  it("leaves the editor alone when there is nothing to report", async () => {
    const { pi, fire, installEditor, renderEditor } = harness();
    // Explicitly, because harness(undefined) would take the default parameter.
    statusRef.current = undefined;
    installEditor(fakeEditor);
    extension(pi as never);

    await fire("session_start");

    expect(renderEditor().at(-1)).toBe(BOTTOM);
  });

  it("stays out of it when the border is turned off", async () => {
    vi.stubEnv("I18N_KIT_BORDER", "off");
    const { pi, fire, installEditor, renderEditor } = harness();
    installEditor(fakeEditor);
    extension(pi as never);

    await fire("session_start");

    expect(renderEditor().at(-1)).toBe(BOTTOM);
    vi.unstubAllEnvs();
  });
});
