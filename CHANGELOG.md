# Changelog

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
