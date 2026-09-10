import { extname } from 'node:path'
import type { CallArgument, CallSite, LanguageFrontend } from './types.js'
import { log } from '../../utils/logger.js'

/**
 * JavaScript, TypeScript and Vue SFCs, read as syntax rather than matched as
 * text (#332).
 *
 * What this buys is one thing: it can follow `t` back to where it came from.
 * A regex sees the name and has to guess from the argument's shape whether the
 * call is a translation — the guess that offered a live key for deletion in
 * #298. Here, a `t` destructured from `useI18n()` is known to be i18n, and a
 * `t` that is anything else is known not to be.
 */

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.ts', '.tsx'])

/** Packages whose exports are translation functions. */
const I18N_MODULES = new Set(['vue-i18n', '@nuxtjs/i18n', 'next-intl', 'react-i18next', 'i18next', 'petite-vue-i18n'])

/** Composables whose destructured `t` is a translation function. */
const I18N_FACTORIES = new Set(['useI18n', 'useTranslation', 'useTranslations', 'getTranslations'])

/**
 * Callees that are unambiguous wherever they appear: a Vue template's `$t`, or
 * `this.$t` in an options-API component. Nothing else is named that.
 *
 * `$d` and `$n` are absent by intent: they format a date or a number, so their
 * argument is a value and never a key.
 */
const ALWAYS_I18N = new Set(['$t', '$te', '$tc', '$tm', '$rt'])

/**
 * Names that might be a translation function without proving it — the same set
 * the patterns match. Without this the frontend reports every call in the file,
 * and `axios.get('/api/v1')` or `require('node:fs')` become translation keys
 * because their argument happens to contain a dot.
 *
 * A call whose callee resolves to an i18n import is reported whatever it is
 * named, which is the point: the list bounds guesswork, not knowledge.
 */
const MAYBE_I18N = new Set(['t', 'te', 'tc', 'tm', 'rt', '$t', '$te', '$tc', '$tm', '$rt'])

type Node = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped AST from the parser

export function createOxcFrontend(): LanguageFrontend {
  return {
    name: 'oxc',

    handles(filePath: string): boolean {
      return JS_EXTENSIONS.has(extname(filePath)) || filePath.endsWith('.vue')
    },

    async read(content: string, filePath: string): Promise<CallSite[] | null> {
      const parse = await loadParser()
      if (!parse) return null

      const blocks = readableBlocks(content, filePath)
      if (!blocks) return null

      const parsed: ParsedBlockPair[] = []
      for (const block of blocks) {
        const ast = parseBlock(parse, block, filePath)
        if (ast) {
          parsed.push({ block, ast })
          continue
        }
        // A script block carries the declarations every other block resolves
        // against, so half a scope is worse evidence than the fallback's; a
        // template expression costs only itself, and may not even be
        // JavaScript (`xmlns:xlink="http://…"`).
        if (block.kind === 'script') return null
      }

      return collectAcrossBlocks(parsed)
    },
  }
}

interface ParsedBlockPair { block: VueBlock, ast: ParsedBlock }

/**
 * The parseable blocks of a file, or null to decline it. A .vue file with
 * neither a template nor a script tag is not an SFC: the block splitter would
 * read only the fragments it recognises and silently drop everything between
 * them — declining hands the whole file to the fallback instead. So does a
 * script tag the splitter found no body for, which means the file is not laid
 * out the way it reads.
 *
 * A template with nothing to lift out of it yields no blocks and is not
 * declined: markup with no lookup in it is a file with no evidence, not a file
 * that could not be read.
 */
function readableBlocks(content: string, filePath: string): VueBlock[] | null {
  if (!filePath.endsWith('.vue')) return [{ kind: 'script', sources: [content], lineOffset: 0 }]
  if (!/<template[\s>]|<script[\s>]/.test(content)) return null

  const blocks = vueBlocks(content)
  if (/<script[\s>]/.test(content) && !blocks.some(block => block.kind === 'script')) return null
  return blocks
}

/**
 * An SFC is one scope split across blocks: a template uses what the script
 * declared. Collecting per block would leave `t(`${base}.title`)` in the
 * template unresolvable, and it is the same file.
 */
