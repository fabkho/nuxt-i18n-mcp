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
import { describe, expect, it, vi } from "vitest";
import extension, { formatCoverage, formatProgress } from "./extension.ts";

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

describe("formatCoverage", () => {
  it("says complete only when nothing is missing", () => {
    expect(formatCoverage(COMPLETE)).toBe("🌐 i18n complete");
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

describe("formatProgress", () => {
  it("renders a message with its ratio", () => {
    expect(formatProgress({ progress: 3, total: 6, message: "es-ES: batch 1/1" })).toBe("🌐 es-ES: batch 1/1 (3/6)");
  });

  it("copes with a progress notification that carries no total", () => {
    expect(formatProgress({ progress: 2, message: "translating" })).toBe("🌐 translating (2)");
  });
});

/** A pi API and context that record what the extension does with them. */
function harness(cwd: string, statusResults: string[]) {
  const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
  const lines: (string | undefined)[] = [];
  let execCount = 0;

  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      (handlers[name] ??= []).push(fn);
    },
    registerCommand: vi.fn(),
    exec: vi.fn(async () => ({
      stdout: statusResults[Math.min(execCount++, statusResults.length - 1)],
      stderr: "",
      code: 0,
      killed: false,
    })),
  };
  const ctx = {
    hasUI: true,
    cwd,
    ui: {
      setWidget: (_key: string, content?: string[]) => lines.push(content?.[0]),
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
  it("shows coverage at session start", async () => {
    const { fire, lines } = harness(projectDir(), [JSON.stringify(COMPLETE)]);
    await fire("session_start", {});
    await vi.waitFor(() => expect(lines).toEqual(["🌐 i18n complete"]));
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

    await vi.waitFor(() => expect(lines.length).toBe(2), { timeout: 5_000 });
    expect(lines[1]).toContain("26 missing");
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

    expect(lines[1]).toBe("🌐 es-ES: batch 1/1 (3/6)");
  });
});
