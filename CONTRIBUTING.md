# Contributing

## Setup

```bash
pnpm install
pnpm build
```

The monorepo uses pnpm workspaces with these packages:

| Package | Description |
|---------|-------------|
| `packages/cli` (`@the-i18n-kit/cli`) | CLI tool for i18n management — JSON/PHP locale files, code scanning, LLM translation, config detection |
| `packages/mcp` (`@the-i18n-kit/mcp`) | MCP server wrapping the CLI as tools for AI agents |
| `packages/mcp-compat` (`the-i18n-mcp`) | Pre-rename alias; one file that starts `@the-i18n-kit/mcp` |
| `packages/nuxt` (`@the-i18n-kit/nuxt`) | Nuxt module that publishes the resolved layer graph to `.nuxt/i18n-kit.json` |
| `packages/eslint-plugin-vue` (`@the-i18n-kit/eslint-plugin-vue`) | ESLint rules for authoring idioms the scanner cannot see |

## Development

```bash
pnpm build          # build all packages
pnpm test           # run all tests (CLI only)
pnpm lint           # lint all source files
pnpm typecheck      # build CLI + typecheck all packages
```

To work on a single package:

```bash
pnpm --filter @the-i18n-kit/cli dev     # watch mode
pnpm --filter @the-i18n-kit/cli test    # run CLI tests only
```

## Architecture

### CLI (`packages/cli/src/`)

```
adapters/     # Framework detection (Nuxt, Laravel, Vue, React, Generic)
commands/     # CLI subcommands, one file each — use createCommand() factory from _shared.ts
config/       # Project config loading, Nuxt app discovery, locale override
core/         # operations.ts — all i18n operations as pure async functions. types.ts — result shapes.
io/           # Locale file reading/writing (JSON + PHP), atomicWrite, readCache, key-operations
llm/          # LLM provider setup (OpenAI, Anthropic, Google)
scanner/      # Source code scanning for i18n key usage, orphan detection
tools/        # Locale scaffold utility
utils/        # errors.ts (custom error classes + toErrorMessage), logger.ts (consola wrapper)
```

### MCP (`packages/mcp/src/`)

```
server.ts     # MCP server with 13 tool registrations, zod input schemas, translation backend resolution (provider vs agent mode)
index.ts      # Entry point — creates server + stdio transport
```

### Data flow

1. CLI commands call operations in `core/operations.ts`
2. Operations detect config via adapters → load project config → read/write locale files via `io/`
3. MCP server registers tools that call the same operations, with MCP-specific progress notification integration

## Testing

Tests use Vitest. Test fixtures live in `packages/cli/tests/fixtures/`.

### Mock pattern

When mocking the config detector (common), use `vi.mock` with dynamic import:

```typescript
registerDetectorMock()

// Import AFTER mock so the mock is in place (Vitest hoists vi.mock)
const { detectI18nConfig } = await import('../../src/config/detector.js')
```

### Temp directories

Some tests create temporary directories via `mkdtemp`. Always clean up in `afterEach`:

```typescript
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})
```

## Adding a new adapter

1. Create `adapters/<framework>/index.ts` implementing `FrameworkAdapter`
2. Register it in `config/detector.ts` via `registerAdapter()`
3. Add types for any framework-specific config to `config/types.ts`
4. Add tests in `tests/adapters/<framework>-adapter.test.ts`

## Comments

- Comments state constraints, invariants, and non-obvious "why"s — things the code cannot say itself.
- No narration of the next line ("// increment the counter") and no restating what a well-named symbol already says.
- No development-history references ("removed in #208", "per review", "the old X did Y"). If a historical note guards a live invariant, rewrite it as the invariant.
- Redundant JSDoc that adds nothing over the signature: enrich it with the non-obvious part or delete it.
- `// ─── Section ───` divider comments are the established navigation style and welcome.

## PRs

- Branch from `main`
- Run `pnpm lint && pnpm typecheck` before committing (enforced by pre-commit hook)
- All tests must pass
- Keep PRs focused — one concern per PR
