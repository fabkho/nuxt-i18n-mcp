/**
 * Putting a label into a border that was already drawn.
 *
 * The editor frame is rendered by whoever owns the editor component, and its
 * metadata set is closed — there is no slot to ask for. What there is, in every
 * frame of this shape, is a run of horizontal rule between the left label and
 * the right one, and that run is spare width by construction.
 *
 * So a label goes in by consuming rule, never by adding width: the line keeps
 * its length, the corners stay put, and the styling around it is untouched
 * because the rule characters are literal text between escape sequences rather
 * than inside them.
 *
 * This is surgery on someone else's output. It is written to fail by doing
 * nothing — no run long enough, no border at all, and the line comes back
 * exactly as it arrived.
 */

/** Horizontal rules used by the frames this runs against. */
const RULE_CHARACTERS = ["─", "━", "-", "═"] as const;

/** Space kept between the label and the rule on either side. */
const PADDING = 1;

export interface InjectOptions {
  /** Rule kept to the left of the label, so the line still reads as a border. */
  minLeadingRule?: number;
  /** Where to sit when several runs are long enough. */
  prefer?: "longest" | "rightmost";
}

interface Run {
  index: number;
  length: number;
  character: string;
}

/** Every unbroken run of one rule character in the line. */
function findRuns(line: string): Run[] {
  const runs: Run[] = [];
  let index = 0;
  while (index < line.length) {
    const character = line[index]!;
    if (!RULE_CHARACTERS.includes(character as (typeof RULE_CHARACTERS)[number])) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < line.length && line[end] === character) end += 1;
    runs.push({ index, length: end - index, character });
    index = end;
  }
  return runs;
}

/** Escape sequences occupy no cells, so they are removed before measuring. */
const ANSI = /\u001b\[[0-9;]*m/gu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Visible width of `text`, counting an emoji as the two cells a terminal gives
 * it and styling as none. Enough for the labels this places; not a
 * general-purpose width function.
 */
export function labelWidth(text: string): number {
  let width = 0;
  for (const character of stripAnsi(text)) {
    const code = character.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1f300 && code <= 0x1faff) || // pictographs
      (code >= 0x2600 && code <= 0x27bf) || // symbols
      (code >= 0x1f000 && code <= 0x1f2ff);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * Place `label` inside the border line, consuming rule so the width holds.
 *
 * `label` may carry its own styling; only its visible width is counted. Returns
 * the line unchanged when there is nowhere for the label to go.
 */
export function injectIntoBorder(line: string, label: string, options: InjectOptions = {}): string {
  const { minLeadingRule = 2, prefer = "longest" } = options;
  if (label.length === 0) return line;

  // Rule on both sides: a label that ends flush against the next one reads as
  // part of it, rather than as its own thing sitting in the border.
  const needed = labelWidth(label) + PADDING * 2 + minLeadingRule + 1;
  const candidates = findRuns(line).filter((run) => run.length >= needed);
  if (candidates.length === 0) return line;

  const target =
    prefer === "rightmost"
      ? candidates[candidates.length - 1]!
      : candidates.reduce((longest, run) => (run.length > longest.length ? run : longest));

  const rule = target.character;
  const consumed = labelWidth(label) + PADDING * 2 + 1;
  const leading = target.length - consumed;
  const replacement =
    `${rule.repeat(leading)}${" ".repeat(PADDING)}${label}${" ".repeat(PADDING)}${rule}`;

  return line.slice(0, target.index) + replacement + line.slice(target.index + target.length);
}

/** Whether a line looks like the bottom edge of a frame. */
export function isBottomBorder(line: string): boolean {
  return /[╰└][^\n]*[╯┘]\s*$/u.test(stripAnsi(line));
}

/** Whether a line looks like the top edge of a frame. */
export function isTopBorder(line: string): boolean {
  return /[╭┌][^\n]*[╮┐]\s*$/u.test(stripAnsi(line));
}

/**
 * Place the first label that fits, from longest to shortest.
 *
 * A border too narrow for "🌐 4 missing" still has room for "🌐 4", and a label
 * that silently disappears when a pane is resized is worse than a terse one.
 */
export function injectFirstThatFits(line: string, labels: string[], options: InjectOptions = {}): string {
  for (const label of labels) {
    const injected = injectIntoBorder(line, label, options);
    if (injected !== line) return injected;
  }
  return line;
}
