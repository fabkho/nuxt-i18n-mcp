/**
 * Core i18n operations — pure async functions with no MCP dependency.
 *
 * This module is a barrel: the implementations live in the cohesive
 * modules below and are re-exported here so consumers keep a single
 * stable import path.
 *
 * Each function accepts plain parameters and returns plain objects.
 * Errors are thrown (ToolError etc.) rather than returned as isError responses.
 */

export { findLocaleImpl } from './shared.js'

export { validateReportPath } from './report.js'

export {
  computeProgressTotal,
  resolveProtectedLocales,
  validatePlaceholders,
  buildTranslationSystemPrompt,
  buildTranslationUserMessage,
  extractJsonFromResponse,
  translateMissing,
  translateKey,
} from './ops-translate.js'

export type {
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
} from './translate/run.js'

export {
  describeProject,
  detectConfig,
  listLocaleDirs,
  getTranslations,
  getMissingTranslations,
  findEmptyTranslations,
  searchTranslations,
  listNamespaces,
} from './ops-read.js'

export type {
  DescribeProjectOutcome,
  DescribeProjectResult,
  EmptyTranslationsResult,
  GetTranslationsByLayer,
  GetTranslationsOutcome,
  GetTranslationsResult,
  ListNamespacesResult,
  LocaleDirInfo,
  MissingTranslationsPage,
  MissingTranslationsResult,
  NamespaceNode,
  PagedResult,
  SearchKeyMatch,
  SearchMatch,
  SearchMatchMode,
  SearchTranslationsPage,
  SearchTranslationsResult,
  TrimmedProjectConfig,
} from './ops-read.js'

export {
  writeTranslations,
  removeTranslations,
  renameTranslationKey,
  moveTranslationKey,
  scaffoldLocaleFiles,
} from './ops-write.js'

export type {
  MoveTranslationKeyOutcome,
  MoveTranslationKeyPlanEntry,
  MoveTranslationKeyResult,
  RemoveTranslationsPreview,
  RemoveTranslationsResult,
  RenameTranslationKeyPreview,
  RenameTranslationKeyResult,
  ScaffoldLocaleFileInfo,
  ScaffoldLocaleResult,
  WriteTranslationsResult,
} from './ops-write.js'

export { initProjectConfig } from './ops-init.js'

export type { GeneratedProjectConfig, InitProjectConfigResult } from './ops-init.js'

export { getTranslationStatus } from './ops-status.js'

export type {
  LayerStatus,
  LocaleStatus,
  TranslationStatusResult,
  TranslationStatusSummary,
} from './ops-status.js'

export {
  findOrphanKeys,
  scanCodeUsage,
  removeOrphanKeys,
} from './ops-orphans.js'

export type {
  CodeUsageRef,
  CodeUsageResult,
  DeclaredNamespaceRef,
  DynamicKeyRef,
  FindOrphanKeysResult,
  MisplacedUsageRef,
  RemoveOrphanKeysResult,
  ScanCodeUsageResult,
  UnresolvedKeyWarningRef,
} from './ops-orphans.js'

export { findDuplicateKeys } from './ops-duplicates.js'

export type {
  DuplicateKeyCollision,
  FindDuplicateKeysResult,
  FindDuplicateKeysSummary,
} from './ops-duplicates.js'

export { checkUndefinedKeys } from './ops-check.js'

export type {
  KeyUsageLocation,
  UndefinedKeyFinding,
  UncertainKeyFinding,
  CheckUndefinedKeysResult,
  CheckUndefinedKeysSummary,
} from './ops-check.js'