function collectAcrossBlocks(parsed: ParsedBlockPair[]): CallSite[] {
  const i18nNames = new Set(parsed.flatMap(p => [...p.ast.i18nNames]))
  const constants: ConstantTable = new Map()
  for (const { ast } of parsed) {
    for (const [name, value] of ast.constants) addConstant(constants, name, value)
  }

  const sites: CallSite[] = []
  for (const { block, ast } of parsed) {
    const scoped = { ...ast, i18nNames, constants }
    const lineAt = lineResolver(ast.source, block.lineOffset)
    collect(scoped, sites, lineAt)
    if (block.directive) collectDirective(block.directive, scoped, sites, lineAt)
  }
  return sites
}

/**
 * `<i18n-t keypath="a.b">` and `v-t="'a.b'"` name a key without calling
 * anything, so the key is the block's own expression rather than an argument.
 * `v-t="{ path: 'a.b' }"` carries it in `path`; anything else the directive
 * accepts (`args`, `locale`) is not a key.
 */
function collectDirective(directive: TemplateDirective, parsed: ParsedBlock, sites: CallSite[], lineAt: (offset: number) => number): void {
  const [statement] = parsed.program.body ?? []
  if (statement?.type !== 'ExpressionStatement') return

  const node = directive === 'v-t' ? directivePath(unwrap(statement.expression)) : statement.expression
  if (!node) return

  for (const argument of readArguments(node, parsed)) {
    if (argument.kind === 'unknown') continue
    sites.push({ callee: directive, binding: 'resolved', argument, line: lineAt(node.start ?? 0) })
  }
}

function directivePath(node: Node | undefined): Node | undefined {
  if (node?.type !== 'ObjectExpression') return node
  for (const property of node.properties ?? []) {
    if (property.key?.name === 'path' || property.key?.value === 'path') return property.value
  }
  return undefined
}

/** Parentheses are nodes in this AST, and every reader below wants the expression. */
function unwrap(node: Node | undefined): Node | undefined {
  return node?.type === 'ParenthesizedExpression' ? unwrap(node.expression) : node
}

type ParseSync = typeof import('oxc-parser').parseSync

/**
 * Loaded on first use rather than at import, so a command that never scans does
 * not pay for a native binary it will not touch. Cached including the failure,
 * so a broken install is reported once and then falls back quietly.
 *
 * Not registered with the config cache: this is a module load, not anything
 * read out of the project, so clearing it could only reload the same binary.
 */
let parserPromise: Promise<ParseSync | null> | undefined

function loadParser(): Promise<ParseSync | null> {
  parserPromise ??= import('oxc-parser')
    .then(m => m.parseSync)
    .catch((error: unknown) => {
      log.warn(
        `oxc-parser could not be loaded (${error instanceof Error ? error.message : String(error)}) — `
        + 'falling back to pattern matching for JavaScript and TypeScript.',
      )
      return null
    })
  return parserPromise
}

/**
 * Parse one block. Returns null when the parser reports errors, which sends the
 * caller to the fallback rather than letting one unusual file break a scan.
 */
interface ParsedBlock {
  program: Node
  source: string
  i18nNames: Set<string>
  constants: ConstantTable
}

function parseBlock(parseSync: ParseSync, block: VueBlock, filePath: string): ParsedBlock | null {
  // .ts so TypeScript syntax parses; a plain .js file is a subset of it.
  const name = filePath.endsWith('.vue') ? 'block.ts' : filePath
  let firstError: string | undefined

  for (const source of block.sources) {
    const result = parseSync(name, source)
    if (result.errors.length > 0) {
      firstError ??= result.errors[0]?.message ?? 'parse error'
      continue
    }

    return {
      program: result.program as Node,
      source,
      i18nNames: collectI18nNames(result.program as Node),
      constants: collectStringConstants(result.program as Node),
    }
  }

  const where = `${filePath}:${block.lineOffset + 1}`
  log.debug(block.kind === 'script'
    ? `oxc declined ${filePath}: ${firstError ?? 'parse error'}`
    : `oxc skipped a template expression at ${where}: ${firstError ?? 'parse error'}`)
  return null
}

/**
 * The names bound to a translation function in this file — imports from an
 * i18n package, and destructures of the composables those packages expose.
 */
