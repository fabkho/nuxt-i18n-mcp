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
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "the-i18n-kit";
/** Short, because a footer key is a footer segment in most hosts. */
const STATUS_KEY = "i18n";

/**
 * The published status, readable in-process.
 *
 * Hosts keep statuses for their own chrome and do not hand them back, so a
 * surface that wants to render coverage somewhere else — an editor border, say —
 * has no way to ask. This is that way: last value plus a subscription, for
 * anything in this repository that renders the same fact somewhere the host
 * does not reach.
 */
let currentStatus: string | undefined;
const statusListeners = new Set<(status: string | undefined) => void>();

export function getI18nStatus(): string | undefined {
  return currentStatus;
}

export function onI18nStatus(listener: (status: string | undefined) => void): () => void {
  statusListeners.add(listener);
  listener(currentStatus);
  return () => statusListeners.delete(listener);
}

function announceStatus(status: string | undefined): void {
  currentStatus = status;
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch {
      // a broken listener must not take the widget with it
    }
  }
}

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

/**
 * Read per call rather than at import, so a session can tune them and a test
 * does not have to wait out the real ones.
 */
function refreshDebounceMs(): number {
  return Number(process.env.I18N_KIT_WIDGET_DEBOUNCE_MS ?? 1_500);
}

/** How long a "nothing to do" confirmation stays before the widget withdraws. */
function settledLingerMs(): number {
  return Number(process.env.I18N_KIT_WIDGET_LINGER_MS ?? 15_000);
}

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

/** Keep a diagnostic short enough to sit in one line of widget. */
function truncateDetail(detail: string): string {
  return detail.length > 60 ? `${detail.slice(0, 57)}…` : detail;
}

/** Source files whose edits can introduce a key that no locale defines. */
const SOURCE_EXTENSIONS = new Set([
  ".vue", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".astro", ".php", ".blade.php", ".py", ".rb",
]);

/** Built-in pi tools that write files. */
const EDIT_TOOLS = ["write", "edit", "multiedit", "apply_patch", "str_replace"];

/**
 * What a translate run actually did, read from the tool's own result.
 *
 * The status re-read that follows knows only how the totals moved; the result
 * knows which locales moved, which translations dropped a placeholder, and
 * which locales were left alone on purpose. Those are the parts worth saying.
 */
export interface TranslateReport {
  perLocale: { code: string; translated: number }[];
  placeholderIssues: { locale: string; key: string; missing: string[] }[];
  protectedLocales: string[];
}

interface RawLocaleResult {
  translated?: unknown;
  skipped?: unknown;
  placeholderValidation?: { errors?: unknown };
}

/**
 * Pull the report out of an MCP tool result.
 *
 * The result arrives as JSON in a text block, which may have been truncated by
 * the host's output guard, so every step tolerates absence: a report is a
 * bonus on top of the status re-read, never the thing the widget depends on.
 */
export function parseTranslateReport(text: string): TranslateReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const layers = (parsed as { layers?: Record<string, { results?: Record<string, RawLocaleResult> }> })?.layers;
  if (!layers || typeof layers !== "object") return undefined;

  const perLocale = new Map<string, number>();
  const placeholderIssues: TranslateReport["placeholderIssues"] = [];
  const protectedLocales = new Set<string>();

  for (const layer of Object.values(layers)) {
    for (const [locale, result] of Object.entries(layer?.results ?? {})) {
      const translated = Array.isArray(result?.translated) ? result.translated.length : 0;
      if (translated > 0) perLocale.set(locale, (perLocale.get(locale) ?? 0) + translated);

      for (const entry of Array.isArray(result?.skipped) ? result.skipped : []) {
        if ((entry as { reason?: string })?.reason === "protected-locale") protectedLocales.add(locale);
      }
      for (const issue of Array.isArray(result?.placeholderValidation?.errors)
        ? (result.placeholderValidation?.errors as { locale?: string; key?: string; missing?: unknown }[])
        : []) {
        placeholderIssues.push({
          locale: issue.locale ?? locale,
          key: issue.key ?? "",
          missing: Array.isArray(issue.missing) ? issue.missing.map(String) : [],
        });
      }
    }
  }

  if (perLocale.size === 0 && placeholderIssues.length === 0 && protectedLocales.size === 0) return undefined;
  return {
    perLocale: [...perLocale.entries()]
      .map(([code, translated]) => ({ code, translated }))
      .sort((a, b) => b.translated - a.translated),
    placeholderIssues,
    protectedLocales: [...protectedLocales],
  };
}

