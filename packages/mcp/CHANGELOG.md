# Changelog

## [10.1.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-kit-mcp-10.0.0...the-i18n-kit-mcp-10.1.0) (2026-09-07)


### Features

* **mcp:** every tool advertises an outputSchema and returns structuredContent ([#466](https://github.com/fabkho/the-i18n-kit/issues/466)) ([06e354b](https://github.com/fabkho/the-i18n-kit/commit/06e354bd8eeb28ede9c3c40a7f73de5c191f33e3))

## [10.0.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-kit-mcp-9.0.0...the-i18n-kit-mcp-10.0.0) (2026-09-06)


### ⚠ BREAKING CHANGES

* **cli:** search_translations (and `the-i18n-cli search`) returns `matches: [{ key, layers, value, locale, localeCount }]`, one row per key, where it returned `matches: [{ layer, locale, key, value }]`, one row per key and locale. `totalMatches` counts the rows either way, so it now counts keys. Pass `includeLocales: true` (`--includeLocales`) for the previous per-locale rows, unchanged in shape.

### Features

* **cli:** declared namespaces for keys the scanner cannot see ([#455](https://github.com/fabkho/the-i18n-kit/issues/455)) ([a2f95f5](https://github.com/fabkho/the-i18n-kit/commit/a2f95f5d16ac868b03360b46ccaf4b695ee74c0e))
* **cli:** search returns one row per key, with fuzzy value matching ([#457](https://github.com/fabkho/the-i18n-kit/issues/457)) ([6b05d27](https://github.com/fabkho/the-i18n-kit/commit/6b05d27ba74e5957008a03499fa0c4eb18fc09cb))


### Bug Fixes

* **cli,mcp:** reject an out-of-project report path before the scan, not after ([091b63c](https://github.com/fabkho/the-i18n-kit/commit/091b63c8c3ae22ea0258859b5b239e608eceafad))

## [9.0.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-kit-mcp-8.0.0...the-i18n-kit-mcp-9.0.0) (2026-09-06)


### ⚠ BREAKING CHANGES

* **cli:** `vite.config.ts` is no longer read. A Vue project whose locale files are not in `locales`, `src/locales`, `i18n/locales`, `src/i18n/locales` or `src/i18n` must declare `localeDirs` (and `defaultLocale`) in `i18n-kit.config.ts` or `.i18n-mcp.json`; run `the-i18n-cli init` to write them. Several locale directories are declared as `localeDirs: [{ path, layer }]` rather than derived from the plugin's `include`. A probed single directory is the layer `default`, where the Vue adapter named it `root`. `framework: "vue"` still validates and resolves, through the generic adapter, with a warning.
* CLI commands `add`, `update`, `empty`, `rename`, `detect`, `list-dirs`, `scan`, `remove-orphans` and the `translate-missing` alias are removed; `orphans` and `discover` replace them where they had a job. MCP tools `find_empty_translations`, `rename_translation_key` and `remove_orphan_keys` are removed, folded into `get_translation_status`, `move_translation_key` and `find_orphan_keys`. `moveTranslationKey` takes `layer` and an optional `toLayer` in place of `fromLayer`/`toLayer`; the `@deprecated` core functions `addTranslations` and `updateTranslations`, and the `AddTranslationsResult`/`UpdateTranslationsResult` types, are removed in favour of `writeTranslations` with `mode`.

### Features

* **cli:** remember source hashes so translate can tell stale targets from current ones ([#444](https://github.com/fabkho/the-i18n-kit/issues/444)) ([d9b8629](https://github.com/fabkho/the-i18n-kit/commit/d9b86290229e04d493e512154abc404fb54e7c9d))
* **config:** infer the consumer graph from workspace dependencies ([#442](https://github.com/fabkho/the-i18n-kit/issues/442)) ([8c92636](https://github.com/fabkho/the-i18n-kit/commit/8c92636b513c677674571059398b7893bf7b1fb5))
* **io:** YAML locale files, behind a format registry ([#445](https://github.com/fabkho/the-i18n-kit/issues/445)) ([d104bb9](https://github.com/fabkho/the-i18n-kit/commit/d104bb91f39f7410dcdb28f5a325aab5e98aaa86))
* **mcp:** progress notifications for orphan scans ([#450](https://github.com/fabkho/the-i18n-kit/issues/450)) ([11a5558](https://github.com/fabkho/the-i18n-kit/commit/11a5558fd636591bb88adb851e28cdb75b81262b))
* prune the command and tool surface ([#440](https://github.com/fabkho/the-i18n-kit/issues/440)) ([f78d0cd](https://github.com/fabkho/the-i18n-kit/commit/f78d0cd0c14296863784fb47633a1222e08a05ed))


### Bug Fixes

* **cli:** drop the stale claim that google rejects a base URL ([1e9c374](https://github.com/fabkho/the-i18n-kit/commit/1e9c374747e38c6eca5355f5d93ef1aafaa8534e))


### Code Refactoring

* **cli:** resolve Vue projects through the generic adapter ([#452](https://github.com/fabkho/the-i18n-kit/issues/452)) ([ff22200](https://github.com/fabkho/the-i18n-kit/commit/ff2220040963f818005af42b79d479b43adc774a))

## [8.0.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-kit-mcp-7.5.0...the-i18n-kit-mcp-8.0.0) (2026-09-06)


### ⚠ BREAKING CHANGES

* the-i18n-cli and the-i18n-mcp on npm receive no further releases. Install @the-i18n-kit/cli and @the-i18n-kit/mcp.

### Features

* finish the rename to @the-i18n-kit/cli and @the-i18n-kit/mcp ([5b4eae6](https://github.com/fabkho/the-i18n-kit/commit/5b4eae6df31eb246b45280e61115be1dbb00fb49))


### Bug Fixes

* **cli:** expose detect, list-dirs and empty; correct the docs that described them ([25c7531](https://github.com/fabkho/the-i18n-kit/commit/25c75310a24f3ec06c208f1eb345ad3c329b8322))

## [7.5.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-7.4.1...the-i18n-mcp-7.5.0) (2026-08-23)


### Features

* find keys that carry the same value, not just the same path ([#396](https://github.com/fabkho/the-i18n-kit/issues/396)) ([02e60d1](https://github.com/fabkho/the-i18n-kit/commit/02e60d10bce4bda5623ff0d11d924bd1e41127e1))
* **mcp:** surface the layer graph from discover ([#388](https://github.com/fabkho/the-i18n-kit/issues/388)) ([8753ee3](https://github.com/fabkho/the-i18n-kit/commit/8753ee3f423dcad31fb27c9a80c6e187c0cf5958)), closes [#342](https://github.com/fabkho/the-i18n-kit/issues/342)
* move a translation key between layers in one operation ([#393](https://github.com/fabkho/the-i18n-kit/issues/393)) ([79a108e](https://github.com/fabkho/the-i18n-kit/commit/79a108ed741da71617db437f9f702bc1f823ffe9)), closes [#341](https://github.com/fabkho/the-i18n-kit/issues/341)


### Bug Fixes

* **config:** require a key on every translation example ([#383](https://github.com/fabkho/the-i18n-kit/issues/383)) ([cdc3418](https://github.com/fabkho/the-i18n-kit/commit/cdc341813e98e8c36d36eb814148da80d17d93aa)), closes [#367](https://github.com/fabkho/the-i18n-kit/issues/367)
* the config surface described nuxt.config.ts policy that [#372](https://github.com/fabkho/the-i18n-kit/issues/372) removed ([#384](https://github.com/fabkho/the-i18n-kit/issues/384)) ([7220e7b](https://github.com/fabkho/the-i18n-kit/commit/7220e7b19b7a3105930ad441df71b435612ce9a1)), closes [#380](https://github.com/fabkho/the-i18n-kit/issues/380) [#300](https://github.com/fabkho/the-i18n-kit/issues/300)

## [7.4.1](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-7.4.0...the-i18n-mcp-7.4.1) (2026-08-17)


### Bug Fixes

* **config:** generate the published JSON Schema from the zod schema ([#346](https://github.com/fabkho/the-i18n-kit/issues/346)) ([#368](https://github.com/fabkho/the-i18n-kit/issues/368)) ([9bfcbc5](https://github.com/fabkho/the-i18n-kit/commit/9bfcbc5f788610dac079855ef0ee6f02746ec0a0))

## [7.4.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-7.3.0...the-i18n-mcp-7.4.0) (2026-08-16)


### Features

* tell users on the old package names that the kit has moved ([#338](https://github.com/fabkho/the-i18n-kit/issues/338)) ([18f146d](https://github.com/fabkho/the-i18n-kit/commit/18f146dfb3fea19102fb97b4ee745b41850aa7aa))

## [7.3.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-7.2.0...the-i18n-mcp-7.3.0) (2026-08-16)


### Features

* **mcp:** expose find_empty_translations ([#335](https://github.com/fabkho/the-i18n-kit/issues/335)) ([34834b8](https://github.com/fabkho/the-i18n-kit/commit/34834b889321594dac818c2eee839002a1e5dc5b)), closes [#252](https://github.com/fabkho/the-i18n-kit/issues/252)

## [7.2.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-7.1.1...the-i18n-mcp-7.2.0) (2026-08-14)


### Features

* **cli:** status — coverage per locale and per layer, with a --fail-under gate ([#311](https://github.com/fabkho/the-i18n-kit/issues/311)) ([8db7c96](https://github.com/fabkho/the-i18n-kit/commit/8db7c96128d79ce6f120fc9745b01e4130e4168d)), closes [#253](https://github.com/fabkho/the-i18n-kit/issues/253)

## [7.1.1](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-7.1.0...the-i18n-mcp-7.1.1) (2026-08-13)


### Bug Fixes

* **cli:** report unresolved and ambiguous locale refs instead of dropping them ([#302](https://github.com/fabkho/the-i18n-kit/issues/302)) ([a257a5f](https://github.com/fabkho/the-i18n-kit/commit/a257a5f9237805f4003efff0a1f84d1868e06a18))

## [7.1.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-7.0.1...the-i18n-mcp-7.1.0) (2026-08-11)


### Features

* **cli:** provider baseUrl via flag, env and project config ([#282](https://github.com/fabkho/the-i18n-kit/issues/282)) ([af5cc9a](https://github.com/fabkho/the-i18n-kit/commit/af5cc9a9d0f9299e630f1ca0b379d2e8576fb672))

## [7.0.1](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-7.0.0...the-i18n-mcp-7.0.1) (2026-08-10)


### Bug Fixes

* **mcp:** default tool projectDir to I18N_PROJECT_DIR ([#279](https://github.com/fabkho/the-i18n-kit/issues/279)) ([16dbcf6](https://github.com/fabkho/the-i18n-kit/commit/16dbcf6acf4563cf4f09a89665773bb3461d09e3)), closes [#264](https://github.com/fabkho/the-i18n-kit/issues/264)

## [7.0.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-6.2.0...the-i18n-mcp-7.0.0) (2026-08-10)


### ⚠ BREAKING CHANGES

* **mcp:** the published package now requires Node.js >= 20 (v2 SDK minimum). Wire behavior toward existing legacy hosts is unchanged.

### Features

* **mcp:** migrate to MCP SDK v2 and serve the 2026-07-28 era alongside legacy ([#260](https://github.com/fabkho/the-i18n-kit/issues/260)) ([b04bad1](https://github.com/fabkho/the-i18n-kit/commit/b04bad1aa15e09b68b697d31ac50f3b689fa822f))

## [6.2.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-6.1.0...the-i18n-mcp-6.2.0) (2026-08-10)


### Features

* **cli:** check — used-but-undefined key detection with CI exit gating ([#245](https://github.com/fabkho/the-i18n-kit/issues/245)) ([6c4b9bf](https://github.com/fabkho/the-i18n-kit/commit/6c4b9bffec124529b415bcbfa1be21af00f715bf))
* **cli:** find_duplicate_keys — cross-layer key collisions with divergence detection ([#243](https://github.com/fabkho/the-i18n-kit/issues/243)) ([cf2343d](https://github.com/fabkho/the-i18n-kit/commit/cf2343dcc6cd17dcf2400cb234e542c464ab54d7))
* **cli:** layer-scope-aware orphan scanning with misplaced-usage detection ([#244](https://github.com/fabkho/the-i18n-kit/issues/244)) ([04cc252](https://github.com/fabkho/the-i18n-kit/commit/04cc2521e323cf9b87e131b0fc39320182a731af))

## [6.1.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-6.0.0...the-i18n-mcp-6.1.0) (2026-08-09)


### Features

* **cli:** protectedLocales — human-maintained locales excluded from auto-translation ([#226](https://github.com/fabkho/the-i18n-kit/issues/226)) ([8a9152e](https://github.com/fabkho/the-i18n-kit/commit/8a9152e8b71c911eaae842c563e2672126fa7e47)), closes [#211](https://github.com/fabkho/the-i18n-kit/issues/211)

## [6.0.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-5.0.0...the-i18n-mcp-6.0.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* **mcp:** MCP sampling support is removed. Hosts that offered sampling no longer get translation through it — configure provider mode via I18N_PROVIDER, I18N_MODEL, and the provider API key env on the server process, or use agent mode (fallbackContexts + write_translations).

### Features

* **mcp:** env-configured provider mode, MCP sampling removed ([#222](https://github.com/fabkho/the-i18n-kit/issues/222)) ([9bb74d2](https://github.com/fabkho/the-i18n-kit/commit/9bb74d2b3202e90a76b8c6ad4bd83a16a11cfbf2))

## [5.0.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-4.0.0...the-i18n-mcp-5.0.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* **cli:** translate_missing and translate_key result shapes changed as described. All consumers (CLI output, MCP tools) updated.

### Features

* **cli:** honest translate result contract — mode, failed/skipped reasons, wouldTranslate ([#220](https://github.com/fabkho/the-i18n-kit/issues/220)) ([9d393bb](https://github.com/fabkho/the-i18n-kit/commit/9d393bb025ddfbf4481ac6f5df716366dc550a3e))

## [4.0.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-3.5.1...the-i18n-mcp-4.0.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* **cli:** programmatic API renames — createSamplingFn is now createTranslateFn; translate operations take translateFn instead of samplingFn; Sampling* types are Translate* types. CLI commands and MCP tool surfaces are unaffected.

### Features

* **mcp:** align with MCP 2026-07-28 direction — SDK 1.30, stateless resources ([#217](https://github.com/fabkho/the-i18n-kit/issues/217)) ([fcfa34c](https://github.com/fabkho/the-i18n-kit/commit/fcfa34c8040f16093df9fab501139513bfd67def))


### Code Refactoring

* **cli:** rename translate seam SamplingFn → TranslateFn, drop model preferences ([#216](https://github.com/fabkho/the-i18n-kit/issues/216)) ([3355298](https://github.com/fabkho/the-i18n-kit/commit/3355298da6065192e7bcb68ef96ec9a648e41c74))

## [3.5.1](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-3.5.0...the-i18n-mcp-3.5.1) (2026-06-16)


### Bug Fixes

* **mcp:** bump to republish with CLI 1.5.0 dependency ([#185](https://github.com/fabkho/the-i18n-kit/issues/185)) ([00b519d](https://github.com/fabkho/the-i18n-kit/commit/00b519dd55ccd019a8c234014f1f7c2b32c75e1f))

## [3.5.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-3.4.0...the-i18n-mcp-3.5.0) (2026-06-15)


### Features

* replace node:path with pathe, add exports field to MCP package ([#173](https://github.com/fabkho/the-i18n-kit/issues/173)) ([46e9ac9](https://github.com/fabkho/the-i18n-kit/commit/46e9ac9607b2e7bd68e8df395c09fe23c41d159d))

## [3.4.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-3.3.1...the-i18n-mcp-3.4.0) (2026-06-15)


### Features

* add list_namespaces MCP tool ([#153](https://github.com/fabkho/the-i18n-kit/issues/153)) ([#163](https://github.com/fabkho/the-i18n-kit/issues/163)) ([474b021](https://github.com/fabkho/the-i18n-kit/commit/474b021e0aa50cb5c05ef484fa9451738aaa3180))
* search all layers, compact outputs for get_translations and translate_missing ([#162](https://github.com/fabkho/the-i18n-kit/issues/162)) ([5c8cfaf](https://github.com/fabkho/the-i18n-kit/commit/5c8cfafc36a8bb30be01538da94f7c0cbe4fea6d))


### Bug Fixes

* remove repository directory field to fix Glama repo URL resolution ([0807be4](https://github.com/fabkho/the-i18n-kit/commit/0807be407244fa31747dc9b9e50839cdec32dcfb))

## [3.3.1](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-3.3.0...the-i18n-mcp-3.3.1) (2026-06-11)


### Performance Improvements

* add concurrent locale translation + LLM provider abstraction ([#141](https://github.com/fabkho/the-i18n-kit/issues/141)) ([7e09ec2](https://github.com/fabkho/the-i18n-kit/commit/7e09ec25ac18481391b6847675222808c4cbaaa1))
* parallel translation + LLM providers + API consolidation + fallow CI ([#144](https://github.com/fabkho/the-i18n-kit/issues/144)) ([caf7349](https://github.com/fabkho/the-i18n-kit/commit/caf7349a81ac7a066dbf6c25909c92c6bcaa32b4))

## [3.3.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-3.2.0...the-i18n-mcp-3.3.0) (2026-06-02)


### Features

* add source key translation tool ([#137](https://github.com/fabkho/the-i18n-kit/issues/137)) ([b3ceae7](https://github.com/fabkho/the-i18n-kit/commit/b3ceae715e171c329cf18f0b88299c80419b1d00))

## [3.2.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-3.1.0...the-i18n-mcp-3.2.0) (2026-05-09)


### Features

* **mcp:** improve project config section in prompts ([1048be5](https://github.com/fabkho/the-i18n-kit/commit/1048be5d2dd732fc504bf9b7df58a95ceec80d5a))


### Bug Fixes

* **mcp:** clearer schema hint for add_translations, batching hint for translate_missing ([#131](https://github.com/fabkho/the-i18n-kit/issues/131)) ([760cff7](https://github.com/fabkho/the-i18n-kit/commit/760cff754bcc1e3168ad1b0bb7f6c8c5507e5fdd))

## [3.1.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-3.0.1...the-i18n-mcp-3.1.0) (2026-05-09)


### Features

* add outputFile param to large-output tools ([#127](https://github.com/fabkho/the-i18n-kit/issues/127)) ([763494e](https://github.com/fabkho/the-i18n-kit/commit/763494ee3955bf05692f59c65633754dc3d95f67))

## [3.0.1](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-3.0.0...the-i18n-mcp-3.0.1) (2026-04-28)


### Bug Fixes

* include package READMEs in npm publish ([53763b9](https://github.com/fabkho/the-i18n-kit/commit/53763b99650e849df3ffe4584f8162a51538dd06))

## [3.0.0](https://github.com/fabkho/the-i18n-kit/compare/the-i18n-mcp-2.3.0...the-i18n-mcp-3.0.0) (2026-04-28)


### ⚠ BREAKING CHANGES

* restructured into pnpm workspace monorepo.

### Features

* add CLI interface, make project CLI-first + MCP ([#120](https://github.com/fabkho/the-i18n-kit/issues/120)) ([874abf4](https://github.com/fabkho/the-i18n-kit/commit/874abf41ed8caf479849934424bcb6e59b177703))
