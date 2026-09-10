/**
 * Tests for the pi widget.
 *
 * The widget's failure mode is silence: a line that does not change tells you
 * nothing about which step gave up. These cover both halves — how a status
 * result becomes a line, and whether a tool call reaches a refresh at all —
 * so a stale widget can be diagnosed here rather than in an editor session.
 *
 * The event-flow tests drive the real extension through a fake pi API, with
 * payloads copied from what pi-mcp-adapter actually returns for a gateway call.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import extension, {
  formatCoverage,
  setI18nPersistentSurface,
  formatStatus,
  formatOutstanding,
  formatProgress,
  formatTranslateReport,
  formatUndefinedKeys,
  parseTranslateReport,
} from "./extension.ts";

/** A translate_missing result in the shape the MCP tool actually returns. */
const TRANSLATE_RESULT = JSON.stringify({
  layers: {
    default: {
      results: {
        "es-ES": {
          mode: "provider",
          missing: 3,
          translated: ["booking.confirm", "booking.resource", "booking.upcoming"],
          failed: [],
          skipped: [],
          placeholderValidation: { ok: true, placeholders: [], errors: [] },
        },
        "fr-FR": {
          mode: "provider",
          missing: 1,
          translated: ["booking.upcoming"],
          failed: [],
          skipped: [],
          placeholderValidation: {
            ok: false,
            placeholders: ["{count}"],
            errors: [{ locale: "fr-FR", key: "booking.upcoming", missing: ["{count}"], extra: [] }],
          },
        },
        "de-DE": {
          mode: "provider",
          missing: 0,
          translated: [],
          failed: [],
          skipped: [{ key: "booking.confirm", reason: "protected-locale" }],
        },
      },
    },
  },
});

/** anny-ui at rest: a quarter million keys, nothing missing. */
const COMPLETE = {
  locales: [{ code: "de", completion: 100, missing: 0, total: 8710, translated: 8710 }],
  summary: { completionPercent: 100, missingKeys: 0, totalKeys: 226460, translatedKeys: 226460 },
};

/**
 * anny-ui with one key added to the reference locale, measured from the real
 * project: 26 locales each miss one key, and the CLI still reports 100%.
 */
const ONE_KEY_SHORT = {
  locales: [
    { code: "de", completion: 100, missing: 0, total: 8710, translated: 8710 },
    { code: "bg-BG", completion: 100, missing: 1, total: 8711, translated: 8710 },
    { code: "cs-CZ", completion: 100, missing: 1, total: 8711, translated: 8710 },
    { code: "en", completion: 100, missing: 0, excludedFromOverall: true },
  ],
  summary: { completionPercent: 100, missingKeys: 26, totalKeys: 226486, translatedKeys: 226460 },
};

/** anny-ui's real shape: 26 locales, one key short each. */
const ONE_KEY_SHORT_WIDE = {
  locales: Array.from({ length: 26 }, (_, index) => ({
    code: `l${index}`,
    completion: 100,
    missing: 1,
    total: 8711,
    translated: 8710,
  })),
  summary: { completionPercent: 100, missingKeys: 26, totalKeys: 226486, translatedKeys: 226460 },
};

// The channel outlives a test, so each one starts from the same place.
beforeEach(() => setI18nPersistentSurface(false));

describe("formatOutstanding", () => {
  it("leads with counts, not percentages", () => {
    const line = formatOutstanding({
      locales: [
        { code: "es-ES", completion: 75, missing: 3, total: 12, translated: 9 },
        { code: "fr-FR", completion: 91.7, missing: 1, total: 12, translated: 11 },
      ],
      summary: { completionPercent: 83.3, missingKeys: 4, totalKeys: 24, translatedKeys: 20 },
    });
    expect(line).toBe("🌐 4 keys missing · es-ES 3 · fr-FR 1");
    expect(line).not.toContain("%");
  });

  it("counts locales instead of naming them when the gaps are spread thin", () => {
    // anny-ui: one key added to the reference locale, missing in 26 others.
    expect(formatOutstanding(ONE_KEY_SHORT_WIDE)).toBe("🌐 26 keys missing · 26 locales");
  });

  it("keeps singular nouns singular", () => {
    expect(
      formatOutstanding({
        locales: [{ code: "fr-FR", missing: 1 }],
        summary: { missingKeys: 1 },
      }),
    ).toBe("🌐 1 key missing · fr-FR 1");
  });

  it("has nothing to report when nothing is missing", () => {
    expect(formatOutstanding(COMPLETE)).toBeUndefined();
  });
});