/**
 * `🌐 es-ES +3 · fr-FR +1 · ⚠ fr-FR dropped {count} · 3 protected, skipped`
 *
 * Which locales moved, rather than a bare total: the same width, and it answers
 * "did the one I care about get done" without a second call.
 */
export function formatTranslateReport(report: TranslateReport, stillMissing: number): string | undefined {
  const parts: string[] = [];
  for (const locale of report.perLocale.slice(0, MAX_LISTED_LOCALES)) {
    parts.push(`${locale.code} +${locale.translated}`);
  }
  const rest = report.perLocale.length - MAX_LISTED_LOCALES;
  if (rest > 0) parts.push(`+${count(rest, "locale")} more`);

  // A dropped placeholder is a broken string in front of a user, so it is named.
  const [issue] = report.placeholderIssues;
  if (issue) {
    const dropped = issue.missing.length > 0 ? ` ${issue.missing.join(", ")}` : "";
    const more = report.placeholderIssues.length - 1;
    parts.push(`⚠ ${issue.locale} dropped${dropped}${more > 0 ? ` (+${more})` : ""}`);
  }
  // Protected locales are refused by design; unexplained, that reads as failure.
  if (report.protectedLocales.length > 0) {
    parts.push(`${count(report.protectedLocales.length, "locale")} protected, skipped`);
  }
  if (stillMissing > 0) parts.push(`${stillMissing} still missing`);
  if (parts.length === 0) return undefined;
  return `🌐 ${parts.join(" · ")}`;
}

/**
 * The footer form: coverage as a standing fact, in as few cells as possible.
 *
 * This is the half of the story the widget deliberately refuses to tell. A
 * transient line is right for change and wrong for state, and a footer is the
 * opposite: it costs nothing to keep, and it is read when someone wonders,
 * rather than announcing itself. Hosts without a footer ignore it.
 */
export function formatStatus(missing: number | undefined): string {
  if (missing === undefined) return "🌐 ?";
  return missing > 0 ? `🌐 ${missing} missing` : "🌐 ✓";
}

/** `🌐 2 undefined keys · checkout.payNow, cart.empty` */
export function formatUndefinedKeys(keys: string[]): string | undefined {
  if (keys.length === 0) return undefined;
  const named = keys.slice(0, 3).join(", ");
  const more = keys.length - 3;
  return `🌐 ${count(keys.length, "undefined key")} · ${named}${more > 0 ? ` +${more}` : ""}`;
}

/** `1 key` / `26 keys`, so a line never reads "1 keys". */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * What is outstanding, in counts.
 *
 * Percentages are left to the on-demand detail: in a large project coverage is
 * pinned near 100 and moves in the third decimal, so a percentage looks like a
 * gauge while behaving like a constant — and per-locale percentages are worse,
 * since twenty locales one key short all read the same. The count is the part
 * you would act on.
 *
 * `🌐 4 keys missing · es-ES 3 · fr-FR 1`, or, when the gaps are spread too
 * thin to name, `🌐 26 keys missing · 26 locales`.
 */