function collectI18nNames(program: Node): Set<string> {
  const names = new Set<string>()
  const factories = new Set<string>()

  walk(program, (node) => {
    if (node.type !== 'ImportDeclaration') return
    if (typeof node.source?.value !== 'string' || !I18N_MODULES.has(node.source.value)) return
    readImportSpecifiers(node, names, factories)
  })

  // `const { t } = useI18n()` — including a factory imported under another name.
  walk(program, (node) => {
    if (node.type !== 'VariableDeclarator') return
    if (!isI18nFactoryCall(node.init, factories)) return
    readBoundNames(node.id, names)
  })

  return names
}

function isI18nFactoryCall(init: Node | undefined, factories: Set<string>): boolean {
  if (init?.type !== 'CallExpression') return false
  const callee = calleeName(init.callee)
  return callee !== undefined && (factories.has(callee) || I18N_FACTORIES.has(callee))
}

/** The names a destructure or a plain assignment binds. */
function readBoundNames(id: Node | undefined, names: Set<string>): void {
  if (!id) return

  if (id.type === 'Identifier') {
    names.add(id.name)
    return
  }
  if (id.type !== 'ObjectPattern') return

  for (const prop of id.properties ?? []) {
    const local = propertyName(prop)
    if (local) names.add(local)
  }
}

/** `{ t }` binds `t`; `{ t: translate }` binds `translate`. */
function propertyName(prop: Node): string | undefined {
  return prop.value?.name ?? prop.key?.name
}

/**
 * String constants, so a key assembled from one resolves to the key it names.
 *
 *   const base = 'pages.settings'
 *   t(`${base}.title`)          →  pages.settings.title
 *
 * The regex path approximates this with a table of textual substitutions. Here
 * it is the binding itself, which is the difference between resolving a name
 * and hoping no other name looks like it.
 */
function collectStringConstants(program: Node): ConstantTable {
  const constants: ConstantTable = new Map()

  walk(program, (node) => {
    if (node.type !== 'VariableDeclarator') return
    if (node.id?.type !== 'Identifier') return
    if (node.init?.type !== 'Literal' || typeof node.init.value !== 'string') return
    addConstant(constants, node.id.name, node.init.value)
  })

  return constants
}

/**
 * `null` marks a name bound to more than one value. Collection is name-keyed
 * with no scope tracking, so two `const base = …` in different functions would
 * otherwise resolve last-write-wins — and a template resolved through the
 * wrong one reports a static key the code never produces. A conflicted name
 * resolves nothing, which leaves the template a dynamic key.
 */
type ConstantTable = Map<string, string | null>

function addConstant(table: ConstantTable, name: string, value: string | null): void {
  const existing = table.get(name)
  if (existing === undefined) table.set(name, value)
  else if (existing !== value) table.set(name, null)
}

function readImportSpecifiers(node: Node, names: Set<string>, factories: Set<string>): void {
  for (const spec of node.specifiers ?? []) {
    const local = spec.local?.name
    if (!local) continue
    const imported = spec.imported?.name ?? local
    if (I18N_FACTORIES.has(imported)) factories.add(local)
    else names.add(local)
  }
}

/**
 * Offsets to line numbers. The parser reports positions as byte offsets, so
 * the line index is built once per block rather than counted per call site.
 */
function lineResolver(source: string, lineOffset: number): (offset: number) => number {
  const starts: number[] = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1)
  }

  return (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if ((starts[mid] ?? 0) <= offset) low = mid
      else high = mid - 1
    }
    return low + 1 + lineOffset
  }
}

function collect(parsed: ParsedBlock, sites: CallSite[], lineAt: (offset: number) => number): void {
  walk(parsed.program, (node) => {
    if (node.type !== 'CallExpression') return
    sites.push(...toCallSites(node, parsed, lineAt))
  })
}

/**
 * One call yields one site per key it can ask for — several when the key is
 * chosen inside the call, none when the callee is not a translation function.
 */