describe("formatCoverage", () => {
  it("describes the settled state without claiming an event happened", () => {
    expect(formatCoverage(COMPLETE)).toBe("🌐 all locales up to date");
  });

  it("never claims 100% next to missing keys", () => {
    const line = formatCoverage(ONE_KEY_SHORT);
    expect(line).not.toContain("100%");
    expect(line).toContain("26 missing");
  });

  it("counts a locale as incomplete by missing keys, not rounded completion", () => {
    // Every locale here reports completion: 100 despite missing a key.
    expect(formatCoverage(ONE_KEY_SHORT)).toContain("bg-BG");
  });

  it("lists the worst locales first and collapses the rest", () => {
    const line = formatCoverage({
      locales: [
        { code: "aa", completion: 90, missing: 1, total: 10, translated: 9 },
        { code: "bb", completion: 50, missing: 5, total: 10, translated: 5 },
        { code: "cc", completion: 60, missing: 4, total: 10, translated: 6 },
        { code: "dd", completion: 70, missing: 3, total: 10, translated: 7 },
        { code: "ee", completion: 80, missing: 2, total: 10, translated: 8 },
      ],
      summary: { completionPercent: 70, missingKeys: 15, totalKeys: 50, translatedKeys: 35 },
    });
    expect(line).toBe("🌐 70% · bb 50% · cc 60% · dd 70% · ee 80% · +1 more · 15 missing");
  });

  it("excludes protected locales from the listing", () => {
    const line = formatCoverage(ONE_KEY_SHORT);
    expect(line).not.toContain("en ");
  });

  it("has nothing to say about an empty status", () => {
    expect(formatCoverage({})).toBeUndefined();
  });
});

describe("translate reports", () => {
  it("reads which locales moved out of the tool's own result", () => {
    const report = parseTranslateReport(TRANSLATE_RESULT);
    expect(report?.perLocale).toEqual([
      { code: "es-ES", translated: 3 },
      { code: "fr-FR", translated: 1 },
    ]);
  });

  it("notices a dropped placeholder and a protected locale", () => {
    const report = parseTranslateReport(TRANSLATE_RESULT);
    expect(report?.placeholderIssues).toEqual([
      { locale: "fr-FR", key: "booking.upcoming", missing: ["{count}"] },
    ]);
    expect(report?.protectedLocales).toEqual(["de-DE"]);
  });

  it("survives a truncated or non-JSON result", () => {
    expect(parseTranslateReport("{\"layers\": {\"default\": {\"resul")).toBeUndefined();
    expect(parseTranslateReport("not json at all")).toBeUndefined();
  });

  it("names the locales that moved, the placeholder, and the skip", () => {
    const report = parseTranslateReport(TRANSLATE_RESULT)!;
    expect(formatTranslateReport(report, 0)).toBe(
      "🌐 es-ES +3 · fr-FR +1 · ⚠ fr-FR dropped {count} · 1 locale protected, skipped",
    );
  });

  it("keeps what is still outstanding in the same line", () => {
    const report = parseTranslateReport(TRANSLATE_RESULT)!;
    expect(formatTranslateReport(report, 4)).toContain("4 still missing");
  });
});

describe("formatUndefinedKeys", () => {
  it("names the keys that would render raw", () => {
    expect(formatUndefinedKeys(["checkout.payNow", "cart.empty"])).toBe(
      "🌐 2 undefined keys · checkout.payNow, cart.empty",
    );
  });

  it("caps the list", () => {
    expect(formatUndefinedKeys(["a", "b", "c", "d", "e"])).toBe("🌐 5 undefined keys · a, b, c +2");
  });

  it("says nothing when the code is clean", () => {
    expect(formatUndefinedKeys([])).toBeUndefined();
  });
});