export function formatOutstanding(status: StatusResult): string | undefined {
  const missing = status.summary?.missingKeys ?? 0;
  if (missing === 0) return undefined;

  const incomplete = (status.locales ?? [])
    .filter((locale) => locale.excludedFromOverall !== true && (locale.missing ?? 0) > 0)
    .sort((a, b) => (b.missing ?? 0) - (a.missing ?? 0));

  if (incomplete.length === 0) return `🌐 ${count(missing, "key")} missing`;
  if (incomplete.length > MAX_LISTED_LOCALES) {
    return `🌐 ${count(missing, "key")} missing · ${count(incomplete.length, "locale")}`;
  }
  const perLocale = incomplete.map((locale) => `${locale.code} ${locale.missing}`).join(" · ");
  return `🌐 ${count(missing, "key")} missing · ${perLocale}`;
}

/**
 * The detailed answer, percentages included, for when you ask outright:
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
  if (missing === 0) return "🌐 all locales up to date";

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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;
const BAR_WIDTH = 12;

/** What the widget is currently saying, and in which register. */
type LineKind = "outstanding" | "resolved" | "detail" | "progress";

interface ProgressState {
  done: number;
  total?: number;
  message: string;
}

interface WidgetState {
  kind: LineKind;
  text?: string;
  progress?: ProgressState;
}

/** The unstyled form, for plain terminals and for tests to assert on. */
function plainLine(state: WidgetState): string {
  if (state.kind === "progress" && state.progress) {
    const { done, total, message } = state.progress;
    return formatProgress({ progress: done, total, message });
  }
  return state.text ?? "";
}

/**
 * The widget as a component, so it can carry colour and motion.
 *
 * Colours are semantic — `warning` for work outstanding, `success` for work
 * done — which means they come from whatever theme is loaded rather than from
 * anything this package decides. The spinner turns only while a tool is
 * running: an idle line that animates is a line that costs redraws to say
 * nothing.
 */
class WidgetLine implements Component {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly read: () => WidgetState | undefined;

  // Written out rather than declared as parameter properties: the loaders that
  // run this file range from esbuild to Node's strip-only mode, and the latter
  // refuses them.
  constructor(tui: TUI, theme: Theme, read: () => WidgetState | undefined) {
    this.tui = tui;
    this.theme = theme;
    this.read = read;
  }

  render(width: number): string[] {
    const state = this.read();
    if (!state) {
      this.stopAnimation();
      return [];
    }
    if (state.kind === "progress") this.startAnimation();
    else this.stopAnimation();

    const line =
      state.kind === "progress" && state.progress ? this.renderProgress(state.progress) : this.renderText(state);
    return [truncateToWidth(line, width)];
  }

  invalidate(): void {}

  requestRender(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.stopAnimation();
  }

  private renderText(state: WidgetState): string {
    const [head = "", ...tail] = (state.text ?? "").split(" · ");
    const headColor = state.kind === "resolved" ? "success" : state.kind === "outstanding" ? "warning" : "text";
    const segments = [
      this.theme.fg(headColor, head.replace(/^🌐\s*/u, "")),
      // A tail that still mentions gaps keeps the warning colour; the rest is context.
      ...tail.map((part) => this.theme.fg(/missing/u.test(part) ? "warning" : "muted", part)),
    ];
    return `${this.theme.fg("accent", "🌐")} ${segments.join(this.theme.fg("dim", " · "))}`;
  }

  private renderProgress(progress: ProgressState): string {
    const spinner = this.theme.fg("accent", SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? "");
    const ratio = progress.total === undefined ? `${progress.done}` : `${progress.done}/${progress.total}`;
    const bar = progress.total === undefined ? "" : `${this.renderBar(progress.done / progress.total)} `;
    return [
      this.theme.fg("accent", "🌐"),
      spinner,
      `${bar}${this.theme.fg("text", progress.message)}`,
      this.theme.fg("muted", ratio),
    ].join(" ");
  }

