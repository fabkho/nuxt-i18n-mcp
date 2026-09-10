// Public API — re-export everything the MCP package (and other consumers) need

// Core operations
export {
  describeProject,
  detectConfig,
  listLocaleDirs,
  getTranslations,
  writeTranslations,
  getMissingTranslations,
  getTranslationStatus,
  findEmptyTranslations,
  searchTranslations,
  removeTranslations,
  renameTranslationKey,
  moveTranslationKey,
  translateMissing,
  translateKey,
  findOrphanKeys,
  scanCodeUsage,
  removeOrphanKeys,
  findDuplicateKeys,
  checkUndefinedKeys,
  scaffoldLocaleFiles,
  listNamespaces,
  findLocaleImpl,
  resolveProtectedLocales,
} from './core/operations.js'
// Every operation's own result shape, re-exported from the module that
// produces it. `core/types.ts` below adds only what several of them share.
export type {
  DuplicateKeyCollision,
  FindDuplicateKeysResult,
  FindDuplicateKeysSummary,
  KeyUsageLocation,
  UndefinedKeyFinding,
  UncertainKeyFinding,
  CheckUndefinedKeysResult,
  CheckUndefinedKeysSummary,
  CodeUsageRef,
  CodeUsageResult,
  DeclaredNamespaceRef,
  DescribeProjectOutcome,
  DescribeProjectResult,
  DynamicKeyRef,
  EmptyTranslationsResult,
  FindOrphanKeysResult,
  GeneratedProjectConfig,
  GetTranslationsByLayer,
  GetTranslationsOutcome,
  GetTranslationsResult,
  InitProjectConfigResult,
  LayerStatus,
  ListNamespacesResult,
  LocaleDirInfo,
  LocaleStatus,
  MisplacedUsageRef,
  MissingTranslationsPage,
  MissingTranslationsResult,
  MoveTranslationKeyOutcome,
  MoveTranslationKeyPlanEntry,
  MoveTranslationKeyResult,
  NamespaceNode,
  PagedResult,
  RemoveOrphanKeysResult,
  RemoveTranslationsPreview,
  RemoveTranslationsResult,
  RenameTranslationKeyPreview,
  RenameTranslationKeyResult,
  ScaffoldLocaleFileInfo,
  ScaffoldLocaleResult,
  ScanCodeUsageResult,
  SearchKeyMatch,
  SearchMatch,
  SearchMatchMode,
  SearchTranslationsPage,
  SearchTranslationsResult,
  TranslateAllLayersResult,
  TranslateAllLayersSummary,
  TranslateFailReason,
  TranslateKeyLocaleIssue,
  TranslateKeyResult,
  TranslateKeySkip,
  TranslateLayerTotals,
  TranslateMissingCompactEntry,
  TranslateMissingLocaleResult,
  TranslateMissingOptions,
  TranslateMissingOutcome,
  TranslateMissingResult,
  TranslateMode,
  TranslateSkipReason,
  TranslationStatusResult,
  TranslationStatusSummary,
  TrimmedProjectConfig,
  UnresolvedKeyWarningRef,
  WriteTranslationsResult,
} from './core/operations.js'

// The operation table both surfaces are built from. The MCP server registers
// its tools from these; the CLI builds its commands from the same array.
export { descriptors, descriptorsFor, visibleParams } from './surface/descriptors.js'
// The file-diversion a surface applies to a large result. Operations return
// their whole result; a caller that wants the { reportFile, summary } shape
// asks for it the way the CLI and the server do.
// `outputSchema` states the same two shapes as a schema, which is what the MCP
// server advertises per tool and validates its structured result against.
export { assertReportPaths, divertToReport, outputSchema } from './surface/report.js'
export type {
  AnyOperationDescriptor,
  AnyReportSpec,
  OperationContext,
  OperationDescriptor,
  ParamSpec,
  ParamType,
  Params,
  ReportContext,
  ReportSpec,
  Surface,
  TranslationsRecord,
} from './surface/types.js'

// The shapes several operations share
export * from './core/types.js'

// Config
export { detectI18nConfig, getCachedConfig, clearConfigCache } from './config/detector.js'
// The spelling the config cache keys on. A consumer comparing one directory
// against another (the MCP server confining a caller-supplied projectDir to
// its root) has to resolve `..` and symlinks the same way, or the two answer
// differently for the same directory.
export { canonicalPath } from './config/paths.js'
export type { I18nConfig, LocaleDefinition, LocaleDir, ProjectConfig } from './config/types.js'
export { buildLayerGraph, serializeLayerGraph } from './config/layer-graph.js'
export type { LayerGraph, SerializedLayerGraph } from './config/layer-graph.js'
// Scanning with an explicit frontend list. `scanSourceFiles` picks the right
// frontends for the pattern set on its own; naming them is for a caller that
// needs one language's chain and nothing else — the packed-CLI smoke test in
// `packages/cli/scripts/php-peer-smoke.sh` drives the PHP chain this way, to
// prove a missing optional parser declines visibly instead of scanning less.
export { scanSourceFiles } from './scanner/code-scanner.js'
export type { ScanResult } from './scanner/code-scanner.js'
export { createPatternsFrontend } from './scanner/frontends/patterns.js'
export { createPhpFrontend } from './scanner/frontends/php/index.js'
export { LARAVEL_PATTERNS } from './scanner/patterns.js'
export type { LanguageFrontend } from './scanner/frontends/types.js'

// IO
export { readLocaleData } from './io/locale-data.js'

// Errors
export { ToolError, toErrorMessage } from './utils/errors.js'

// LLM providers
export { createTranslateFn, TranslateProviderError, classifyProviderError, resolveProviderBaseUrl, BASE_URL_ENV } from './llm/providers.js'
export { loadProjectConfig } from './config/project-config.js'
export { defineI18nKitConfig } from './define-config.js'
export type { I18nKitConfig } from './define-config.js'
export type { LlmProvider, LlmProviderConfig, TranslateProviderErrorKind } from './llm/providers.js'
