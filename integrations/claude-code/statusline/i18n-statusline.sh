#!/usr/bin/env bash
# Translation coverage for the Claude Code status line.
#
# Claude Code cannot ship a status line inside a plugin, so wire it manually in
# ~/.claude/settings.json (see the integration README). Prints nothing when the
# cwd is not an i18n-kit project, so it composes with any existing status line:
#
#   your-existing-line | i18n-statusline.sh
#
# Coverage is cached for 60s per project to keep the status line instant.

set -euo pipefail

cwd=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).workspace?.current_dir??JSON.parse(d).cwd??"")}catch{}})' 2>/dev/null || true)
[ -n "$cwd" ] || cwd=$PWD

# Nearest i18n-kit config upward; bail silently when there is none.
root=$cwd
while [ "$root" != "/" ]; do
  if [ -e "$root/.i18n-mcp.json" ] || ls "$root"/i18n-kit.config.* >/dev/null 2>&1; then
    break
  fi
  root=$(dirname "$root")
done
[ "$root" != "/" ] || exit 0

cache="${TMPDIR:-/tmp}/the-i18n-kit-statusline-$(printf %s "$root" | shasum -a 256 | cut -c1-16)"
if [ -f "$cache" ] && [ $(( $(date +%s) - $(stat -f %m "$cache" 2>/dev/null || stat -c %Y "$cache") )) -lt 60 ]; then
  cat "$cache"
  exit 0
fi

line=$(cd "$root" && npx -y @the-i18n-kit/cli@latest status --json 2>/dev/null | node -e '
let d = "";
process.stdin.on("data", c => d += c).on("end", () => {
  try {
    const s = JSON.parse(d);
    const locales = Array.isArray(s.locales) ? s.locales : [];
    const parts = [];
    let missing = 0;
    for (const l of locales) {
      if (typeof l?.completion !== "number") continue;
      parts.push(`${String(l.code).split("-")[0]} ${Math.round(l.completion)}%`);
      if (typeof l.missing === "number") missing += l.missing;
    }
    if (parts.length === 0) process.exit(0);
    const tail = missing > 0 ? ` · ${missing} missing` : "";
    process.stdout.write(`🌐 ${parts.join(" · ")}${tail}`);
  } catch {}
});' || true)

printf %s "$line" > "$cache"
printf %s "$line"
