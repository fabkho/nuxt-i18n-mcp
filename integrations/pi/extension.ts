/**
 * the-i18n-kit widget for pi.
 *
 * Two things the transcript cannot show you:
 *
 *  1. **Coverage, always visible.** Translation coverage per locale in a widget
 *     by the editor, refreshed after any kit tool that writes.
 *  2. **Live translate progress.** `translate_missing` reports progress over
 *     MCP progress notifications; pi surfaces those as partial tool results
 *     (`tool_execution_update` → `details.mcpProgress`), and this renders them
 *     as they arrive rather than leaving a spinner with no numbers.
 *
 * Silent outside i18n-kit projects: no config file upward from the working
 * directory, no widget. Every CLI failure degrades to "no widget" rather than
 * an error in the session.
 */

import { appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "the-i18n-kit";

/**
 * Diagnostics for the one thing a widget cannot report about itself: why it did
 * not change. `I18N_KIT_WIDGET_DEBUG=<file>` appends every decision — events
 * seen, tools matched, what the CLI returned — so a session that shows a stale
 * line can be read afterwards instead of guessed at.
 */
const DEBUG_FILE = process.env.I18N_KIT_WIDGET_DEBUG;

function debug(message: string, data?: unknown): void {
  if (!DEBUG_FILE) return;
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  try {
    appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${message}${suffix}\n`);
  } catch {
    // diagnostics never break the session
  }
}

const CONFIG_FILES = [
  ".i18n-mcp.json",
  "i18n-kit.config.ts",
  "i18n-kit.config.mts",
  "i18n-kit.config.js",
  "i18n-kit.config.mjs",
];

/** Kit tools that change coverage; the widget refreshes after these. */
const MUTATING_TOOLS = [
  "translate_missing",
  "translate_key",
  "write_translations",
  "remove_translations",
  "move_translation_key",
  "scaffold",
];

/** Locales listed individually before the rest collapse into a count. */
const MAX_LISTED_LOCALES = 4;
const REFRESH_DEBOUNCE_MS = 1_500;

interface LocaleStatus {
  code: string;
  completion?: number;
  missing?: number;
  total?: number;
  translated?: number;
  protected?: boolean;
  excludedFromOverall?: boolean;
}

interface StatusResult {
  locales?: LocaleStatus[];
  summary?: {
    completionPercent?: number;
    missingKeys?: number;
    totalKeys?: number;
    translatedKeys?: number;
  };
}

/** Nearest ancestor directory holding an i18n-kit config, if any. */
function findProjectRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (CONFIG_FILES.some((name) => existsSync(join(dir, name)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Project-local CLI first, then a global one, then npx. */
function resolveCli(projectRoot: string): [string, string[]] {
  let dir = projectRoot;
  for (;;) {
    const local = join(dir, "node_modules", ".bin", "the-i18n-cli");
    if (existsSync(local)) return [local, []];
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return ["npx", ["-y", "@the-i18n-kit/cli@latest"]];
}

/** `translating de (12/40)` — one line, newest state wins. */
export function formatProgress(progress: Record<string, unknown>): string {
  const done = typeof progress.progress === "number" ? progress.progress : undefined;
  const total = typeof progress.total === "number" ? progress.total : undefined;
  const message = typeof progress.message === "string" ? progress.message : "working";
  const ratio = done === undefined ? "" : total === undefined ? ` (${done})` : ` (${done}/${total})`;
  return `🌐 ${message}${ratio}`;
}

/**
 * Coverage rounded down, never up, and computed from key counts where the
 * status result carries them.
 *
 * A quarter-million-key project with one key missing per locale is 99.99%
 * coverage, which the CLI reports as `completionPercent: 100` — so a widget
 * that trusts that field says "100%" next to "26 missing" and teaches you to
 * distrust it. Recomputing from translated/total keeps the number honest, and
 * flooring keeps 100 for the one case that earns it.
 */
function overallPercent(summary: StatusResult["summary"]): number | undefined {
  const total = summary?.totalKeys;
  const translated = summary?.translatedKeys;
  if (typeof total === "number" && typeof translated === "number" && total > 0) {
    return formatPercent((translated / total) * 100);
  }
  return summary?.completionPercent === undefined ? undefined : formatPercent(summary.completionPercent);
}

function formatPercent(value: number): number {
  return value >= 100 ? 100 : Math.floor(value);
}

/** A locale's own coverage, from its key counts where present. */
function localePercent(locale: LocaleStatus): number {
  if (typeof locale.total === "number" && typeof locale.translated === "number" && locale.total > 0) {
    return formatPercent((locale.translated / locale.total) * 100);
  }
  return formatPercent(locale.completion ?? 0);
}

/**
 * `🌐 83% · es 75% · fr 92% · 4 missing`, worst locales first so a project with
 * twenty locales still says something useful in one line. Protected locales are
 * hand-maintained and excluded from the overall figure, so they are not listed.
 */
export function formatCoverage(status: StatusResult): string | undefined {
  const locales = (status.locales ?? []).filter(
    (locale) => locale.excludedFromOverall !== true && typeof locale.completion === "number",
  );
  const overall = overallPercent(status.summary);
  const missing = status.summary?.missingKeys ?? 0;
  if (locales.length === 0 && overall === undefined) return undefined;
  if (missing === 0) return "🌐 i18n complete";

  // Rounded completion hides a single missing key in a large locale, so the
  // missing count decides what counts as incomplete.
  const incomplete = locales
    .filter((locale) => (locale.missing ?? 0) > 0 || (locale.completion ?? 100) < 100)
    .sort((a, b) => localePercent(a) - localePercent(b));

  const parts: string[] = [];
  if (overall !== undefined) parts.push(`${overall}%`);
  for (const locale of incomplete.slice(0, MAX_LISTED_LOCALES)) {
    parts.push(`${locale.code} ${localePercent(locale)}%`);
  }
  const rest = incomplete.length - MAX_LISTED_LOCALES;
  if (rest > 0) parts.push(`+${rest} more`);
  parts.push(`${missing} missing`);
  return `🌐 ${parts.join(" · ")}`;
}

/** The kit tool behind a tool event, whatever prefixing the host applied. */
function toolNameOf(toolName: string, details: unknown): string | undefined {
  const fromDetails =
    details !== null && typeof details === "object" && typeof (details as { tool?: unknown }).tool === "string"
      ? (details as { tool: string }).tool
      : undefined;
  return fromDetails ?? toolName;
}

function isMutatingKitTool(name: string | undefined): boolean {
  return name !== undefined && MUTATING_TOOLS.some((tool) => name.includes(tool));
}

export default function i18nKitWidget(pi: ExtensionAPI): void {
  let projectRoot: string | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  const placement = process.env.I18N_KIT_WIDGET_PLACEMENT === "aboveEditor" ? "aboveEditor" : "belowEditor";

  const setLine = (ctx: ExtensionContext, line: string | undefined) => {
    ctx.ui.setWidget(WIDGET_KEY, line === undefined ? undefined : [line], { placement });
  };

  const refresh = async (ctx: ExtensionContext) => {
    if (!projectRoot || refreshing) return;
    refreshing = true;
    try {
      const [command, prefix] = resolveCli(projectRoot);
      const result = await pi.exec(command, [...prefix, "status", "--json"], {
        cwd: projectRoot,
        timeout: 60_000,
      });
      if (result.code !== 0) {
        debug("status failed", { code: result.code, stderr: result.stderr.slice(0, 200) });
        return;
      }
      const parsed = JSON.parse(result.stdout) as StatusResult & { error?: unknown };
      if (parsed.error) {
        debug("status returned an error result", parsed.error);
        return;
      }
      const line = formatCoverage(parsed);
      debug("refreshed", { line, summary: parsed.summary });
      setLine(ctx, line);
    } catch (error) {
      debug("refresh threw", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      refreshing = false;
    }
  };

  const scheduleRefresh = (ctx: ExtensionContext) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(ctx), REFRESH_DEBOUNCE_MS);
  };

  pi.on("session_start", (_event, ctx) => {
    // No hasUI gate: setWidget is inert without a UI, and running the same path
    // headlessly is what makes the widget testable outside an interactive session.
    projectRoot = findProjectRoot(ctx.cwd);
    debug("session_start", { cwd: ctx.cwd, projectRoot, cli: projectRoot ? resolveCli(projectRoot) : undefined });
    if (!projectRoot) return;
    void refresh(ctx);
  });

  // Progress notifications arrive as partial results while a tool runs.
  pi.on("tool_execution_update", (event, ctx) => {
    if (!projectRoot) return;
    const progress = (event.partialResult as { details?: { mcpProgress?: Record<string, unknown> } })?.details
      ?.mcpProgress;
    if (!progress) return;
    if (!isMutatingKitTool(typeof progress.tool === "string" ? progress.tool : undefined)) return;
    setLine(ctx, formatProgress(progress));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!projectRoot) return;
    const tool = toolNameOf(event.toolName, event.result?.details);
    const matched = isMutatingKitTool(tool);
    debug("tool_execution_end", { toolName: event.toolName, tool, matched });
    if (!matched) return;
    scheduleRefresh(ctx);
  });

  pi.registerCommand("i18n-coverage", {
    description: "Refresh the the-i18n-kit coverage widget",
    handler: async (_args, ctx) => {
      projectRoot ??= findProjectRoot(ctx.cwd);
      if (!projectRoot) {
        ctx.ui.notify("Not an i18n-kit project (no .i18n-mcp.json or i18n-kit.config.*)", "warning");
        return;
      }
      await refresh(ctx);
    },
  });
}
