# Changelog

## [1.5.0](https://github.com/fabkho/nuxt-i18n-mcp/compare/v1.4.1...v1.5.0) (2026-03-25)


### Features

* add dryRun support to add_translations and update_translations ([#35](https://github.com/fabkho/nuxt-i18n-mcp/issues/35)) ([f1979b6](https://github.com/fabkho/nuxt-i18n-mcp/commit/f1979b68cccf733be4ca5211d50d8c3cd4ecb7e6))
* monorepo-aware Nuxt app discovery ([#33](https://github.com/fabkho/nuxt-i18n-mcp/issues/33)) ([c57b6cc](https://github.com/fabkho/nuxt-i18n-mcp/commit/c57b6cc790be42c4005d0f479764b1416b4a0a06))

## [1.4.1](https://github.com/fabkho/nuxt-i18n-mcp/compare/v1.4.0...v1.4.1) (2026-03-23)


### Bug Fixes

* use source-level shebang for proper npx execution ([bea11b2](https://github.com/fabkho/nuxt-i18n-mcp/commit/bea11b2451fcedf968730624be67686d89201186))
* use source-level shebang for proper npx execution ([e34d7cd](https://github.com/fabkho/nuxt-i18n-mcp/commit/e34d7cd59e4eb2a83290d9767068fce8bde48170))

## [1.4.0](https://github.com/fabkho/nuxt-i18n-mcp/compare/v1.3.0...v1.4.0) (2026-03-22)


### Features

* add ignorePatterns for orphan key detection ([f02f1c6](https://github.com/fabkho/nuxt-i18n-mcp/commit/f02f1c6c27c54d3680f5edeefd22bfa749b2e255))
* add ignorePatterns for orphan key detection ([e8449a3](https://github.com/fabkho/nuxt-i18n-mcp/commit/e8449a374064c3efa2740c685672a319c39beb1a)), closes [#22](https://github.com/fabkho/nuxt-i18n-mcp/issues/22)
* add reportFile parameter to 5 diagnostic tools ([72e8660](https://github.com/fabkho/nuxt-i18n-mcp/commit/72e8660f8d13ceceda9943a484f347eaaef5e871)), closes [#23](https://github.com/fabkho/nuxt-i18n-mcp/issues/23)
* write diagnostic tool reports to file ([40aabe7](https://github.com/fabkho/nuxt-i18n-mcp/commit/40aabe7bde66802faa41f1d54db1017a68bdf217))


### Bug Fixes

* use static unlink import, reject empty reportOutput strings ([6167375](https://github.com/fabkho/nuxt-i18n-mcp/commit/6167375aa010e1c88f21c6ea88f189d5515dea8f))

## [1.3.0](https://github.com/fabkho/nuxt-i18n-mcp/compare/v1.2.0...v1.3.0) (2026-03-21)


### Features

* add buildDynamicKeyRegexes() for dynamic key pattern matching ([b281b8e](https://github.com/fabkho/nuxt-i18n-mcp/commit/b281b8eeac746b029b35bec7eb7af436abd7afc7))
* add cleanup_unused_translations tool (13th tool) ([6db4521](https://github.com/fabkho/nuxt-i18n-mcp/commit/6db4521b497b3199d735e6af5a150d61e6e01057))
* add find_empty_translations tool ([7ce0c9f](https://github.com/fabkho/nuxt-i18n-mcp/commit/7ce0c9fd36579987c3f728a3c9ecb771070c50f8))
* add find_empty_translations tool ([4c554ab](https://github.com/fabkho/nuxt-i18n-mcp/commit/4c554ab2d1dc0819f2f36a3b33bacf4e01db81d9))
* add orphanScan config for per-layer scan scope ([6b6cfb1](https://github.com/fabkho/nuxt-i18n-mcp/commit/6b6cfb167ca3d34503893b703b27f9695188c631))
* add scan_code_usage tool (12th tool) ([7cd5ed2](https://github.com/fabkho/nuxt-i18n-mcp/commit/7cd5ed27961041483410bb2eb2ae566976cba8a4))
* configurable orphanScan scope per layer ([c92f230](https://github.com/fabkho/nuxt-i18n-mcp/commit/c92f23000c29cb0e1b7a69388396550dfa1f73c1))
* detect concatenation-based dynamic keys (t('prefix.' + var)) ([62b5c0a](https://github.com/fabkho/nuxt-i18n-mcp/commit/62b5c0af683519eda7bf54245c67af310e2bd787))
* Phase 1 MVP — MCP server with config detection, JSON I/O, and core tools ([b4b4713](https://github.com/fabkho/nuxt-i18n-mcp/commit/b4b47130a7491fff7a249cbf8d3ca99162e447c9))
* Phase 2 — analysis, search & project config ([c9ff7b4](https://github.com/fabkho/nuxt-i18n-mcp/commit/c9ff7b49d1d68b70a2fcad1cc81583c8f65e621d))
* Phase 3 — remove_translations and rename_translation_key tools ([b7572bb](https://github.com/fabkho/nuxt-i18n-mcp/commit/b7572bbd3bbe3be8355300a4dfd458655f63c41f))
* Phase 4 — translate_missing tool and MCP prompts ([652a1d3](https://github.com/fabkho/nuxt-i18n-mcp/commit/652a1d3ec213f47706fb2e4a7428cec68d6cd48c))
* Phase 5 (items 1-5) — polish, caching, error codes, edge cases ([e417b74](https://github.com/fabkho/nuxt-i18n-mcp/commit/e417b7438249a7c1b61231310e9badd41a45b008))
* use buildDynamicKeyRegexes in find_orphan_keys and cleanup_unused_translations ([b99d7a5](https://github.com/fabkho/nuxt-i18n-mcp/commit/b99d7a5be9dec7b2aca41ba82aff56be62e707a9))
* wire 3-tier scan directory fallback in orphan detection tools ([c8e90a9](https://github.com/fabkho/nuxt-i18n-mcp/commit/c8e90a9bd23a75299ce1b5219a28abec2c065208))


### Bug Fixes

* add pnpm workspace so CI installs playground dependencies ([d451cf2](https://github.com/fabkho/nuxt-i18n-mcp/commit/d451cf2d1f727791cd605640f0a9c3066c4b6780))
* address CodeRabbit review findings ([c55f764](https://github.com/fabkho/nuxt-i18n-mcp/commit/c55f76497a7f95106d3a267d9fbc7aa1e12fcaee))
* fallback layerRootDirs to projectDir when layers array is empty ([6cf4e3a](https://github.com/fabkho/nuxt-i18n-mcp/commit/6cf4e3a2f0e1b18cdc5d98bc138cddd59148abc2))
* handle nested braces in interpolation splitting and improve zero-orphan message ([29523b2](https://github.com/fabkho/nuxt-i18n-mcp/commit/29523b2645275ae51cae53ac8fb28ea89698d32e))
* scan all Nuxt layers for source code, not just those with locale dirs ([83f09c3](https://github.com/fabkho/nuxt-i18n-mcp/commit/83f09c3e6a26fa58eb14b52b0cf94e4ecdcdd902))
* scan all Nuxt layers for source code, not just those with locale dirs ([932d855](https://github.com/fabkho/nuxt-i18n-mcp/commit/932d8558967b821e445f02c814e1c102a671235c))
* shorten server.json description for MCP Registry 100-char limit ([b3c56e4](https://github.com/fabkho/nuxt-i18n-mcp/commit/b3c56e48431f39ec43dc8ad4e26493f7a4a65322))
* treat empty-string and null values as missing translations ([adba2ec](https://github.com/fabkho/nuxt-i18n-mcp/commit/adba2ec52a80fbcf17d8df61f50e43f027269ad4))
* use dynamic key patterns to reduce orphan detection false positives ([2a5586c](https://github.com/fabkho/nuxt-i18n-mcp/commit/2a5586c429ac2e27a14b3b522021e81da8e8da03))
* use ready:false instead of modules:[] in loadNuxt retry to fix CI ([1f274f4](https://github.com/fabkho/nuxt-i18n-mcp/commit/1f274f4d893f82bc579e825b49de1c662e555c89))
* walk up directory tree to find .i18n-mcp.json in monorepos ([3c13fae](https://github.com/fabkho/nuxt-i18n-mcp/commit/3c13faecd63b1789db5e16a6078ea158204f0d18))
* walk up directory tree to find .i18n-mcp.json in monorepos ([e354298](https://github.com/fabkho/nuxt-i18n-mcp/commit/e354298f44c911d1ef2575dfc3e617619229cba0)), closes [#19](https://github.com/fabkho/nuxt-i18n-mcp/issues/19)

## [1.2.0](https://github.com/fabkho/nuxt-i18n-mcp/compare/v1.1.0...v1.2.0) (2026-03-21)


### Features

* add buildDynamicKeyRegexes() for dynamic key pattern matching ([b281b8e](https://github.com/fabkho/nuxt-i18n-mcp/commit/b281b8eeac746b029b35bec7eb7af436abd7afc7))
* add find_empty_translations tool ([7ce0c9f](https://github.com/fabkho/nuxt-i18n-mcp/commit/7ce0c9fd36579987c3f728a3c9ecb771070c50f8))
* add find_empty_translations tool ([4c554ab](https://github.com/fabkho/nuxt-i18n-mcp/commit/4c554ab2d1dc0819f2f36a3b33bacf4e01db81d9))
* add orphanScan config for per-layer scan scope ([6b6cfb1](https://github.com/fabkho/nuxt-i18n-mcp/commit/6b6cfb167ca3d34503893b703b27f9695188c631))
* configurable orphanScan scope per layer ([c92f230](https://github.com/fabkho/nuxt-i18n-mcp/commit/c92f23000c29cb0e1b7a69388396550dfa1f73c1))
* detect concatenation-based dynamic keys (t('prefix.' + var)) ([62b5c0a](https://github.com/fabkho/nuxt-i18n-mcp/commit/62b5c0af683519eda7bf54245c67af310e2bd787))
* use buildDynamicKeyRegexes in find_orphan_keys and cleanup_unused_translations ([b99d7a5](https://github.com/fabkho/nuxt-i18n-mcp/commit/b99d7a5be9dec7b2aca41ba82aff56be62e707a9))
* wire 3-tier scan directory fallback in orphan detection tools ([c8e90a9](https://github.com/fabkho/nuxt-i18n-mcp/commit/c8e90a9bd23a75299ce1b5219a28abec2c065208))


### Bug Fixes

* fallback layerRootDirs to projectDir when layers array is empty ([6cf4e3a](https://github.com/fabkho/nuxt-i18n-mcp/commit/6cf4e3a2f0e1b18cdc5d98bc138cddd59148abc2))
* handle nested braces in interpolation splitting and improve zero-orphan message ([29523b2](https://github.com/fabkho/nuxt-i18n-mcp/commit/29523b2645275ae51cae53ac8fb28ea89698d32e))
* scan all Nuxt layers for source code, not just those with locale dirs ([83f09c3](https://github.com/fabkho/nuxt-i18n-mcp/commit/83f09c3e6a26fa58eb14b52b0cf94e4ecdcdd902))
* scan all Nuxt layers for source code, not just those with locale dirs ([932d855](https://github.com/fabkho/nuxt-i18n-mcp/commit/932d8558967b821e445f02c814e1c102a671235c))
* use dynamic key patterns to reduce orphan detection false positives ([2a5586c](https://github.com/fabkho/nuxt-i18n-mcp/commit/2a5586c429ac2e27a14b3b522021e81da8e8da03))

## [1.2.0](https://github.com/fabkho/nuxt-i18n-mcp/compare/v1.1.0...v1.2.0) (2026-03-21)


### Features

* add buildDynamicKeyRegexes() for dynamic key pattern matching ([4233c6f](https://github.com/fabkho/nuxt-i18n-mcp/commit/4233c6f1504bd42746dc67b8bb11d2c89febbd99))
* add find_empty_translations tool ([be271c0](https://github.com/fabkho/nuxt-i18n-mcp/commit/be271c049704dae815232efce3d96bdd394ecd12))
* add find_empty_translations tool ([b8f6677](https://github.com/fabkho/nuxt-i18n-mcp/commit/b8f6677724938f9b3c3a553342b919692d296f78))
* add orphanScan config for per-layer scan scope ([2b48581](https://github.com/fabkho/nuxt-i18n-mcp/commit/2b4858133c7854f832e477b7a8c7cf92af109997))
* configurable orphanScan scope per layer ([1048103](https://github.com/fabkho/nuxt-i18n-mcp/commit/10481031c2bc85125681ce3947cd024de3c39a00))
* detect concatenation-based dynamic keys (t('prefix.' + var)) ([e3b4b58](https://github.com/fabkho/nuxt-i18n-mcp/commit/e3b4b58efaa874edc81e2e92e548ac3a5aba4242))
* use buildDynamicKeyRegexes in find_orphan_keys and cleanup_unused_translations ([29ba41f](https://github.com/fabkho/nuxt-i18n-mcp/commit/29ba41f348fa69a5f3e0ed8c654289a935fbf077))
* wire 3-tier scan directory fallback in orphan detection tools ([7acc033](https://github.com/fabkho/nuxt-i18n-mcp/commit/7acc03387218d49922771deb24048fcda3729ba4))


### Bug Fixes

* fallback layerRootDirs to projectDir when layers array is empty ([6cf4e3a](https://github.com/fabkho/nuxt-i18n-mcp/commit/6cf4e3a2f0e1b18cdc5d98bc138cddd59148abc2))
* handle nested braces in interpolation splitting and improve zero-orphan message ([aa3cb41](https://github.com/fabkho/nuxt-i18n-mcp/commit/aa3cb41b4de4c6f69c1dd327d3d882a6f134973c))
* scan all Nuxt layers for source code, not just those with locale dirs ([83f09c3](https://github.com/fabkho/nuxt-i18n-mcp/commit/83f09c3e6a26fa58eb14b52b0cf94e4ecdcdd902))
* scan all Nuxt layers for source code, not just those with locale dirs ([932d855](https://github.com/fabkho/nuxt-i18n-mcp/commit/932d8558967b821e445f02c814e1c102a671235c))
* use dynamic key patterns to reduce orphan detection false positives ([11324a9](https://github.com/fabkho/nuxt-i18n-mcp/commit/11324a99e4efe14c59c2c89b26918cc46a5aa149))

## [1.1.0](https://github.com/fabkho/nuxt-i18n-mcp/compare/v1.0.1...v1.1.0) (2026-03-20)


### Dependencies

* upgrade zod from v3 to v4 (`^3.25.0` → `^4.3.6`) ([130acbd](https://github.com/fabkho/nuxt-i18n-mcp/commit/130acbd))
* upgrade `@modelcontextprotocol/sdk` from `^1.12.0` to `^1.23.0` (minimum version with zod v4 peer compatibility)
* upgrade `@nuxt/kit` devDependency from `^3.17.0` to `^4.4.2` ([eed18f7](https://github.com/fabkho/nuxt-i18n-mcp/commit/eed18f7))
* widen `@nuxt/kit` peerDependency to `^3.0.0 || ^4.0.0` (supports both Nuxt 3 and Nuxt 4 projects)
* bump minimum Node.js version from `>=18.0.0` to `>=18.12.0` (required by `@nuxt/kit` v4)

## [1.0.1](https://github.com/fabkho/nuxt-i18n-mcp/compare/v1.0.0...v1.0.1) (2026-03-20)


### Bug Fixes

* shorten server.json description for MCP Registry 100-char limit ([b3c56e4](https://github.com/fabkho/nuxt-i18n-mcp/commit/b3c56e48431f39ec43dc8ad4e26493f7a4a65322))

## 1.0.0 (2026-03-20)


### Features

* add cleanup_unused_translations tool (13th tool) ([6db4521](https://github.com/fabkho/nuxt-i18n-mcp/commit/6db4521b497b3199d735e6af5a150d61e6e01057))
* add scan_code_usage tool (12th tool) ([7cd5ed2](https://github.com/fabkho/nuxt-i18n-mcp/commit/7cd5ed27961041483410bb2eb2ae566976cba8a4))
* Phase 1 MVP — MCP server with config detection, JSON I/O, and core tools ([b4b4713](https://github.com/fabkho/nuxt-i18n-mcp/commit/b4b47130a7491fff7a249cbf8d3ca99162e447c9))
* Phase 2 — analysis, search & project config ([c9ff7b4](https://github.com/fabkho/nuxt-i18n-mcp/commit/c9ff7b49d1d68b70a2fcad1cc81583c8f65e621d))
* Phase 3 — remove_translations and rename_translation_key tools ([b7572bb](https://github.com/fabkho/nuxt-i18n-mcp/commit/b7572bbd3bbe3be8355300a4dfd458655f63c41f))
* Phase 4 — translate_missing tool and MCP prompts ([652a1d3](https://github.com/fabkho/nuxt-i18n-mcp/commit/652a1d3ec213f47706fb2e4a7428cec68d6cd48c))
* Phase 5 (items 1-5) — polish, caching, error codes, edge cases ([e417b74](https://github.com/fabkho/nuxt-i18n-mcp/commit/e417b7438249a7c1b61231310e9badd41a45b008))


### Bug Fixes

* add pnpm workspace so CI installs playground dependencies ([d451cf2](https://github.com/fabkho/nuxt-i18n-mcp/commit/d451cf2d1f727791cd605640f0a9c3066c4b6780))
* address CodeRabbit review findings ([c55f764](https://github.com/fabkho/nuxt-i18n-mcp/commit/c55f76497a7f95106d3a267d9fbc7aa1e12fcaee))
* treat empty-string and null values as missing translations ([adba2ec](https://github.com/fabkho/nuxt-i18n-mcp/commit/adba2ec52a80fbcf17d8df61f50e43f027269ad4))
* use ready:false instead of modules:[] in loadNuxt retry to fix CI ([1f274f4](https://github.com/fabkho/nuxt-i18n-mcp/commit/1f274f4d893f82bc579e825b49de1c662e555c89))

## Changelog

All notable changes to this project will be documented in this file.

This project uses [Release Please](https://github.com/googleapis/release-please) for automated versioning and changelog generation based on [Conventional Commits](https://www.conventionalcommits.org/).