function toCallSites(node: Node, parsed: ParsedBlock, lineAt: (offset: number) => number): CallSite[] {
  const callee = resolveCallee(node.callee, parsed.i18nNames)
  if (!callee) return []
  if (!callee.resolved && !MAYBE_I18N.has(callee.name)) return []

  const [first] = node.arguments ?? []
  if (!first) return []

  const line = lineAt(node.start ?? 0)
  const seen = new Set<string>()
  const sites: CallSite[] = []
  for (const argument of readArguments(first, parsed)) {
    const id = argumentId(argument)
    if (seen.has(id)) continue
    seen.add(id)
    sites.push({ callee: callee.name, binding: callee.resolved ? 'resolved' : 'ambiguous', argument, line })
  }
  return sites
}

function argumentId(argument: CallArgument): string {
  switch (argument.kind) {
    case 'static': return `static:${argument.value}`
    case 'template': return `template:${argument.expression}`
    case 'concat': return `concat:${argument.prefix}`
    case 'unknown': return 'unknown'
  }
}

/**
 * Name a callee and decide whether its binding proves it is i18n.
 *
 * An identifier resolves through what this file bound — an i18n import or a
 * destructure of `useI18n()`. A member call resolves only through its own
 * shape: `$t` is unambiguous on any receiver, and `t` proves i18n only when
 * the receiver itself is an i18n binding (`const i18n = useI18n(); i18n.t(…)`).
 * A local `t` from `useI18n()` says nothing about `client.t(…)` — matching a
 * member by its property name against local bindings would resolve exactly the
 * calls this frontend exists to tell apart.
 */
function resolveCallee(node: Node | undefined, i18nNames: Set<string>): ResolvedCallee | undefined {
  if (!node) return undefined
  if (node.type === 'Identifier') {
    return { name: node.name, resolved: i18nNames.has(node.name) || ALWAYS_I18N.has(node.name) }
  }
  if (node.type === 'MemberExpression') return resolveMemberCallee(node, i18nNames)
  return undefined
}

interface ResolvedCallee { name: string, resolved: boolean }

function resolveMemberCallee(node: Node, i18nNames: Set<string>): ResolvedCallee | undefined {
  if (node.property?.type !== 'Identifier') return undefined
  const name = node.property.name
  const receiverIsI18n = node.object?.type === 'Identifier' && i18nNames.has(node.object.name)
  return { name, resolved: ALWAYS_I18N.has(name) || (receiverIsI18n && MAYBE_I18N.has(name)) }
}

/**
 * Every key one argument position can produce.
 *
 * A key chosen inside the call — `t(plural ? 'a.many' : 'a.one')`, `t(x ?? 'a.fallback')`
 * — is a use of each literal it can reach, so each becomes its own site; an arm
 * that is not a literal contributes nothing rather than making the whole call
 * unreadable.
 */
function readArguments(node: Node | undefined, parsed: ParsedBlock): CallArgument[] {
  if (!node) return []

  if (node.type === 'ParenthesizedExpression') return readArguments(node.expression, parsed)

  if (node.type === 'ConditionalExpression') {
    return [...readArguments(node.consequent, parsed), ...readArguments(node.alternate, parsed)]
  }

  // `&&` is left out: its literal side is what the call produces only when the
  // other side is falsy, which is the case the code writes to avoid a lookup.
  if (node.type === 'LogicalExpression' && (node.operator === '??' || node.operator === '||')) {
    return [...readArguments(node.left, parsed), ...readArguments(node.right, parsed)]
  }

  if (node.type === 'SequenceExpression') {
    return (node.expressions ?? []).flatMap((child: Node) => readArguments(child, parsed))
  }

  return [readArgument(node, parsed)]
}

function readArgument(node: Node, parsed: ParsedBlock): CallArgument {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return { kind: 'static', value: node.value }
  }

  if (node.type === 'TemplateLiteral') {
    return readTemplateArgument(node, parsed)
  }

  // `'common.' + name` — the literal side bounds what the call can produce.
  if (node.type === 'BinaryExpression' && node.operator === '+' && typeof node.left?.value === 'string') {
    return { kind: 'concat', prefix: node.left.value }
  }

  return { kind: 'unknown' }
}

