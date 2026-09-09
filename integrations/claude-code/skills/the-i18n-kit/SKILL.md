---
name: the-i18n-kit
description: Manage translations with the-i18n-kit MCP tools — find missing or dead keys, translate, rename across locales. Use when working with i18n, translations, locale files, or translation keys in a project configured for the-i18n-kit.
---

# the-i18n-kit

This project manages translations with the-i18n-kit. The MCP server (`the-i18n-kit`)
is the interface — never edit locale files by hand (a PreToolUse guard blocks it):
one edited locale silently drifts from its siblings.

## Workflow

1. **Orient**: `discover` shows locales, layers and the translation mode
   (provider mode translates directly; agent mode returns fallback contexts for
   you to translate and persist via `write_translations`).
2. **Read before writing**: `get_translations`, `search_translations`,
   `get_translation_status`, `get_missing_translations`.
3. **Write through tools**:
   - add/change keys → `write_translations`
   - fill missing locales → `translate_missing` (pass every target locale at once)
   - one new key everywhere → `translate_key`
   - restructure → `move_translation_key`, delete → `remove_translations`
4. **Verify before finishing**: `find_undefined_keys` (raw keys shipping to
   production — a Stop hook enforces this), `find_orphan_keys` for dead keys.

## Rules

- Respect protected locales (hand-maintained; `discover` lists them) — never
  machine-translate into them.
- Preserve `{placeholders}` exactly in every translation.
- Keys are sorted alphabetically by the tools; do not fight the ordering.