describe("the status channel", () => {
  it("is shared between separate copies of this module", async () => {
    /*
     * pi loads every extension through its own jiti instance with the module
     * cache disabled, so an extension importing this file gets a second copy of
     * it. Two imports with different query strings reproduce that here: state
     * kept in module scope would not survive it, and the editor border that
     * reads this would show nothing — which is precisely what it did.
     */
    type Module = typeof import("./extension.ts");
    // The query suffix is what defeats the cache; TypeScript cannot resolve a
    // specifier it does not recognise, and the runtime is the point here.
    // @ts-expect-error -- deliberate cache-busting specifier
    const first: Module = await import("./extension.ts?copy=1");
    // @ts-expect-error -- deliberate cache-busting specifier
    const second: Module = await import("./extension.ts?copy=2");
    expect(first).not.toBe(second);

    const { fire, statuses } = harness(projectDir(), [JSON.stringify(ONE_KEY_SHORT_WIDE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(statuses).toHaveBeenCalledWith("i18n", "🌐 26 missing"));

    // Whichever copy publishes, every copy can read.
    expect(first.getI18nStatus()).toBe("🌐 26 missing");
    expect(second.getI18nStatus()).toBe("🌐 26 missing");
  });
});

describe("formatStatus", () => {
  it("states coverage in as few cells as a footer can spare", () => {
    expect(formatStatus(4)).toBe("🌐 4 missing");
    expect(formatStatus(0)).toBe("🌐 ✓");
  });

  it("admits when the number is unknown", () => {
    expect(formatStatus(undefined)).toBe("🌐 ?");
  });
});

describe("formatProgress", () => {
  it("renders a message with its ratio", () => {
    expect(formatProgress({ progress: 3, total: 6, message: "es-ES: batch 1/1" })).toBe("🌐 es-ES: batch 1/1 (3/6)");
  });

  it("copes with a progress notification that carries no total", () => {
    expect(formatProgress({ progress: 2, message: "translating" })).toBe("🌐 translating (2)");
  });
});

/** A pi API and context that record what the extension does with them. */
function harness(cwd: string, statusResults: string[], tagColors = false) {
  const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
  const lines: (string | undefined)[] = [];
  let execCount = 0;
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      (handlers[name] ??= []).push(fn);
    },
    registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commandHandler = options.handler;
    },
    exec: vi.fn(async () => {
      const next = statusResults[Math.min(execCount++, statusResults.length - 1)] ?? "";
      // A result starting with "!" stands for a failed CLI run, the rest being stderr.
      if (next.startsWith("!")) {
        return { stdout: "", stderr: next.slice(1), code: 1, killed: false };
      }
      return { stdout: next, stderr: "", code: 0, killed: false };
    }),
  };
  // A theme that returns text untouched, so assertions stay about content, and a
  // TUI whose renders are counted rather than drawn.
  const theme = {
    fg: (color: string, text: string) => (tagColors ? `<${color}>${text}</${color}>` : text),
  } as never;
  const tui = { requestRender: () => renderComponent() } as never;
  let component: { render: (width: number) => string[]; dispose?: () => void } | undefined;
  const renders: string[] = [];

  const renderComponent = () => {
    const [line] = component?.render(120) ?? [];
    renders.push(line ?? "");
    if (line !== undefined) lines.push(line);
  };

  const ctx = {
    hasUI: true,
    cwd,
    ui: {
      setWidget: (
        _key: string,
        content?: string[] | ((tui: never, theme: never) => { render: (width: number) => string[]; dispose?: () => void }),
      ) => {
        if (content === undefined) {
          component?.dispose?.();
          component = undefined;
          lines.push(undefined);
          return;
        }
        if (typeof content === "function") {
          component = content(tui, theme);
          renderComponent();
          return;
        }
        lines.push(content[0]);
      },
      setWorkingMessage: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extension(pi as any);

  return {
    lines,
    pi,
    fire: async (name: string, event: unknown) => {
      for (const handler of handlers[name] ?? []) await handler(event, ctx);
    },
    command: async () => commandHandler?.("", ctx),
    workingMessages: ctx.ui.setWorkingMessage,
    statuses: ctx.ui.setStatus,
    renders,
  };
}

/** A directory that looks like an i18n-kit project to the upward search. */
function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "i18n-kit-widget-"));
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, ".i18n-mcp.json"), "{}");
  return dir;
}