function readTemplateArgument(node: Node, parsed: ParsedBlock): CallArgument {
  // No expressions is a plain string written with backticks.
  if ((node.expressions ?? []).length === 0) {
    const only = node.quasis?.[0]?.value?.cooked
    return typeof only === 'string' ? { kind: 'static', value: only } : { kind: 'unknown' }
  }

  // Every slot filled by a known constant makes the whole thing a literal.
  const resolved = resolveTemplate(node, parsed.constants)
  if (resolved !== undefined) return { kind: 'static', value: resolved }

  // As written in the file, backticks excluded — reports stay byte-identical
  // with the pattern scanner's for unchanged code.
  const expression = typeof node.start === 'number' && typeof node.end === 'number'
    ? parsed.source.slice(node.start + 1, node.end - 1)
    : (node.quasis ?? []).map((q: Node) => q.value?.cooked ?? '').join('${_}')
  return { kind: 'template', expression }
}

/**
 * The literal a template resolves to, or undefined when any slot is something
 * other than a constant this file declares.
 */
function resolveTemplate(node: Node, constants: ConstantTable): string | undefined {
  const parts: string[] = []
  const quasis = node.quasis ?? []
  const expressions = node.expressions ?? []

  for (const [i, quasi] of quasis.entries()) {
    parts.push(quasi.value?.cooked ?? '')
    const expression = expressions[i]
    if (!expression) continue

    if (expression.type !== 'Identifier') return undefined
    const value = constants.get(expression.name)
    if (typeof value !== 'string') return undefined
    parts.push(value)
  }

  return parts.join('')
}

function calleeName(node: Node | undefined): string | undefined {
  if (!node) return undefined
  if (node.type === 'Identifier') return node.name
  // this.$t / i18n.t / vm.$t — the property is what names the function.
  if (node.type === 'MemberExpression' && node.property?.type === 'Identifier') return node.property.name
  return undefined
}

function walk(node: Node | undefined, visit: (node: Node) => void): void {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)

  for (const [key, child] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue
    walkChild(child, visit)
  }
}

/** Positional metadata, not syntax — walking it wastes time and finds nothing. */
const SKIP_KEYS = new Set(['loc', 'range', 'parent'])

function walkChild(child: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(child)) {
    for (const item of child) walkChild(item, visit)
    return
  }
  if (child && typeof child === 'object') walk(child as Node, visit)
}


/**
 * Split an SFC into parseable blocks. A template block's expressions are not
 * JavaScript, so its interpolations are lifted out and parsed as expressions —
 * the same trick the PHP frontend uses for Blade directives.
 */
function vueBlocks(content: string): VueBlock[] {
  return [...scriptBlocks(content), ...templateExpressionBlocks(content)]
}

/**
 * One parseable region of an SFC.
 *
 * `sources` are spellings of the same region, tried in order until one parses:
 * a Vue attribute is not required to be a single JavaScript expression, and
 * which wrapping it needs cannot be told from the text alone. Every spelling
 * keeps the region's newlines where they were, so the lines it reports stay
 * the file's own.
 */
interface VueBlock {
  kind: BlockKind
  sources: string[]
  lineOffset: number
  /** Set when the region is an attribute that names a key instead of calling for one. */
  directive?: TemplateDirective
}

/** A script block declines the file; a template block declines only itself. */
type BlockKind = 'script' | 'template'

/** Attribute spellings of a lookup, named as written so a report can point at one. */
type TemplateDirective = 'keypath' | 'v-t'

const lineOffsetAt = (content: string, offset: number): number =>
  content.slice(0, offset).split('\n').length - 1

/**
 * An opening tag's attributes. Not `[^>]*`: `<script setup generic="T extends
 * Record<string, any>">` carries a `>` inside a quoted value, and stopping the
 * tag there makes the block body start mid-attribute — unparseable, which
 * declined the file.
 */
const OPEN_TAG_ATTRS = '(?:"[^"]*"|\'[^\']*\'|[^>])*'

const SCRIPT_BLOCK = new RegExp(`<script(?=[\\s>])(${OPEN_TAG_ATTRS})>([\\s\\S]*?)</script\\s*>`, 'g')

