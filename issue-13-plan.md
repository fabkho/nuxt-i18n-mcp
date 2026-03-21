# Issue #13 — Reduce false positives in orphan key detection

Three independent improvements, each shipped as its own branch + PR against `main`.

---

## Task 1 — Dynamic key pattern matching

**Branch:** `fix/dynamic-key-matching`

**Problem:** `find_orphan_keys` and `cleanup_unused_translations` collect dynamic key patterns (e.g. `` t(`components.integrations.${type}.title`) ``) into `allDynamicKeys` but never use them to exclude matching locale keys. Every key under `components.integrations.*` gets flagged as an orphan even though it's clearly referenced via interpolation. This is the single highest-impact source of false positives (~1,000+ in anny-ui).

**Fix:**

1. Add a helper function `buildDynamicKeyRegexes(dynamicKeys)` in `src/scanner/code-scanner.ts`:
   - For each dynamic key expression, extract the template literal content (strip outer backticks).
   - Replace each `${...}` interpolation with `[^.]+` (match one key segment) to produce a regex pattern.
   - Anchor with `^...$` so it matches complete dot-paths.
   - Deduplicate identical patterns.
   - Return `RegExp[]`.
   - Example: `` `components.integrations.${type}.title` `` → `/^components\.integrations\.[^.]+\.title$/`

2. In `find_orphan_keys` (server.ts ~line 1354), after building `combinedUniqueKeys` and `allDynamicKeys`:
   - Build regexes from `allDynamicKeys` via the new helper.
   - When checking if a key is orphaned, also test it against the dynamic regexes.
   - A key is NOT orphaned if `combinedUniqueKeys.has(key)` OR any dynamic regex matches it.

3. Same change in `cleanup_unused_translations` (server.ts ~line 1610).

4. Update the response shape: add `dynamicMatchedCount` to the summary (how many keys were saved from orphan status by dynamic matching). Keep `dynamicKeys` and `dynamicKeyWarning` in the response for transparency.

5. Tests in `tests/scanner/code-scanner.test.ts`:
   - `buildDynamicKeyRegexes` unit tests: single interpolation, multiple interpolations, no interpolation (returns empty), adjacent segments, special regex chars in static parts.
   - Integration test: a key matching a dynamic pattern is excluded from orphans.

**Files changed:**
- `src/scanner/code-scanner.ts` — add `buildDynamicKeyRegexes()`
- `src/server.ts` — update `find_orphan_keys` and `cleanup_unused_translations` to use it
- `tests/scanner/code-scanner.test.ts` — new tests for the helper

---

## Task 2 — Configurable scan scope per layer (`orphanScan`)

**Branch:** `feat/orphan-scan-config`
**Depends on:** Task 1 merged to `main`

**Problem:** In a monorepo with 5 apps sharing a root `i18n/locales/`, running `find_orphan_keys({ projectDir: "app-admin" })` only scans `app-admin` + its Nuxt layer ancestors. Root-layer keys like `common.components.checkout.*` that are only used in `app-shop` are falsely flagged as orphans (~700 false positives in anny-ui).

The tool already accepts a `scanDirs` parameter, but requiring absolute paths on every call is impractical. Users need a way to declare the correct scan scope per layer in their project config once.

**Fix:**

1. Extend `ProjectConfig` in `src/config/types.ts` with an optional `orphanScan` field:
   ```ts
   orphanScan?: Record<string, {
     description?: string
     scanDirs: string[]
   }>
   ```
   Keys are layer names. `scanDirs` are paths relative to the project root.

2. Update `schema.json` with the new `orphanScan` property and its nested schema.

3. Update `src/config/project-config.ts` to validate `orphanScan`:
   - Must be an object if present.
   - Each value must have a `scanDirs` string array.
   - `description` is optional string.

4. In `find_orphan_keys`, `scan_code_usage`, and `cleanup_unused_translations` in `server.ts`:
   - When `scanDirs` parameter is not provided by the caller, check `config.projectConfig?.orphanScan` for a matching layer entry.
   - If found, resolve its relative `scanDirs` against `config.rootDir` and use those.
   - If not found, fall back to `config.layerRootDirs` (current behavior).
   - Priority: explicit `scanDirs` param > `orphanScan` config > `layerRootDirs` default.

5. Tests:
   - Validate `orphanScan` parsing in project-config tests.
   - Verify the 3-tier fallback logic in a server tool test.

**Files changed:**
- `src/config/types.ts` — extend `ProjectConfig`
- `schema.json` — add `orphanScan` schema
- `src/config/project-config.ts` — validate the new field
- `src/server.ts` — 3 tools get the fallback chain
- `tests/config/project-config.test.ts` — validation tests
- `tests/fixtures/config.ts` — fixture with `orphanScan`

---

## Task 3 — `find_empty_translations` tool

**Branch:** `feat/find-empty-translations`
**Depends on:** Task 2 merged to `main` (or independent — no code overlap)

**Problem:** Keys with `""` in the reference locale are silently invisible to `get_missing_translations` because the reference filter at line 597-601 skips empty values (by design — there's nothing to compare against). Users have no way to discover these untranslated keys in the reference itself.

**Fix:**

1. Add a new tool `find_empty_translations` in `server.ts`:
   - **Input:** `layer?`, `locale?` (defaults to all locales), `projectDir?`
   - **Behavior:** For each locale file in scope, find all leaf keys where the value is `""`.
   - **Output:** `{ emptyKeys: Record<string, Record<string, string[]>>, summary: { totalEmpty, localesChecked, layersChecked } }`
     - Grouped as `{ [locale]: { [layer]: ["key1", "key2"] } }`.
   - This is read-only — no writes, no dry-run needed.

2. Register the tool after `get_missing_translations` in the tool registration order.

3. Update README tools table with the new tool.

4. Tests:
   - Mock a locale file with some `""` values and some populated values.
   - Verify only empty-string keys are returned.
   - Verify non-existent keys are NOT returned (only `""`, not missing keys).

**Files changed:**
- `src/server.ts` — new tool registration
- `README.md` — tools table update
- `tests/tools/missing-and-search.test.ts` — new test describe block