describe("event flow", () => {
  it("says nothing at session start when there is no work", async () => {
    const { fire, lines, pi } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(pi.exec).toHaveBeenCalled());
    // It read the project, and chose to stay off screen.
    await vi.waitFor(() => expect(lines).toEqual([undefined]));
  });

  it("mentions outstanding work at session start, then withdraws", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "300");
    const { fire, lines } = harness(projectDir(), [JSON.stringify(ONE_KEY_SHORT_WIDE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines[0]).toBe("🌐 26 keys missing · 26 locales"));
    await vi.waitFor(() => expect(lines.at(-1)).toBeUndefined(), { timeout: 5_000 });
    vi.unstubAllEnvs();
  });

  it("reports a partial resolution as what moved and what is left", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "300");
    const partial = {
      locales: [{ code: "fr-FR", missing: 4, completion: 90 }],
      summary: { missingKeys: 4, completionPercent: 90, totalKeys: 40, translatedKeys: 36 },
    };
    const { fire, lines } = harness(projectDir(), [JSON.stringify(ONE_KEY_SHORT_WIDE), JSON.stringify(partial)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines[0]).toContain("26 keys missing"));

    await fire("tool_execution_end", {
      toolName: "mcp",
      isError: false,
      result: { content: [], details: { mode: "call", server: "the-i18n-mcp", tool: "translate_missing" } },
    });

    await vi.waitFor(() => expect(lines).toContain("🌐 22 resolved · 4 still missing"), { timeout: 5_000 });
    vi.unstubAllEnvs();
  });

  it("stays quiet outside an i18n-kit project", async () => {
    const { fire, lines, pi } = harness(mkdtempSync(join(tmpdir(), "plain-")), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    expect(lines).toEqual([]);
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("refreshes after a kit tool writes, through the gateway", async () => {
    const { fire, lines } = harness(projectDir(), [JSON.stringify(COMPLETE), JSON.stringify(ONE_KEY_SHORT)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines.length).toBe(1));

    // The shape pi-mcp-adapter returns for mcp({ tool: "write_translations" }).
    await fire("tool_execution_end", {
      toolName: "mcp",
      isError: false,
      result: { content: [], details: { mode: "call", server: "the-i18n-mcp", tool: "write_translations" } },
    });

    await vi.waitFor(
      () => expect(lines.some((line) => line?.includes("26 keys missing"))).toBe(true),
      { timeout: 5_000 },
    );
  });

  it("ignores tools that cannot change coverage", async () => {
    const { fire, lines } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines.length).toBe(1));

    await fire("tool_execution_end", {
      toolName: "mcp",
      isError: false,
      result: { content: [], details: { mode: "call", server: "the-i18n-mcp", tool: "get_translation_status" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(lines.length).toBe(1);
  });

  it("reports what a translate resolved, then withdraws", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "300");
    const { fire, lines } = harness(projectDir(), [JSON.stringify(ONE_KEY_SHORT), JSON.stringify(COMPLETE)]);

    await fire("session_start", {});
    await vi.waitFor(() => expect(lines[0]).toContain("26 keys missing"));

    await fire("tool_execution_end", {
      toolName: "mcp",
      isError: false,
      result: { content: [], details: { mode: "call", server: "the-i18n-mcp", tool: "translate_missing" } },
    });

    await vi.waitFor(
      () => expect(lines).toContain("🌐 26 keys resolved · all locales up to date"),
      { timeout: 5_000 },
    );
    // and then it gets out of the way
    await vi.waitFor(() => expect(lines.at(-1)).toBeUndefined(), { timeout: 5_000 });
    vi.unstubAllEnvs();
  });

  it("answers an explicit request even when there is nothing to report", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "300");
    const { fire, lines, command } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines).toEqual([undefined]));

    await command();
    await vi.waitFor(() => expect(lines).toContain("🌐 all locales up to date"));
    await vi.waitFor(() => expect(lines.at(-1)).toBeUndefined(), { timeout: 5_000 });
    vi.unstubAllEnvs();
  });

  it("renders progress notifications while a translate runs", async () => {
    const { fire, lines } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines.length).toBe(1));

    await fire("tool_execution_update", {
      toolName: "mcp",
      partialResult: {
        content: [],
        details: {
          mcpProgress: { server: "the-i18n-mcp", tool: "translate_missing", progress: 3, total: 6, message: "es-ES: batch 1/1" },
        },
      },
    });

    const line = lines[1] ?? "";
    expect(line).toContain("es-ES: batch 1/1");
    expect(line).toContain("3/6");
    // half done, so half the bar is filled
    expect(line).toContain("██████░░░░░░");
    expect(line).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
  });

  it("renders plain text when styling is turned off", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_STYLE", "plain");
    const { fire, lines } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines.length).toBe(1));

    await fire("tool_execution_update", {
      toolName: "mcp",
      partialResult: {
        content: [],
        details: {
          mcpProgress: { server: "the-i18n-mcp", tool: "translate_missing", progress: 3, total: 6, message: "es-ES: batch 1/1" },
        },
      },
    });

    expect(lines[1]).toBe("🌐 es-ES: batch 1/1 (3/6)");
    vi.unstubAllEnvs();
  });

  it("colours outstanding work as a warning and resolution as a success", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "5000");
    const { fire, lines } = harness(
      projectDir(),
      [JSON.stringify(ONE_KEY_SHORT_WIDE), JSON.stringify(COMPLETE)],
      true,
    );

    await fire("session_start", {});
    await vi.waitFor(() => expect(lines[0]).toContain("<warning>26 keys missing</warning>"));
    expect(lines[0]).toContain("<accent>🌐</accent>");

    await fire("tool_execution_end", {
      toolName: "mcp",
      isError: false,
      result: { content: [], details: { mode: "call", server: "the-i18n-mcp", tool: "translate_missing" } },
    });

    await vi.waitFor(
      () => expect(lines.some((line) => line?.includes("<success>26 keys resolved</success>"))).toBe(true),
      { timeout: 5_000 },
    );
    vi.unstubAllEnvs();
  });

  it("says so when the status read fails, instead of looking like a clean project", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "5000");
    const { fire, lines, pi } = harness(projectDir(), [
      "!npm error code ETARGET\nNo matching version found for @the-i18n-kit/cli@8.3.0",
    ]);

    await fire("session_start", {});

    await vi.waitFor(() => expect(lines.some((line) => line?.includes("status unavailable"))).toBe(true));
    expect(lines.some((line) => line?.includes("ETARGET"))).toBe(true);
    // one retry before giving up, since npx fails transiently
    expect(pi.exec).toHaveBeenCalledTimes(2);
    vi.unstubAllEnvs();
  });

  it("recovers silently when the retry succeeds", async () => {
    const { fire, lines } = harness(projectDir(), ["!transient npm failure", JSON.stringify(ONE_KEY_SHORT_WIDE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines[0]).toBe("🌐 26 keys missing · 26 locales"));
    expect(lines.some((line) => line?.includes("unavailable"))).toBe(false);
  });

  it("asks the CLI about a directory explicitly, never implicitly", async () => {
    const root = projectDir();
    const { fire, pi } = harness(root, [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(pi.exec).toHaveBeenCalled());
    // Typed here rather than on the mock, which takes no declared parameters.
    const [, args = []] = (pi.exec.mock.calls[0] ?? []) as unknown as [string, string[]];
    expect(args).toContain("--projectDir");
    expect(args).toContain(root);
  });

  it("reports a translate from its own result rather than from the totals", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "5000");
    const { fire, lines } = harness(projectDir(), [JSON.stringify(ONE_KEY_SHORT_WIDE), JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines[0]).toContain("26 keys missing"));

    await fire("tool_execution_end", {
      toolName: "mcp",
      isError: false,
      result: {
        content: [{ type: "text", text: TRANSLATE_RESULT }],
        details: { mode: "call", server: "the-i18n-mcp", tool: "translate_missing" },
      },
    });

    await vi.waitFor(
      () => expect(lines.some((line) => line?.includes("es-ES +3 · fr-FR +1"))).toBe(true),
      { timeout: 5_000 },
    );
    expect(lines.some((line) => line?.includes("⚠ fr-FR dropped {count}"))).toBe(true);
    vi.unstubAllEnvs();
  });

  it("checks for undefined keys after a turn that edited source", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "5000");
    const check = JSON.stringify({
      undefinedKeys: [{ key: "checkout.payNow", app: "web", searchedLayers: [], usages: [] }],
      uncertainKeys: [],
      summary: { usedKeysChecked: 12, undefinedCount: 1, uncertainCount: 0 },
    });
    const { fire, lines } = harness(projectDir(), [JSON.stringify(COMPLETE), check]);
    await fire("session_start", {});

    await fire("tool_execution_start", { toolName: "edit", args: { path: "/src/Checkout.vue" } });
    await fire("turn_end", {});

    await vi.waitFor(
      () => expect(lines.some((line) => line?.includes("1 undefined key · checkout.payNow"))).toBe(true),
      { timeout: 5_000 },
    );
    vi.unstubAllEnvs();
  });

  it("does not run the check when a turn only touched locale files", async () => {
    const { fire, pi } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(pi.exec).toHaveBeenCalledTimes(1));

    await fire("tool_execution_start", { toolName: "edit", args: { path: "/src/locales/de.json" } });
    await fire("turn_end", {});

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pi.exec).toHaveBeenCalledTimes(1);
  });

  it("defers standing coverage at session start when a border carries it", async () => {
    setI18nPersistentSurface(true);
    const { fire, lines, statuses } = harness(projectDir(), [JSON.stringify(ONE_KEY_SHORT_WIDE)]);

    await fire("session_start", {});

    // The number is published for the border, and said nowhere else.
    await vi.waitFor(() => expect(statuses).toHaveBeenCalledWith("i18n", "🌐 26 missing"));
    expect(lines.filter((line) => line !== undefined)).toEqual([]);
  });

  it("still reports change when a border carries the standing figure", async () => {
    setI18nPersistentSurface(true);
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "5000");
    const { fire, lines } = harness(projectDir(), [
      JSON.stringify(ONE_KEY_SHORT_WIDE),
      JSON.stringify(COMPLETE),
    ]);
    await fire("session_start", {});

    await fire("tool_execution_end", {
      toolName: "mcp",
      isError: false,
      result: { content: [], details: { mode: "call", server: "the-i18n-mcp", tool: "translate_missing" } },
    });

    await vi.waitFor(
      () => expect(lines.some((line) => line?.includes("26 keys resolved"))).toBe(true),
      { timeout: 5_000 },
    );
    vi.unstubAllEnvs();
  });

  it("publishes coverage as a status, even when the widget stays silent", async () => {
    const { fire, lines, statuses } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});

    // Nothing missing: no widget line, but the footer still knows.
    await vi.waitFor(() => expect(statuses).toHaveBeenCalledWith("i18n", "🌐 ✓"));
    expect(lines).toEqual([undefined]);
  });

  it("keeps the status current as work is resolved", async () => {
    vi.stubEnv("I18N_KIT_WIDGET_LINGER_MS", "300");
    const { fire, statuses } = harness(projectDir(), [
      JSON.stringify(ONE_KEY_SHORT_WIDE),
      JSON.stringify(COMPLETE),
    ]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(statuses).toHaveBeenCalledWith("i18n", "🌐 26 missing"));

    await fire("tool_execution_end", {
      toolName: "mcp",
      isError: false,
      result: { content: [], details: { mode: "call", server: "the-i18n-mcp", tool: "translate_missing" } },
    });

    await vi.waitFor(() => expect(statuses).toHaveBeenLastCalledWith("i18n", "🌐 ✓"), { timeout: 5_000 });
    vi.unstubAllEnvs();
  });

  it("stops asserting a number it could not read", async () => {
    const { fire, statuses } = harness(projectDir(), ["!npm error code ETARGET"]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(statuses).toHaveBeenCalledWith("i18n", "🌐 ?"));
  });

  it("publishes nothing when statuses are turned off", async () => {
    vi.stubEnv("I18N_KIT_STATUS", "off");
    const { fire, statuses, pi } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(pi.exec).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(statuses).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("narrates progress on the working row, and hands it back when the tool ends", async () => {
    const { fire, workingMessages } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});

    await fire("tool_execution_update", {
      toolName: "mcp",
      partialResult: {
        content: [],
        details: {
          mcpProgress: { server: "the-i18n-mcp", tool: "translate_missing", progress: 12, total: 40, message: "translating es-ES" },
        },
      },
    });
    expect(workingMessages).toHaveBeenCalledWith("translating es-ES (12/40)");

    await fire("tool_execution_end", {
      toolName: "mcp",
      isError: false,
      result: { content: [], details: { mode: "call", server: "the-i18n-mcp", tool: "translate_missing" } },
    });
    expect(workingMessages).toHaveBeenLastCalledWith();
  });
});