function scriptBlocks(content: string): VueBlock[] {
  const blocks: VueBlock[] = []
  for (const match of content.matchAll(SCRIPT_BLOCK)) {
    // Offset to the block body, not the tag: an opening tag written across
    // several lines (`<script\n  setup\n  lang="ts">`) otherwise shifts every
    // line the block reports.
    const openTagLength = '<script'.length + (match[1] ?? '').length + '>'.length
    blocks.push({ kind: 'script', sources: [match[2] ?? ''], lineOffset: lineOffsetAt(content, (match.index ?? 0) + openTagLength) })
  }
  return blocks
}

/**
 * Template regions that carry a key: every interpolation and directive
 * expression, plus the static `keypath="a.b"` of `<i18n-t>` — an attribute
 * value rather than an expression, so it is quoted into one.
 *
 * The static form is matched on any element: the component can be registered
 * under another name, and `keypath` is vue-i18n's attribute wherever it is
 * written. Group 1 is an interpolation, 2/3-4 a directive and its expression,
 * 5-6 a static keypath.
 */
const TEMPLATE_EXPRESSION
  = /\{\{([\s\S]*?)\}\}|(v-[a-z-]+|:[\w-]+|@[\w-]+)=(?:"([^"]*)"|'([^']*)')|(?<![\w:-])keypath=(?:"([^"]*)"|'([^']*)')/g

function templateExpressionBlocks(content: string): VueBlock[] {
  const template = maskSpans(content, NON_TEMPLATE)
  const blocks: VueBlock[] = []
  for (const match of template.matchAll(TEMPLATE_EXPRESSION)) {
    const lineOffset = lineOffsetAt(template, match.index ?? 0)
    const literal = match[5] ?? match[6]
    if (literal !== undefined) {
      if (!literal.trim()) continue
      blocks.push({ kind: 'template', sources: [`(${JSON.stringify(literal)})`], lineOffset, directive: 'keypath' })
      continue
    }

    const expression = match[1] ?? match[3] ?? match[4]
    if (!expression?.trim()) continue
    blocks.push({ kind: 'template', sources: expressionSources(expression), lineOffset, directive: directiveOf(match[2]) })
  }
  return blocks
}

function directiveOf(attribute: string | undefined): TemplateDirective | undefined {
  if (attribute === 'v-t') return 'v-t'
  if (attribute === ':keypath') return 'keypath'
  return undefined
}

/**
 * `(expr)` is what a Vue attribute usually is. `@click="a(); b()"` is a
 * statement list, which only parses as a block, and `v-for="(_, slot) of $slots"`
 * is a binding head no expression grammar accepts — the head names nothing a
 * lookup could use, so only the iterable after it is parsed. Blanked rather
 * than cut, so what follows keeps its offset and its line.
 */
function expressionSources(expression: string): string[] {
  const sources = [`(${expression})`, `{ ${expression} }`]
  const head = FOR_BINDING_HEAD.exec(expression)
  if (head) sources.push(`(${head[0].replace(/[^\n]/g, ' ')}${expression.slice(head[0].length)})`)
  return sources
}

const FOR_BINDING_HEAD = /^[\s\S]*?\s(?:of|in)\s/

/**
 * Regions of an SFC that are definitely not template markup: HTML comments,
 * the script and style blocks whole, and `<i18n>` custom blocks (messages,
 * read as definitions elsewhere).
 *
 * A commented-out `:title="$t('a.b')"` is not a usage — counted as one, it
 * keeps a dead key alive forever, and `check --write` writes keys back out of
 * code nobody runs. Script bodies are read by {@link scriptBlocks} from the
 * unmasked source, so masking them here only stops the same call being read
 * twice; masking the tags with them keeps a `<!--` inside a script string from
 * opening a comment that swallows real template.
 *
 * Not an attempt to locate the root template: a nested `<template #slot>` is
 * template like its parent, and only what cannot be is taken out.
 */
const NON_TEMPLATE = new RegExp(`<!--[\\s\\S]*?-->|<(script|style|i18n)(?=[\\s/>])${OPEN_TAG_ATTRS}>[\\s\\S]*?</\\1\\s*>`, 'gi')

/**
 * Blank out every matched span, newlines kept, so the text around it stays at
 * the offset and line it was read from — every reported line number depends on
 * that.
 */
function maskSpans(content: string, regex: RegExp): string {
  return content.replace(regex, span => span.replace(/[^\n]/g, ' '))
}