  private renderBar(fraction: number): string {
    const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(fraction * BAR_WIDTH)));
    return [
      this.theme.fg("dim", "▕"),
      this.theme.fg("accent", "█".repeat(filled)),
      this.theme.fg("dim", "░".repeat(BAR_WIDTH - filled)),
      this.theme.fg("dim", "▏"),
    ].join("");
  }

  private startAnimation(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame += 1;
      this.tui.requestRender();
    }, SPINNER_INTERVAL_MS);
    // The spinner must never hold the process open on its own.
    this.timer.unref?.();
  }

  private stopAnimation(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Why a refresh happened, which decides whether the widget shows anything. */
type Reason = "session-start" | "activity" | "command";

export default function i18nKitWidget(pi: ExtensionAPI): void {
  let projectRoot: string | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  /** Missing keys as of the last successful read, for reporting what changed. */
  let lastMissing: number | undefined;
  let reportedUnavailable = false;
  /** The last translate run's own account of itself, awaiting the status re-read. */
  let pendingReport: TranslateReport | undefined;
  /** Whether this turn edited anything that can reference a translation key. */
  let sourceTouched = false;
  const placement = process.env.I18N_KIT_WIDGET_PLACEMENT === "aboveEditor" ? "aboveEditor" : "belowEditor";

  let state: WidgetState | undefined;
  let mounted = false;
  let component: WidgetLine | undefined;
  const styled = process.env.I18N_KIT_WIDGET_STYLE !== "plain";

  /** Push the current state to the widget, mounting or unmounting as needed. */
  const paint = (ctx: ExtensionContext) => {
    if (!state) {
      ctx.ui.setWidget(WIDGET_KEY, undefined, { placement });
      component?.dispose();
      component = undefined;
      mounted = false;
      return;
    }
    if (!styled) {
      ctx.ui.setWidget(WIDGET_KEY, [plainLine(state)], { placement });
      mounted = true;
      return;
    }
    if (!mounted) {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui: TUI, theme: Theme) => {
          component = new WidgetLine(tui, theme, () => state);
          return component;
        },
        { placement },
      );
      mounted = true;
      return;
    }
    component?.requestRender();
  };

  const setLine = (ctx: ExtensionContext, line: string | undefined, kind: LineKind = "detail") => {
    state = line === undefined ? undefined : { kind, text: line };
    paint(ctx);
  };

  /**
   * Mirror progress onto pi's working row as well as the widget: the spinner
   * there is already animating for the same wait, and a verb beats a generic one.
   */
  const setProgress = (ctx: ExtensionContext, progress: ProgressState) => {
    state = { kind: "progress", progress };
    paint(ctx);
    const ratio = progress.total === undefined ? `${progress.done}` : `${progress.done}/${progress.total}`;
    ctx.ui.setWorkingMessage?.(`${progress.message} (${ratio})`);
  };

  /**
   * Publish coverage to whatever the host does with statuses — pi's own footer,
   * a themed one, or nothing at all. Off with I18N_KIT_STATUS=off.
   */
  const publishStatus = (ctx: ExtensionContext, missing: number | undefined) => {
    if (process.env.I18N_KIT_STATUS === "off") return;
    const status = formatStatus(missing);
    ctx.ui.setStatus?.(STATUS_KEY, status);
    announceStatus(status);
  };

  /**
   * A failed read must not look like a clean project.
   *
   * Hiding on error is indistinguishable from having nothing to report, which
   * turns a broken CLI into a widget that is merely absent — and an absent
   * widget is unreportable. Say it once per session, quietly.
   */
  const reportUnavailable = (ctx: ExtensionContext, stderr: string) => {
    if (reportedUnavailable) return;
    reportedUnavailable = true;
    // The footer must not keep asserting a number nobody could verify.
    publishStatus(ctx, undefined);
    const detail = stderr.split("\n").find((line) => line.trim().length > 0)?.trim();
    showTransient(ctx, `🌐 i18n status unavailable${detail ? ` · ${truncateDetail(detail)}` : ""}`, "outstanding");
  };

  /** Hand the working row back to pi once the work it described is over. */
  const clearWorkingMessage = (ctx: ExtensionContext) => {
    ctx.ui.setWorkingMessage?.();
  };

  const clearLinger = () => {
    if (lingerTimer) clearTimeout(lingerTimer);
    lingerTimer = undefined;
  };

  /** Show a line, then withdraw it: for states that are worth a glance, not a residency. */
  const showTransient = (ctx: ExtensionContext, line: string, kind: LineKind) => {
    clearLinger();
    setLine(ctx, line, kind);
    lingerTimer = setTimeout(() => setLine(ctx, undefined), settledLingerMs());
  };

  /**
   * What to display once a status read lands.
   *
   * Nothing persists. A line that stays put stops being read — that is true of
   * "all locales up to date" and equally true of a missing count that has not
   * moved since Tuesday. So the widget reports change and then withdraws:
   * outstanding work is news when you sit down, and wallpaper a minute later.
   * Standing facts live behind /i18n-coverage, which answers in full.
   */
  const present = (ctx: ExtensionContext, status: StatusResult, reason: Reason) => {
    const missing = status.summary?.missingKeys ?? 0;
    const previous = lastMissing;
    lastMissing = missing;
    publishStatus(ctx, missing);

    if (reason === "command") {
      const line = formatCoverage(status);
      if (line) showTransient(ctx, line, "detail");
      return;
    }

    // What a translate run reported about itself beats what the totals imply.
    if (reason === "activity" && pendingReport) {
      const line = formatTranslateReport(pendingReport, missing);
      pendingReport = undefined;
      if (line) {
        showTransient(ctx, line, missing > 0 ? "outstanding" : "resolved");
        return;
      }
    }

    if (missing === 0) {
      // At session start this is the ordinary case, and ordinary is not news.
      if (reason === "session-start") {
        setLine(ctx, undefined);
        return;
      }
      const resolved = previous !== undefined && previous > 0 ? previous : 0;
      showTransient(
        ctx,
        resolved > 0 ? `🌐 ${count(resolved, "key")} resolved · all locales up to date` : "🌐 all locales up to date",
        "resolved",
      );
      return;
    }

    if (reason === "activity" && previous !== undefined && previous > missing) {
      showTransient(ctx, `🌐 ${previous - missing} resolved · ${missing} still missing`, "resolved");
      return;
    }

    const outstanding = formatOutstanding(status);
    if (outstanding) showTransient(ctx, outstanding, "outstanding");
  };

  const runStatus = async (root: string) => {
    const [command, prefix] = resolveCli(root);
    // --projectDir rather than cwd: inside a workspace, npx can resolve the
    // package differently depending on where it runs.
    return pi.exec(command, [...prefix, "status", "--json", "--projectDir", root], {
      cwd: root,
      timeout: 60_000,
    });
  };

  const refresh = async (ctx: ExtensionContext, reason: Reason) => {
    if (!projectRoot || refreshing) return;
    refreshing = true;
    try {
      let result = await runStatus(projectRoot);
      if (result.code !== 0) {
        // npx fetches from the network and fails transiently (a stale packument
        // is enough); one retry costs a second and saves a blank widget.
        debug("status failed, retrying", { code: result.code, stderr: result.stderr.slice(0, 200) });
        result = await runStatus(projectRoot);
      }
      if (result.code !== 0) {
        debug("status failed", { code: result.code, stderr: result.stderr.slice(0, 200) });
        reportUnavailable(ctx, result.stderr);
        return;
      }
      const parsed = JSON.parse(result.stdout) as StatusResult & { error?: unknown };
      if (parsed.error) {
        debug("status returned an error result", parsed.error);
        return;
      }
      debug("refreshed", { reason, summary: parsed.summary });
      present(ctx, parsed, reason);
    } catch (error) {
      debug("refresh threw", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      refreshing = false;
    }
  };

  const scheduleRefresh = (ctx: ExtensionContext) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(ctx, "activity"), refreshDebounceMs());
  };

  pi.on("session_start", (_event, ctx) => {
    // No hasUI gate: setWidget is inert without a UI, and running the same path
    // headlessly is what makes the widget testable outside an interactive session.
    projectRoot = findProjectRoot(ctx.cwd);
    debug("session_start", { cwd: ctx.cwd, projectRoot, cli: projectRoot ? resolveCli(projectRoot) : undefined });
    if (!projectRoot) return;
    void refresh(ctx, "session-start");
  });

  // Progress notifications arrive as partial results while a tool runs.
  pi.on("tool_execution_update", (event, ctx) => {
    if (!projectRoot) return;
    const progress = (event.partialResult as { details?: { mcpProgress?: Record<string, unknown> } })?.details
      ?.mcpProgress;
    if (!progress) return;
    if (!isMutatingKitTool(typeof progress.tool === "string" ? progress.tool : undefined)) return;
    clearLinger();
    setProgress(ctx, {
      done: typeof progress.progress === "number" ? progress.progress : 0,
      total: typeof progress.total === "number" ? progress.total : undefined,
      message: typeof progress.message === "string" ? progress.message : "working",
    });
  });

  pi.on("tool_execution_start", (event) => {
    if (!projectRoot) return;
    if (!EDIT_TOOLS.includes(event.toolName)) return;
    const path = (event.args as { path?: unknown })?.path;
    if (typeof path !== "string") return;
    const extension = path.slice(path.lastIndexOf("."));
    if (SOURCE_EXTENSIONS.has(extension.toLowerCase())) sourceTouched = true;
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!projectRoot) return;
    const tool = toolNameOf(event.toolName, event.result?.details);
    const matched = isMutatingKitTool(tool);
    debug("tool_execution_end", { toolName: event.toolName, tool, matched });
    if (!matched) return;
    clearWorkingMessage(ctx);
    if (!event.isError && typeof tool === "string" && tool.includes("translate")) {
      const text = (event.result?.content ?? []).find(
        (block: { type?: string }) => block?.type === "text",
      )?.text;
      pendingReport = typeof text === "string" ? parseTranslateReport(text) : undefined;
      debug("translate report", pendingReport);
    }
    scheduleRefresh(ctx);
  });

  /**
   * Keys the code calls and no layer defines render raw in production. A turn
   * that edited source is the moment that becomes true, and the cheapest moment
   * to hear about it — so the check runs then, and only then.
   */
  const checkUndefinedKeys = async (ctx: ExtensionContext) => {
    if (!projectRoot || !sourceTouched) return;
    sourceTouched = false;
    try {
      const [command, prefix] = resolveCli(projectRoot);
      const result = await pi.exec(command, [...prefix, "check", "--json", "--projectDir", projectRoot], {
        cwd: projectRoot,
        timeout: 120_000,
      });
      // `check` exits non-zero precisely when it finds something, so the exit
      // code is not an error signal here; the payload is.
      const parsed = JSON.parse(result.stdout) as {
        undefinedKeys?: { key?: string }[];
        error?: unknown;
      };
      if (parsed.error) return;
      const keys = (parsed.undefinedKeys ?? [])
        .map((finding) => finding?.key)
        .filter((key): key is string => typeof key === "string");
      debug("undefined keys", { count: keys.length });
      const line = formatUndefinedKeys(keys);
      if (line) showTransient(ctx, line, "outstanding");
    } catch (error) {
      debug("check threw", { message: error instanceof Error ? error.message : String(error) });
    }
  };

  pi.on("turn_end", (_event, ctx) => {
    void checkUndefinedKeys(ctx);
  });

  pi.registerCommand("i18n-coverage", {
    description: "Refresh the the-i18n-kit coverage widget",
    handler: async (_args, ctx) => {
      projectRoot ??= findProjectRoot(ctx.cwd);
      if (!projectRoot) {
        ctx.ui.notify("Not an i18n-kit project (no .i18n-mcp.json or i18n-kit.config.*)", "warning");
        return;
      }
      await refresh(ctx, "command");
    },
  });
}
