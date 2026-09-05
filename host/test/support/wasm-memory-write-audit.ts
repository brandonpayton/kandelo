import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type MemoryOwner =
  "kernel" | "process-memory" | "framebuffer" | "shared-memory" | "rust-lent";

export type OwnershipForm =
  "memory" | "buffer" | "view" | "instance" | "scratch-region";

export interface OwnershipSeed {
  /**
   * Exact `repo/relative/file.ts::Qualified.declaration` key.
   *
   * Wildcards are intentionally unsupported: adding a new owner must produce
   * a visible, narrowly reviewed contract change.
   */
  declaration: string;
  target: "value" | "return";
  owner: MemoryOwner;
  form: OwnershipForm;
  why: string;
}

export interface AuditAllowance {
  /** Exact key returned in {@link AuditFinding.key}. */
  key: string;
  disposition:
    | "scratch-core"
    | "rust-lent"
    | "kernel-read"
    | "kernel-control"
    | "non-kernel";
  /**
   * Required only for a WebAssembly Memory/Instance authority origin.
   *
   * The exact site allowlist must say whose address space the newly created
   * authority controls. This prevents an unseeded kernel Memory from being
   * silently treated as ordinary process memory.
   */
  authorityOwner?: MemoryOwner;
  /** Exact number of structurally identical sites admitted by this entry. */
  count?: number;
  why: string;
}

export interface AuditFinding {
  key: string;
  file: string;
  enclosing: string;
  kind:
    | "kernel-view"
    | "kernel-write"
    | "kernel-view-escape"
    | "kernel-view-return"
    | "kernel-view-store"
    | "kernel-buffer-escape"
    | "kernel-buffer-return"
    | "kernel-buffer-store"
    | "kernel-memory-escape"
    | "kernel-memory-return"
    | "kernel-memory-store"
    | "kernel-pointer-export-bypass"
    | "kernel-export-direct-use"
    | "scratch-address-contract"
    | "scratch-allocator-call"
    | "scratch-region-factory-call"
    | "scratch-reservation-call"
    | "kernel-destination-factory-call"
    | "kernel-destination-factory-unsafe"
    | "wasm-memory-authority"
    | "wasm-instance-authority"
    | "wasm-authority-escape"
    | "dynamic-code-contract";
  line: number;
  text: string;
}

export interface AuditResult {
  findings: AuditFinding[];
  violations: AuditFinding[];
  unusedAllowances: AuditAllowance[];
  unresolvedSeeds: OwnershipSeed[];
  contractErrors: string[];
  sourceFiles: string[];
  propagationPasses: number;
}

export interface AuditOptions {
  rootDir: string;
  sourceFiles: string[];
  ownershipSeeds: readonly OwnershipSeed[];
  allowances?: readonly AuditAllowance[];
  /**
   * Complete generated kernel export-name set from the ABI snapshot.
   *
   * When supplied, every named kernel export defaults to the raw-call finding,
   * not only exports already present in the runtime scratch whitelist. This
   * closes the classification hole where a newly used pointer-bearing export
   * could be omitted from that hand-reviewed whitelist.
   */
  kernelExportNames?: readonly string[];
  /**
   * Exact declarations of authenticated Rust-lent destination factories.
   *
   * Every call becomes its own finding. The production contract therefore
   * reviews where each pointer and explicit capacity enters instead of allowing
   * a raw sink body once for all future callers.
   */
  kernelDestinationFactoryDeclarations?: readonly string[];
  /**
   * Require an exact owner-classified allowance for every intrinsic
   * WebAssembly Memory or Instance creation site.
   */
  auditWasmAuthorityOrigins?: boolean;
  compilerOptions?: ts.CompilerOptions;
  virtualSources?: ReadonlyMap<string, string>;
}

type StateKey = ts.Symbol | ts.FunctionLikeDeclaration;

interface ValueState {
  memory: number;
  buffer: number;
  view: number;
  instance: number;
  exportNamespace: number;
  kernelExportFunctions: Set<string>;
  allocator: boolean;
  reserver: boolean;
  scratchRegionFactory: boolean;
  scratchRegion: boolean;
  viewConstructors: number;
  properties: Map<string, ValueState>;
  hiddenProperties: Map<string, ValueState>;
  elements: ValueState | null;
  unknownDescendant: boolean;
}

type StateProjection = { kind: "property"; name: string } | { kind: "element" };

interface Constraint {
  target: StateKey;
  expression: ts.Expression;
  projection?: readonly StateProjection[];
  targetProjection?: readonly StateProjection[];
}

interface DeclarationTarget {
  value?: ts.Symbol;
  returns?: ts.FunctionLikeDeclaration;
}

const EMPTY_STATE: ValueState = Object.freeze({
  memory: 0,
  buffer: 0,
  view: 0,
  instance: 0,
  exportNamespace: 0,
  kernelExportFunctions: new Set<string>(),
  allocator: false,
  reserver: false,
  scratchRegionFactory: false,
  scratchRegion: false,
  viewConstructors: 0,
  properties: new Map(),
  hiddenProperties: new Map(),
  elements: null,
  unknownDescendant: false,
});

const OWNER_BITS: Record<MemoryOwner, number> = {
  kernel: 1 << 0,
  "process-memory": 1 << 1,
  framebuffer: 1 << 2,
  "shared-memory": 1 << 3,
  "rust-lent": 1 << 4,
};

const KERNEL_OWNER = OWNER_BITS.kernel;
const TYPED_ARRAY_CONSTRUCTOR = 1 << 0;
const DATA_VIEW_CONSTRUCTOR = 1 << 1;
const WASM_MEMORY_CONSTRUCTOR = 1 << 0;
const WASM_INSTANCE_CONSTRUCTOR = 1 << 1;
const WASM_INSTANTIATE_FUNCTION = 1 << 2;
const WASM_AUTHORITY_NAMESPACE = 1 << 3;
const WASM_GLOBAL_OBJECT = 1 << 4;
const TYPE_PROPERTIES = new WeakMap<ts.Type, readonly ts.Symbol[]>();
const INTRINSIC_ARRAY_METHODS = new WeakMap<ts.CallExpression, string | null>();
const ARRAY_ELEMENT_RETURNING_METHODS = new Set([
  "at",
  "find",
  "findLast",
  "pop",
  "shift",
]);
const ARRAY_ELEMENT_CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
]);

const TYPED_ARRAY_CONSTRUCTORS = new Set([
  "BigInt64Array",
  "BigUint64Array",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
]);

const TYPED_ARRAY_MUTATORS = new Set([
  "copyWithin",
  "fill",
  "reverse",
  "set",
  "sort",
]);

// Positive list only: these intrinsic methods neither mutate a typed array nor
// pass/retain its live receiver. Callback and iterator methods are deliberately
// absent because they can expose the receiver after a superficially read-only
// call.
const TYPED_ARRAY_NON_RETAINING_METHODS = new Set([
  "at",
  "includes",
  "indexOf",
  "join",
  "lastIndexOf",
  "slice",
  "subarray",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toString",
  "with",
]);

const TYPED_ARRAY_RETAINING_ITERATOR_METHODS = new Set([
  "entries",
  "keys",
  "values",
]);

const CONTAINER_CALLBACK_PARAMETER_INDEX = new Map<string, number>([
  ["every", 2],
  ["filter", 2],
  ["find", 2],
  ["findIndex", 2],
  ["findLast", 2],
  ["findLastIndex", 2],
  ["forEach", 2],
  ["map", 2],
  ["reduce", 3],
  ["reduceRight", 3],
  ["some", 2],
]);

const ATOMIC_MUTATORS = new Set([
  "add",
  "and",
  "compareExchange",
  "exchange",
  "or",
  "store",
  "sub",
  "xor",
]);

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "test-results",
]);

const UNKNOWN_KERNEL_EXPORT = "<computed-kernel-export>";
const MAX_STRUCTURED_STATE_DEPTH = 16;

function frozenStringArray(
  expression: ts.Expression,
): readonly string[] | null {
  let value = unwrapExpression(expression);
  if (ts.isCallExpression(value) && value.arguments.length === 1) {
    const callee = unwrapExpression(value.expression);
    const capturedFreeze =
      ts.isIdentifier(callee) && callee.text === "intrinsicObjectFreeze";
    const freezeReceiver = ts.isPropertyAccessExpression(callee)
      ? unwrapExpression(callee.expression)
      : null;
    const directFreeze =
      ts.isPropertyAccessExpression(callee) &&
      freezeReceiver !== null &&
      ts.isIdentifier(freezeReceiver) &&
      freezeReceiver.text === "Object" &&
      callee.name.text === "freeze";
    if (!capturedFreeze && !directFreeze) return null;
    value = unwrapExpression(value.arguments[0]);
  }
  if (!ts.isArrayLiteralExpression(value)) return null;
  const result: string[] = [];
  for (const element of value.elements) {
    if (!ts.isStringLiteralLike(element)) return null;
    result.push(element.text);
  }
  return result;
}

function kernelScratchPointerExportContract(
  sourceFiles: readonly ts.SourceFile[],
): {
  readonly names: ReadonlySet<string>;
  readonly errors: readonly string[];
} {
  const contractFiles = sourceFiles.filter((sourceFile) =>
    toPosix(sourceFile.fileName).endsWith("/host/src/kernel-scratch.ts"),
  );
  if (contractFiles.length === 0) {
    return { names: new Set(), errors: [] };
  }

  const declarations: ts.VariableDeclaration[] = [];
  for (const sourceFile of contractFiles) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "KERNEL_SCRATCH_EXPORT_NAMES"
      ) {
        declarations.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  if (declarations.length !== 1 || !declarations[0].initializer) {
    return {
      names: new Set(),
      errors: [
        "could not resolve the single authoritative " +
          "KERNEL_SCRATCH_EXPORT_NAMES declaration",
      ],
    };
  }
  const values = frozenStringArray(declarations[0].initializer);
  if (
    !values ||
    values.length === 0 ||
    new Set(values).size !== values.length
  ) {
    return {
      names: new Set(),
      errors: [
        "KERNEL_SCRATCH_EXPORT_NAMES must remain a non-empty frozen " +
          "string-literal array",
      ],
    };
  }
  return { names: new Set(values), errors: [] };
}

function emptyState(): ValueState {
  return {
    memory: 0,
    buffer: 0,
    view: 0,
    instance: 0,
    exportNamespace: 0,
    kernelExportFunctions: new Set<string>(),
    allocator: false,
    reserver: false,
    scratchRegionFactory: false,
    scratchRegion: false,
    viewConstructors: 0,
    properties: new Map(),
    hiddenProperties: new Map(),
    elements: null,
    unknownDescendant: false,
  };
}

function ownerState(owner: MemoryOwner, form: OwnershipForm): ValueState {
  const state = emptyState();
  if (form === "scratch-region") {
    state.scratchRegion = true;
  } else {
    state[form] = OWNER_BITS[owner];
  }
  return state;
}

function mergeDirectState(into: ValueState, other: ValueState): boolean {
  const beforeMemory = into.memory;
  const beforeBuffer = into.buffer;
  const beforeView = into.view;
  const beforeInstance = into.instance;
  const beforeExportNamespace = into.exportNamespace;
  const beforeKernelExportFunctionCount = into.kernelExportFunctions.size;
  const beforeAllocator = into.allocator;
  const beforeReserver = into.reserver;
  const beforeScratchRegionFactory = into.scratchRegionFactory;
  const beforeScratchRegion = into.scratchRegion;
  const beforeViewConstructors = into.viewConstructors;
  const beforeUnknownDescendant = into.unknownDescendant;
  into.memory |= other.memory;
  into.buffer |= other.buffer;
  into.view |= other.view;
  into.instance |= other.instance;
  into.exportNamespace |= other.exportNamespace;
  for (const name of other.kernelExportFunctions) {
    into.kernelExportFunctions.add(name);
  }
  into.allocator ||= other.allocator;
  into.reserver ||= other.reserver;
  into.scratchRegionFactory ||= other.scratchRegionFactory;
  into.scratchRegion ||= other.scratchRegion;
  into.viewConstructors |= other.viewConstructors;
  into.unknownDescendant ||= other.unknownDescendant;
  return (
    beforeMemory !== into.memory ||
    beforeBuffer !== into.buffer ||
    beforeView !== into.view ||
    beforeInstance !== into.instance ||
    beforeExportNamespace !== into.exportNamespace ||
    beforeKernelExportFunctionCount !== into.kernelExportFunctions.size ||
    beforeAllocator !== into.allocator ||
    beforeReserver !== into.reserver ||
    beforeScratchRegionFactory !== into.scratchRegionFactory ||
    beforeScratchRegion !== into.scratchRegion ||
    beforeViewConstructors !== into.viewConstructors ||
    beforeUnknownDescendant !== into.unknownDescendant
  );
}

function hasDirectCapability(state: ValueState): boolean {
  return (
    state.memory !== 0 ||
    state.buffer !== 0 ||
    state.view !== 0 ||
    state.instance !== 0 ||
    state.exportNamespace !== 0 ||
    state.kernelExportFunctions.size !== 0 ||
    state.allocator ||
    state.reserver ||
    state.scratchRegionFactory ||
    state.scratchRegion ||
    state.viewConstructors !== 0
  );
}

function mergeDescendantCapabilities(
  into: ValueState,
  descendant: ValueState,
  seen = new Set<ValueState>(),
): boolean {
  if (seen.has(descendant)) return false;
  seen.add(descendant);
  let changed = mergeDirectState(into, descendant);
  let found = hasDirectCapability(descendant) || descendant.unknownDescendant;
  for (const property of descendant.properties.values()) {
    found ||= hasCapability(property);
    changed = mergeDescendantCapabilities(into, property, seen) || changed;
  }
  for (const property of descendant.hiddenProperties.values()) {
    found ||= hasCapability(property);
    changed = mergeDescendantCapabilities(into, property, seen) || changed;
  }
  if (descendant.elements) {
    found ||= hasCapability(descendant.elements);
    changed =
      mergeDescendantCapabilities(into, descendant.elements, seen) || changed;
  }
  if (found && !into.unknownDescendant) {
    into.unknownDescendant = true;
    changed = true;
  }
  return changed;
}

function cloneState(state: ValueState, depth = 0): ValueState {
  const result: ValueState = {
    memory: state.memory,
    buffer: state.buffer,
    view: state.view,
    instance: state.instance,
    exportNamespace: state.exportNamespace,
    kernelExportFunctions: new Set(state.kernelExportFunctions),
    allocator: state.allocator,
    reserver: state.reserver,
    scratchRegionFactory: state.scratchRegionFactory,
    scratchRegion: state.scratchRegion,
    viewConstructors: state.viewConstructors,
    properties: new Map(),
    hiddenProperties: new Map(),
    elements: null,
    unknownDescendant: state.unknownDescendant,
  };
  if (depth >= MAX_STRUCTURED_STATE_DEPTH) {
    for (const property of state.properties.values()) {
      mergeDescendantCapabilities(result, property);
    }
    for (const property of state.hiddenProperties.values()) {
      mergeDescendantCapabilities(result, property);
    }
    if (state.elements) mergeDescendantCapabilities(result, state.elements);
    return result;
  }
  result.elements = state.elements ? cloneState(state.elements, depth + 1) : null;
  for (const [name, property] of state.properties) {
    result.properties.set(name, cloneState(property, depth + 1));
  }
  for (const [name, property] of state.hiddenProperties) {
    result.hiddenProperties.set(name, cloneState(property, depth + 1));
  }
  return result;
}

function unionState(
  into: ValueState,
  other: ValueState,
  depth = 0,
): boolean {
  let changed = mergeDirectState(into, other);
  if (depth >= MAX_STRUCTURED_STATE_DEPTH) {
    for (const property of into.properties.values()) {
      changed = mergeDescendantCapabilities(into, property) || changed;
    }
    for (const property of into.hiddenProperties.values()) {
      changed = mergeDescendantCapabilities(into, property) || changed;
    }
    if (into.elements) {
      changed = mergeDescendantCapabilities(into, into.elements) || changed;
    }
    into.properties.clear();
    into.hiddenProperties.clear();
    into.elements = null;
    for (const property of other.properties.values()) {
      changed = mergeDescendantCapabilities(into, property) || changed;
    }
    for (const property of other.hiddenProperties.values()) {
      changed = mergeDescendantCapabilities(into, property) || changed;
    }
    if (other.elements) {
      changed = mergeDescendantCapabilities(into, other.elements) || changed;
    }
    return changed;
  }
  for (const [name, property] of other.properties) {
    const existing = into.properties.get(name);
    if (existing) {
      changed = unionState(existing, property, depth + 1) || changed;
    } else {
      into.properties.set(name, cloneState(property, depth + 1));
      changed = true;
    }
  }
  for (const [name, property] of other.hiddenProperties) {
    const existing = into.hiddenProperties.get(name);
    if (existing) {
      changed = unionState(existing, property, depth + 1) || changed;
    } else {
      into.hiddenProperties.set(name, cloneState(property, depth + 1));
      changed = true;
    }
  }
  if (other.elements) {
    if (into.elements) {
      changed = unionState(into.elements, other.elements, depth + 1) || changed;
    } else {
      into.elements = cloneState(other.elements, depth + 1);
      changed = true;
    }
  }
  return changed;
}

function unionMany(states: Iterable<ValueState>): ValueState {
  const result = emptyState();
  for (const state of states) unionState(result, state);
  return result;
}

function hasCapability(
  state: ValueState,
  seen = new Set<ValueState>(),
): boolean {
  if (seen.has(state)) return false;
  seen.add(state);
  if (hasDirectCapability(state)) return true;
  for (const property of state.properties.values()) {
    if (hasCapability(property, seen)) return true;
  }
  for (const property of state.hiddenProperties.values()) {
    if (hasCapability(property, seen)) return true;
  }
  return state.elements ? hasCapability(state.elements, seen) : false;
}

function propertyState(state: ValueState, name: string): ValueState {
  const result = cloneState(state.properties.get(name) ?? EMPTY_STATE);
  unionState(result, state.hiddenProperties.get(name) ?? EMPTY_STATE);
  if (state.unknownDescendant) {
    const unknown = emptyState();
    mergeDirectState(unknown, state);
    unknown.unknownDescendant = true;
    unionState(result, unknown);
  }
  if (name === "buffer") {
    result.buffer |= state.memory | state.view;
  } else if (name === "exports") {
    result.exportNamespace |= state.instance;
  } else if (name === "memory") {
    result.memory |= state.exportNamespace;
  }
  if (
    (state.exportNamespace & KERNEL_OWNER) !== 0 &&
    name.startsWith("kernel_")
  ) {
    result.kernelExportFunctions.add(name);
  }
  if (name === "call" || name === "apply" || name === "bind") {
    for (const exportName of state.kernelExportFunctions) {
      result.kernelExportFunctions.add(exportName);
    }
  }
  return result;
}

function elementState(state: ValueState): ValueState {
  const result = cloneState(state.elements ?? EMPTY_STATE);
  if (state.unknownDescendant) {
    const unknown = emptyState();
    mergeDirectState(unknown, state);
    unknown.unknownDescendant = true;
    unionState(result, unknown);
  }
  if ((state.exportNamespace & KERNEL_OWNER) !== 0) {
    result.kernelExportFunctions.add(UNKNOWN_KERNEL_EXPORT);
  }
  for (const property of state.properties.values()) {
    unionState(result, property);
  }
  for (const property of state.hiddenProperties.values()) {
    unionState(result, property);
  }
  return result;
}

function projectState(
  state: ValueState,
  projections: readonly StateProjection[] | undefined,
): ValueState {
  let result = cloneState(state);
  for (const projection of projections ?? []) {
    result =
      projection.kind === "property"
        ? propertyState(result, projection.name)
        : elementState(result);
  }
  return result;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name: ts.DeclarationName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function accessedPropertyName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  const argument = expression.argumentExpression;
  return argument &&
    (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
    ? argument.text
    : null;
}

function normalizeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ").trim();
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function relativeFile(rootDir: string, sourceFile: ts.SourceFile): string {
  return toPosix(path.relative(rootDir, sourceFile.fileName));
}

function namedDeclarationPart(node: ts.Node): string | null {
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name?.getText() ?? null;
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return propertyNameText(node.name) ?? null;
  }
  return null;
}

function enclosingDeclarationParts(node: ts.Node): string[] {
  const parts: string[] = [];
  for (
    let current: ts.Node | undefined = node.parent;
    current;
    current = current.parent
  ) {
    const part = namedDeclarationPart(current);
    if (part) parts.push(part);
  }
  return parts.reverse();
}

function declarationName(node: ts.Declaration): string | null {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node)
  ) {
    return propertyNameText(node.name);
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return propertyNameText(node.name);
  }
  return null;
}

function declarationKey(
  rootDir: string,
  sourceFile: ts.SourceFile,
  declaration: ts.Declaration,
): string | null {
  const name = declarationName(declaration);
  if (!name) return null;
  const parts = enclosingDeclarationParts(declaration);
  if (ts.isParameter(declaration)) {
    parts.push(`$param:${name}`);
  } else if (parts.at(-1) !== name) {
    parts.push(name);
  }
  return `${relativeFile(rootDir, sourceFile)}::${parts.join(".")}`;
}

function callableName(node: ts.Node): string {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    if (ts.isConstructorDeclaration(current)) {
      const container = enclosingDeclarationParts(current).join(".");
      return container ? `${container}.constructor` : "constructor";
    }
    if (
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      const method = propertyNameText(current.name) ?? "<computed>";
      const container = enclosingDeclarationParts(current).join(".");
      return container ? `${container}.${method}` : method;
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      const container = enclosingDeclarationParts(current).join(".");
      return container
        ? `${container}.${current.name.text}`
        : current.name.text;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      const container = enclosingDeclarationParts(current.parent).join(".");
      return container
        ? `${container}.${current.parent.name.text}`
        : current.parent.name.text;
    }
  }
  return "<module>";
}

function sourceScriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (
    fileName.endsWith(".js") ||
    fileName.endsWith(".mjs") ||
    fileName.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createProgram(options: AuditOptions): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    ...options.compilerOptions,
  };
  if (!options.virtualSources) {
    return ts.createProgram({
      rootNames: options.sourceFiles,
      options: compilerOptions,
    });
  }

  const normalizedVirtualSources = new Map<string, string>();
  for (const [fileName, source] of options.virtualSources) {
    normalizedVirtualSources.set(path.resolve(fileName), source);
  }
  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    directoryExists(directoryName) {
      const resolved = path.resolve(directoryName);
      for (const fileName of normalizedVirtualSources.keys()) {
        if (fileName.startsWith(`${resolved}${path.sep}`)) return true;
      }
      return baseHost.directoryExists?.(directoryName) ?? false;
    },
    fileExists(fileName) {
      return (
        normalizedVirtualSources.has(path.resolve(fileName)) ||
        baseHost.fileExists(fileName)
      );
    },
    readFile(fileName) {
      return (
        normalizedVirtualSources.get(path.resolve(fileName)) ??
        baseHost.readFile(fileName)
      );
    },
    getSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) {
      const source = normalizedVirtualSources.get(path.resolve(fileName));
      if (source !== undefined) {
        return ts.createSourceFile(
          fileName,
          source,
          languageVersion,
          true,
          sourceScriptKind(fileName),
        );
      }
      return baseHost.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
  };
  return ts.createProgram({
    rootNames: options.sourceFiles,
    options: compilerOptions,
    host,
  });
}

function isParameterProperty(
  declaration: ts.Declaration,
): declaration is ts.ParameterDeclaration {
  return (
    ts.isParameter(declaration) &&
    ts.isIdentifier(declaration.name) &&
    ts.isConstructorDeclaration(declaration.parent) &&
    Boolean(
      declaration.modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PublicKeyword ||
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
      ),
    )
  );
}

function canonicalSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }
  const parameterProperty = symbol.declarations?.find(isParameterProperty);
  if (parameterProperty) {
    // TypeScript can materialize distinct symbols for the declaration name,
    // the bare constructor parameter, and `this.property`. They are one
    // runtime slot, so normalize all three to the declaration-name symbol.
    return checker.getSymbolAtLocation(parameterProperty.name) ?? symbol;
  }
  return symbol;
}

function symbolAtExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Symbol | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return canonicalSymbol(checker, checker.getSymbolAtLocation(unwrapped));
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const direct = canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(unwrapped.name),
    );
    if (direct) return direct;
    const receiverType = checker.getTypeAtLocation(
      unwrapExpression(unwrapped.expression),
    );
    return canonicalSymbol(
      checker,
      checker.getPropertyOfType(receiverType, unwrapped.name.text),
    );
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const name = accessedPropertyName(unwrapped);
    if (!name) return undefined;
    const type = checker.getTypeAtLocation(
      unwrapExpression(unwrapped.expression),
    );
    return canonicalSymbol(checker, checker.getPropertyOfType(type, name));
  }
  return undefined;
}

function isScratchRegionFactorySymbol(symbol: ts.Symbol | undefined): boolean {
  return Boolean(
    symbol?.declarations?.some((declaration) => {
      const name = declarationName(declaration);
      if (
        name !== "allocateKernelScratchRegion" &&
        name !== "reserveKernelScratchRegion"
      ) {
        return false;
      }
      const file = toPosix(declaration.getSourceFile().fileName);
      return file.endsWith("/host/src/kernel-scratch.ts");
    }),
  );
}

function isScratchRegionOwnershipValidatorSymbol(
  symbol: ts.Symbol | undefined,
): boolean {
  return Boolean(
    symbol?.declarations?.some((declaration) => {
      if (
        declarationName(declaration) !== "validateKernelScratchRegionOwnership"
      ) {
        return false;
      }
      const file = toPosix(declaration.getSourceFile().fileName);
      return file.endsWith("/host/src/kernel-scratch.ts");
    }),
  );
}

const SCRATCH_ADDRESS_OWNERS = new Set([
  "ActiveKernelScratchLease",
  "KernelScratchLease",
]);
const SCRATCH_REGION_OWNERS = new Set([
  "KernelScratchRegion",
  "OwnedKernelScratchRegion",
]);

function isKernelScratchMemberDeclaration(
  declaration: ts.Declaration,
  member: string,
  owners: ReadonlySet<string>,
): boolean {
  const name = (declaration as ts.NamedDeclaration).name;
  if (!name || propertyNameText(name) !== member) return false;
  const file = toPosix(declaration.getSourceFile().fileName);
  return (
    file.endsWith("/host/src/kernel-scratch.ts") &&
    owners.has(signatureOwnerName(declaration as ts.SignatureDeclaration) ?? "")
  );
}

function isScratchAddressSymbol(symbol: ts.Symbol | undefined): boolean {
  return Boolean(
    symbol?.declarations?.some((declaration) =>
      isKernelScratchMemberDeclaration(
        declaration,
        "address",
        SCRATCH_ADDRESS_OWNERS,
      ),
    ),
  );
}

function isScratchLeaseMemberSymbol(symbol: ts.Symbol | undefined): boolean {
  return Boolean(
    symbol?.declarations?.some((declaration) => {
      const file = toPosix(declaration.getSourceFile().fileName);
      return (
        file.endsWith("/host/src/kernel-scratch.ts") &&
        SCRATCH_ADDRESS_OWNERS.has(
          signatureOwnerName(declaration as ts.SignatureDeclaration) ?? "",
        )
      );
    }),
  );
}

function isScratchWithLeaseSymbol(symbol: ts.Symbol | undefined): boolean {
  return Boolean(
    symbol?.declarations?.some((declaration) =>
      isKernelScratchMemberDeclaration(
        declaration,
        "withLease",
        SCRATCH_REGION_OWNERS,
      ),
    ),
  );
}

function isScratchRegionMemberSymbol(symbol: ts.Symbol | undefined): boolean {
  return Boolean(
    symbol?.declarations?.some((declaration) => {
      const file = toPosix(declaration.getSourceFile().fileName);
      return (
        file.endsWith("/host/src/kernel-scratch.ts") &&
        SCRATCH_REGION_OWNERS.has(
          signatureOwnerName(declaration as ts.SignatureDeclaration) ?? "",
        )
      );
    }),
  );
}

function isKernelScratchWithLeaseCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  if (callPropertyName(call) !== "withLease") return false;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  return Boolean(
    declaration &&
    isKernelScratchMemberDeclaration(
      declaration,
      "withLease",
      SCRATCH_REGION_OWNERS,
    ),
  );
}

function symbolForDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): ts.Symbol | undefined {
  const name = (declaration as ts.NamedDeclaration).name;
  return name
    ? canonicalSymbol(checker, checker.getSymbolAtLocation(name))
    : undefined;
}

function parameterPropertySymbol(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
): ts.Symbol | undefined {
  if (
    !isParameterProperty(parameter) ||
    !ts.isIdentifier(parameter.name) ||
    !ts.isConstructorDeclaration(parameter.parent) ||
    !ts.isClassLike(parameter.parent.parent)
  ) {
    return undefined;
  }
  const classDeclaration = parameter.parent.parent;
  const classSymbol = classDeclaration.name
    ? canonicalSymbol(
        checker,
        checker.getSymbolAtLocation(classDeclaration.name),
      )
    : undefined;
  if (!classSymbol) return undefined;
  return canonicalSymbol(
    checker,
    checker.getPropertyOfType(
      checker.getDeclaredTypeOfSymbol(classSymbol),
      parameter.name.text,
    ),
  );
}

function hasBody(
  declaration: ts.Node | undefined,
): declaration is ts.FunctionLikeDeclaration {
  return Boolean(declaration && "body" in declaration && declaration.body);
}

function callbackDeclarations(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration[] {
  const node = unwrapExpression(expression);
  const declarations = new Set<ts.FunctionLikeDeclaration>();
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    declarations.add(node);
  }
  const type = checker.getTypeAtLocation(node);
  for (const signature of checker.getSignaturesOfType(
    type,
    ts.SignatureKind.Call,
  )) {
    if (hasBody(signature.declaration)) {
      declarations.add(signature.declaration);
    }
  }
  return [...declarations];
}

function isInProgram(
  programSourceFiles: ReadonlySet<ts.SourceFile>,
  node: ts.Node,
): boolean {
  return programSourceFiles.has(node.getSourceFile());
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function isSimpleAssignment(node: ts.BinaryExpression): boolean {
  return node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

function typedArrayConstructorName(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return null;
}

function isIntrinsicLibDeclaration(declaration: ts.Declaration): boolean {
  const sourceFile = declaration.getSourceFile();
  return (
    sourceFile.isDeclarationFile &&
    /^lib\..*\.d\.ts$/.test(path.basename(sourceFile.fileName))
  );
}

function hasIntrinsicLibValueDeclaration(
  symbol: ts.Symbol | undefined,
): boolean {
  return Boolean(
    symbol?.valueDeclaration &&
    isIntrinsicLibDeclaration(symbol.valueDeclaration),
  );
}

function isIntrinsicObjectFreezeCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  if (call.arguments.length !== 1) return false;
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee) && callee.text === "intrinsicObjectFreeze") {
    return Boolean(
      symbolAtExpression(checker, callee)?.declarations?.some(
        (declaration) =>
          ts.isVariableDeclaration(declaration) &&
          toPosix(declaration.getSourceFile().fileName).endsWith(
            "/host/src/kernel-scratch.ts",
          ),
      ),
    );
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "freeze") {
    return false;
  }
  const receiver = unwrapExpression(callee.expression);
  const declaration = checker.getResolvedSignature(call)?.declaration;
  return (
    ts.isIdentifier(receiver) &&
    receiver.text === "Object" &&
    hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, receiver)) &&
    Boolean(
      declaration &&
      isIntrinsicLibDeclaration(declaration) &&
      signatureOwnerName(declaration) === "ObjectConstructor",
    )
  );
}

function intrinsicViewConstructorBits(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): number {
  const name = typedArrayConstructorName(expression);
  if (name !== "DataView" && (!name || !TYPED_ARRAY_CONSTRUCTORS.has(name))) {
    return 0;
  }
  const symbol = symbolAtExpression(checker, expression);
  if (!hasIntrinsicLibValueDeclaration(symbol)) {
    return 0;
  }
  return name === "DataView" ? DATA_VIEW_CONSTRUCTOR : TYPED_ARRAY_CONSTRUCTOR;
}

function immutableAuthorityContainerProjection(
  container: ts.Expression,
  property: string,
): ts.Expression | null {
  const node = unwrapExpression(container);
  if (ts.isObjectLiteralExpression(node)) {
    const matches: ts.Expression[] = [];
    for (const entry of node.properties) {
      if (
        ts.isPropertyAssignment(entry) &&
        propertyNameText(entry.name) === property
      ) {
        matches.push(entry.initializer);
      } else if (
        ts.isShorthandPropertyAssignment(entry) &&
        entry.name.text === property
      ) {
        matches.push(entry.name);
      } else if (
        ts.isSpreadAssignment(entry) ||
        ts.isGetAccessorDeclaration(entry) ||
        ts.isMethodDeclaration(entry)
      ) {
        return null;
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  }
  if (ts.isArrayLiteralExpression(node) && /^\d+$/.test(property)) {
    const index = Number(property);
    const element = node.elements[index];
    return element &&
      !ts.isOmittedExpression(element) &&
      !ts.isSpreadElement(element)
      ? element
      : null;
  }
  return null;
}

/**
 * Resolve immutable aliases and literal container projections used to hide a
 * WebAssembly authority-bearing namespace/function/constructor.
 *
 * This is deliberately syntax-exact: mutable objects, spreads, getters, and
 * computed indexes are never trusted as stable projections.
 */
function immutableAuthorityProjection(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.Expression {
  const node = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const property = accessedPropertyName(node);
    if (property !== null) {
      const receiver = immutableAuthorityProjection(
        node.expression,
        checker,
        new Set(seen),
      );
      const projected = immutableAuthorityContainerProjection(
        receiver,
        property,
      );
      if (projected) {
        return immutableAuthorityProjection(projected, checker, seen);
      }
    }
    return node;
  }
  if (!ts.isIdentifier(node)) return node;
  const symbol = symbolAtExpression(checker, node);
  if (!symbol || seen.has(symbol)) return node;
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return node;
  const declaration = declarations[0]!;
  const nextSeen = new Set(seen);
  nextSeen.add(symbol);
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    return immutableAuthorityProjection(
      declaration.initializer,
      checker,
      nextSeen,
    );
  }
  if (
    ts.isBindingElement(declaration) &&
    ts.isVariableDeclaration(declaration.parent.parent) &&
    declaration.parent.parent.initializer &&
    ts.isVariableDeclarationList(declaration.parent.parent.parent) &&
    (declaration.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    let property: string | null = null;
    if (ts.isObjectBindingPattern(declaration.parent)) {
      property =
        propertyNameText(declaration.propertyName) ??
        propertyNameText(declaration.name);
    } else if (ts.isArrayBindingPattern(declaration.parent)) {
      const index = declaration.parent.elements.indexOf(declaration);
      property = index >= 0 ? String(index) : null;
    }
    if (property !== null) {
      const container = immutableAuthorityProjection(
        declaration.parent.parent.initializer,
        checker,
        nextSeen,
      );
      const projected = immutableAuthorityContainerProjection(
        container,
        property,
      );
      if (projected) {
        return immutableAuthorityProjection(projected, checker, nextSeen);
      }
    }
  }
  return node;
}

function intrinsicWasmAuthorityConstructorBits(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): number {
  const node = immutableAuthorityProjection(expression, checker);
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return 0;
  }
  const name = accessedPropertyName(node);
  if (name !== "Memory" && name !== "Instance") return 0;
  const receiver = unwrapExpression(node.expression);
  if (
    !isIntrinsicNamespaceReference(receiver, "WebAssembly", checker) ||
    !hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, node))
  ) {
    return 0;
  }
  return name === "Memory"
    ? WASM_MEMORY_CONSTRUCTOR
    : WASM_INSTANCE_CONSTRUCTOR;
}

function isIntrinsicNamespaceReference(
  expression: ts.Expression,
  namespace: "Reflect" | "WebAssembly",
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  const node = immutableAuthorityProjection(expression, checker, seen);
  if (
    namespace === "WebAssembly" &&
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    accessedPropertyName(node) === "WebAssembly"
  ) {
    const receiver = unwrapExpression(node.expression);
    if (
      ts.isIdentifier(receiver) &&
      receiver.text === "globalThis" &&
      hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, receiver))
    ) {
      return true;
    }
  }
  if (
    ts.isIdentifier(node) &&
    node.text === namespace &&
    hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, node))
  ) {
    return true;
  }
  if (!ts.isIdentifier(node)) return false;
  const symbol = symbolAtExpression(checker, node);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return false;
  const declaration = declarations[0];
  if (
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }
  return isIntrinsicNamespaceReference(
    declaration.initializer,
    namespace,
    checker,
    seen,
  );
}

function isIntrinsicGlobalObjectReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const node = unwrapExpression(expression);
  if (
    !ts.isIdentifier(node) ||
    (node.text !== "globalThis" &&
      node.text !== "self" &&
      node.text !== "window")
  ) {
    return false;
  }
  const symbol = symbolAtExpression(checker, node);
  // `globalThis` is a compiler-synthesized global in some programs and has no
  // declaration symbol. A same-spelled local always has a source declaration
  // and must not be treated as the intrinsic global object.
  return !symbol?.declarations?.some(
    (declaration) => !isIntrinsicLibDeclaration(declaration),
  );
}

function intrinsicWasmAuthorityConstructorReferenceBits(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): number {
  const direct = intrinsicWasmAuthorityConstructorBits(expression, checker);
  if (direct !== 0) return direct;
  const node = immutableAuthorityProjection(expression, checker, seen);
  if (
    ts.isCallExpression(node) &&
    propertyIs(node.expression, "bind") &&
    node.arguments.length >= 1
  ) {
    const receiver = callReceiver(node);
    const signature = checker.getResolvedSignature(node)?.declaration;
    if (receiver && signature && isIntrinsicLibDeclaration(signature)) {
      return intrinsicWasmAuthorityConstructorReferenceBits(
        receiver,
        checker,
        seen,
      );
    }
  }
  if (!ts.isIdentifier(node)) return 0;
  const symbol = symbolAtExpression(checker, node);
  if (!symbol || seen.has(symbol)) return 0;
  seen.add(symbol);
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return 0;
  const declaration = declarations[0];
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    return intrinsicWasmAuthorityConstructorReferenceBits(
      declaration.initializer,
      checker,
      seen,
    );
  }
  if (
    ts.isBindingElement(declaration) &&
    ts.isObjectBindingPattern(declaration.parent) &&
    ts.isVariableDeclaration(declaration.parent.parent) &&
    declaration.parent.parent.initializer &&
    ts.isVariableDeclarationList(declaration.parent.parent.parent) &&
    (declaration.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0 &&
    isIntrinsicNamespaceReference(
      declaration.parent.parent.initializer,
      "WebAssembly",
      checker,
    )
  ) {
    const property =
      propertyNameText(declaration.propertyName) ??
      propertyNameText(declaration.name);
    return property === "Memory"
      ? WASM_MEMORY_CONSTRUCTOR
      : property === "Instance"
        ? WASM_INSTANCE_CONSTRUCTOR
        : 0;
  }
  return 0;
}

function isIntrinsicReflectConstructReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  const node = immutableAuthorityProjection(expression, checker, seen);
  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    accessedPropertyName(node) === "construct" &&
    isIntrinsicNamespaceReference(node.expression, "Reflect", checker) &&
    hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, node))
  ) {
    return true;
  }
  if (!ts.isIdentifier(node)) return false;
  const symbol = symbolAtExpression(checker, node);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return false;
  const declaration = declarations[0];
  if (
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }
  return isIntrinsicReflectConstructReference(
    declaration.initializer,
    checker,
    seen,
  );
}

function isIntrinsicWasmInstantiateFunction(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const node = immutableAuthorityProjection(expression, checker);
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  const member = accessedPropertyName(node);
  if (member !== "instantiate" && member !== "instantiateStreaming") {
    return false;
  }
  const receiver = unwrapExpression(node.expression);
  return (
    isIntrinsicNamespaceReference(receiver, "WebAssembly", checker) &&
    hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, node))
  );
}

/**
 * Return the target of an intrinsic Function.prototype call/apply dispatch.
 *
 * `WebAssembly.instantiate.call(...)` and `.apply(...)` create the same
 * Instance authority as a direct call. Checking the resolved intrinsic
 * signature prevents a user-defined `call` property from being mistaken for
 * the built-in dispatcher.
 */
function intrinsicCallApplyTarget(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.Expression | null {
  const callee = unwrapExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return null;
  }
  const member = accessedPropertyName(callee);
  if (member !== "call" && member !== "apply") return null;
  const signature = checker.getResolvedSignature(call)?.declaration;
  return signature && isIntrinsicLibDeclaration(signature)
    ? callee.expression
    : null;
}

function intrinsicFunctionDispatcherKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): "call" | "apply" | null {
  const node = immutableAuthorityProjection(expression, checker);
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return null;
  }
  const member = accessedPropertyName(node);
  if (member !== "call" && member !== "apply") return null;
  return hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, node))
    ? member
    : null;
}

function immutableArrayArgument(
  expression: ts.Expression | undefined,
  index: number,
  checker: ts.TypeChecker,
): ts.Expression | null {
  if (!expression) return null;
  const node = immutableAuthorityProjection(expression, checker);
  if (!ts.isArrayLiteralExpression(node)) return null;
  const element = node.elements[index];
  return element &&
    !ts.isOmittedExpression(element) &&
    !ts.isSpreadElement(element)
    ? element
    : null;
}

function intrinsicReflectConstructInvocationTarget(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.Expression | null {
  if (isIntrinsicReflectConstructReference(call.expression, checker)) {
    return call.arguments[0] ?? null;
  }

  const callApplyTarget = intrinsicCallApplyTarget(call, checker);
  if (
    callApplyTarget &&
    isIntrinsicReflectConstructReference(callApplyTarget, checker)
  ) {
    const member = callPropertyName(call);
    return member === "call"
      ? (call.arguments[1] ?? null)
      : member === "apply"
        ? immutableArrayArgument(call.arguments[1], 0, checker)
        : null;
  }

  if (
    isCapturedIntrinsicApply(call.expression, checker) &&
    call.arguments[0] &&
    isIntrinsicReflectConstructReference(call.arguments[0], checker)
  ) {
    return immutableArrayArgument(call.arguments[2], 0, checker);
  }

  const invoked = immutableAuthorityProjection(call.expression, checker);
  if (ts.isCallExpression(invoked) && propertyIs(invoked.expression, "bind")) {
    const receiver = callReceiver(invoked);
    const signature = checker.getResolvedSignature(invoked)?.declaration;
    if (
      receiver &&
      signature &&
      isIntrinsicLibDeclaration(signature) &&
      isIntrinsicReflectConstructReference(receiver, checker)
    ) {
      return invoked.arguments[1] ?? null;
    }
  }
  return null;
}

function isIntrinsicWasmInstantiateReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (isIntrinsicWasmInstantiateFunction(expression, checker)) return true;
  const node = immutableAuthorityProjection(expression, checker, seen);
  if (
    ts.isCallExpression(node) &&
    propertyIs(node.expression, "bind") &&
    node.arguments.length >= 1
  ) {
    const receiver = callReceiver(node);
    const signature = checker.getResolvedSignature(node)?.declaration;
    if (receiver && signature && isIntrinsicLibDeclaration(signature)) {
      if (isIntrinsicWasmInstantiateReference(receiver, checker, seen)) {
        return true;
      }
      if (
        intrinsicFunctionDispatcherKind(receiver, checker) !== null &&
        isIntrinsicWasmInstantiateReference(node.arguments[0]!, checker, seen)
      ) {
        return true;
      }
    }
  }
  if (!ts.isIdentifier(node)) return false;
  const symbol = symbolAtExpression(checker, node);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return false;
  const declaration = declarations[0];
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    return isIntrinsicWasmInstantiateReference(
      declaration.initializer,
      checker,
      seen,
    );
  }
  if (
    ts.isBindingElement(declaration) &&
    ts.isObjectBindingPattern(declaration.parent) &&
    ts.isVariableDeclaration(declaration.parent.parent) &&
    declaration.parent.parent.initializer &&
    ts.isVariableDeclarationList(declaration.parent.parent.parent) &&
    (declaration.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0 &&
    isIntrinsicNamespaceReference(
      declaration.parent.parent.initializer,
      "WebAssembly",
      checker,
    ) &&
    (propertyNameText(declaration.propertyName) ??
      propertyNameText(declaration.name)) === "instantiate"
  ) {
    return true;
  }
  return false;
}

function typeContainsIntrinsicWasmInstance(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    return type.types.some((part) =>
      typeContainsIntrinsicWasmInstance(part, checker, seen),
    );
  }
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (
    symbol?.getName() === "Instance" &&
    symbol.declarations?.some(
      (declaration) =>
        isIntrinsicLibDeclaration(declaration) &&
        (() => {
          for (
            let current: ts.Node | undefined = declaration.parent;
            current;
            current = current.parent
          ) {
            if (
              ts.isModuleDeclaration(current) &&
              current.name.getText() === "WebAssembly"
            ) {
              return true;
            }
            if (ts.isSourceFile(current)) break;
          }
          return false;
        })(),
    )
  ) {
    return true;
  }
  if (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
  ) {
    const reference = type as ts.TypeReference;
    for (const argument of checker.getTypeArguments(reference)) {
      if (typeContainsIntrinsicWasmInstance(argument, checker, seen)) {
        return true;
      }
    }
  }
  return false;
}

function typeContainsIntrinsicWasmMemory(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    return type.types.some((part) =>
      typeContainsIntrinsicWasmMemory(part, checker, seen),
    );
  }
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (
    symbol?.getName() === "Memory" &&
    symbol.declarations?.some(
      (declaration) =>
        isIntrinsicLibDeclaration(declaration) &&
        (() => {
          for (
            let current: ts.Node | undefined = declaration.parent;
            current;
            current = current.parent
          ) {
            if (
              ts.isModuleDeclaration(current) &&
              current.name.getText() === "WebAssembly"
            ) {
              return true;
            }
            if (ts.isSourceFile(current)) break;
          }
          return false;
        })(),
    )
  ) {
    return true;
  }
  if (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
  ) {
    const reference = type as ts.TypeReference;
    for (const argument of checker.getTypeArguments(reference)) {
      if (typeContainsIntrinsicWasmMemory(argument, checker, seen)) {
        return true;
      }
    }
  }
  return false;
}

function authorityTypeAtLocation(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Type {
  try {
    return checker.getTypeAtLocation(node);
  } catch (error) {
    if (error instanceof RangeError) {
      const sourceFile = node.getSourceFile();
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      throw new Error(
        `authority type analysis overflowed at ${toPosix(sourceFile.fileName)}:${line + 1}:${character + 1}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function isTypedWasmInstantiateCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const member = callPropertyName(call);
  if (member !== "instantiate" && member !== "instantiateStreaming") {
    return false;
  }
  return typeContainsIntrinsicWasmInstance(
    authorityTypeAtLocation(call, checker),
    checker,
  );
}

function isIntrinsicBufferFrom(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const callee = unwrapExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "from" ||
    callee.expression.getText(call.getSourceFile()) !== "Buffer"
  ) {
    return false;
  }
  const signatureDeclaration = checker.getResolvedSignature(call)?.declaration;
  return Boolean(
    signatureDeclaration?.getSourceFile().isDeclarationFile &&
    signatureOwnerName(signatureDeclaration) === "BufferConstructor",
  );
}

function intrinsicArrayMethod(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): string | null {
  const cached = INTRINSIC_ARRAY_METHODS.get(call);
  if (cached !== undefined) return cached;
  const method = callPropertyName(call);
  if (
    !method ||
    (!ARRAY_ELEMENT_RETURNING_METHODS.has(method) &&
      !ARRAY_ELEMENT_CALLBACK_METHODS.has(method))
  ) {
    INTRINSIC_ARRAY_METHODS.set(call, null);
    return null;
  }
  const declaration = checker.getResolvedSignature(call)?.declaration;
  const owner = signatureOwnerName(declaration);
  const result =
    declaration &&
    isIntrinsicLibDeclaration(declaration) &&
    (owner === "Array" || owner === "ReadonlyArray")
      ? method
      : null;
  INTRINSIC_ARRAY_METHODS.set(call, result);
  return result;
}

function intrinsicTypedArrayMethod(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): string | null {
  const method = callPropertyName(call);
  if (!method) return null;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  const owner = signatureOwnerName(declaration);
  return declaration &&
    isIntrinsicLibDeclaration(declaration) &&
    owner &&
    TYPED_ARRAY_CONSTRUCTORS.has(owner)
    ? method
    : null;
}

function returnFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current;
    current = current.parent
  ) {
    if (hasBody(current)) return current;
  }
  return null;
}

function isPersistentStoreTarget(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  assignment: ts.Node,
): boolean {
  const node = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    return true;
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return isPersistentStoreTarget(property.name, checker, assignment);
      }
      if (ts.isPropertyAssignment(property)) {
        return isPersistentStoreTarget(
          property.initializer,
          checker,
          assignment,
        );
      }
      if (ts.isSpreadAssignment(property)) {
        return isPersistentStoreTarget(
          property.expression,
          checker,
          assignment,
        );
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some(
      (element) =>
        !ts.isOmittedExpression(element) &&
        isPersistentStoreTarget(
          ts.isSpreadElement(element) ? element.expression : element,
          checker,
          assignment,
        ),
    );
  }
  if (!ts.isIdentifier(node)) return false;
  const symbol = symbolAtExpression(checker, node);
  const assignmentFunction = returnFunction(assignment);
  return Boolean(
    symbol?.declarations?.some(
      (declaration) => returnFunction(declaration) !== assignmentFunction,
    ),
  );
}

function stateFor(
  states: Map<StateKey, ValueState>,
  key: StateKey | undefined,
): ValueState {
  return key ? (states.get(key) ?? EMPTY_STATE) : EMPTY_STATE;
}

function mergeIntoKey(
  states: Map<StateKey, ValueState>,
  key: StateKey,
  state: ValueState,
  targetProjection: readonly StateProjection[] = [],
): boolean {
  let target = states.get(key);
  if (!target) {
    target = emptyState();
    states.set(key, target);
  }
  let depth = 0;
  for (const projection of targetProjection) {
    if (depth >= MAX_STRUCTURED_STATE_DEPTH) {
      return mergeDescendantCapabilities(target, state);
    }
    if (projection.kind === "element") {
      if (!target.elements) target.elements = emptyState();
      target = target.elements;
      depth++;
      continue;
    }
    let property = target.properties.get(projection.name);
    if (!property) {
      property = emptyState();
      target.properties.set(projection.name, property);
    }
    target = property;
    depth++;
  }
  return unionState(target, state, depth);
}

function hydrateTypeProperties(
  state: ValueState,
  expression: ts.Expression,
  checker: ts.TypeChecker,
  states: Map<StateKey, ValueState>,
): ValueState {
  const result = cloneState(state);
  const type = checker.getTypeAtLocation(expression);
  let properties = TYPE_PROPERTIES.get(type);
  if (!properties) {
    properties = checker.getPropertiesOfType(type);
    TYPE_PROPERTIES.set(type, properties);
  }
  for (const property of properties) {
    const hardPrivate = property.declarations?.some((declaration) => {
      const name = (declaration as ts.NamedDeclaration).name;
      return Boolean(name && ts.isPrivateIdentifier(name));
    });
    if (hardPrivate) continue;
    const hidden = Boolean(
      property.declarations?.some(
        (declaration) =>
          ts.canHaveModifiers(declaration) &&
          ts
            .getModifiers(declaration)
            ?.some(
              (modifier) =>
                modifier.kind === ts.SyntaxKind.PrivateKeyword ||
                modifier.kind === ts.SyntaxKind.ProtectedKeyword,
            ),
      ),
    );
    const propertySource = stateFor(
      states,
      canonicalSymbol(checker, property),
    );
    if (!hasCapability(propertySource)) continue;
    const propertyValue = cloneState(propertySource);
    // WHY: private/protected TypeScript slots must remain selectable through
    // explicit diagnostic casts, but must not make the whole owning wrapper a
    // raw-memory escape. Object spread promotes these ordinary runtime fields.
    const target = hidden ? result.hiddenProperties : result.properties;
    const existing = target.get(property.name);
    if (existing) unionState(existing, propertyValue);
    else target.set(property.name, propertyValue);
  }
  return result;
}

function propertyIs(expression: ts.Expression, expected: string): boolean {
  const unwrapped = unwrapExpression(expression);
  return (
    (ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)) &&
    accessedPropertyName(unwrapped) === expected
  );
}

function isJavaScriptKernelMemoryAccessorCall(
  node: ts.CallExpression,
): boolean {
  const sourceFile = node.getSourceFile();
  if (!/\.(?:c|m)?jsx?$/.test(sourceFile.fileName)) {
    return false;
  }
  // WHY: JavaScript's untyped parameters can erase the receiver type before
  // the checker reaches `kernel.getMemory()`. This exact zero-argument method
  // is Kandelo's documented raw kernel-memory escape hatch, so seed its result
  // syntactically and let the ordinary ownership analysis and exact allowlist
  // handle aliases, helper parameters, views, and writes. This is deliberately
  // not general JavaScript taint analysis.
  return (
    node.arguments.length === 0 && propertyIs(node.expression, "getMemory")
  );
}

function isJavaScriptKernelInstanceAccessorCall(
  node: ts.CallExpression,
): boolean {
  const sourceFile = node.getSourceFile();
  if (!/\.(?:c|m)?jsx?$/.test(sourceFile.fileName)) {
    return false;
  }
  // See getMemory above. JavaScript erases the receiver type, but this exact
  // trusted-embedder escape exposes the same kernel memory through
  // `getInstance().exports.memory` and must remain visible to the audit.
  return (
    node.arguments.length === 0 && propertyIs(node.expression, "getInstance")
  );
}

type CapturedOwnershipGetter = "instance-exports" | "memory-buffer";

type CapturedIntrinsicOperation =
  | "array-buffer-byte-length"
  | "atomics-notify"
  | "atomics-wait"
  | "data-view-get-uint16"
  | "data-view-get-uint32"
  | "shared-array-buffer-byte-length"
  | "uint8-array-set"
  | "uint8-array-slice";

function immutableConstValue(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.Expression {
  const node = unwrapExpression(expression);
  if (!ts.isIdentifier(node)) return node;
  const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(node));
  if (!symbol || seen.has(symbol)) return node;
  const declaration = symbol.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return node;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(symbol);
  return immutableConstValue(declaration.initializer, checker, nextSeen);
}

function isCapturedIntrinsicApply(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const node = immutableConstValue(expression, checker);
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "apply") {
    return false;
  }
  const receiver = unwrapExpression(node.expression);
  const symbol = symbolAtExpression(checker, node);
  return (
    ts.isIdentifier(receiver) &&
    receiver.text === "Reflect" &&
    Boolean(symbol?.declarations?.some(isIntrinsicLibDeclaration))
  );
}

function capturedOwnershipGetter(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): CapturedOwnershipGetter | null {
  const getter = immutableConstValue(expression, checker);
  if (!ts.isPropertyAccessExpression(getter) || getter.name.text !== "get") {
    return null;
  }
  const descriptor = unwrapExpression(getter.expression);
  if (!ts.isCallExpression(descriptor) || descriptor.arguments.length !== 2) {
    return null;
  }
  const descriptorDeclaration =
    checker.getResolvedSignature(descriptor)?.declaration;
  if (
    !descriptorDeclaration ||
    !isIntrinsicLibDeclaration(descriptorDeclaration) ||
    signatureOwnerName(descriptorDeclaration) !== "ObjectConstructor" ||
    callPropertyName(descriptor) !== "getOwnPropertyDescriptor"
  ) {
    return null;
  }
  const prototype = unwrapExpression(descriptor.arguments[0]);
  const property = unwrapExpression(descriptor.arguments[1]);
  if (
    !ts.isPropertyAccessExpression(prototype) ||
    prototype.name.text !== "prototype" ||
    !ts.isStringLiteralLike(property)
  ) {
    return null;
  }
  const constructor = unwrapExpression(prototype.expression);
  if (
    !ts.isPropertyAccessExpression(constructor) ||
    !ts.isIdentifier(unwrapExpression(constructor.expression)) ||
    unwrapExpression(constructor.expression).text !== "WebAssembly" ||
    !symbolAtExpression(checker, constructor)?.declarations?.some(
      isIntrinsicLibDeclaration,
    )
  ) {
    return null;
  }
  if (constructor.name.text === "Memory" && property.text === "buffer") {
    return "memory-buffer";
  }
  if (constructor.name.text === "Instance" && property.text === "exports") {
    return "instance-exports";
  }
  return null;
}

function capturedByteLengthGetter(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): CapturedIntrinsicOperation | null {
  const getter = immutableConstValue(expression, checker);
  if (!ts.isPropertyAccessExpression(getter) || getter.name.text !== "get") {
    return null;
  }
  const descriptor = unwrapExpression(getter.expression);
  if (!ts.isCallExpression(descriptor) || descriptor.arguments.length !== 2) {
    return null;
  }
  const descriptorDeclaration =
    checker.getResolvedSignature(descriptor)?.declaration;
  if (
    !descriptorDeclaration ||
    !isIntrinsicLibDeclaration(descriptorDeclaration) ||
    signatureOwnerName(descriptorDeclaration) !== "ObjectConstructor" ||
    callPropertyName(descriptor) !== "getOwnPropertyDescriptor"
  ) {
    return null;
  }
  const prototype = unwrapExpression(descriptor.arguments[0]);
  const property = unwrapExpression(descriptor.arguments[1]);
  if (
    !ts.isPropertyAccessExpression(prototype) ||
    prototype.name.text !== "prototype" ||
    !ts.isStringLiteralLike(property) ||
    property.text !== "byteLength"
  ) {
    return null;
  }
  const constructor = unwrapExpression(prototype.expression);
  if (
    !ts.isIdentifier(constructor) ||
    !symbolAtExpression(checker, constructor)?.declarations?.some(
      isIntrinsicLibDeclaration,
    )
  ) {
    return null;
  }
  if (constructor.text === "ArrayBuffer") {
    return "array-buffer-byte-length";
  }
  return constructor.text === "SharedArrayBuffer"
    ? "shared-array-buffer-byte-length"
    : null;
}

function capturedPrototypeOperation(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): CapturedIntrinsicOperation | null {
  const operation = immutableConstValue(expression, checker);
  if (!ts.isPropertyAccessExpression(operation)) return null;
  const operationSymbol = symbolAtExpression(checker, operation);
  if (!operationSymbol?.declarations?.some(isIntrinsicLibDeclaration)) {
    return null;
  }
  const receiver = unwrapExpression(operation.expression);
  if (ts.isIdentifier(receiver) && receiver.text === "Atomics") {
    if (operation.name.text === "wait") return "atomics-wait";
    if (operation.name.text === "notify") return "atomics-notify";
    return null;
  }
  if (
    !ts.isPropertyAccessExpression(receiver) ||
    receiver.name.text !== "prototype"
  ) {
    return null;
  }
  const constructor = unwrapExpression(receiver.expression);
  if (
    !ts.isIdentifier(constructor) ||
    !symbolAtExpression(checker, constructor)?.declarations?.some(
      isIntrinsicLibDeclaration,
    )
  ) {
    return null;
  }
  if (constructor.text === "DataView") {
    if (operation.name.text === "getUint16") {
      return "data-view-get-uint16";
    }
    return operation.name.text === "getUint32" ? "data-view-get-uint32" : null;
  }
  if (constructor.text !== "Uint8Array") return null;
  if (operation.name.text === "set") return "uint8-array-set";
  return operation.name.text === "slice" ? "uint8-array-slice" : null;
}

function isPlainIntrinsicArgumentList(expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  if (ts.isConditionalExpression(node)) {
    return (
      isPlainIntrinsicArgumentList(node.whenTrue) &&
      isPlainIntrinsicArgumentList(node.whenFalse)
    );
  }
  return (
    ts.isArrayLiteralExpression(node) &&
    node.elements.every(
      (element) =>
        !ts.isOmittedExpression(element) && !ts.isSpreadElement(element),
    )
  );
}

function capturedIntrinsicOperationCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): CapturedIntrinsicOperation | null {
  if (
    node.arguments.length !== 3 ||
    !isCapturedIntrinsicApply(node.expression, checker) ||
    !isPlainIntrinsicArgumentList(node.arguments[2])
  ) {
    return null;
  }
  return (
    capturedByteLengthGetter(node.arguments[0], checker) ??
    capturedPrototypeOperation(node.arguments[0], checker)
  );
}

function capturedOwnershipGetterCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): CapturedOwnershipGetter | null {
  if (
    node.arguments.length !== 3 ||
    !isCapturedIntrinsicApply(node.expression, checker)
  ) {
    return null;
  }
  const argumentList = unwrapExpression(node.arguments[2]);
  if (
    !ts.isArrayLiteralExpression(argumentList) ||
    argumentList.elements.length !== 0
  ) {
    return null;
  }
  return capturedOwnershipGetter(node.arguments[0], checker);
}

function transparentCapturedOwnershipGetterWrapper(
  declaration: ts.Declaration | undefined,
  checker: ts.TypeChecker,
): {
  readonly argumentIndex: number;
  readonly getter: CapturedOwnershipGetter;
} | null {
  if (!declaration || !hasBody(declaration)) return null;
  let returned: ts.Expression | null = null;
  if (ts.isBlock(declaration.body)) {
    if (
      declaration.body.statements.length !== 1 ||
      !ts.isReturnStatement(declaration.body.statements[0]) ||
      !declaration.body.statements[0].expression
    ) {
      return null;
    }
    returned = declaration.body.statements[0].expression;
  } else {
    returned = declaration.body;
  }
  const call = unwrapExpression(returned);
  if (!ts.isCallExpression(call)) return null;
  const getter = capturedOwnershipGetterCall(call, checker);
  if (getter === null) return null;
  const receiver = unwrapExpression(call.arguments[1]);
  if (!ts.isIdentifier(receiver)) return null;
  const receiverSymbol = symbolAtExpression(checker, receiver);
  const argumentIndex = declaration.parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      symbolAtExpression(checker, parameter.name) === receiverSymbol,
  );
  return argumentIndex < 0 ? null : { argumentIndex, getter };
}

function expressionState(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  states: Map<StateKey, ValueState>,
  programSources: ReadonlySet<ts.SourceFile>,
): ValueState {
  const node = unwrapExpression(expression);
  if (ts.isSpreadElement(node)) {
    // A spread call/new argument passes the elements, not the container.
    // WHY: dropping this projection lets `opaque(...[kernelView])` hide the
    // same live view that `opaque(kernelView)` exposes directly.
    return elementState(
      expressionState(node.expression, checker, states, programSources),
    );
  }
  const direct =
    ts.isIdentifier(node) &&
    ts.isShorthandPropertyAssignment(node.parent) &&
    node.parent.name === node
      ? canonicalSymbol(
          checker,
          checker.getShorthandAssignmentValueSymbol(node.parent),
        )
      : symbolAtExpression(checker, node);
  const directState = cloneState(stateFor(states, direct));
  if (isScratchRegionFactorySymbol(direct)) {
    directState.scratchRegionFactory = true;
  }
  if (
    direct?.declarations?.some((declaration) => {
      if (!ts.isBindingElement(declaration)) return false;
      const property =
        propertyNameText(declaration.propertyName) ??
        (ts.isIdentifier(declaration.name) ? declaration.name.text : null);
      return (
        property !== null &&
        (property === "kernel_spawn_scratch_begin" ||
          property === "kernel_spawn_scratch_pointer" ||
          property === "kernel_spawn_scratch_capacity" ||
          property === "kernel_spawn_scratch_cancel" ||
          property === "kernel_transfer_scratch_begin" ||
          property === "kernel_transfer_scratch_pointer" ||
          property === "kernel_transfer_scratch_capacity" ||
          property === "kernel_transfer_scratch_cancel")
      );
    })
  ) {
    // A destructured export is the same allocator authority as a dotted or
    // bracketed projection. The finite names keep same-spelled unrelated
    // callbacks visible rather than silently treating them as ordinary code.
    directState.reserver = true;
  }
  directState.viewConstructors |= intrinsicViewConstructorBits(node, checker);
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const property = accessedPropertyName(node);
    if (property === "kernel_alloc_scratch") {
      directState.allocator = true;
    } else if (
      property === "kernel_spawn_scratch_begin" ||
      property === "kernel_spawn_scratch_pointer" ||
      property === "kernel_spawn_scratch_capacity" ||
      property === "kernel_spawn_scratch_cancel" ||
      property === "kernel_transfer_scratch_begin" ||
      property === "kernel_transfer_scratch_pointer" ||
      property === "kernel_transfer_scratch_capacity" ||
      property === "kernel_transfer_scratch_cancel"
    ) {
      directState.reserver = true;
    }
  }

  if (ts.isConditionalExpression(node)) {
    return unionMany([
      directState,
      expressionState(node.whenTrue, checker, states, programSources),
      expressionState(node.whenFalse, checker, states, programSources),
    ]);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // The comma expression evaluates to its right operand.
      return unionMany([
        directState,
        expressionState(node.right, checker, states, programSources),
      ]);
    }
    if (
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      // A logical expression can return either operand without copying it.
      return unionMany([
        directState,
        expressionState(node.left, checker, states, programSources),
        expressionState(node.right, checker, states, programSources),
      ]);
    }
  }
  if (ts.isBinaryExpression(node) && isSimpleAssignment(node)) {
    return unionMany([
      directState,
      expressionState(node.right, checker, states, programSources),
    ]);
  }
  if (ts.isAwaitExpression(node)) {
    return unionMany([
      directState,
      expressionState(node.expression, checker, states, programSources),
    ]);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return unionMany([directState, stateFor(states, node)]);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result = cloneState(directState);
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        const value = expressionState(
          property.initializer,
          checker,
          states,
          programSources,
        );
        if (!hasCapability(value)) continue;
        if (!name) {
          if (result.elements) unionState(result.elements, value);
          else result.elements = cloneState(value);
          continue;
        }
        const existing = result.properties.get(name);
        if (existing) unionState(existing, value);
        else result.properties.set(name, value);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        // getSymbolAtLocation(name) denotes the object-literal property. The
        // shorthand value symbol is the outer binding that actually carries
        // ownership into the new container.
        const propertySource = stateFor(
          states,
          canonicalSymbol(
            checker,
            checker.getShorthandAssignmentValueSymbol(property),
          ),
        );
        if (!hasCapability(propertySource)) continue;
        const value = cloneState(propertySource);
        const existing = result.properties.get(property.name.text);
        if (existing) unionState(existing, value);
        else result.properties.set(property.name.text, value);
      } else if (ts.isSpreadAssignment(property)) {
        const spread = expressionState(
          property.expression,
          checker,
          states,
          programSources,
        );
        for (const [name, value] of spread.properties) {
          const existing = result.properties.get(name);
          if (existing) unionState(existing, value);
          else result.properties.set(name, cloneState(value));
        }
        for (const [name, value] of spread.hiddenProperties) {
          const existing = result.properties.get(name);
          if (existing) unionState(existing, value);
          else result.properties.set(name, cloneState(value));
        }
        if (spread.elements) {
          if (result.elements) {
            unionState(result.elements, spread.elements);
          } else {
            result.elements = cloneState(spread.elements);
          }
        }
      } else if (
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property)
      ) {
        const name = propertyNameText(property.name);
        if (!name) continue;
        const propertySource = stateFor(states, property);
        if (!hasCapability(propertySource)) continue;
        const value = cloneState(propertySource);
        const existing = result.properties.get(name);
        if (existing) unionState(existing, value);
        else result.properties.set(name, value);
      }
    }
    return result;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const result = cloneState(directState);
    for (const element of node.elements) {
      let value: ValueState;
      if (ts.isSpreadElement(element)) {
        value = elementState(
          expressionState(element.expression, checker, states, programSources),
        );
      } else if (ts.isOmittedExpression(element)) {
        continue;
      } else {
        value = expressionState(element, checker, states, programSources);
      }
      if (!hasCapability(value)) continue;
      if (result.elements) unionState(result.elements, value);
      else result.elements = cloneState(value);
    }
    return result;
  }
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const receiver = expressionState(
      node.expression,
      checker,
      states,
      programSources,
    );
    const property = accessedPropertyName(node);
    const numericIndex =
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isNumericLiteral(node.argumentExpression);
    const selected = numericIndex
      ? unionMany([
          receiver.elements ?? EMPTY_STATE,
          property === null ? EMPTY_STATE : propertyState(receiver, property),
        ])
      : property === null
        ? elementState(receiver)
        : propertyState(receiver, property);
    const result = cloneState(directState);
    unionState(result, selected);
    return result;
  }
  if (ts.isNewExpression(node)) {
    const constructor = expressionState(
      node.expression,
      checker,
      states,
      programSources,
    );
    if (constructor.viewConstructors !== 0) {
      const source = node.arguments?.[0]
        ? expressionState(node.arguments[0], checker, states, programSources)
        : EMPTY_STATE;
      const result = cloneState(directState);
      // A TypedArray constructed from another TypedArray copies. A DataView
      // or TypedArray constructed from an ArrayBufferLike aliases it.
      result.view |= source.buffer;
      result.memory = 0;
      result.buffer = 0;
      result.instance = 0;
      result.exportNamespace = 0;
      result.viewConstructors = 0;
      result.properties.clear();
      result.elements = null;
      return result;
    }
    const result = hydrateTypeProperties(directState, node, checker, states);
    result.viewConstructors = 0;
    return result;
  }
  if (ts.isCallExpression(node)) {
    const capturedGetter = capturedOwnershipGetterCall(node, checker);
    if (capturedGetter !== null) {
      const receiver = expressionState(
        node.arguments[1],
        checker,
        states,
        programSources,
      );
      const result = cloneState(directState);
      if (capturedGetter === "memory-buffer") {
        result.buffer |= receiver.memory;
      } else {
        result.exportNamespace |= receiver.instance;
      }
      return result;
    }
    if (capturedIntrinsicOperationCall(node, checker) !== null) {
      // Exact captured reads return only scalars, and Uint8Array#slice returns
      // a detached copy. Uint8Array#set is inventoried as a write at the call
      // site below; none of these operations returns the live receiver.
      return directState;
    }
    if (isIntrinsicObjectFreezeCall(node, checker)) {
      // Object.freeze returns the same object and does not hand it to user
      // code. Preserve every nested capability so freezing a private export
      // snapshot cannot erase the raw callable before its audited invocation.
      return unionMany([
        directState,
        expressionState(node.arguments[0], checker, states, programSources),
      ]);
    }
    if (propertyIs(node.expression, "subarray")) {
      const receiver = unwrapExpression(node.expression);
      if (
        ts.isPropertyAccessExpression(receiver) ||
        ts.isElementAccessExpression(receiver)
      ) {
        const source = expressionState(
          receiver.expression,
          checker,
          states,
          programSources,
        );
        const result = cloneState(directState);
        result.view |= source.view;
        result.memory = 0;
        result.buffer = 0;
        return result;
      }
    }
    if (isIntrinsicBufferFrom(node, checker)) {
      const source = node.arguments[0]
        ? expressionState(node.arguments[0], checker, states, programSources)
        : EMPTY_STATE;
      const result = cloneState(directState);
      result.view |= source.buffer;
      result.memory = 0;
      result.buffer = 0;
      result.instance = 0;
      result.exportNamespace = 0;
      return result;
    }
    const typedArrayMethod = intrinsicTypedArrayMethod(node, checker);
    if (
      typedArrayMethod &&
      TYPED_ARRAY_RETAINING_ITERATOR_METHODS.has(typedArrayMethod)
    ) {
      const receiver = callReceiver(node);
      const result = cloneState(directState);
      if (receiver) {
        const receiverState = expressionState(
          receiver,
          checker,
          states,
          programSources,
        );
        // Model the iterator as a retained view capability. It is not itself a
        // TypedArray, but keeping the stronger state makes return/store/unknown
        // calls fail closed instead of losing the backing view at `.values()`.
        result.view |= receiverState.view;
      }
      return result;
    }
    const arrayMethod = intrinsicArrayMethod(node, checker);
    if (
      arrayMethod &&
      (ARRAY_ELEMENT_RETURNING_METHODS.has(arrayMethod) ||
        arrayMethod === "filter" ||
        arrayMethod === "map")
    ) {
      const receiver = callReceiver(node);
      const result = cloneState(directState);
      if (receiver) {
        const receiverElement = elementState(
          expressionState(receiver, checker, states, programSources),
        );
        if (ARRAY_ELEMENT_RETURNING_METHODS.has(arrayMethod)) {
          unionState(result, receiverElement);
        } else if (arrayMethod === "filter") {
          if (hasCapability(receiverElement)) {
            result.elements = receiverElement;
          }
        } else if (node.arguments[0]) {
          const mappedElement = expressionState(
            node.arguments[0],
            checker,
            states,
            programSources,
          );
          if (hasCapability(mappedElement)) {
            result.elements = mappedElement;
          }
        }
      }
      return result;
    }
    const signature = checker.getResolvedSignature(node);
    const declaration = signature?.declaration;
    const result = cloneState(directState);
    result.viewConstructors = 0;
    const transparentGetter = transparentCapturedOwnershipGetterWrapper(
      declaration,
      checker,
    );
    if (
      transparentGetter !== null &&
      node.arguments[transparentGetter.argumentIndex]
    ) {
      const receiver = expressionState(
        node.arguments[transparentGetter.argumentIndex],
        checker,
        states,
        programSources,
      );
      if (transparentGetter.getter === "memory-buffer") {
        result.buffer |= receiver.memory;
      } else {
        result.exportNamespace |= receiver.instance;
      }
      return result;
    }
    if (directState.scratchRegionFactory) {
      // The factory function itself is an audited authority; its return value
      // is the nominal provenance witness required before withLease can mint a
      // live address capability.
      result.scratchRegionFactory = false;
      result.scratchRegion = true;
    }
    if (isJavaScriptKernelMemoryAccessorCall(node)) {
      result.memory |= KERNEL_OWNER;
    }
    if (isJavaScriptKernelInstanceAccessorCall(node)) {
      result.instance |= KERNEL_OWNER;
    }
    if (propertyIs(node.expression, "slice")) {
      const receiver = callReceiver(node);
      const owner = signatureOwnerName(declaration);
      const provenDetachedTypedArraySlice = Boolean(
        declaration &&
        declaration.getSourceFile().isDeclarationFile &&
        owner &&
        TYPED_ARRAY_CONSTRUCTORS.has(owner),
      );
      if (receiver && !provenDetachedTypedArraySlice) {
        // WHY: Uint8Array#slice copies, but Buffer#slice and arbitrary custom
        // methods may alias. Method spelling alone cannot prove detachment.
        result.view |= expressionState(
          receiver,
          checker,
          states,
          programSources,
        ).view;
      }
    }
    if (
      declaration &&
      isInProgram(programSources, declaration) &&
      hasBody(declaration)
    ) {
      unionState(result, stateFor(states, declaration));
    }
    const returnedKernelExportFunctions = new Set(result.kernelExportFunctions);
    // Higher-order callbacks retain the return capability in the parameter's
    // state. Calling such a parameter yields that capability.
    unionState(
      result,
      expressionState(node.expression, checker, states, programSources),
    );
    if (callPropertyName(node) !== "bind") {
      // Calling a raw export returns a scalar; the callable capability itself
      // does not flow into that scalar. An analyzed identity/helper return is
      // already represented by the declaration state captured above.
      result.kernelExportFunctions = returnedKernelExportFunctions;
    }
    if (result.scratchRegionFactory) {
      result.scratchRegionFactory = false;
      result.scratchRegion = true;
    }
    return result;
  }
  return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword
    ? hydrateTypeProperties(directState, node, checker, states)
    : directState;
}

function assignmentWritesKernelView(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  states: Map<StateKey, ValueState>,
  programSources: ReadonlySet<ts.SourceFile>,
): boolean {
  const node = unwrapExpression(expression);
  if (ts.isElementAccessExpression(node)) {
    return isKernelView(
      expressionState(node.expression, checker, states, programSources),
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some(
      (element) =>
        !ts.isOmittedExpression(element) &&
        assignmentWritesKernelView(
          ts.isSpreadElement(element) ? element.expression : element,
          checker,
          states,
          programSources,
        ),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return assignmentWritesKernelView(
          property.initializer,
          checker,
          states,
          programSources,
        );
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentWritesKernelView(
          property.expression,
          checker,
          states,
          programSources,
        );
      }
      return false;
    });
  }
  // A default inside an assignment pattern is itself a nested assignment and
  // is visited independently, avoiding duplicate findings for one write.
  return false;
}

function findingFor(
  rootDir: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  kind: AuditFinding["kind"],
): AuditFinding {
  const file = relativeFile(rootDir, sourceFile);
  const enclosing = callableName(node);
  const text = normalizeText(node, sourceFile);
  const key = `${file}::${enclosing}::${kind}::${text}`;
  const line =
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return { key, file, enclosing, kind, line, text };
}

type KernelOwnershipForm = "memory" | "buffer" | "view";

function hasKernelOwnership(
  state: ValueState,
  form: KernelOwnershipForm,
): boolean {
  if ((state[form] & KERNEL_OWNER) !== 0) return true;
  for (const property of state.properties.values()) {
    if (hasKernelOwnership(property, form)) return true;
  }
  return state.elements ? hasKernelOwnership(state.elements, form) : false;
}

function isKernelView(state: ValueState): boolean {
  return (state.view & KERNEL_OWNER) !== 0;
}

function isKernelBuffer(state: ValueState): boolean {
  return (state.buffer & KERNEL_OWNER) !== 0;
}

function isKernelMemory(state: ValueState): boolean {
  return (state.memory & KERNEL_OWNER) !== 0;
}

function hasAuditedKernelExport(
  state: ValueState,
  auditedKernelExports: ReadonlySet<string>,
  seen = new Set<ValueState>(),
): boolean {
  if (seen.has(state)) return false;
  seen.add(state);
  if (state.kernelExportFunctions.has(UNKNOWN_KERNEL_EXPORT)) return true;
  for (const name of state.kernelExportFunctions) {
    if (auditedKernelExports.has(name)) return true;
  }
  for (const property of state.properties.values()) {
    if (hasAuditedKernelExport(property, auditedKernelExports, seen)) {
      return true;
    }
  }
  for (const property of state.hiddenProperties.values()) {
    if (hasAuditedKernelExport(property, auditedKernelExports, seen)) {
      return true;
    }
  }
  return state.elements
    ? hasAuditedKernelExport(state.elements, auditedKernelExports, seen)
    : false;
}

function isViewConstructor(
  node: ts.Node,
  checker: ts.TypeChecker,
  states: Map<StateKey, ValueState>,
  programSources: ReadonlySet<ts.SourceFile>,
): boolean {
  if (ts.isNewExpression(node)) {
    return (
      expressionState(node.expression, checker, states, programSources)
        .viewConstructors !== 0
    );
  }
  return ts.isCallExpression(node) && isIntrinsicBufferFrom(node, checker);
}

function callPropertyName(call: ts.CallExpression): string | null {
  const callee = unwrapExpression(call.expression);
  return ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee)
    ? accessedPropertyName(callee)
    : null;
}

function callReceiver(call: ts.CallExpression): ts.Expression | null {
  const callee = unwrapExpression(call.expression);
  return ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee)
    ? callee.expression
    : null;
}

function signatureOwnerName(
  declaration: ts.Node | undefined,
): string | undefined {
  for (let current = declaration?.parent; current; current = current.parent) {
    if (
      (ts.isInterfaceDeclaration(current) || ts.isClassDeclaration(current)) &&
      current.name
    ) {
      return current.name.text;
    }
  }
  return undefined;
}

function isProvenReadOnlyKernelReceiverCall(
  call: ts.CallExpression,
  receiverState: ValueState,
  checker: ts.TypeChecker,
): boolean {
  const method = callPropertyName(call);
  if (!method) return false;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !isIntrinsicLibDeclaration(declaration)) return false;
  const owner = signatureOwnerName(declaration);

  if (
    isKernelView(receiverState) &&
    owner &&
    TYPED_ARRAY_CONSTRUCTORS.has(owner) &&
    TYPED_ARRAY_NON_RETAINING_METHODS.has(method)
  ) {
    return true;
  }
  if (
    isKernelView(receiverState) &&
    owner === "DataView" &&
    method.startsWith("get")
  ) {
    return true;
  }
  if (
    isKernelBuffer(receiverState) &&
    (owner === "ArrayBuffer" || owner === "SharedArrayBuffer") &&
    method === "slice"
  ) {
    return true;
  }
  return false;
}

function isKnownReadOnlyKernelViewArgument(
  call: ts.CallExpression,
  argumentIndex: number,
  checker: ts.TypeChecker,
): boolean {
  const method = callPropertyName(call);
  const signatureDeclaration = checker.getResolvedSignature(call)?.declaration;
  const methodOwner = signatureOwnerName(signatureDeclaration);
  // WHY: method spelling alone is not a read-only proof. A Map or custom
  // object's `set(kernelView)` can retain that live view. Admit only the
  // standard typed-array signature whose receiver write consumes arg0
  // synchronously.
  if (
    method === "set" &&
    argumentIndex === 0 &&
    methodOwner !== undefined &&
    TYPED_ARRAY_CONSTRUCTORS.has(methodOwner) &&
    signatureDeclaration !== undefined &&
    isIntrinsicLibDeclaration(signatureDeclaration)
  ) {
    return true;
  }
  // TextDecoder#decode consumes bytes synchronously; a custom `decode`
  // method remains an opaque escape.
  if (
    method === "decode" &&
    argumentIndex === 0 &&
    methodOwner === "TextDecoder" &&
    signatureDeclaration !== undefined &&
    isIntrinsicLibDeclaration(signatureDeclaration)
  ) {
    return true;
  }
  if (
    argumentIndex === 0 &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.expression.getText(call.getSourceFile()) === "Atomics" &&
    signatureDeclaration !== undefined &&
    isIntrinsicLibDeclaration(signatureDeclaration) &&
    hasIntrinsicLibValueDeclaration(
      symbolAtExpression(checker, call.expression.expression),
    ) &&
    !ATOMIC_MUTATORS.has(call.expression.name.text)
  ) {
    return true;
  }
  return false;
}

function validateContractEntries(
  ownershipSeeds: readonly OwnershipSeed[],
  allowances: readonly AuditAllowance[],
  kernelDestinationFactoryDeclarations: readonly string[],
): void {
  const seedKeys = new Set<string>();
  for (const seed of ownershipSeeds) {
    if (
      seed.declaration.includes("*") ||
      seed.declaration.includes("?") ||
      seed.declaration.endsWith("::")
    ) {
      throw new Error(`ownership seed must be exact: ${seed.declaration}`);
    }
    if (seed.why.trim().length < 12) {
      throw new Error(`ownership seed requires a WHY: ${seed.declaration}`);
    }
    const key = `${seed.declaration}::${seed.target}::${seed.owner}::${seed.form}`;
    if (seedKeys.has(key)) throw new Error(`duplicate ownership seed: ${key}`);
    seedKeys.add(key);
  }
  const allowanceKeys = new Set<string>();
  for (const allowance of allowances) {
    // Matching below is strict string equality. `?` is ordinary TypeScript
    // source text (notably `??` and `?.`) and therefore can be part of an
    // exact finding key; only `*` could plausibly advertise a wildcard.
    if (allowance.key.includes("*")) {
      throw new Error(`audit allowance must be exact: ${allowance.key}`);
    }
    if (allowance.why.trim().length < 12) {
      throw new Error(`audit allowance requires a WHY: ${allowance.key}`);
    }
    if (
      allowance.count !== undefined &&
      (!Number.isSafeInteger(allowance.count) || allowance.count <= 0)
    ) {
      throw new Error(
        `audit allowance count must be positive: ${allowance.key}`,
      );
    }
    if (allowanceKeys.has(allowance.key)) {
      throw new Error(`duplicate audit allowance: ${allowance.key}`);
    }
    const isAuthorityOrigin =
      allowance.key.includes("::wasm-memory-authority::") ||
      allowance.key.includes("::wasm-instance-authority::");
    if (isAuthorityOrigin !== (allowance.authorityOwner !== undefined)) {
      throw new Error(
        isAuthorityOrigin
          ? `authority allowance must classify its owner: ${allowance.key}`
          : `authorityOwner is valid only for an authority origin: ${allowance.key}`,
      );
    }
    allowanceKeys.add(allowance.key);
  }
  const sinkKeys = new Set<string>();
  for (const declaration of kernelDestinationFactoryDeclarations) {
    if (
      declaration.includes("*") ||
      declaration.includes("?") ||
      declaration.endsWith("::")
    ) {
      throw new Error(
        `kernel destination factory must be exact: ${declaration}`,
      );
    }
    if (sinkKeys.has(declaration)) {
      throw new Error(`duplicate kernel destination factory: ${declaration}`);
    }
    sinkKeys.add(declaration);
  }
}

export function auditWasmMemoryWrites(options: AuditOptions): AuditResult {
  const allowances = options.allowances ?? [];
  const allowanceByKey = new Map(allowances.map((entry) => [entry.key, entry]));
  const kernelDestinationFactoryDeclarations =
    options.kernelDestinationFactoryDeclarations ?? [];
  validateContractEntries(
    options.ownershipSeeds,
    allowances,
    kernelDestinationFactoryDeclarations,
  );
  const program = createProgram(options);
  const checker = program.getTypeChecker();
  const requestedFiles = new Set(
    options.sourceFiles.map((fileName) => path.resolve(fileName)),
  );
  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        requestedFiles.has(path.resolve(sourceFile.fileName)) &&
        !sourceFile.isDeclarationFile,
    );
  const programSources = new Set(sourceFiles);
  const authorityWrites = new Map<ts.Symbol, ts.Expression[]>();
  const authorityIndexedWrites = new Map<
    ts.Symbol,
    Map<string, ts.Expression[]>
  >();
  const addAuthorityWrite = (
    symbol: ts.Symbol | undefined,
    expression: ts.Expression,
  ): void => {
    if (!symbol) return;
    const existing = authorityWrites.get(symbol);
    if (existing) existing.push(expression);
    else authorityWrites.set(symbol, [expression]);
  };
  const addAuthorityIndexedWrite = (
    symbol: ts.Symbol | undefined,
    property: string | null,
    expression: ts.Expression,
  ): void => {
    if (!symbol || property === null) return;
    let properties = authorityIndexedWrites.get(symbol);
    if (!properties) {
      properties = new Map();
      authorityIndexedWrites.set(symbol, properties);
    }
    const existing = properties.get(property);
    if (existing) existing.push(expression);
    else properties.set(property, [expression]);
  };
  const addBindingAuthorityWrites = (
    name: ts.BindingName,
    initializer: ts.Expression,
  ): void => {
    if (ts.isIdentifier(name)) {
      addAuthorityWrite(symbolAtExpression(checker, name), initializer);
      return;
    }
    for (let index = 0; index < name.elements.length; index++) {
      const element = name.elements[index];
      if (ts.isOmittedExpression(element)) continue;
      if (element.initializer) {
        addBindingAuthorityWrites(element.name, element.initializer);
      }
      const property = ts.isObjectBindingPattern(name)
        ? (propertyNameText(element.propertyName) ??
          propertyNameText(element.name))
        : String(index);
      if (property === null) continue;
      const projected = immutableAuthorityContainerProjection(
        immutableAuthorityProjection(initializer, checker),
        property,
      );
      if (projected) {
        addBindingAuthorityWrites(element.name, projected);
      } else if (ts.isIdentifier(element.name)) {
        // Keep the namespace/container as a conservative frontier root. The
        // semantic classifier below resolves the exact destructured member.
        addAuthorityWrite(
          symbolAtExpression(checker, element.name),
          initializer,
        );
      }
    }
  };
  for (const sourceFile of sourceFiles) {
    const indexAuthorityWrites = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        addBindingAuthorityWrites(node.name, node.initializer);
      } else if (ts.isPropertyDeclaration(node) && node.initializer) {
        addAuthorityWrite(
          symbolForDeclaration(checker, node),
          node.initializer,
        );
      } else if (ts.isPropertyAssignment(node)) {
        addAuthorityWrite(
          symbolForDeclaration(checker, node),
          node.initializer,
        );
      } else if (ts.isShorthandPropertyAssignment(node)) {
        addAuthorityWrite(symbolForDeclaration(checker, node), node.name);
      } else if (
        ts.isParameter(node) &&
        node.initializer &&
        ts.isIdentifier(node.name)
      ) {
        addAuthorityWrite(
          symbolAtExpression(checker, node.name),
          node.initializer,
        );
      } else if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind)
      ) {
        const target = unwrapExpression(node.left);
        if (ts.isIdentifier(target)) {
          addAuthorityWrite(symbolAtExpression(checker, target), node.right);
        } else if (
          ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)
        ) {
          addAuthorityWrite(symbolAtExpression(checker, target), node.right);
          addAuthorityIndexedWrite(
            symbolAtExpression(checker, target.expression),
            accessedPropertyName(target),
            node.right,
          );
        }
      }
      ts.forEachChild(node, indexAuthorityWrites);
    };
    indexAuthorityWrites(sourceFile);
  }

  // Keep the authority pass syntax-first. TypeScript can recurse indefinitely
  // while resolving ordinary property/flow symbols in large inferred
  // JavaScript object graphs. Only expressions rooted in one of these
  // capability kinds (or in an exact tracked alias/container) are eligible for
  // the deeper semantic checks below.
  const AUTHORITY_CONTAINER = 1 << 8;
  const DYNAMIC_CODE_CAPABILITY = 1 << 9;
  const authorityFrontier = new Map<ts.Symbol, number>();
  let authorityFrontierNames = new Set<string>();
  const frontierSymbol = (node: ts.Identifier): ts.Symbol | undefined => {
    if (!authorityFrontierNames.has(node.text)) return undefined;
    return symbolAtExpression(checker, node);
  };
  const frontierBits = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): number => {
    const node = unwrapExpression(expression);
    if (ts.isIdentifier(node)) {
      if (node.text === "WebAssembly") {
        return WASM_AUTHORITY_NAMESPACE;
      }
      if (
        node.text === "globalThis" ||
        node.text === "self" ||
        node.text === "window"
      ) {
        return WASM_GLOBAL_OBJECT;
      }
      if (node.text === "eval" || node.text === "Function") {
        return DYNAMIC_CODE_CAPABILITY;
      }
      const symbol = frontierSymbol(node);
      return symbol && !seen.has(symbol)
        ? (authorityFrontier.get(symbol) ?? 0)
        : 0;
    }
    if (ts.isConditionalExpression(node)) {
      return (
        frontierBits(node.whenTrue, new Set(seen)) |
        frontierBits(node.whenFalse, new Set(seen))
      );
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return frontierBits(node.right, seen);
      }
      if (
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return (
          frontierBits(node.left, new Set(seen)) |
          frontierBits(node.right, new Set(seen))
        );
      }
      return 0;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const property = accessedPropertyName(node);
      const receiverBits = frontierBits(node.expression, new Set(seen));
      let bits = 0;
      if ((receiverBits & WASM_GLOBAL_OBJECT) !== 0) {
        if (property === "WebAssembly") {
          bits |= WASM_AUTHORITY_NAMESPACE;
        } else if (property === "eval" || property === "Function") {
          bits |= DYNAMIC_CODE_CAPABILITY;
        } else if (property === null) {
          bits |=
            DYNAMIC_CODE_CAPABILITY |
            WASM_AUTHORITY_NAMESPACE |
            WASM_MEMORY_CONSTRUCTOR |
            WASM_INSTANCE_CONSTRUCTOR |
            WASM_INSTANTIATE_FUNCTION;
        }
      }
      if ((receiverBits & WASM_AUTHORITY_NAMESPACE) !== 0) {
        if (property === "Memory") bits |= WASM_MEMORY_CONSTRUCTOR;
        else if (property === "Instance") bits |= WASM_INSTANCE_CONSTRUCTOR;
        else if (
          property === "instantiate" ||
          property === "instantiateStreaming"
        ) {
          bits |= WASM_INSTANTIATE_FUNCTION;
        } else if (property === null) {
          bits |=
            WASM_MEMORY_CONSTRUCTOR |
            WASM_INSTANCE_CONSTRUCTOR |
            WASM_INSTANTIATE_FUNCTION;
        }
      }
      if (
        (receiverBits &
          (WASM_MEMORY_CONSTRUCTOR | WASM_INSTANCE_CONSTRUCTOR)) !==
          0 &&
        (property === "prototype" || property === "constructor")
      ) {
        bits |=
          receiverBits & (WASM_MEMORY_CONSTRUCTOR | WASM_INSTANCE_CONSTRUCTOR);
      }
      if ((receiverBits & AUTHORITY_CONTAINER) !== 0 && property !== null) {
        bits |= receiverBits & ~WASM_GLOBAL_OBJECT;
      }

      const receiver = unwrapExpression(node.expression);
      if (
        ts.isIdentifier(receiver) &&
        authorityFrontierNames.has(receiver.text)
      ) {
        const receiverSymbol = symbolAtExpression(checker, receiver);
        if (receiverSymbol && !seen.has(receiverSymbol)) {
          const nextSeen = new Set(seen);
          nextSeen.add(receiverSymbol);
          for (const write of authorityIndexedWrites
            .get(receiverSymbol)
            ?.get(property ?? "") ?? []) {
            bits |= frontierBits(write, new Set(nextSeen));
          }
          if (property !== null) {
            for (const write of authorityWrites.get(receiverSymbol) ?? []) {
              const projected = immutableAuthorityContainerProjection(
                unwrapExpression(write),
                property,
              );
              if (projected) {
                bits |= frontierBits(projected, new Set(nextSeen));
              }
            }
          }
        }
      }
      return bits;
    }
    if (ts.isObjectLiteralExpression(node)) {
      let bits = 0;
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          bits |= frontierBits(property.initializer, new Set(seen));
        } else if (ts.isShorthandPropertyAssignment(property)) {
          bits |= frontierBits(property.name, new Set(seen));
        } else if (ts.isSpreadAssignment(property)) {
          bits |= frontierBits(property.expression, new Set(seen));
        }
      }
      return bits === 0 ? 0 : bits | AUTHORITY_CONTAINER;
    }
    if (ts.isArrayLiteralExpression(node)) {
      let bits = 0;
      for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) continue;
        bits |= frontierBits(
          ts.isSpreadElement(element) ? element.expression : element,
          new Set(seen),
        );
      }
      return bits === 0 ? 0 : bits | AUTHORITY_CONTAINER;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (propertyIs(callee, "bind")) {
        let bits = 0;
        const receiver = callReceiver(node);
        if (receiver) bits |= frontierBits(receiver, new Set(seen));
        for (const argument of node.arguments) {
          bits |= frontierBits(argument, new Set(seen));
        }
        return bits;
      }
      if (
        (propertyIs(callee, "call") || propertyIs(callee, "apply")) &&
        (ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)) &&
        propertyIs(callee.expression, "bind")
      ) {
        let bits = 0;
        for (const argument of node.arguments) {
          bits |= frontierBits(argument, new Set(seen));
        }
        return bits;
      }
      return 0;
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      const bits = frontierBits(node.body, new Set(seen));
      return bits === 0 ? 0 : bits | AUTHORITY_CONTAINER;
    }
    // Creating a Memory/Instance or invoking instantiate yields an object or
    // promise, not a reusable constructor/namespace capability.
    if (ts.isNewExpression(node)) return 0;
    return 0;
  };

  // Resolve the small alias/container frontier to a fixed point. Symbol
  // queries are performed only for names already known to carry authority.
  for (;;) {
    let changed = false;
    authorityFrontierNames = new Set(
      [...authorityFrontier.keys()].map((symbol) => symbol.getName()),
    );
    for (const [symbol, writes] of authorityWrites) {
      let bits = authorityFrontier.get(symbol) ?? 0;
      for (const write of writes) {
        bits |= frontierBits(write, new Set([symbol]));
      }
      if (bits !== (authorityFrontier.get(symbol) ?? 0)) {
        authorityFrontier.set(symbol, bits);
        changed = true;
      }
    }
    for (const [symbol, properties] of authorityIndexedWrites) {
      let bits = authorityFrontier.get(symbol) ?? 0;
      let contained = 0;
      for (const writes of properties.values()) {
        for (const write of writes) {
          contained |= frontierBits(write, new Set([symbol]));
        }
      }
      if (contained !== 0) bits |= contained | AUTHORITY_CONTAINER;
      if (bits !== (authorityFrontier.get(symbol) ?? 0)) {
        authorityFrontier.set(symbol, bits);
        changed = true;
      }
    }
    if (!changed) break;
  }
  authorityFrontierNames = new Set(
    [...authorityFrontier.keys()].map((symbol) => symbol.getName()),
  );
  const expressionIsAuthorityRelevant = (expression: ts.Expression): boolean =>
    (frontierBits(expression) &
      (WASM_MEMORY_CONSTRUCTOR |
        WASM_INSTANCE_CONSTRUCTOR |
        WASM_INSTANTIATE_FUNCTION |
        WASM_AUTHORITY_NAMESPACE |
        WASM_GLOBAL_OBJECT |
        AUTHORITY_CONTAINER)) !==
    0;
  const expressionIsDynamicCodeRelevant = (
    expression: ts.Expression,
  ): boolean =>
    (frontierBits(expression) &
      (DYNAMIC_CODE_CAPABILITY | WASM_GLOBAL_OBJECT)) !==
      0 ||
    ((ts.isPropertyAccessExpression(unwrapExpression(expression)) ||
      ts.isElementAccessExpression(unwrapExpression(expression))) &&
      accessedPropertyName(
        unwrapExpression(expression) as
          ts.PropertyAccessExpression | ts.ElementAccessExpression,
      ) === "constructor" &&
      expressionIsAuthorityRelevant(
        (
          unwrapExpression(expression) as
            ts.PropertyAccessExpression | ts.ElementAccessExpression
        ).expression,
      ));

  const possibleWasmAuthorityBits = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): number => {
    if (!expressionIsAuthorityRelevant(expression)) return 0;
    const node = unwrapExpression(expression);
    if (ts.isConditionalExpression(node)) {
      return (
        possibleWasmAuthorityBits(node.whenTrue, new Set(seen)) |
        possibleWasmAuthorityBits(node.whenFalse, new Set(seen))
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return possibleWasmAuthorityBits(node.right, seen);
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return (
        possibleWasmAuthorityBits(node.left, new Set(seen)) |
        possibleWasmAuthorityBits(node.right, new Set(seen))
      );
    }

    let bits = intrinsicWasmAuthorityConstructorReferenceBits(node, checker);
    if (isIntrinsicWasmInstantiateReference(node, checker)) {
      bits |= WASM_INSTANTIATE_FUNCTION;
    }
    if (isIntrinsicNamespaceReference(node, "WebAssembly", checker)) {
      bits |= WASM_AUTHORITY_NAMESPACE;
    }
    if (isIntrinsicGlobalObjectReference(node, checker)) {
      bits |= WASM_GLOBAL_OBJECT;
    }

    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const property = accessedPropertyName(node);
      const receiverBits = possibleWasmAuthorityBits(
        node.expression,
        new Set(seen),
      );
      if ((receiverBits & WASM_GLOBAL_OBJECT) !== 0) {
        if (property === "WebAssembly") {
          bits |= WASM_AUTHORITY_NAMESPACE;
        } else if (property === null) {
          bits |=
            WASM_AUTHORITY_NAMESPACE |
            WASM_MEMORY_CONSTRUCTOR |
            WASM_INSTANCE_CONSTRUCTOR |
            WASM_INSTANTIATE_FUNCTION;
        }
      }
      if ((receiverBits & WASM_AUTHORITY_NAMESPACE) !== 0) {
        if (property === "Memory") bits |= WASM_MEMORY_CONSTRUCTOR;
        else if (property === "Instance") bits |= WASM_INSTANCE_CONSTRUCTOR;
        else if (
          property === "instantiate" ||
          property === "instantiateStreaming"
        ) {
          bits |= WASM_INSTANTIATE_FUNCTION;
        } else if (property === null) {
          // Unknown computed namespace members are authority-possible. New/call
          // sites below fail closed instead of assuming a harmless property.
          bits |=
            WASM_MEMORY_CONSTRUCTOR |
            WASM_INSTANCE_CONSTRUCTOR |
            WASM_INSTANTIATE_FUNCTION;
        }
      }
      if (
        (receiverBits &
          (WASM_MEMORY_CONSTRUCTOR | WASM_INSTANCE_CONSTRUCTOR)) !==
          0 &&
        (property === "prototype" || property === "constructor")
      ) {
        bits |=
          receiverBits & (WASM_MEMORY_CONSTRUCTOR | WASM_INSTANCE_CONSTRUCTOR);
      }
      const receiverSymbol = symbolAtExpression(checker, node.expression);
      if (receiverSymbol && property !== null) {
        const nextSeen = new Set(seen);
        nextSeen.add(receiverSymbol);
        for (const write of authorityIndexedWrites
          .get(receiverSymbol)
          ?.get(property) ?? []) {
          bits |= possibleWasmAuthorityBits(write, new Set(nextSeen));
        }
        for (const container of authorityWrites.get(receiverSymbol) ?? []) {
          const projected = immutableAuthorityContainerProjection(
            unwrapExpression(container),
            property,
          );
          if (projected) {
            bits |= possibleWasmAuthorityBits(projected, new Set(nextSeen));
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (propertyIs(callee, "bind")) {
        const receiver = callReceiver(node);
        if (receiver) {
          bits |=
            possibleWasmAuthorityBits(receiver, new Set(seen)) &
            (WASM_MEMORY_CONSTRUCTOR |
              WASM_INSTANCE_CONSTRUCTOR |
              WASM_INSTANTIATE_FUNCTION);
        }
      }
      const callTarget = intrinsicCallApplyTarget(node, checker);
      if (callTarget && propertyIs(callTarget, "bind") && node.arguments[0]) {
        bits |=
          possibleWasmAuthorityBits(node.arguments[0], new Set(seen)) &
          (WASM_MEMORY_CONSTRUCTOR |
            WASM_INSTANCE_CONSTRUCTOR |
            WASM_INSTANTIATE_FUNCTION);
      }
    }

    // Property reads are resolved through their receiver's indexed writes
    // above. Asking TypeScript for the symbol of every ordinary property read
    // forces full flow analysis of unrelated values and can recurse through
    // large inferred object graphs. Identifier symbols are declaration-local
    // and sufficient for aliases; authority stored in a property is already a
    // fail-closed escape at the write site.
    const symbol = ts.isIdentifier(node)
      ? symbolAtExpression(checker, node)
      : undefined;
    if (symbol && !seen.has(symbol)) {
      const nextSeen = new Set(seen);
      nextSeen.add(symbol);
      for (const write of authorityWrites.get(symbol) ?? []) {
        bits |= possibleWasmAuthorityBits(write, new Set(nextSeen));
      }
    }
    return bits;
  };
  const WASM_AUTHORITY_CAPABILITY_MASK =
    WASM_MEMORY_CONSTRUCTOR |
    WASM_INSTANCE_CONSTRUCTOR |
    WASM_INSTANTIATE_FUNCTION |
    WASM_AUTHORITY_NAMESPACE;
  const expressionCarriesWasmAuthority = (expression: ts.Expression): boolean =>
    (possibleWasmAuthorityBits(expression) & WASM_AUTHORITY_CAPABILITY_MASK) !==
    0;
  const callIsReviewedAuthorityInvocation = (
    call: ts.CallExpression,
  ): boolean => {
    if (
      !expressionIsAuthorityRelevant(call.expression) &&
      !call.arguments.some(expressionIsAuthorityRelevant)
    ) {
      return false;
    }
    if (
      (possibleWasmAuthorityBits(call.expression) &
        (WASM_MEMORY_CONSTRUCTOR |
          WASM_INSTANCE_CONSTRUCTOR |
          WASM_INSTANTIATE_FUNCTION)) !==
        0 ||
      intrinsicReflectConstructInvocationTarget(call, checker) !== null ||
      isCapturedIntrinsicApply(call.expression, checker) ||
      intrinsicCallApplyTarget(call, checker) !== null
    ) {
      return true;
    }
    if (propertyIs(call.expression, "bind")) {
      const signature = checker.getResolvedSignature(call)?.declaration;
      return Boolean(signature && isIntrinsicLibDeclaration(signature));
    }
    return false;
  };
  const expressionMayGenerateDynamicCode = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): boolean => {
    if (!expressionIsDynamicCodeRelevant(expression)) return false;
    const node = unwrapExpression(expression);
    if (ts.isConditionalExpression(node)) {
      return (
        expressionMayGenerateDynamicCode(node.whenTrue, new Set(seen)) ||
        expressionMayGenerateDynamicCode(node.whenFalse, new Set(seen))
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return expressionMayGenerateDynamicCode(node.right, seen);
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return (
        expressionMayGenerateDynamicCode(node.left, new Set(seen)) ||
        expressionMayGenerateDynamicCode(node.right, new Set(seen))
      );
    }
    if (
      ts.isIdentifier(node) &&
      (node.text === "eval" || node.text === "Function") &&
      hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, node))
    ) {
      return true;
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      (accessedPropertyName(node) === "eval" ||
        accessedPropertyName(node) === "Function" ||
        accessedPropertyName(node) === null)
    ) {
      if (
        (possibleWasmAuthorityBits(node.expression) & WASM_GLOBAL_OBJECT) !==
        0
      ) {
        return true;
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      accessedPropertyName(node) === "constructor" &&
      (possibleWasmAuthorityBits(node.expression) &
        (WASM_MEMORY_CONSTRUCTOR |
          WASM_INSTANCE_CONSTRUCTOR |
          WASM_INSTANTIATE_FUNCTION |
          WASM_AUTHORITY_NAMESPACE)) !==
        0
    ) {
      return true;
    }
    const symbol = ts.isIdentifier(node)
      ? symbolAtExpression(checker, node)
      : undefined;
    if (!symbol || seen.has(symbol)) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(symbol);
    return (authorityWrites.get(symbol) ?? []).some((write) =>
      expressionMayGenerateDynamicCode(write, new Set(nextSeen)),
    );
  };
  const kernelScratchExportContract =
    kernelScratchPointerExportContract(sourceFiles);
  const generatedKernelExportNames =
    options.kernelExportNames === undefined
      ? null
      : new Set(options.kernelExportNames);
  const generatedKernelExportContractErrors: string[] = [];
  if (generatedKernelExportNames !== null) {
    if (generatedKernelExportNames.size !== options.kernelExportNames!.length) {
      generatedKernelExportContractErrors.push(
        "generated kernel export set contains duplicate names",
      );
    }
    for (const name of kernelScratchExportContract.names) {
      if (!generatedKernelExportNames.has(name)) {
        generatedKernelExportContractErrors.push(
          `kernel scratch export ${name} is absent from the generated kernel export set`,
        );
      }
    }
  }
  const auditedKernelExports =
    generatedKernelExportNames ?? kernelScratchExportContract.names;
  const wasmAuthorityKindsAtNode = (
    node: ts.Node,
  ): Array<"wasm-memory-authority" | "wasm-instance-authority"> => {
    if (!options.auditWasmAuthorityOrigins) return [];
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      !expressionIsAuthorityRelevant(node.expression) &&
      !(
        ts.isCallExpression(node) &&
        node.arguments.some(expressionIsAuthorityRelevant)
      )
    ) {
      return [];
    }
    let constructorBits = 0;
    let createsInstance = false;
    if (ts.isNewExpression(node)) {
      constructorBits = intrinsicWasmAuthorityConstructorReferenceBits(
        node.expression,
        checker,
      );
      constructorBits |=
        possibleWasmAuthorityBits(node.expression) &
        (WASM_MEMORY_CONSTRUCTOR | WASM_INSTANCE_CONSTRUCTOR);
      if (
        typeContainsIntrinsicWasmMemory(
          authorityTypeAtLocation(node, checker),
          checker,
        )
      ) {
        constructorBits |= WASM_MEMORY_CONSTRUCTOR;
      }
      if (
        typeContainsIntrinsicWasmInstance(
          authorityTypeAtLocation(node, checker),
          checker,
        )
      ) {
        constructorBits |= WASM_INSTANCE_CONSTRUCTOR;
      }
    } else if (ts.isCallExpression(node)) {
      const callApplyTarget = intrinsicCallApplyTarget(node, checker);
      createsInstance =
        isIntrinsicWasmInstantiateReference(node.expression, checker) ||
        (possibleWasmAuthorityBits(node.expression) &
          WASM_INSTANTIATE_FUNCTION) !==
          0 ||
        isTypedWasmInstantiateCall(node, checker) ||
        (callApplyTarget !== null &&
          isIntrinsicWasmInstantiateReference(callApplyTarget, checker)) ||
        (node.arguments[0] !== undefined &&
          isCapturedIntrinsicApply(node.expression, checker) &&
          isIntrinsicWasmInstantiateReference(node.arguments[0], checker)) ||
        (node.arguments[0] !== undefined &&
          node.arguments[1] !== undefined &&
          isCapturedIntrinsicApply(node.expression, checker) &&
          intrinsicFunctionDispatcherKind(node.arguments[0], checker) !==
            null &&
          isIntrinsicWasmInstantiateReference(node.arguments[1], checker));
      const reflectConstructTarget = intrinsicReflectConstructInvocationTarget(
        node,
        checker,
      );
      if (reflectConstructTarget !== null) {
        constructorBits = intrinsicWasmAuthorityConstructorReferenceBits(
          reflectConstructTarget,
          checker,
        );
      }
    } else {
      return [];
    }
    const kinds: Array<"wasm-memory-authority" | "wasm-instance-authority"> =
      [];
    if ((constructorBits & WASM_MEMORY_CONSTRUCTOR) !== 0) {
      kinds.push("wasm-memory-authority");
    }
    if (
      createsInstance ||
      (constructorBits & WASM_INSTANCE_CONSTRUCTOR) !== 0
    ) {
      kinds.push("wasm-instance-authority");
    }
    return kinds;
  };
  const states = new Map<StateKey, ValueState>();
  const constraints: Constraint[] = [];
  const declarationTargets = new Map<string, DeclarationTarget>();
  const seededReturnStates = new Map<StateKey, ValueState>();
  const seededValueStates = new Map<StateKey, ValueState>();
  const leaseOriginCallbacks = new Map<ts.Symbol, ts.FunctionLikeDeclaration>();
  const leaseCallbackCalls = new Map<
    ts.FunctionLikeDeclaration,
    ts.CallExpression
  >();
  const inlineScratchLeaseCallback = (
    call: ts.CallExpression,
  ): ts.FunctionLikeDeclaration | null => {
    if (!isKernelScratchWithLeaseCall(call, checker) || !call.arguments[0]) {
      return null;
    }
    const callback = unwrapExpression(call.arguments[0]);
    if (
      !ts.isArrowFunction(callback) ||
      callback.asteriskToken ||
      (ts.canHaveModifiers(callback) &&
        ts
          .getModifiers(callback)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) ||
      !callback.parameters[0] ||
      !ts.isIdentifier(callback.parameters[0].name)
    ) {
      return null;
    }
    return callback;
  };

  const addDeclarationTarget = (
    sourceFile: ts.SourceFile,
    declaration: ts.Declaration,
    target: DeclarationTarget,
  ): void => {
    const key = declarationKey(options.rootDir, sourceFile, declaration);
    if (!key) return;
    const existing = declarationTargets.get(key) ?? {};
    if (target.value) existing.value = target.value;
    if (target.returns) existing.returns = target.returns;
    declarationTargets.set(key, existing);
  };

  const addBindingConstraints = (
    name: ts.BindingName,
    expression: ts.Expression,
    projection: readonly StateProjection[] = [],
  ): void => {
    if (ts.isIdentifier(name)) {
      const target = canonicalSymbol(
        checker,
        checker.getSymbolAtLocation(name),
      );
      if (target) {
        constraints.push({
          target,
          expression,
          projection,
        });
      }
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        const property =
          propertyNameText(element.propertyName) ??
          (ts.isIdentifier(element.name) ? element.name.text : null);
        const nextProjection: StateProjection =
          element.dotDotDotToken || property === null
            ? { kind: "element" }
            : { kind: "property", name: property };
        addBindingConstraints(element.name, expression, [
          ...projection,
          nextProjection,
        ]);
        if (element.initializer) {
          addBindingConstraints(element.name, element.initializer, []);
        }
      }
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      addBindingConstraints(element.name, expression, [
        ...projection,
        { kind: "element" },
      ]);
      if (element.initializer) {
        addBindingConstraints(element.name, element.initializer, []);
      }
    }
  };
  const addAssignmentConstraints = (
    targetExpression: ts.Expression,
    sourceExpression: ts.Expression,
    projection: readonly StateProjection[] = [],
  ): void => {
    const targetNode = unwrapExpression(targetExpression);
    if (
      ts.isElementAccessExpression(targetNode) &&
      accessedPropertyName(targetNode) === null
    ) {
      const target = symbolAtExpression(
        checker,
        unwrapExpression(targetNode.expression),
      );
      if (target) {
        constraints.push({
          target,
          expression: sourceExpression,
          projection,
          targetProjection: [{ kind: "element" }],
        });
        return;
      }
    }
    if (
      ts.isIdentifier(targetNode) ||
      ts.isPropertyAccessExpression(targetNode) ||
      ts.isElementAccessExpression(targetNode)
    ) {
      const target = symbolAtExpression(checker, targetNode);
      if (target) {
        constraints.push({
          target,
          expression: sourceExpression,
          projection,
        });
      }
      return;
    }
    if (ts.isObjectLiteralExpression(targetNode)) {
      for (const property of targetNode.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          addAssignmentConstraints(property.name, sourceExpression, [
            ...projection,
            { kind: "property", name: property.name.text },
          ]);
          if (property.objectAssignmentInitializer) {
            addAssignmentConstraints(
              property.name,
              property.objectAssignmentInitializer,
            );
          }
        } else if (ts.isPropertyAssignment(property)) {
          const name = propertyNameText(property.name);
          addAssignmentConstraints(property.initializer, sourceExpression, [
            ...projection,
            name === null ? { kind: "element" } : { kind: "property", name },
          ]);
        } else if (ts.isSpreadAssignment(property)) {
          addAssignmentConstraints(property.expression, sourceExpression, [
            ...projection,
            { kind: "element" },
          ]);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(targetNode)) {
      for (const element of targetNode.elements) {
        if (ts.isOmittedExpression(element)) continue;
        addAssignmentConstraints(
          ts.isSpreadElement(element) ? element.expression : element,
          sourceExpression,
          [...projection, { kind: "element" }],
        );
      }
    }
  };
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isParameter(node)
      ) {
        const symbol = symbolForDeclaration(checker, node);
        if (symbol) addDeclarationTarget(sourceFile, node, { value: symbol });
      }
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        const symbol = symbolForDeclaration(checker, node);
        addDeclarationTarget(sourceFile, node, {
          value: symbol,
          returns: node,
        });
      }

      if (
        (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
        node.initializer
      ) {
        if (ts.isVariableDeclaration(node)) {
          addBindingConstraints(node.name, node.initializer);
        } else {
          const target = symbolForDeclaration(checker, node);
          if (target) {
            constraints.push({ target, expression: node.initializer });
          }
        }
      } else if (ts.isBinaryExpression(node) && isSimpleAssignment(node)) {
        addAssignmentConstraints(node.left, node.right);
      } else if (ts.isReturnStatement(node) && node.expression) {
        const fn = returnFunction(node);
        if (fn) {
          constraints.push({ target: fn, expression: node.expression });
          if (ts.isGetAccessorDeclaration(fn)) {
            const target = symbolForDeclaration(checker, fn);
            if (target) {
              constraints.push({ target, expression: node.expression });
            }
          }
        }
      } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        constraints.push({ target: node, expression: node.body });
      }

      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.declaration;
        if (
          declaration &&
          isInProgram(programSources, declaration) &&
          hasBody(declaration)
        ) {
          const parameters = declaration.parameters;
          const args = node.arguments ?? [];
          for (let index = 0; index < args.length; index++) {
            const parameter =
              parameters[Math.min(index, parameters.length - 1)];
            if (!parameter) continue;
            addBindingConstraints(parameter.name, args[index]);
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const leaseCallback = inlineScratchLeaseCallback(node);
        if (leaseCallback) {
          const parameter = leaseCallback.parameters[0];
          const symbol = symbolAtExpression(
            checker,
            parameter.name as ts.Identifier,
          );
          if (symbol) {
            leaseOriginCallbacks.set(symbol, leaseCallback);
            leaseCallbackCalls.set(leaseCallback, node);
          }
        }
        const method =
          intrinsicArrayMethod(node, checker) ??
          intrinsicTypedArrayMethod(node, checker);
        const receiver = method ? callReceiver(node) : null;
        const callback = node.arguments[0];
        const containerParameterIndex = method
          ? CONTAINER_CALLBACK_PARAMETER_INDEX.get(method)
          : undefined;
        if (
          method &&
          receiver &&
          callback &&
          containerParameterIndex !== undefined
        ) {
          for (const declaration of callbackDeclarations(callback, checker)) {
            if (!isInProgram(programSources, declaration)) continue;
            const elementParameter = declaration.parameters[0];
            if (elementParameter) {
              addBindingConstraints(elementParameter.name, receiver, [
                { kind: "element" },
              ]);
            }
            const containerParameter =
              declaration.parameters[containerParameterIndex];
            if (containerParameter) {
              addBindingConstraints(containerParameter.name, receiver, []);
            }
          }
        }
      }
      if (ts.isForOfStatement(node)) {
        const projection: readonly StateProjection[] = [{ kind: "element" }];
        if (ts.isVariableDeclarationList(node.initializer)) {
          for (const declaration of node.initializer.declarations) {
            addBindingConstraints(
              declaration.name,
              node.expression,
              projection,
            );
          }
        } else {
          addAssignmentConstraints(
            node.initializer,
            node.expression,
            projection,
          );
        }
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        const property = parameterPropertySymbol(checker, node);
        if (property) {
          constraints.push({ target: property, expression: node.name });
        }
      }
      if (ts.isParameter(node) && node.initializer) {
        addBindingConstraints(node.name, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const unresolvedDestinationFactoryDeclarations: string[] = [];
  const destinationFactorySymbols = new Set<ts.Symbol>();
  for (const declaration of kernelDestinationFactoryDeclarations) {
    const target = declarationTargets.get(declaration)?.value;
    if (!target) {
      unresolvedDestinationFactoryDeclarations.push(declaration);
      continue;
    }
    destinationFactorySymbols.add(target);
  }
  const mutatedSymbols = new Set<ts.Symbol>();
  for (const sourceFile of sourceFiles) {
    const findMutations = (node: ts.Node): void => {
      let target: ts.Expression | undefined;
      if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind)
      ) {
        target = node.left;
      } else if (
        ts.isPrefixUnaryExpression(node) ||
        ts.isPostfixUnaryExpression(node)
      ) {
        if (
          node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken
        ) {
          target = node.operand;
        }
      }
      if (target) {
        const exactTarget = unwrapExpression(target);
        if (ts.isIdentifier(exactTarget)) {
          const symbol = symbolAtExpression(checker, exactTarget);
          if (symbol) mutatedSymbols.add(symbol);
        }
      }
      ts.forEachChild(node, findMutations);
    };
    findMutations(sourceFile);
  }
  const exactUnmodifiedParameter = (
    expression: ts.Expression,
    call: ts.CallExpression,
  ): boolean => {
    const node = unwrapExpression(expression);
    if (!ts.isIdentifier(node)) return false;
    const symbol = symbolAtExpression(checker, node);
    if (!symbol || mutatedSymbols.has(symbol)) return false;
    const declaration = symbol.declarations?.find(ts.isParameter);
    return Boolean(
      declaration &&
      ts.isIdentifier(declaration.name) &&
      enclosingFunction(declaration) === enclosingFunction(call),
    );
  };
  const reviewedFixedCapacity = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): boolean => {
    const node = unwrapExpression(expression);
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      return Number.isSafeInteger(value) && value >= 0;
    }
    if (ts.isBigIntLiteral(node)) {
      try {
        const value = BigInt(node.text.slice(0, -1));
        return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
      } catch {
        return false;
      }
    }
    if (!ts.isIdentifier(node)) return false;
    const symbol = symbolAtExpression(checker, node);
    if (!symbol || seen.has(symbol) || mutatedSymbols.has(symbol)) {
      return false;
    }
    seen.add(symbol);
    const declarations = symbol.declarations ?? [];
    if (declarations.length !== 1) return false;
    const declaration = declarations[0];
    return (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      reviewedFixedCapacity(declaration.initializer, seen)
    );
  };
  const destinationFactoryCallIsAtReviewedBoundary = (
    call: ts.CallExpression,
  ): boolean => {
    const boundary = enclosingFunction(call);
    if (
      boundary &&
      (ts.isArrowFunction(boundary) || ts.isFunctionExpression(boundary)) &&
      ts.isPropertyAssignment(boundary.parent) &&
      boundary.parent.initializer === boundary
    ) {
      const name = propertyNameText(boundary.parent.name);
      return name?.startsWith("host_") === true;
    }
    if (
      boundary &&
      (ts.isArrowFunction(boundary) || ts.isFunctionExpression(boundary)) &&
      ts.isCallExpression(boundary.parent) &&
      boundary.parent.arguments[1] === boundary &&
      ts.isIdentifier(unwrapExpression(boundary.parent.expression)) &&
      unwrapExpression(boundary.parent.expression).text === "defineMethod" &&
      ts.isStringLiteralLike(boundary.parent.arguments[0])
    ) {
      // `#createTestAuthority` supplies only frozen module-secret white-box
      // closures through this local helper. Exact call-site allowances still
      // make every such test boundary independently reviewed.
      return true;
    }
    return false;
  };
  const destinationFactoryArgumentsAreExact = (
    call: ts.CallExpression,
  ): boolean =>
    destinationFactoryCallIsAtReviewedBoundary(call) &&
    call.arguments.length === 3 &&
    exactUnmodifiedParameter(call.arguments[0]!, call) &&
    (exactUnmodifiedParameter(call.arguments[1]!, call) ||
      reviewedFixedCapacity(call.arguments[1]!)) &&
    ts.isStringLiteralLike(unwrapExpression(call.arguments[2]!));

  const authorityClassificationErrors: string[] = [];
  const authorityBindingTarget = (origin: ts.Node): StateKey | null => {
    let child = origin;
    for (
      let current: ts.Node | undefined = origin.parent;
      current;
      child = current, current = current.parent
    ) {
      if (ts.isVariableDeclaration(current) && current.initializer) {
        return symbolForDeclaration(checker, current) ?? null;
      }
      if (ts.isPropertyDeclaration(current) && current.initializer) {
        return symbolForDeclaration(checker, current) ?? null;
      }
      if (
        ts.isBinaryExpression(current) &&
        isSimpleAssignment(current) &&
        current.right === child
      ) {
        return symbolAtExpression(checker, current.left) ?? null;
      }
      if (ts.isReturnStatement(current) && current.expression) {
        return returnFunction(current);
      }
      if (
        ts.isArrowFunction(current) &&
        !ts.isBlock(current.body) &&
        current.body === child
      ) {
        return current;
      }
      if (
        ts.isFunctionLike(current) ||
        ts.isClassStaticBlockDeclaration(current)
      ) {
        return null;
      }
    }
    return null;
  };
  for (const sourceFile of sourceFiles) {
    const classifyAuthorityOrigin = (node: ts.Node): void => {
      for (const kind of wasmAuthorityKindsAtNode(node)) {
        const finding = findingFor(options.rootDir, sourceFile, node, kind);
        const classification = allowanceByKey.get(finding.key);
        if (classification?.authorityOwner !== undefined) {
          const target = authorityBindingTarget(node);
          if (!target) {
            authorityClassificationErrors.push(
              `authority origin has no stable binding: ${finding.key}`,
            );
          } else {
            mergeIntoKey(
              states,
              target,
              ownerState(
                classification.authorityOwner,
                kind === "wasm-memory-authority" ? "memory" : "instance",
              ),
            );
          }
        }
      }
      ts.forEachChild(node, classifyAuthorityOrigin);
    };
    classifyAuthorityOrigin(sourceFile);
  }

  const unresolvedSeeds: OwnershipSeed[] = [];
  for (const seed of options.ownershipSeeds) {
    const target = declarationTargets.get(seed.declaration);
    const key = seed.target === "return" ? target?.returns : target?.value;
    if (!key) {
      unresolvedSeeds.push(seed);
      continue;
    }
    mergeIntoKey(states, key, ownerState(seed.owner, seed.form));
    if (seed.target === "return" && target?.returns) {
      mergeIntoKey(
        seededReturnStates,
        target.returns,
        ownerState(seed.owner, seed.form),
      );
    } else if (seed.target === "value" && target?.value) {
      mergeIntoKey(
        seededValueStates,
        target.value,
        ownerState(seed.owner, seed.form),
      );
    }
  }

  // Alias/argument/return propagation reaches a fixed point over the complete
  // source set. This is what makes a new helper file or a renamed local alias
  // visible to the ownership contract.
  let changed = true;
  let propagationPasses = 0;
  const maxPropagationPasses = constraints.length + 32;
  while (changed && propagationPasses < maxPropagationPasses) {
    changed = false;
    propagationPasses++;
    for (const constraint of constraints) {
      const state = expressionState(
        constraint.expression,
        checker,
        states,
        programSources,
      );
      const projected = projectState(state, constraint.projection);
      changed =
        mergeIntoKey(
          states,
          constraint.target,
          projected,
          constraint.targetProjection,
        ) || changed;
    }
  }

  const isIntrinsicWebAssemblyInstantiate = (
    expression: ts.Expression,
  ): boolean => {
    let node = unwrapExpression(expression);
    if (ts.isAwaitExpression(node)) node = unwrapExpression(node.expression);
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrapExpression(node.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== "instantiate"
    ) {
      return false;
    }
    const receiver = unwrapExpression(callee.expression);
    return (
      ts.isIdentifier(receiver) &&
      receiver.text === "WebAssembly" &&
      hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, receiver))
    );
  };
  const isNullishSeedInitializer = (expression: ts.Expression): boolean => {
    const node = unwrapExpression(expression);
    return (
      node.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(node) &&
        node.text === "undefined" &&
        hasIntrinsicLibValueDeclaration(symbolAtExpression(checker, node)))
    );
  };
  const immutableConstInitializer = (
    expression: ts.Expression,
  ): ts.Expression | null => {
    const node = unwrapExpression(expression);
    if (!ts.isIdentifier(node)) return null;
    const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(node));
    const declaration = symbol?.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return null;
    }
    return declaration.initializer;
  };
  const invalidSeedAssignmentExpressions = new Set<ts.Expression>();
  const invalidSeededScratchRegions = new Set<StateKey>();
  const constraintsByTarget = new Map<StateKey, Constraint[]>();
  for (const constraint of constraints) {
    if ((constraint.targetProjection?.length ?? 0) !== 0) continue;
    const existing = constraintsByTarget.get(constraint.target);
    if (existing) existing.push(constraint);
    else constraintsByTarget.set(constraint.target, [constraint]);
  }
  const declaredPropertySymbol = (
    type: ts.Type,
    name: string,
  ): ts.Symbol | undefined => {
    // ECMAScript private names are nominal, owner-rooted symbols. Never look
    // one up by the displayed "#name": two classes may legally declare that
    // same spelling while referring to different runtime slots.
    if (name.startsWith("#")) return undefined;
    const property = checker.getPropertyOfType(type, name);
    for (const declaration of property?.declarations ?? []) {
      const declared = symbolForDeclaration(checker, declaration);
      if (declared) return declared;
    }
    return canonicalSymbol(checker, property);
  };
  const isSeededScratchRegionKey = (key: StateKey | undefined): boolean =>
    Boolean(key && stateFor(seededValueStates, key).scratchRegion);
  const isDirectScratchRegionFactoryCall = (
    expression: ts.Expression,
  ): boolean => {
    const node = unwrapExpression(expression);
    return (
      ts.isCallExpression(node) &&
      isScratchRegionFactorySymbol(symbolAtExpression(checker, node.expression))
    );
  };
  const isValidatedScratchRegionProjection = (
    expression: ts.Expression,
    projection: readonly StateProjection[],
  ): boolean => {
    const node = unwrapExpression(expression);
    return (
      ts.isCallExpression(node) &&
      isScratchRegionOwnershipValidatorSymbol(
        symbolAtExpression(checker, node.expression),
      ) &&
      projection.length === 1 &&
      projection[0]!.kind === "property" &&
      projection[0]!.name === "region"
    );
  };
  const SCRATCH_ORIGIN_UNSAFE = 0;
  const SCRATCH_ORIGIN_EMPTY = 1;
  const SCRATCH_ORIGIN_EXACT = 2;
  type ScratchOriginProof =
    | typeof SCRATCH_ORIGIN_UNSAFE
    | typeof SCRATCH_ORIGIN_EMPTY
    | typeof SCRATCH_ORIGIN_EXACT;
  const combineScratchOriginProofs = (
    proofs: readonly ScratchOriginProof[],
  ): ScratchOriginProof => {
    if (
      proofs.length === 0 ||
      proofs.some((proof) => proof === SCRATCH_ORIGIN_UNSAFE)
    ) {
      return SCRATCH_ORIGIN_UNSAFE;
    }
    return proofs.some((proof) => proof === SCRATCH_ORIGIN_EXACT)
      ? SCRATCH_ORIGIN_EXACT
      : SCRATCH_ORIGIN_EMPTY;
  };
  const scratchOriginSymbolAtExpression = (
    expression: ts.Expression,
  ): ts.Symbol | undefined => {
    const node = unwrapExpression(expression);
    if (
      ts.isIdentifier(node) &&
      ts.isShorthandPropertyAssignment(node.parent) &&
      node.parent.name === node
    ) {
      return canonicalSymbol(
        checker,
        checker.getShorthandAssignmentValueSymbol(node.parent),
      );
    }
    return symbolAtExpression(checker, node);
  };
  const isExactMethodReceiver = (
    expression: ts.Expression,
    method: ts.MethodDeclaration,
    seen = new Set<StateKey>(),
  ): boolean => {
    const node = unwrapExpression(expression);
    if (ts.isConditionalExpression(node)) {
      return (
        isExactMethodReceiver(node.whenTrue, method, new Set(seen)) &&
        isExactMethodReceiver(node.whenFalse, method, new Set(seen))
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return isExactMethodReceiver(node.right, method, seen);
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return (
        isExactMethodReceiver(node.left, method, new Set(seen)) &&
        isExactMethodReceiver(node.right, method, new Set(seen))
      );
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword || ts.isNewExpression(node)) {
      if (ts.isNewExpression(node)) {
        const constructor = unwrapExpression(node.expression);
        if (
          ts.isIdentifier(constructor) &&
          constructor.text === "Proxy" &&
          hasIntrinsicLibValueDeclaration(
            symbolAtExpression(checker, constructor),
          )
        ) {
          return false;
        }
      }
      const methodName = propertyNameText(method.name);
      if (!methodName) return false;
      const expected = symbolForDeclaration(checker, method);
      if (!expected) return false;
      const receiverType = checker.getTypeAtLocation(node);
      if (ts.isPrivateIdentifier(method.name)) {
        // WHY: private method calls must keep the declaration symbol selected
        // by TypeScript for this exact class owner. A source-name lookup would
        // conflate unrelated classes that both declare (for example)
        // `#requireRegion`.
        return checker
          .getPropertiesOfType(receiverType)
          .some(
            (candidate) => canonicalSymbol(checker, candidate) === expected,
          );
      }
      return declaredPropertySymbol(receiverType, methodName) === expected;
    }
    if (ts.isCallExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (
        !declaration ||
        !isInProgram(programSources, declaration) ||
        !hasBody(declaration) ||
        seen.has(declaration)
      ) {
        return false;
      }
      if (ts.isMethodDeclaration(declaration)) {
        const receiver = callReceiver(node);
        if (
          !receiver ||
          !isExactMethodReceiver(receiver, declaration, new Set(seen))
        ) {
          return false;
        }
      }
      const writes = constraintsByTarget.get(declaration) ?? [];
      if (writes.length === 0) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(declaration);
      return writes.every(
        (constraint) =>
          (constraint.projection?.length ?? 0) === 0 &&
          isExactMethodReceiver(
            constraint.expression,
            method,
            new Set(nextSeen),
          ),
      );
    }
    const symbol = scratchOriginSymbolAtExpression(node);
    if (!symbol || seen.has(symbol)) return false;
    const writes = constraintsByTarget.get(symbol) ?? [];
    if (writes.length === 0) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(symbol);
    return writes.every(
      (constraint) =>
        (constraint.projection?.length ?? 0) === 0 &&
        isExactMethodReceiver(constraint.expression, method, new Set(nextSeen)),
    );
  };
  const proveExactScratchRegionOrigin = (
    expression: ts.Expression,
    projection: readonly StateProjection[] = [],
    seen = new Set<StateKey>(),
  ): ScratchOriginProof => {
    const node = unwrapExpression(expression);
    if (isNullishSeedInitializer(node)) return SCRATCH_ORIGIN_EMPTY;
    if (isDirectScratchRegionFactoryCall(node)) {
      return projection.length === 0
        ? SCRATCH_ORIGIN_EXACT
        : SCRATCH_ORIGIN_UNSAFE;
    }
    if (isValidatedScratchRegionProjection(node, projection)) {
      // WHY: this exact helper authenticates the structural input against the
      // allocator module's private WeakMap and exact gate generation. Only its
      // returned `region` projection receives provenance; the raw argument and
      // unrelated result fields remain untrusted.
      return SCRATCH_ORIGIN_EXACT;
    }
    if (ts.isConditionalExpression(node)) {
      return combineScratchOriginProofs([
        proveExactScratchRegionOrigin(node.whenTrue, projection, new Set(seen)),
        proveExactScratchRegionOrigin(
          node.whenFalse,
          projection,
          new Set(seen),
        ),
      ]);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return proveExactScratchRegionOrigin(node.right, projection, seen);
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return combineScratchOriginProofs([
        proveExactScratchRegionOrigin(node.left, projection, new Set(seen)),
        proveExactScratchRegionOrigin(node.right, projection, new Set(seen)),
      ]);
    }
    if (projection.length > 0 && ts.isObjectLiteralExpression(node)) {
      const [head, ...tail] = projection;
      if (head.kind !== "property") return SCRATCH_ORIGIN_UNSAFE;
      const values: ts.Expression[] = [];
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          propertyNameText(property.name) === head.name
        ) {
          values.push(property.initializer);
        } else if (
          ts.isShorthandPropertyAssignment(property) &&
          property.name.text === head.name
        ) {
          values.push(property.name);
        } else if (
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property) ||
          ts.isSpreadAssignment(property)
        ) {
          // A getter or spread can compute/replace the projected property at
          // runtime. Do not infer provenance from its structural type.
          return SCRATCH_ORIGIN_UNSAFE;
        }
      }
      if (values.length === 0) return SCRATCH_ORIGIN_EMPTY;
      return combineScratchOriginProofs(
        values.map((value) =>
          proveExactScratchRegionOrigin(value, tail, new Set(seen)),
        ),
      );
    }
    if (
      projection.length > 0 &&
      (node.kind === ts.SyntaxKind.ThisKeyword || ts.isNewExpression(node))
    ) {
      if (ts.isNewExpression(node)) {
        const constructor = unwrapExpression(node.expression);
        if (
          ts.isIdentifier(constructor) &&
          constructor.text === "Proxy" &&
          hasIntrinsicLibValueDeclaration(
            symbolAtExpression(checker, constructor),
          )
        ) {
          return SCRATCH_ORIGIN_UNSAFE;
        }
      }
      const [head, ...tail] = projection;
      if (head.kind !== "property") return SCRATCH_ORIGIN_UNSAFE;
      const property = declaredPropertySymbol(
        checker.getTypeAtLocation(node),
        head.name,
      );
      if (!property || invalidSeededScratchRegions.has(property)) {
        return SCRATCH_ORIGIN_UNSAFE;
      }
      if (tail.length === 0 && isSeededScratchRegionKey(property)) {
        return SCRATCH_ORIGIN_EXACT;
      }
      const writes = constraintsByTarget.get(property) ?? [];
      if (writes.length === 0) return SCRATCH_ORIGIN_UNSAFE;
      const nextSeen = new Set(seen);
      nextSeen.add(property);
      return combineScratchOriginProofs(
        writes.map((constraint) =>
          proveExactScratchRegionOrigin(
            constraint.expression,
            [...(constraint.projection ?? []), ...tail],
            new Set(nextSeen),
          ),
        ),
      );
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const property = accessedPropertyName(node);
      if (property === null) return SCRATCH_ORIGIN_UNSAFE;
      if (property.startsWith("#")) {
        // Preserve TypeScript's class-rooted private symbol instead of
        // projecting by the human-readable spelling. This makes declaration,
        // assignment, and reads on one owner converge while an unrelated
        // class's same-spelled private slot remains a different origin.
        const symbol = scratchOriginSymbolAtExpression(node);
        if (
          projection.length === 0 &&
          symbol &&
          isSeededScratchRegionKey(symbol) &&
          !invalidSeededScratchRegions.has(symbol)
        ) {
          return SCRATCH_ORIGIN_EXACT;
        }
        if (
          !symbol ||
          seen.has(symbol) ||
          invalidSeededScratchRegions.has(symbol)
        ) {
          return SCRATCH_ORIGIN_UNSAFE;
        }
        const writes = constraintsByTarget.get(symbol) ?? [];
        if (writes.length === 0) return SCRATCH_ORIGIN_UNSAFE;
        const nextSeen = new Set(seen);
        nextSeen.add(symbol);
        return combineScratchOriginProofs(
          writes.map((constraint) =>
            proveExactScratchRegionOrigin(
              constraint.expression,
              [...(constraint.projection ?? []), ...projection],
              new Set(nextSeen),
            ),
          ),
        );
      }
      return proveExactScratchRegionOrigin(
        node.expression,
        [{ kind: "property", name: property }, ...projection],
        seen,
      );
    }
    if (ts.isCallExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (
        declaration &&
        isInProgram(programSources, declaration) &&
        hasBody(declaration) &&
        !seen.has(declaration)
      ) {
        if (ts.isMethodDeclaration(declaration)) {
          const receiver = callReceiver(node);
          if (!receiver || !isExactMethodReceiver(receiver, declaration)) {
            return SCRATCH_ORIGIN_UNSAFE;
          }
        }
        if (invalidSeededScratchRegions.has(declaration)) {
          return SCRATCH_ORIGIN_UNSAFE;
        }
        const writes = constraintsByTarget.get(declaration) ?? [];
        if (writes.length === 0) return SCRATCH_ORIGIN_UNSAFE;
        const nextSeen = new Set(seen);
        nextSeen.add(declaration);
        return combineScratchOriginProofs(
          writes.map((constraint) =>
            proveExactScratchRegionOrigin(
              constraint.expression,
              [...(constraint.projection ?? []), ...projection],
              new Set(nextSeen),
            ),
          ),
        );
      }
    }
    const symbol = scratchOriginSymbolAtExpression(node);
    if (
      projection.length === 0 &&
      symbol &&
      isSeededScratchRegionKey(symbol) &&
      !invalidSeededScratchRegions.has(symbol)
    ) {
      return SCRATCH_ORIGIN_EXACT;
    }
    if (!symbol || seen.has(symbol)) return SCRATCH_ORIGIN_UNSAFE;
    const writes = constraintsByTarget.get(symbol) ?? [];
    if (writes.length === 0) return SCRATCH_ORIGIN_UNSAFE;
    const nextSeen = new Set(seen);
    nextSeen.add(symbol);
    // WHY: region provenance is a must-property. Every value ever written to
    // a field/local/helper return must be either nullish or independently
    // derived from the reviewed allocator. One fake, projected container
    // value, or unresolved helper poisons the origin instead of being hidden
    // by the general ownership lattice's may-taint.
    return combineScratchOriginProofs(
      writes.map((constraint) =>
        proveExactScratchRegionOrigin(
          constraint.expression,
          [...(constraint.projection ?? []), ...projection],
          new Set(nextSeen),
        ),
      ),
    );
  };
  const isExactScratchRegionOrigin = (expression: ts.Expression): boolean =>
    proveExactScratchRegionOrigin(expression) === SCRATCH_ORIGIN_EXACT;

  for (const constraint of constraints) {
    const seeded = stateFor(seededValueStates, constraint.target);
    const source = projectState(
      expressionState(constraint.expression, checker, states, programSources),
      constraint.projection,
    );
    if (
      (seeded.instance & KERNEL_OWNER) !== 0 &&
      (source.instance & KERNEL_OWNER) === 0 &&
      !isNullishSeedInitializer(constraint.expression) &&
      !isIntrinsicWebAssemblyInstantiate(constraint.expression)
    ) {
      invalidSeedAssignmentExpressions.add(constraint.expression);
    }
  }

  // Scratch-region trust is a must-provenance property. The general ownership
  // lattice intentionally records possible capability flow, but a conditional,
  // mutable alias, helper return, or container can combine a real factory value
  // with a structural fake. Only an exact seed or direct factory result, plus
  // immutable const aliases, can mint a lease callback.
  let invalidScratchSeedChanged = true;
  while (invalidScratchSeedChanged) {
    invalidScratchSeedChanged = false;
    for (const constraint of constraints) {
      if (
        !isSeededScratchRegionKey(constraint.target) ||
        isNullishSeedInitializer(constraint.expression) ||
        ((constraint.projection?.length ?? 0) === 0 &&
          isExactScratchRegionOrigin(constraint.expression))
      ) {
        continue;
      }
      invalidSeedAssignmentExpressions.add(constraint.expression);
      if (!invalidSeededScratchRegions.has(constraint.target)) {
        invalidSeededScratchRegions.add(constraint.target);
        invalidScratchSeedChanged = true;
      }
    }
  }

  const reflectedSeedMutationCalls = new Set<ts.CallExpression>();
  type ReflectiveScratchMutation =
    "assign" | "defineProperties" | "defineProperty" | "set" | "setPrototypeOf";
  const REFLECTIVE_SCRATCH_MUTATIONS = new Set<ReflectiveScratchMutation>([
    "assign",
    "defineProperties",
    "defineProperty",
    "set",
    "setPrototypeOf",
  ]);
  const reflectiveMutationFromDeclaration = (
    declaration: ts.Declaration | undefined,
  ): ReflectiveScratchMutation | null => {
    if (!declaration || !isIntrinsicLibDeclaration(declaration)) return null;
    const declarationProperty = (declaration as ts.NamedDeclaration).name;
    const name =
      declarationProperty &&
      (ts.isIdentifier(declarationProperty) ||
        ts.isStringLiteralLike(declarationProperty) ||
        ts.isNumericLiteral(declarationProperty))
        ? declarationProperty.text
        : null;
    if (
      !name ||
      !REFLECTIVE_SCRATCH_MUTATIONS.has(name as ReflectiveScratchMutation)
    ) {
      return null;
    }
    let owner = signatureOwnerName(declaration);
    if (!owner) {
      for (
        let current: ts.Node | undefined = declaration.parent;
        current;
        current = current.parent
      ) {
        if (ts.isModuleDeclaration(current) && ts.isIdentifier(current.name)) {
          owner = current.name.text;
          break;
        }
      }
    }
    if (
      (owner === "ObjectConstructor" &&
        (name === "assign" ||
          name === "defineProperties" ||
          name === "defineProperty" ||
          name === "setPrototypeOf")) ||
      (owner === "Reflect" && (name === "set" || name === "setPrototypeOf"))
    ) {
      return name as ReflectiveScratchMutation;
    }
    return null;
  };
  const reflectiveMutationIdentity = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): ReflectiveScratchMutation | null => {
    const node = unwrapExpression(expression);
    if (ts.isCallExpression(node) && callPropertyName(node) === "bind") {
      const receiver = callReceiver(node);
      return receiver ? reflectiveMutationIdentity(receiver, seen) : null;
    }
    const signatures = checker.getSignaturesOfType(
      checker.getTypeAtLocation(node),
      ts.SignatureKind.Call,
    );
    for (const signature of signatures) {
      const mutation = reflectiveMutationFromDeclaration(signature.declaration);
      if (mutation) return mutation;
    }
    const symbol = scratchOriginSymbolAtExpression(node);
    if (!symbol || seen.has(symbol)) return null;
    const declaration = symbol.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer
    ) {
      const nextSeen = new Set(seen);
      nextSeen.add(symbol);
      return reflectiveMutationIdentity(declaration.initializer, nextSeen);
    }
    return null;
  };
  const reflectiveMutationInvocation = (
    call: ts.CallExpression,
  ): {
    readonly mutation: ReflectiveScratchMutation;
    readonly args: readonly ts.Expression[];
  } | null => {
    const callee = unwrapExpression(call.expression);
    if (
      (ts.isPropertyAccessExpression(callee) ||
        ts.isElementAccessExpression(callee)) &&
      (accessedPropertyName(callee) === "call" ||
        accessedPropertyName(callee) === "apply")
    ) {
      const mutation = reflectiveMutationIdentity(callee.expression);
      if (!mutation) return null;
      if (accessedPropertyName(callee) === "call") {
        return { mutation, args: call.arguments.slice(1) };
      }
      const applied = call.arguments[1]
        ? unwrapExpression(call.arguments[1])
        : null;
      return applied && ts.isArrayLiteralExpression(applied)
        ? {
            mutation,
            args: applied.elements.filter(
              (element): element is ts.Expression =>
                !ts.isOmittedExpression(element) &&
                !ts.isSpreadElement(element),
            ),
          }
        : null;
    }
    const mutation = reflectiveMutationIdentity(callee);
    return mutation ? { mutation, args: call.arguments } : null;
  };
  const trackedScratchProperties = (expression: ts.Expression): ts.Symbol[] => {
    const type = checker.getTypeAtLocation(unwrapExpression(expression));
    return checker
      .getPropertiesOfType(type)
      .map(
        (property) =>
          declaredPropertySymbol(type, property.name) ??
          canonicalSymbol(checker, property) ??
          property,
      )
      .filter(
        (symbol) =>
          isSeededScratchRegionKey(symbol) ||
          stateFor(states, symbol).scratchRegion ||
          Boolean(
            symbol.declarations?.some(
              (declaration) =>
                hasBody(declaration) &&
                stateFor(states, declaration).scratchRegion,
            ),
          ),
      );
  };
  const markReflectedSeedMutation = (
    call: ts.CallExpression,
    target: ts.Expression | undefined,
    property: string | null,
  ): void => {
    if (!target) return;
    const seeded = trackedScratchProperties(target);
    const matches =
      property === null
        ? seeded
        : seeded.filter((symbol) => symbol.name === property);
    if (matches.length === 0) return;
    reflectedSeedMutationCalls.add(call);
    for (const symbol of matches) {
      invalidSeededScratchRegions.add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        if (hasBody(declaration)) {
          invalidSeededScratchRegions.add(declaration);
        }
      }
    }
  };
  for (const sourceFile of sourceFiles) {
    const findReflectedSeedMutations = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const invocation = reflectiveMutationInvocation(node);
        const target = invocation?.args[0];
        if (invocation && target) {
          if (
            invocation.mutation === "defineProperty" ||
            invocation.mutation === "set"
          ) {
            const propertyArgument = invocation.args[1];
            const property =
              propertyArgument &&
              (ts.isStringLiteralLike(propertyArgument) ||
                ts.isNumericLiteral(propertyArgument))
                ? propertyArgument.text
                : null;
            markReflectedSeedMutation(node, target, property);
          } else if (invocation.mutation === "setPrototypeOf") {
            markReflectedSeedMutation(node, target, null);
          } else {
            for (const source of invocation.args.slice(1)) {
              const value = unwrapExpression(source);
              if (!ts.isObjectLiteralExpression(value)) {
                markReflectedSeedMutation(node, target, null);
                continue;
              }
              for (const entry of value.properties) {
                const property = propertyNameText(entry.name);
                markReflectedSeedMutation(node, target, property);
              }
            }
          }
        }
      }
      ts.forEachChild(node, findReflectedSeedMutations);
    };
    findReflectedSeedMutations(sourceFile);
  }

  for (const [origin, callback] of leaseOriginCallbacks) {
    const call = leaseCallbackCalls.get(callback);
    const receiver = call ? callReceiver(call) : null;
    if (!receiver || !isExactScratchRegionOrigin(receiver)) {
      leaseOriginCallbacks.delete(origin);
    }
  }
  const leaseOriginSymbol = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): ts.Symbol | undefined => {
    const node = unwrapExpression(expression);
    const symbol = symbolAtExpression(checker, node);
    if (!symbol) return undefined;
    if (ts.isIdentifier(node) && !seen.has(symbol)) {
      const initializer = immutableConstInitializer(node);
      if (initializer) {
        seen.add(symbol);
        return leaseOriginSymbol(initializer, seen);
      }
    }
    return symbol;
  };
  const enclosingFunction = (
    node: ts.Node,
  ): ts.FunctionLikeDeclaration | null => {
    for (
      let current: ts.Node | undefined = node.parent;
      current;
      current = current.parent
    ) {
      if (hasBody(current)) return current;
    }
    return null;
  };
  const isTransparentScratchUseWrapper = (
    parent: ts.Node,
    child: ts.Node,
  ): parent is
    | ts.ParenthesizedExpression
    | ts.AsExpression
    | ts.TypeAssertion
    | ts.NonNullExpression
    | ts.SatisfiesExpression =>
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)) &&
    parent.expression === child;
  const directCallForMember = (
    member: ts.Expression,
  ): ts.CallExpression | null => {
    let value: ts.Expression = member;
    while (
      value.parent &&
      isTransparentScratchUseWrapper(value.parent, value)
    ) {
      value = value.parent;
    }
    return value.parent &&
      ts.isCallExpression(value.parent) &&
      value.parent.expression === value
      ? value.parent
      : null;
  };
  const typeHasScratchMember = (
    expression: ts.Expression,
    member: "address" | "invokeKernelExport" | "withLease",
  ): boolean => {
    const symbol = canonicalSymbol(
      checker,
      checker.getPropertyOfType(
        checker.getTypeAtLocation(unwrapExpression(expression)),
        member,
      ),
    );
    if (member === "address") return isScratchAddressSymbol(symbol);
    if (member === "withLease") return isScratchWithLeaseSymbol(symbol);
    return isScratchLeaseMemberSymbol(symbol);
  };
  const expressionTypeHasScratchMember = (
    expression: ts.Expression,
    member: "address" | "invokeKernelExport" | "withLease",
  ): boolean => {
    const type = checker.getTypeAtLocation(expression);
    const members = type.isUnion()
      ? type.types.filter(
          (part) =>
            (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0,
        )
      : [type];
    return (
      members.length > 0 &&
      members.every((part) => {
        const symbol = canonicalSymbol(
          checker,
          checker.getPropertyOfType(part, member),
        );
        if (member === "address") return isScratchAddressSymbol(symbol);
        if (member === "withLease") return isScratchWithLeaseSymbol(symbol);
        return isScratchLeaseMemberSymbol(symbol);
      })
    );
  };
  interface ReviewedEntryScratchInvoker {
    readonly declaration: ts.MethodDeclaration;
    readonly leaseCalls: ReadonlySet<ts.CallExpression>;
  }
  const reviewedEntryScratchInvoker =
    ((): ReviewedEntryScratchInvoker | null => {
      const candidates: ts.MethodDeclaration[] = [];
      for (const sourceFile of sourceFiles) {
        if (
          !toPosix(sourceFile.fileName).endsWith("/host/src/kernel-worker.ts")
        ) {
          continue;
        }
        const collect = (node: ts.Node): void => {
          if (
            ts.isMethodDeclaration(node) &&
            ts.isPrivateIdentifier(node.name) &&
            node.name.text === "#invokeEntryScratchExport" &&
            signatureOwnerName(node) === "CentralizedKernelWorker"
          ) {
            candidates.push(node);
          }
          ts.forEachChild(node, collect);
        };
        collect(sourceFile);
      }
      if (candidates.length !== 1) return null;
      const declaration = candidates[0]!;
      if (
        declaration.asteriskToken ||
        declaration.parameters.length !== 4 ||
        declaration.body?.statements.length !== 1 ||
        declaration.modifiers?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.AsyncKeyword ||
            modifier.kind === ts.SyntaxKind.StaticKeyword,
        )
      ) {
        return null;
      }
      const [entryParameter, leaseParameter, nameParameter, argsParameter] =
        declaration.parameters;
      if (
        !entryParameter ||
        !leaseParameter ||
        !nameParameter ||
        !argsParameter ||
        !ts.isIdentifier(entryParameter.name) ||
        entryParameter.name.text !== "entry" ||
        !ts.isIdentifier(leaseParameter.name) ||
        leaseParameter.name.text !== "lease" ||
        !ts.isIdentifier(nameParameter.name) ||
        nameParameter.name.text !== "name" ||
        !ts.isIdentifier(argsParameter.name) ||
        argsParameter.name.text !== "args" ||
        declaration.parameters.some(
          (parameter) =>
            parameter.dotDotDotToken ||
            parameter.initializer ||
            parameter.questionToken,
        ) ||
        !expressionTypeHasScratchMember(
          leaseParameter.name,
          "invokeKernelExport",
        )
      ) {
        return null;
      }
      const statement = declaration.body.statements[0];
      if (
        !statement ||
        !ts.isReturnStatement(statement) ||
        !statement.expression ||
        !ts.isConditionalExpression(statement.expression)
      ) {
        return null;
      }
      const parameterSymbol = (
        parameter: ts.ParameterDeclaration,
      ): ts.Symbol | undefined =>
        ts.isIdentifier(parameter.name)
          ? canonicalSymbol(
              checker,
              checker.getSymbolAtLocation(parameter.name),
            )
          : undefined;
      const entrySymbol = parameterSymbol(entryParameter);
      const leaseSymbol = parameterSymbol(leaseParameter);
      const nameSymbol = parameterSymbol(nameParameter);
      const argsSymbol = parameterSymbol(argsParameter);
      const exactParameterReference = (
        expression: ts.Expression,
        expected: ts.Symbol | undefined,
      ): boolean =>
        Boolean(
          expected &&
          canonicalSymbol(
            checker,
            checker.getSymbolAtLocation(unwrapExpression(expression)),
          ) === expected,
        );
      const condition = statement.expression.condition;
      if (
        !ts.isBinaryExpression(condition) ||
        condition.operatorToken.kind !==
          ts.SyntaxKind.EqualsEqualsEqualsToken ||
        !exactParameterReference(condition.left, entrySymbol) ||
        !ts.isIdentifier(unwrapExpression(condition.right)) ||
        unwrapExpression(condition.right).getText() !== "undefined"
      ) {
        return null;
      }
      const exactLeaseCall = (
        expression: ts.Expression,
        memberName: "invokeKernelExport" | "invokeKernelExportScoped",
        expectedArguments: readonly (
          | ts.Symbol
          | {
              readonly receiver: ts.Symbol;
              readonly property: string;
            }
        )[],
      ): ts.CallExpression | null => {
        const node = unwrapExpression(expression);
        if (
          !ts.isCallExpression(node) ||
          node.arguments.length !== expectedArguments.length
        ) {
          return null;
        }
        const callee = unwrapExpression(node.expression);
        if (
          !ts.isPropertyAccessExpression(callee) ||
          callee.name.text !== memberName ||
          !exactParameterReference(callee.expression, leaseSymbol) ||
          !isScratchLeaseMemberSymbol(symbolAtExpression(checker, callee))
        ) {
          return null;
        }
        for (let index = 0; index < expectedArguments.length; index++) {
          const expected = expectedArguments[index]!;
          const argument = node.arguments[index]!;
          if ("receiver" in expected) {
            const access = unwrapExpression(argument);
            if (
              !ts.isPropertyAccessExpression(access) ||
              access.name.text !== expected.property ||
              !exactParameterReference(access.expression, expected.receiver)
            ) {
              return null;
            }
          } else if (!exactParameterReference(argument, expected)) {
            return null;
          }
        }
        return node;
      };
      if (!entrySymbol || !leaseSymbol || !nameSymbol || !argsSymbol) {
        return null;
      }
      const unscopedCall = exactLeaseCall(
        statement.expression.whenTrue,
        "invokeKernelExport",
        [nameSymbol, argsSymbol],
      );
      const scopedCall = exactLeaseCall(
        statement.expression.whenFalse,
        "invokeKernelExportScoped",
        [{ receiver: entrySymbol, property: "scope" }, nameSymbol, argsSymbol],
      );
      if (!unscopedCall || !scopedCall) return null;
      return {
        declaration,
        leaseCalls: new Set([unscopedCall, scopedCall]),
      };
    })();
  const isReviewedEntryScratchInvokerCall = (
    call: ts.CallExpression,
  ): boolean => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (
      !reviewedEntryScratchInvoker ||
      declaration !== reviewedEntryScratchInvoker.declaration ||
      call.arguments.length !== 4
    ) {
      return false;
    }
    const receiver = callReceiver(call);
    return Boolean(
      receiver &&
      isExactMethodReceiver(receiver, reviewedEntryScratchInvoker.declaration),
    );
  };
  interface ReviewedLinearLeaseConsumer {
    readonly declaration: ts.MethodDeclaration;
    readonly leaseArgumentIndex: number;
    readonly leaseCalls: ReadonlySet<ts.CallExpression>;
  }
  const reviewedLinearLeaseConsumers = new Map<
    ts.MethodDeclaration,
    ReviewedLinearLeaseConsumer
  >();
  const linearLeaseConsumerSpecs = new Map([
    ["#copyFlattenedTransferInput", "copyFrom"],
    ["#copyFlattenedTransferOutput", "copyTo"],
  ] as const);
  for (const [methodName, allowedLeaseMember] of linearLeaseConsumerSpecs) {
    const candidates: ts.MethodDeclaration[] = [];
    for (const sourceFile of sourceFiles) {
      if (
        !toPosix(sourceFile.fileName).endsWith("/host/src/kernel-worker.ts")
      ) {
        continue;
      }
      const collect = (node: ts.Node): void => {
        if (
          ts.isMethodDeclaration(node) &&
          ts.isPrivateIdentifier(node.name) &&
          node.name.text === methodName &&
          signatureOwnerName(node) === "CentralizedKernelWorker"
        ) {
          candidates.push(node);
        }
        ts.forEachChild(node, collect);
      };
      collect(sourceFile);
    }
    if (candidates.length !== 1) continue;
    const declaration = candidates[0]!;
    const leaseParameter = declaration.parameters[0];
    if (
      declaration.asteriskToken ||
      !declaration.body ||
      declaration.modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.AsyncKeyword ||
          modifier.kind === ts.SyntaxKind.StaticKeyword,
      ) ||
      !leaseParameter ||
      !ts.isIdentifier(leaseParameter.name) ||
      leaseParameter.name.text !== "lease" ||
      leaseParameter.dotDotDotToken ||
      leaseParameter.initializer ||
      leaseParameter.questionToken ||
      !expressionTypeHasScratchMember(leaseParameter.name, "invokeKernelExport")
    ) {
      continue;
    }
    const leaseSymbol = canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(leaseParameter.name),
    );
    if (!leaseSymbol) continue;
    const leaseCalls = new Set<ts.CallExpression>();
    let valid = true;
    const proveLinearUse = (node: ts.Node): void => {
      if (!valid) return;
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(unwrapExpression(node.expression)) &&
        unwrapExpression(node.expression).getText() === "eval"
      ) {
        // Direct eval could name the lease without leaving an identifier
        // reference for the proof below.
        valid = false;
        return;
      }
      if (ts.isIdentifier(node) && node.text === "arguments") {
        // A helper could otherwise recover its lease as arguments[0] without
        // naming the parameter.
        valid = false;
        return;
      }
      if (
        ts.isIdentifier(node) &&
        canonicalSymbol(checker, checker.getSymbolAtLocation(node)) ===
          leaseSymbol
      ) {
        const access = node.parent;
        const call = access?.parent;
        if (
          !access ||
          !ts.isPropertyAccessExpression(access) ||
          access.expression !== node ||
          access.name.text !== allowedLeaseMember ||
          !call ||
          !ts.isCallExpression(call) ||
          call.expression !== access ||
          !isScratchLeaseMemberSymbol(symbolAtExpression(checker, access)) ||
          enclosingFunction(call) !== declaration
        ) {
          valid = false;
          return;
        }
        leaseCalls.add(call);
      }
      ts.forEachChild(node, proveLinearUse);
    };
    proveLinearUse(declaration.body);
    if (!valid || leaseCalls.size === 0) continue;
    reviewedLinearLeaseConsumers.set(declaration, {
      declaration,
      leaseArgumentIndex: 0,
      leaseCalls,
    });
  }
  const reviewedLinearLeaseConsumerForCall = (
    call: ts.CallExpression,
  ): ReviewedLinearLeaseConsumer | null => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (!declaration || !ts.isMethodDeclaration(declaration)) return null;
    const consumer = reviewedLinearLeaseConsumers.get(declaration);
    if (!consumer || call.arguments.length !== declaration.parameters.length) {
      return null;
    }
    const receiver = callReceiver(call);
    return receiver && isExactMethodReceiver(receiver, declaration)
      ? consumer
      : null;
  };
  interface ReviewedTwoPhaseLeaseDispatch {
    readonly declaration: ts.MethodDeclaration;
    readonly stageParameterIndex: number;
    readonly finishParameterIndex: number;
    readonly leaseCallbackCalls: ReadonlySet<ts.CallExpression>;
  }
  const workerMethodCandidates = (
    methodName: string,
  ): ts.MethodDeclaration[] => {
    const candidates: ts.MethodDeclaration[] = [];
    for (const sourceFile of sourceFiles) {
      if (
        !toPosix(sourceFile.fileName).endsWith("/host/src/kernel-worker.ts")
      ) {
        continue;
      }
      const collect = (node: ts.Node): void => {
        if (
          ts.isMethodDeclaration(node) &&
          ts.isPrivateIdentifier(node.name) &&
          node.name.text === methodName &&
          signatureOwnerName(node) === "CentralizedKernelWorker"
        ) {
          candidates.push(node);
        }
        ts.forEachChild(node, collect);
      };
      collect(sourceFile);
    }
    return candidates;
  };
  const exactSymbolReference = (
    expression: ts.Expression,
    expected: ts.Symbol,
  ): boolean =>
    canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(unwrapExpression(expression)),
    ) === expected;
  const parameterSymbol = (
    declaration: ts.MethodDeclaration,
    index: number,
    expectedName: string,
  ): ts.Symbol | null => {
    const parameter = declaration.parameters[index];
    if (
      !parameter ||
      !ts.isIdentifier(parameter.name) ||
      parameter.name.text !== expectedName ||
      parameter.dotDotDotToken ||
      parameter.initializer ||
      parameter.questionToken
    ) {
      return null;
    }
    return (
      canonicalSymbol(checker, checker.getSymbolAtLocation(parameter.name)) ??
      null
    );
  };
  const symbolReferencesIn = (
    root: ts.Node,
    symbol: ts.Symbol,
  ): ts.Identifier[] => {
    const references: ts.Identifier[] = [];
    const collect = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        canonicalSymbol(checker, checker.getSymbolAtLocation(node)) === symbol
      ) {
        references.push(node);
      }
      ts.forEachChild(node, collect);
    };
    collect(root);
    return references;
  };
  const directCallbackCallForReference = (
    reference: ts.Identifier,
  ): ts.CallExpression | null => {
    const callee = unwrapExpression(reference);
    const parent = callee.parent;
    return parent &&
      ts.isCallExpression(parent) &&
      unwrapExpression(parent.expression) === callee
      ? parent
      : null;
  };
  const enclosingInlineLeaseCallback = (
    call: ts.CallExpression,
  ): ts.FunctionLikeDeclaration | null => {
    const callback = enclosingFunction(call);
    if (!callback) return null;
    const parent = callback.parent;
    if (
      !parent ||
      !ts.isCallExpression(parent) ||
      inlineScratchLeaseCallback(parent) !== callback ||
      !isKernelScratchWithLeaseCall(parent, checker) ||
      !callReceiver(parent) ||
      !isExactScratchRegionOrigin(callReceiver(parent)!)
    ) {
      return null;
    }
    return callback;
  };
  const exactEntryScratchExportName = (
    call: ts.CallExpression,
    expectedName: string,
  ): boolean => {
    if (!isReviewedEntryScratchInvokerCall(call)) return false;
    const name = unwrapExpression(call.arguments[2]!);
    return ts.isStringLiteralLike(name) && name.text === expectedName;
  };
  const reviewTwoPhaseLeaseMethod = (
    methodName: string,
    expectedExportName: string,
    forwardedTo?: ts.MethodDeclaration,
  ): ReviewedTwoPhaseLeaseDispatch | null => {
    const candidates = workerMethodCandidates(methodName);
    if (candidates.length !== 1) return null;
    const declaration = candidates[0]!;
    if (
      declaration.asteriskToken ||
      !declaration.body ||
      declaration.parameters.length !== 6 ||
      declaration.modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.AsyncKeyword ||
          modifier.kind === ts.SyntaxKind.StaticKeyword,
      )
    ) {
      return null;
    }
    const channelSymbol = parameterSymbol(declaration, 0, "channel");
    const capacitySymbol = parameterSymbol(declaration, 1, "totalCapacity");
    const entrySymbol = parameterSymbol(declaration, 2, "entry");
    const stageSymbol = parameterSymbol(declaration, 3, "stage");
    const finishSymbol = parameterSymbol(declaration, 4, "finish");
    const retryTokenParameter = declaration.parameters[5];
    const retryTokenSymbol =
      retryTokenParameter &&
      ts.isIdentifier(retryTokenParameter.name) &&
      retryTokenParameter.name.text === "retryToken" &&
      !retryTokenParameter.dotDotDotToken &&
      !retryTokenParameter.questionToken &&
      retryTokenParameter.initializer &&
      ts.isBigIntLiteral(retryTokenParameter.initializer) &&
      retryTokenParameter.initializer.getText() === "0n"
        ? (canonicalSymbol(
            checker,
            checker.getSymbolAtLocation(retryTokenParameter.name),
          ) ?? null)
        : null;
    const stageType = declaration.parameters[3]!.type;
    const finishType = declaration.parameters[4]!.type;
    const stageLeaseParameter =
      stageType && ts.isFunctionTypeNode(stageType)
        ? stageType.parameters[0]
        : undefined;
    const finishLeaseParameter =
      finishType && ts.isFunctionTypeNode(finishType)
        ? finishType.parameters[0]
        : undefined;
    if (
      !channelSymbol ||
      !capacitySymbol ||
      !entrySymbol ||
      !stageSymbol ||
      !finishSymbol ||
      !retryTokenSymbol ||
      !stageLeaseParameter ||
      !ts.isIdentifier(stageLeaseParameter.name) ||
      !finishLeaseParameter ||
      !ts.isIdentifier(finishLeaseParameter.name) ||
      !expressionTypeHasScratchMember(
        stageLeaseParameter.name,
        "invokeKernelExport",
      ) ||
      !expressionTypeHasScratchMember(
        finishLeaseParameter.name,
        "invokeKernelExport",
      )
    ) {
      return null;
    }

    const stageReferences = symbolReferencesIn(declaration.body, stageSymbol);
    const finishReferences = symbolReferencesIn(declaration.body, finishSymbol);
    const stageCalls = stageReferences
      .map(directCallbackCallForReference)
      .filter((call): call is ts.CallExpression => call !== null);
    const finishCalls = finishReferences
      .map(directCallbackCallForReference)
      .filter((call): call is ts.CallExpression => call !== null);
    if (stageCalls.length !== 1 || finishCalls.length !== 1) return null;
    const stageCall = stageCalls[0]!;
    const finishCall = finishCalls[0]!;
    if (
      stageCall.arguments.length !== 1 ||
      finishCall.arguments.length !== 1 ||
      !ts.isExpressionStatement(stageCall.parent) ||
      !ts.isReturnStatement(finishCall.parent) ||
      finishCall.parent.expression !== finishCall
    ) {
      return null;
    }
    const stageLeaseCallback = enclosingInlineLeaseCallback(stageCall);
    const finishLeaseCallback = enclosingInlineLeaseCallback(finishCall);
    if (
      !stageLeaseCallback ||
      stageLeaseCallback !== finishLeaseCallback ||
      !stageLeaseCallback.parameters[0] ||
      !ts.isIdentifier(stageLeaseCallback.parameters[0]!.name) ||
      !stageLeaseCallback.body ||
      !ts.isBlock(stageLeaseCallback.body)
    ) {
      return null;
    }
    const leaseSymbol = canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(stageLeaseCallback.parameters[0]!.name),
    );
    if (
      !leaseSymbol ||
      !exactSymbolReference(stageCall.arguments[0]!, leaseSymbol) ||
      !exactSymbolReference(finishCall.arguments[0]!, leaseSymbol)
    ) {
      return null;
    }
    const exportCalls: ts.CallExpression[] = [];
    const collectExportCalls = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        enclosingFunction(node) === stageLeaseCallback &&
        exactEntryScratchExportName(node, expectedExportName)
      ) {
        exportCalls.push(node);
      }
      ts.forEachChild(node, collectExportCalls);
    };
    collectExportCalls(stageLeaseCallback.body);
    if (exportCalls.length !== 1) {
      return null;
    }
    const callbackBlock = stageLeaseCallback.body;
    const stageStatement = directExpressionCallStatement(
      stageCall,
      callbackBlock,
    );
    const finishStatement =
      ts.isReturnStatement(finishCall.parent) &&
      finishCall.parent.expression === finishCall &&
      finishCall.parent.parent === callbackBlock
        ? finishCall.parent
        : null;
    let exportContainer = directCallStatement(exportCalls[0]!, callbackBlock);
    if (!exportContainer) {
      const exportTry = callbackBlock.statements.find(
        (statement): statement is ts.TryStatement =>
          ts.isTryStatement(statement) &&
          !statement.catchClause &&
          statement.finallyBlock !== undefined &&
          statement.tryBlock.statements.length === 1 &&
          directCallStatement(exportCalls[0]!, statement.tryBlock) ===
            statement.tryBlock.statements[0] &&
          !statement.finallyBlock.statements.some(
            (cleanupStatement) =>
              ts.isReturnStatement(cleanupStatement) ||
              ts.isThrowStatement(cleanupStatement),
          ),
      );
      exportContainer = exportTry ?? null;
    }
    if (
      !stageStatement ||
      !finishStatement ||
      !exportContainer ||
      callbackBlock.statements.indexOf(stageStatement) >=
        callbackBlock.statements.indexOf(exportContainer) ||
      callbackBlock.statements.indexOf(exportContainer) >=
        callbackBlock.statements.indexOf(finishStatement)
    ) {
      return null;
    }
    const exportArguments = exportCalls[0]!.arguments[3]
      ? unwrapExpression(exportCalls[0]!.arguments[3]!)
      : null;
    if (
      !exportArguments ||
      !ts.isArrayLiteralExpression(exportArguments) ||
      exportArguments.elements.length === 0 ||
      !exactSymbolReference(
        exportArguments.elements[exportArguments.elements.length - 1]!,
        retryTokenSymbol,
      )
    ) {
      return null;
    }

    let forwardedStageReference: ts.Identifier | null = null;
    let forwardedFinishReference: ts.Identifier | null = null;
    let forwardedRetryTokenReference: ts.Identifier | null = null;
    if (forwardedTo) {
      const forwardingCalls: ts.CallExpression[] = [];
      const collectForwardingCalls = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const resolved = checker.getResolvedSignature(node)?.declaration;
          const receiver = callReceiver(node);
          if (
            resolved === forwardedTo &&
            receiver &&
            isExactMethodReceiver(receiver, forwardedTo)
          ) {
            forwardingCalls.push(node);
          }
        }
        ts.forEachChild(node, collectForwardingCalls);
      };
      collectForwardingCalls(declaration.body);
      if (forwardingCalls.length !== 1) return null;
      const forwardingCall = forwardingCalls[0]!;
      if (
        forwardingCall.arguments.length !== 6 ||
        !exactSymbolReference(forwardingCall.arguments[0]!, channelSymbol) ||
        !exactSymbolReference(forwardingCall.arguments[1]!, capacitySymbol) ||
        !exactSymbolReference(forwardingCall.arguments[2]!, entrySymbol) ||
        !exactSymbolReference(forwardingCall.arguments[3]!, stageSymbol) ||
        !exactSymbolReference(forwardingCall.arguments[4]!, finishSymbol) ||
        !exactSymbolReference(forwardingCall.arguments[5]!, retryTokenSymbol) ||
        !ts.isReturnStatement(forwardingCall.parent) ||
        forwardingCall.parent.expression !== forwardingCall
      ) {
        return null;
      }
      forwardedStageReference = unwrapExpression(
        forwardingCall.arguments[3]!,
      ) as ts.Identifier;
      forwardedFinishReference = unwrapExpression(
        forwardingCall.arguments[4]!,
      ) as ts.Identifier;
      forwardedRetryTokenReference = unwrapExpression(
        forwardingCall.arguments[5]!,
      ) as ts.Identifier;
    }
    const expectedStageReferences = forwardedTo ? 2 : 1;
    const expectedFinishReferences = forwardedTo ? 2 : 1;
    const retryTokenReferences = symbolReferencesIn(
      declaration.body,
      retryTokenSymbol,
    );
    const expectedRetryTokenReferences = forwardedTo ? 2 : 1;
    if (
      stageReferences.length !== expectedStageReferences ||
      finishReferences.length !== expectedFinishReferences ||
      retryTokenReferences.length !== expectedRetryTokenReferences ||
      (forwardedTo &&
        (!stageReferences.includes(forwardedStageReference!) ||
          !finishReferences.includes(forwardedFinishReference!) ||
          !retryTokenReferences.includes(forwardedRetryTokenReference!)))
    ) {
      return null;
    }
    return {
      declaration,
      stageParameterIndex: 3,
      finishParameterIndex: 4,
      leaseCallbackCalls: new Set([stageCall, finishCall]),
    };
  };
  const exactPropertyReceiverIdentifier = (
    expression: ts.Expression,
    propertyName: string,
    receiverSymbol: ts.Symbol,
  ): ts.Identifier | null => {
    const value = unwrapExpression(expression);
    if (
      !ts.isPropertyAccessExpression(value) ||
      value.name.text !== propertyName
    ) {
      return null;
    }
    const receiver = unwrapExpression(value.expression);
    return ts.isIdentifier(receiver) &&
      exactSymbolReference(receiver, receiverSymbol)
      ? receiver
      : null;
  };
  const exactPropertyOfSymbol = (
    expression: ts.Expression,
    propertyName: string,
    receiverSymbol: ts.Symbol,
  ): boolean =>
    exactPropertyReceiverIdentifier(
      expression,
      propertyName,
      receiverSymbol,
    ) !== null;
  const privateMethodCallName = (call: ts.CallExpression): string | null => {
    const callee = unwrapExpression(call.expression);
    return ts.isPropertyAccessExpression(callee) &&
      ts.isPrivateIdentifier(callee.name)
      ? callee.name.text
      : null;
  };
  const constVariableSymbol = (
    declaration: ts.VariableDeclaration,
  ): ts.Symbol | null => {
    if (
      !ts.isIdentifier(declaration.name) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return null;
    }
    return (
      canonicalSymbol(checker, checker.getSymbolAtLocation(declaration.name)) ??
      null
    );
  };
  const exactPointerWidthConversion = (
    expression: ts.Expression,
    valueSymbol: ts.Symbol,
  ): boolean => {
    const value = unwrapExpression(expression);
    if (exactSymbolReference(value, valueSymbol)) return true;
    if (
      !ts.isCallExpression(value) ||
      value.arguments.length !== 1 ||
      !exactSymbolReference(value.arguments[0]!, valueSymbol)
    ) {
      return false;
    }
    const callee = unwrapExpression(value.expression);
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "toKernelPtr" &&
      callee.expression.kind === ts.SyntaxKind.ThisKeyword
    );
  };
  const nodeInside = (node: ts.Node, owner: ts.Node): boolean =>
    owner.getStart() <= node.getStart() && node.getEnd() <= owner.getEnd();
  const directExpressionCallStatement = (
    call: ts.CallExpression,
    block: ts.Block,
  ): ts.ExpressionStatement | null =>
    ts.isExpressionStatement(call.parent) &&
    call.parent.expression === call &&
    call.parent.parent === block
      ? call.parent
      : null;
  const directCallStatement = (
    call: ts.CallExpression,
    block: ts.Block,
  ): ts.Statement | null => {
    const expressionStatement = directExpressionCallStatement(call, block);
    if (expressionStatement) return expressionStatement;
    const declaration = call.parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== call ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      declaration.parent.declarations.length !== 1 ||
      !ts.isVariableStatement(declaration.parent.parent) ||
      declaration.parent.parent.parent !== block
    ) {
      return null;
    }
    return declaration.parent.parent;
  };
  const nullComparisonIdentifier = (
    expression: ts.Expression,
    operator:
      | ts.SyntaxKind.EqualsEqualsEqualsToken
      | ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ): ts.Identifier | null => {
    const value = unwrapExpression(expression);
    if (
      !ts.isBinaryExpression(value) ||
      value.operatorToken.kind !== operator
    ) {
      return null;
    }
    const left = unwrapExpression(value.left);
    const right = unwrapExpression(value.right);
    if (ts.isIdentifier(left) && right.kind === ts.SyntaxKind.NullKeyword) {
      return left;
    }
    return left.kind === ts.SyntaxKind.NullKeyword && ts.isIdentifier(right)
      ? right
      : null;
  };
  const exactNullComparison = (
    expression: ts.Expression,
    symbol: ts.Symbol,
    operator:
      | ts.SyntaxKind.EqualsEqualsEqualsToken
      | ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ): boolean => {
    const identifier = nullComparisonIdentifier(expression, operator);
    return identifier !== null && exactSymbolReference(identifier, symbol);
  };
  /**
   * Prove the reserved-spawn raw export is one closed transaction.
   *
   * WHY: the export names no pointer; its token authorizes the Rust Vec whose
   * pointer and capacity produced `activeRegion`. Treating that raw call as a
   * scalar allowance would lose the only static proof that the staged region,
   * commit token, and unconditional cancellation all refer to one reservation.
   */
  const reviewReservedSpawnTransaction = (): ts.CallExpression | null => {
    const candidates = workerMethodCandidates("#handleSpawnAfterResolve");
    if (candidates.length !== 1) return null;
    const declaration = candidates[0]!;
    if (
      declaration.asteriskToken ||
      !declaration.body ||
      declaration.modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.AsyncKeyword ||
          modifier.kind === ts.SyntaxKind.StaticKeyword,
      )
    ) {
      return null;
    }
    const namedParameter = (name: string): ts.Symbol | null => {
      const parameter = declaration.parameters.find(
        (candidate) =>
          ts.isIdentifier(candidate.name) &&
          candidate.name.text === name &&
          !candidate.dotDotDotToken &&
          !candidate.initializer &&
          !candidate.questionToken,
      );
      return parameter && ts.isIdentifier(parameter.name)
        ? (canonicalSymbol(
            checker,
            checker.getSymbolAtLocation(parameter.name),
          ) ?? null)
        : null;
    };
    const parentPidSymbol = namedParameter("parentPid");
    const callerTidSymbol = namedParameter("callerTid");
    const blobBytesSymbol = namedParameter("blobBytes");
    const blobLenSymbol = namedParameter("blobLen");
    const entrySymbol = namedParameter("entry");
    if (
      !parentPidSymbol ||
      !callerTidSymbol ||
      !blobBytesSymbol ||
      !blobLenSymbol ||
      !entrySymbol ||
      mutatedSymbols.has(parentPidSymbol) ||
      mutatedSymbols.has(callerTidSymbol) ||
      mutatedSymbols.has(blobBytesSymbol) ||
      mutatedSymbols.has(blobLenSymbol) ||
      mutatedSymbols.has(entrySymbol)
    ) {
      return null;
    }

    const reservedSpawnDeclarations: ts.VariableDeclaration[] = [];
    const allCalls: ts.CallExpression[] = [];
    const allAssignments: ts.BinaryExpression[] = [];
    const allTryStatements: ts.TryStatement[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (
          ts.isIdentifier(node.name) &&
          node.name.text === "reservedSpawn" &&
          ts.isPropertyAccessExpression(initializer) &&
          initializer.name.text === "kernel_spawn_reserved_process"
        ) {
          reservedSpawnDeclarations.push(node);
        }
      }
      if (ts.isCallExpression(node)) allCalls.push(node);
      if (ts.isBinaryExpression(node) && isSimpleAssignment(node)) {
        allAssignments.push(node);
      }
      if (ts.isTryStatement(node)) allTryStatements.push(node);
      ts.forEachChild(node, collect);
    };
    collect(declaration.body);
    if (reservedSpawnDeclarations.length !== 1) return null;
    const reservedSpawnDeclaration = reservedSpawnDeclarations[0]!;
    const reservedSpawnSymbol = constVariableSymbol(reservedSpawnDeclaration);
    if (!reservedSpawnSymbol) return null;
    const reservedSpawnReferences = symbolReferencesIn(
      declaration.body,
      reservedSpawnSymbol,
    );
    const commitCalls = reservedSpawnReferences
      .map(directCallbackCallForReference)
      .filter((call): call is ts.CallExpression => call !== null);
    if (commitCalls.length !== 1) return null;
    const commitCall = commitCalls[0]!;
    for (const reference of reservedSpawnReferences) {
      if (
        reference === reservedSpawnDeclaration.name ||
        directCallbackCallForReference(reference) === commitCall ||
        ts.isTypeOfExpression(reference.parent)
      ) {
        continue;
      }
      return null;
    }
    if (
      commitCall.arguments.length !== 4 ||
      !exactSymbolReference(commitCall.arguments[0]!, parentPidSymbol) ||
      !exactSymbolReference(commitCall.arguments[1]!, callerTidSymbol)
    ) {
      return null;
    }

    const callback = enclosingFunction(commitCall);
    if (
      !callback ||
      !ts.isArrowFunction(callback) ||
      callback.asteriskToken ||
      callback.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      ) ||
      callback.parameters.length !== 1 ||
      !callback.parameters[0] ||
      !ts.isIdentifier(callback.parameters[0].name) ||
      !ts.isCallExpression(callback.parent) ||
      callback.parent.arguments.length !== 1 ||
      callback.parent.arguments[0] !== callback ||
      !ts.isBlock(callback.body)
    ) {
      return null;
    }
    const withLeaseCall = callback.parent;
    const withLeaseCallee = unwrapExpression(withLeaseCall.expression);
    if (
      !ts.isPropertyAccessExpression(withLeaseCallee) ||
      withLeaseCallee.name.text !== "withLease"
    ) {
      return null;
    }
    const activeRegionExpression = unwrapExpression(withLeaseCallee.expression);
    if (!ts.isIdentifier(activeRegionExpression)) return null;
    const activeRegionSymbol = canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(activeRegionExpression),
    );
    const activeRegionDeclaration = activeRegionSymbol?.valueDeclaration;
    if (
      !activeRegionSymbol ||
      !activeRegionDeclaration ||
      !ts.isVariableDeclaration(activeRegionDeclaration) ||
      constVariableSymbol(activeRegionDeclaration) !== activeRegionSymbol ||
      !activeRegionDeclaration.initializer
    ) {
      return null;
    }
    const reservationRegion = unwrapExpression(
      activeRegionDeclaration.initializer,
    );
    if (
      !ts.isPropertyAccessExpression(reservationRegion) ||
      reservationRegion.name.text !== "region" ||
      !ts.isIdentifier(unwrapExpression(reservationRegion.expression))
    ) {
      return null;
    }
    const reservationExpression = unwrapExpression(
      reservationRegion.expression,
    ) as ts.Identifier;
    const reservationSymbol = canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(reservationExpression),
    );
    const reservationDeclaration = reservationSymbol?.valueDeclaration;
    if (
      !reservationSymbol ||
      !reservationDeclaration ||
      !ts.isVariableDeclaration(reservationDeclaration) ||
      !ts.isIdentifier(reservationDeclaration.name) ||
      !reservationDeclaration.initializer ||
      unwrapExpression(reservationDeclaration.initializer).kind !==
        ts.SyntaxKind.NullKeyword ||
      !ts.isVariableDeclarationList(reservationDeclaration.parent) ||
      (reservationDeclaration.parent.flags & ts.NodeFlags.Let) === 0
    ) {
      return null;
    }
    const activeRegionReferences = symbolReferencesIn(
      declaration.body,
      activeRegionSymbol,
    );
    if (
      activeRegionReferences.length !== 2 ||
      !activeRegionReferences.includes(activeRegionDeclaration.name) ||
      !activeRegionReferences.includes(activeRegionExpression)
    ) {
      return null;
    }

    const activeTokenExpression = unwrapExpression(commitCall.arguments[2]!);
    if (!ts.isIdentifier(activeTokenExpression)) return null;
    const activeTokenSymbol = canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(activeTokenExpression),
    );
    const activeTokenDeclaration = activeTokenSymbol?.valueDeclaration;
    if (
      !activeTokenSymbol ||
      !activeTokenDeclaration ||
      !ts.isVariableDeclaration(activeTokenDeclaration) ||
      constVariableSymbol(activeTokenDeclaration) !== activeTokenSymbol ||
      !activeTokenDeclaration.initializer
    ) {
      return null;
    }
    const activeTokenReservationExpression = exactPropertyReceiverIdentifier(
      activeTokenDeclaration.initializer,
      "token",
      reservationSymbol,
    );
    if (!activeTokenReservationExpression) return null;
    const activeTokenReferences = symbolReferencesIn(
      declaration.body,
      activeTokenSymbol,
    );
    if (
      activeTokenReferences.length !== 2 ||
      !activeTokenReferences.includes(activeTokenDeclaration.name) ||
      !activeTokenReferences.includes(activeTokenExpression)
    ) {
      return null;
    }
    if (
      activeRegionDeclaration.parent.parent.parent !==
        activeTokenDeclaration.parent.parent.parent ||
      !(
        activeRegionDeclaration.getStart() < activeTokenDeclaration.getStart()
      ) ||
      !(activeTokenDeclaration.getEnd() < withLeaseCall.getStart())
    ) {
      return null;
    }

    const scratchParameter = callback.parameters[0]!;
    const scratchSymbol = canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(scratchParameter.name as ts.Identifier),
    );
    if (!scratchSymbol) return null;
    const copyCalls = allCalls.filter((call) => {
      if (enclosingFunction(call) !== callback) return false;
      const callee = unwrapExpression(call.expression);
      return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "copyFrom" &&
        exactSymbolReference(callee.expression, scratchSymbol)
      );
    });
    if (
      copyCalls.length !== 1 ||
      copyCalls[0]!.arguments.length !== 4 ||
      !exactSymbolReference(copyCalls[0]!.arguments[0]!, blobBytesSymbol) ||
      !(
        ts.isNumericLiteral(unwrapExpression(copyCalls[0]!.arguments[1]!)) &&
        Number(
          (unwrapExpression(copyCalls[0]!.arguments[1]!) as ts.NumericLiteral)
            .text,
        ) === 0
      ) ||
      !(
        ts.isNumericLiteral(unwrapExpression(copyCalls[0]!.arguments[2]!)) &&
        Number(
          (unwrapExpression(copyCalls[0]!.arguments[2]!) as ts.NumericLiteral)
            .text,
        ) === 0
      ) ||
      !exactSymbolReference(copyCalls[0]!.arguments[3]!, blobLenSymbol) ||
      !exactPointerWidthConversion(commitCall.arguments[3]!, blobLenSymbol)
    ) {
      return null;
    }
    const copyStatement = directExpressionCallStatement(
      copyCalls[0]!,
      callback.body,
    );
    const commitResultDeclaration = commitCall.parent;
    if (
      !copyStatement ||
      !ts.isVariableDeclaration(commitResultDeclaration) ||
      commitResultDeclaration.initializer !== commitCall ||
      !constVariableSymbol(commitResultDeclaration) ||
      !ts.isVariableDeclarationList(commitResultDeclaration.parent) ||
      commitResultDeclaration.parent.declarations.length !== 1 ||
      !ts.isVariableStatement(commitResultDeclaration.parent.parent) ||
      commitResultDeclaration.parent.parent.parent !== callback.body
    ) {
      return null;
    }
    const commitStatement = commitResultDeclaration.parent.parent;
    if (
      callback.body.statements.indexOf(copyStatement) >=
      callback.body.statements.indexOf(commitStatement)
    ) {
      return null;
    }
    const scratchReferences = symbolReferencesIn(callback, scratchSymbol);
    if (
      scratchReferences.length !== 2 ||
      !scratchReferences.includes(scratchParameter.name as ts.Identifier)
    ) {
      return null;
    }

    const beginCalls = allCalls.filter(
      (call) => privateMethodCallName(call) === "#beginLargeSpawnScratch",
    );
    if (
      beginCalls.length !== 1 ||
      beginCalls[0]!.arguments.length !== 2 ||
      !exactSymbolReference(beginCalls[0]!.arguments[0]!, blobLenSymbol) ||
      !exactSymbolReference(beginCalls[0]!.arguments[1]!, entrySymbol)
    ) {
      return null;
    }
    const beginCall = beginCalls[0]!;
    const begunDeclaration = beginCall.parent;
    if (
      !ts.isVariableDeclaration(begunDeclaration) ||
      begunDeclaration.initializer !== beginCall ||
      !ts.isIdentifier(begunDeclaration.name)
    ) {
      return null;
    }
    const begunSymbol = canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(begunDeclaration.name),
    );
    if (!begunSymbol || constVariableSymbol(begunDeclaration) !== begunSymbol) {
      return null;
    }
    const reservationAssignments = allAssignments.filter((assignment) =>
      exactSymbolReference(assignment.left, reservationSymbol),
    );
    const reservationAssignment = reservationAssignments[0];
    const reservationAssignmentLeft = reservationAssignment
      ? unwrapExpression(reservationAssignment.left)
      : null;
    const begunReservationExpression = reservationAssignment
      ? exactPropertyReceiverIdentifier(
          reservationAssignment.right,
          "reservation",
          begunSymbol,
        )
      : null;
    if (
      reservationAssignments.length !== 1 ||
      !reservationAssignment ||
      !reservationAssignmentLeft ||
      !ts.isIdentifier(reservationAssignmentLeft) ||
      !begunReservationExpression
    ) {
      return null;
    }

    const transactionTries = allTryStatements.filter(
      (statement) =>
        statement.finallyBlock &&
        nodeInside(beginCall, statement.tryBlock) &&
        nodeInside(commitCall, statement.tryBlock),
    );
    if (transactionTries.length !== 1) return null;
    const transactionTry = transactionTries[0]!;
    const beginStatement = directCallStatement(
      beginCall,
      transactionTry.tryBlock,
    );
    const reservationAssignmentStatement =
      ts.isExpressionStatement(reservationAssignment.parent) &&
      reservationAssignment.parent.expression === reservationAssignment &&
      reservationAssignment.parent.parent === transactionTry.tryBlock
        ? reservationAssignment.parent
        : null;

    let liveRegionIf: ts.IfStatement | null = null;
    let liveRegionConditionReference: ts.Identifier | null = null;
    let liveRegionBranch: ts.Statement | null = null;
    let ancestor: ts.Node = activeRegionDeclaration;
    while (ancestor.parent && ancestor !== transactionTry.tryBlock) {
      const parent = ancestor.parent;
      if (ts.isIfStatement(parent)) {
        let condition = unwrapExpression(parent.expression);
        let negated = false;
        if (
          ts.isPrefixUnaryExpression(condition) &&
          condition.operator === ts.SyntaxKind.ExclamationToken
        ) {
          negated = true;
          condition = unwrapExpression(condition.operand);
        }
        const conditionReference = exactPropertyReceiverIdentifier(
          condition,
          "region",
          reservationSymbol,
        );
        const branch = negated ? parent.elseStatement : parent.thenStatement;
        if (
          conditionReference &&
          branch &&
          nodeInside(activeRegionDeclaration, branch)
        ) {
          liveRegionIf = parent;
          liveRegionConditionReference = conditionReference;
          liveRegionBranch = branch;
          break;
        }
      }
      ancestor = parent;
    }
    if (
      !beginStatement ||
      !reservationAssignmentStatement ||
      !liveRegionIf ||
      !liveRegionConditionReference ||
      !liveRegionBranch ||
      liveRegionIf.parent !== transactionTry.tryBlock ||
      !ts.isBlock(liveRegionBranch) ||
      !nodeInside(activeTokenDeclaration, liveRegionBranch) ||
      !nodeInside(withLeaseCall, liveRegionBranch) ||
      transactionTry.tryBlock.statements.length !== 3 ||
      transactionTry.tryBlock.statements[0] !== beginStatement ||
      transactionTry.tryBlock.statements[1] !==
        reservationAssignmentStatement ||
      transactionTry.tryBlock.statements[2] !== liveRegionIf
    ) {
      return null;
    }
    const activeRegionStatement =
      ts.isVariableDeclarationList(activeRegionDeclaration.parent) &&
      ts.isVariableStatement(activeRegionDeclaration.parent.parent) &&
      activeRegionDeclaration.parent.parent.parent === liveRegionBranch
        ? activeRegionDeclaration.parent.parent
        : null;
    const activeTokenStatement =
      ts.isVariableDeclarationList(activeTokenDeclaration.parent) &&
      ts.isVariableStatement(activeTokenDeclaration.parent.parent) &&
      activeTokenDeclaration.parent.parent.parent === liveRegionBranch
        ? activeTokenDeclaration.parent.parent
        : null;
    const withLeaseAssignment = withLeaseCall.parent;
    const withLeaseStatement =
      ts.isBinaryExpression(withLeaseAssignment) &&
      isSimpleAssignment(withLeaseAssignment) &&
      withLeaseAssignment.right === withLeaseCall &&
      ts.isExpressionStatement(withLeaseAssignment.parent) &&
      withLeaseAssignment.parent.expression === withLeaseAssignment &&
      withLeaseAssignment.parent.parent === liveRegionBranch
        ? withLeaseAssignment.parent
        : null;
    if (
      !activeRegionStatement ||
      !activeTokenStatement ||
      !withLeaseStatement ||
      liveRegionBranch.statements.length !== 3 ||
      liveRegionBranch.statements[0] !== activeRegionStatement ||
      liveRegionBranch.statements[1] !== activeTokenStatement ||
      liveRegionBranch.statements[2] !== withLeaseStatement
    ) {
      return null;
    }

    const rawCancelCalls = allCalls.filter(
      (call) => privateMethodCallName(call) === "#cancelLargeSpawnScratch",
    );
    const cancelCall = rawCancelCalls[0];
    const cancelReservationExpression =
      cancelCall &&
      cancelCall.arguments.length === 2 &&
      exactSymbolReference(cancelCall.arguments[1]!, entrySymbol)
        ? exactPropertyReceiverIdentifier(
            cancelCall.arguments[0]!,
            "token",
            reservationSymbol,
          )
        : null;
    const revokeCalls = allCalls.filter((call) => {
      const callee = unwrapExpression(call.expression);
      return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "revoke" &&
        exactPropertyOfSymbol(callee.expression, "region", reservationSymbol)
      );
    });
    const revokeCall = revokeCalls[0];
    const revokeCallee = revokeCall
      ? unwrapExpression(revokeCall.expression)
      : null;
    const revokeReservationExpression =
      revokeCallee && ts.isPropertyAccessExpression(revokeCallee)
        ? exactPropertyReceiverIdentifier(
            revokeCallee.expression,
            "region",
            reservationSymbol,
          )
        : null;
    if (
      rawCancelCalls.length !== 1 ||
      !cancelCall ||
      !cancelReservationExpression ||
      revokeCalls.length !== 1 ||
      !revokeCall ||
      !revokeReservationExpression
    ) {
      return null;
    }

    const cleanupGuards = transactionTry.finallyBlock!.statements.filter(
      (statement): statement is ts.IfStatement =>
        ts.isIfStatement(statement) &&
        !statement.elseStatement &&
        ts.isIdentifier(unwrapExpression(statement.expression)) &&
        exactSymbolReference(statement.expression, reservationSymbol) &&
        ts.isBlock(statement.thenStatement) &&
        nodeInside(revokeCall, statement.thenStatement) &&
        nodeInside(cancelCall, statement.thenStatement),
    );
    if (cleanupGuards.length !== 1) return null;
    const cleanupGuard = cleanupGuards[0]!;
    const cleanupGuardReference = unwrapExpression(
      cleanupGuard.expression,
    ) as ts.Identifier;
    const cleanupBlock = cleanupGuard.thenStatement as ts.Block;

    const simpleRevokeStatement = directExpressionCallStatement(
      revokeCall,
      cleanupBlock,
    );
    const simpleCancelStatement = directExpressionCallStatement(
      cancelCall,
      cleanupBlock,
    );
    const simpleCleanup =
      cleanupBlock.statements.length === 2 &&
      cleanupBlock.statements[0] === simpleRevokeStatement &&
      cleanupBlock.statements[1] === simpleCancelStatement;

    let fatalAwareCleanup = false;
    if (
      !simpleCleanup &&
      cleanupBlock.statements.length === 2 &&
      ts.isTryStatement(cleanupBlock.statements[0]) &&
      ts.isIfStatement(cleanupBlock.statements[1])
    ) {
      const revokeTry = cleanupBlock.statements[0];
      const cancelGuard = cleanupBlock.statements[1];
      const fatalIdentifier = nullComparisonIdentifier(
        cancelGuard.expression,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
      );
      const fatalSymbol = fatalIdentifier
        ? canonicalSymbol(checker, checker.getSymbolAtLocation(fatalIdentifier))
        : undefined;
      const fatalDeclaration = fatalSymbol?.valueDeclaration;
      const cancelGuardBody = cancelGuard.thenStatement;
      const cancelTry =
        ts.isBlock(cancelGuardBody) &&
        cancelGuardBody.statements.length === 1 &&
        ts.isTryStatement(cancelGuardBody.statements[0])
          ? cancelGuardBody.statements[0]
          : null;
      const directRevokeStatement = directExpressionCallStatement(
        revokeCall,
        revokeTry.tryBlock,
      );
      const directCancelStatement = cancelTry
        ? directCallStatement(cancelCall, cancelTry.tryBlock)
        : null;
      const cleanupFatalAssignment = (
        block: ts.Block | undefined,
        acceptedOperators: readonly ts.SyntaxKind[],
      ): boolean =>
        Boolean(
          block &&
          fatalSymbol &&
          block.statements.some((statement) => {
            if (
              !ts.isExpressionStatement(statement) ||
              !ts.isBinaryExpression(statement.expression) ||
              !acceptedOperators.includes(
                statement.expression.operatorToken.kind,
              ) ||
              !exactSymbolReference(statement.expression.left, fatalSymbol)
            ) {
              return false;
            }
            const right = unwrapExpression(statement.expression.right);
            const callee = ts.isNewExpression(right)
              ? unwrapExpression(right.expression)
              : null;
            return (
              callee !== null &&
              ts.isIdentifier(callee) &&
              callee.text === "KernelTransferExecuteTrapError"
            );
          }),
        );
      const resetGuard = transactionTry.finallyBlock!.statements[1];
      const transactionBlock = transactionTry.parent;
      const postTransactionThrow = ts.isBlock(transactionBlock)
        ? transactionBlock.statements.find(
            (statement) =>
              statement.getStart() > transactionTry.getEnd() &&
              ts.isIfStatement(statement) &&
              fatalSymbol &&
              exactNullComparison(
                statement.expression,
                fatalSymbol,
                ts.SyntaxKind.ExclamationEqualsEqualsToken,
              ) &&
              ts.isThrowStatement(statement.thenStatement) &&
              exactSymbolReference(
                statement.thenStatement.expression,
                fatalSymbol,
              ),
          )
        : undefined;
      const resetAssignment =
        resetGuard &&
        ts.isIfStatement(resetGuard) &&
        fatalSymbol &&
        exactNullComparison(
          resetGuard.expression,
          fatalSymbol,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
        ) &&
        ts.isExpressionStatement(resetGuard.thenStatement) &&
        ts.isBinaryExpression(resetGuard.thenStatement.expression) &&
        isSimpleAssignment(resetGuard.thenStatement.expression)
          ? resetGuard.thenStatement.expression
          : null;
      const resetTarget = resetAssignment
        ? unwrapExpression(resetAssignment.left)
        : null;
      fatalAwareCleanup = Boolean(
        fatalSymbol &&
        fatalDeclaration &&
        ts.isVariableDeclaration(fatalDeclaration) &&
        fatalDeclaration.initializer &&
        unwrapExpression(fatalDeclaration.initializer).kind ===
          ts.SyntaxKind.NullKeyword &&
        !cancelGuard.elseStatement &&
        exactNullComparison(
          cancelGuard.expression,
          fatalSymbol,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
        ) &&
        revokeTry.tryBlock.statements.length === 1 &&
        revokeTry.tryBlock.statements[0] === directRevokeStatement &&
        cleanupFatalAssignment(revokeTry.catchClause?.block, [
          ts.SyntaxKind.EqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken,
        ]) &&
        cancelTry &&
        cancelTry.tryBlock.statements[0] === directCancelStatement &&
        cleanupFatalAssignment(cancelTry.catchClause?.block, [
          ts.SyntaxKind.EqualsToken,
        ]) &&
        transactionTry.finallyBlock!.statements.length === 2 &&
        resetGuard !== undefined &&
        resetAssignment &&
        resetTarget &&
        ts.isPropertyAccessExpression(resetTarget) &&
        ts.isPrivateIdentifier(resetTarget.name) &&
        resetTarget.name.text === "#largeSpawnScratchInUse" &&
        resetTarget.expression.kind === ts.SyntaxKind.ThisKeyword &&
        unwrapExpression(resetAssignment.right).kind ===
          ts.SyntaxKind.FalseKeyword &&
        postTransactionThrow,
      );
    }
    if (!simpleCleanup && !fatalAwareCleanup) return null;

    const allowedReservationReferences = new Set<ts.Identifier>([
      reservationDeclaration.name,
      reservationAssignmentLeft,
      reservationExpression,
      activeTokenReservationExpression,
      liveRegionConditionReference,
      cleanupGuardReference,
      revokeReservationExpression,
      cancelReservationExpression,
    ]);
    const reservationReferences = symbolReferencesIn(
      declaration.body,
      reservationSymbol,
    );
    if (
      reservationReferences.length !== allowedReservationReferences.size ||
      reservationReferences.some(
        (reference) => !allowedReservationReferences.has(reference),
      )
    ) {
      return null;
    }
    return commitCall;
  };
  const reviewedReservedSpawnCall = reviewReservedSpawnTransaction();
  const reviewedReservedChannelDispatch = reviewTwoPhaseLeaseMethod(
    "#executeReservedChannelDispatch",
    "kernel_transfer_channel_execute",
  );
  const reviewedCapacityOwnedChannel = reviewedReservedChannelDispatch
    ? reviewTwoPhaseLeaseMethod(
        "#executeCapacityOwnedChannel",
        "kernel_handle_channel",
        reviewedReservedChannelDispatch.declaration,
      )
    : null;
  const reviewedTwoPhaseLeaseCallbackCalls = new Set<ts.CallExpression>();
  if (reviewedReservedChannelDispatch) {
    for (const call of reviewedReservedChannelDispatch.leaseCallbackCalls) {
      reviewedTwoPhaseLeaseCallbackCalls.add(call);
    }
  }
  if (reviewedCapacityOwnedChannel) {
    for (const call of reviewedCapacityOwnedChannel.leaseCallbackCalls) {
      reviewedTwoPhaseLeaseCallbackCalls.add(call);
    }
  }
  const inlineTwoPhaseLeaseCallback = (
    call: ts.CallExpression,
    argumentIndex: number,
  ): ts.FunctionLikeDeclaration | null => {
    const argument = call.arguments[argumentIndex];
    if (!argument) return null;
    const callback = unwrapExpression(argument);
    if (
      !ts.isArrowFunction(callback) ||
      callback.asteriskToken ||
      callback.parameters.length !== 1 ||
      !callback.parameters[0] ||
      !ts.isIdentifier(callback.parameters[0].name) ||
      callback.parameters[0].dotDotDotToken ||
      callback.parameters[0].initializer ||
      callback.parameters[0].questionToken ||
      callback.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      )
    ) {
      return null;
    }
    return callback;
  };
  const invalidTwoPhaseLeaseCalls = new Set<ts.CallExpression>();
  if (reviewedCapacityOwnedChannel) {
    for (const sourceFile of sourceFiles) {
      const collect = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const resolved = checker.getResolvedSignature(node)?.declaration;
          const receiver = callReceiver(node);
          if (
            resolved === reviewedCapacityOwnedChannel.declaration &&
            receiver &&
            isExactMethodReceiver(
              receiver,
              reviewedCapacityOwnedChannel.declaration,
            )
          ) {
            const stage = inlineTwoPhaseLeaseCallback(
              node,
              reviewedCapacityOwnedChannel.stageParameterIndex,
            );
            const finish = inlineTwoPhaseLeaseCallback(
              node,
              reviewedCapacityOwnedChannel.finishParameterIndex,
            );
            if (
              node.arguments.length !==
                reviewedCapacityOwnedChannel.declaration.parameters.length ||
              !stage ||
              !finish
            ) {
              invalidTwoPhaseLeaseCalls.add(node);
            } else {
              for (const callback of [stage, finish]) {
                const parameter = callback.parameters[0]!;
                const symbol = canonicalSymbol(
                  checker,
                  checker.getSymbolAtLocation(parameter.name as ts.Identifier),
                );
                if (symbol) leaseOriginCallbacks.set(symbol, callback);
              }
            }
          }
        }
        ts.forEachChild(node, collect);
      };
      collect(sourceFile);
    }
  }
  const activeLeaseCallbacks = new Set(leaseOriginCallbacks.values());
  const isRealScratchWithLeaseCall = (call: ts.CallExpression): boolean => {
    if (!isKernelScratchWithLeaseCall(call, checker)) return false;
    const receiver = callReceiver(call);
    return Boolean(receiver && isExactScratchRegionOrigin(receiver));
  };
  const isRealScratchLeaseMemberCall = (call: ts.CallExpression): boolean => {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (!isScratchLeaseMemberSymbol(symbolAtExpression(checker, callee))) {
      return false;
    }
    if (reviewedEntryScratchInvoker?.leaseCalls.has(call)) {
      return true;
    }
    for (const consumer of reviewedLinearLeaseConsumers.values()) {
      if (consumer.leaseCalls.has(call)) return true;
    }
    const origin = leaseOriginSymbol(callee.expression);
    const callback = origin ? leaseOriginCallbacks.get(origin) : undefined;
    return Boolean(callback && enclosingFunction(call) === callback);
  };
  const isIdentifierValueReference = (identifier: ts.Identifier): boolean => {
    const parent = identifier.parent;
    if (
      ts.isShorthandPropertyAssignment(parent) &&
      parent.name === identifier
    ) {
      return true;
    }
    if (
      (parent as ts.NamedDeclaration).name === identifier ||
      (ts.isBindingElement(parent) &&
        (parent.name === identifier || parent.propertyName === identifier)) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
      (ts.isPropertyAssignment(parent) && parent.name === identifier)
    ) {
      return false;
    }
    return true;
  };
  const transparentCapabilityExpression = (
    expression: ts.Expression,
    retainsCapability: (candidate: ts.Expression) => boolean,
  ): ts.Expression | null => {
    let value = expression;
    while (
      value.parent &&
      isTransparentScratchUseWrapper(value.parent, value)
    ) {
      value = value.parent;
      if (!retainsCapability(value)) return null;
    }
    return value;
  };
  const isImmutableCapabilityAlias = (
    expression: ts.Expression,
    retainsCapability: (candidate: ts.Expression) => boolean,
  ): boolean => {
    const value = transparentCapabilityExpression(
      expression,
      retainsCapability,
    );
    if (!value) return false;
    const declaration = value.parent;
    return Boolean(
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === value &&
      ts.isIdentifier(declaration.name) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      retainsCapability(declaration.name),
    );
  };
  const isAllowedActiveLeaseReference = (
    identifier: ts.Identifier,
    callback: ts.FunctionLikeDeclaration,
  ): boolean => {
    const retainsLease = (candidate: ts.Expression): boolean =>
      expressionTypeHasScratchMember(candidate, "invokeKernelExport");
    const value = transparentCapabilityExpression(identifier, retainsLease);
    if (!value) return false;
    const parent = value.parent;
    if (
      parent &&
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === value &&
      retainsLease(value)
    ) {
      const member = symbolAtExpression(checker, parent);
      return (
        isScratchLeaseMemberSymbol(member) &&
        !isScratchAddressSymbol(member) &&
        !propertyAccessIsMutation(parent) &&
        enclosingFunction(identifier) === callback
      );
    }
    if (
      parent &&
      ts.isCallExpression(parent) &&
      parent.arguments[1] === value &&
      isReviewedEntryScratchInvokerCall(parent) &&
      enclosingFunction(identifier) === callback
    ) {
      // WHY: this one true-private worker method is statically proved above
      // to synchronously forward the lease only to its two genuine invocation
      // members. It cannot retain, return, structurally erase, or reflect the
      // lease, so callers keep the exact withLease callback lifetime.
      return true;
    }
    if (
      parent &&
      ts.isCallExpression(parent) &&
      parent.arguments[0] === value &&
      reviewedTwoPhaseLeaseCallbackCalls.has(parent) &&
      enclosingFunction(identifier) === callback
    ) {
      // WHY: the two exact private dispatchers are re-proved above as rigid
      // stage → one kernel export → finish transactions. Their callback
      // parameters are never stored, returned, reflected, or invoked outside
      // the active withLease callback.
      return true;
    }
    if (parent && ts.isCallExpression(parent)) {
      const consumer = reviewedLinearLeaseConsumerForCall(parent);
      if (
        consumer &&
        parent.arguments[consumer.leaseArgumentIndex] === value &&
        enclosingFunction(identifier) === callback
      ) {
        // WHY: each admitted true-private helper is re-proved above on every
        // audit run. Every reference to its lease parameter must be one direct
        // synchronous call to the single reviewed copy member, so the helper
        // cannot store, return, reflect, or asynchronously capture the lease.
        return true;
      }
    }
    return (
      enclosingFunction(identifier) === callback &&
      isImmutableCapabilityAlias(identifier, retainsLease)
    );
  };
  const propertyAccessIsMutation = (
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): boolean => {
    const parent = access.parent;
    return (
      (ts.isBinaryExpression(parent) &&
        parent.left === access &&
        isAssignmentOperator(parent.operatorToken.kind)) ||
      ((ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)) &&
        parent.operand === access) ||
      (ts.isDeleteExpression(parent) && parent.expression === access)
    );
  };
  const findings: AuditFinding[] = [];
  const addFinding = (
    sourceFile: ts.SourceFile,
    node: ts.Node,
    kind: AuditFinding["kind"],
  ): void => {
    findings.push(findingFor(options.rootDir, sourceFile, node, kind));
  };
  const kernelExportUseKind = (
    state: ValueState,
  ): "kernel-pointer-export-bypass" | "kernel-export-direct-use" | null => {
    if (hasAuditedKernelExport(state, kernelScratchExportContract.names)) {
      return "kernel-pointer-export-bypass";
    }
    return hasAuditedKernelExport(state, auditedKernelExports)
      ? "kernel-export-direct-use"
      : null;
  };
  const addKernelExportUseFinding = (
    sourceFile: ts.SourceFile,
    node: ts.Node,
    state: ValueState,
  ): void => {
    const kind = kernelExportUseKind(state);
    if (kind !== null) addFinding(sourceFile, node, kind);
  };
  const directReflectedKernelExportUseKind = (
    call: ts.CallExpression,
  ): "kernel-pointer-export-bypass" | "kernel-export-direct-use" | null => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (!declaration || !isIntrinsicLibDeclaration(declaration)) return null;
    let owner = signatureOwnerName(declaration);
    if (!owner) {
      for (
        let current: ts.Node | undefined = declaration.parent;
        current;
        current = current.parent
      ) {
        if (ts.isModuleDeclaration(current) && ts.isIdentifier(current.name)) {
          owner = current.name.text;
          break;
        }
      }
    }
    const member =
      callPropertyName(call) ??
      propertyNameText((declaration as ts.NamedDeclaration).name) ??
      declarationName(declaration);
    const readsOneProperty =
      (owner === "Reflect" &&
        (member === "get" || member === "getOwnPropertyDescriptor")) ||
      (owner === "ObjectConstructor" && member === "getOwnPropertyDescriptor");
    if (readsOneProperty) {
      if (call.arguments.length < 2) return null;
      const targetState = expressionState(
        call.arguments[0]!,
        checker,
        states,
        programSources,
      );
      if ((targetState.exportNamespace & KERNEL_OWNER) === 0) return null;

      // WHY: a reflective read returns the raw callable (or a descriptor whose
      // value is that callable) without traversing a property-access node.
      // Keep dynamic names in the pointer-bearing class because they may select
      // any scratch borrower; literal names retain the generated-name split.
      const property = unwrapExpression(
        immutableConstValue(call.arguments[1]!, checker),
      );
      if (!ts.isStringLiteralLike(property)) {
        return "kernel-pointer-export-bypass";
      }
      if (kernelScratchExportContract.names.has(property.text)) {
        return "kernel-pointer-export-bypass";
      }
      return auditedKernelExports.has(property.text)
        ? "kernel-export-direct-use"
        : null;
    }

    return null;
  };
  const containsKernelExportNamespace = (
    state: ValueState,
    seen = new Set<ValueState>(),
  ): boolean => {
    if (seen.has(state)) return false;
    seen.add(state);
    if ((state.exportNamespace & KERNEL_OWNER) !== 0) return true;
    for (const property of state.properties.values()) {
      if (containsKernelExportNamespace(property, seen)) return true;
    }
    for (const property of state.hiddenProperties.values()) {
      if (containsKernelExportNamespace(property, seen)) return true;
    }
    return state.elements
      ? containsKernelExportNamespace(state.elements, seen)
      : false;
  };
  const expressionContainsKernelExportNamespace = (
    expression: ts.Expression,
  ): boolean => {
    const node = unwrapExpression(expression);
    if (ts.isSpreadElement(node)) {
      return expressionContainsKernelExportNamespace(node.expression);
    }
    return containsKernelExportNamespace(
      expressionState(node, checker, states, programSources),
    );
  };
  const ownershipWitness = (
    expression: ts.Expression,
    form: KernelOwnershipForm,
  ): ts.Expression => {
    const node = unwrapExpression(expression);
    const state = expressionState(node, checker, states, programSources);
    if ((state[form] & KERNEL_OWNER) !== 0) return node;
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        let value: ts.Expression | undefined;
        if (ts.isPropertyAssignment(property)) {
          value = property.initializer;
        } else if (ts.isShorthandPropertyAssignment(property)) {
          value = property.name;
        } else if (ts.isSpreadAssignment(property)) {
          value = property.expression;
        }
        if (
          value &&
          hasKernelOwnership(
            expressionState(value, checker, states, programSources),
            form,
          )
        ) {
          return ownershipWitness(value, form);
        }
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) continue;
        const value = ts.isSpreadElement(element)
          ? element.expression
          : element;
        if (
          hasKernelOwnership(
            expressionState(value, checker, states, programSources),
            form,
          )
        ) {
          return ownershipWitness(value, form);
        }
      }
    } else if (ts.isConditionalExpression(node)) {
      for (const value of [node.whenTrue, node.whenFalse]) {
        if (
          hasKernelOwnership(
            expressionState(value, checker, states, programSources),
            form,
          )
        ) {
          return ownershipWitness(value, form);
        }
      }
    }
    return node;
  };
  const addOwnershipFindings = (
    sourceFile: ts.SourceFile,
    node: ts.Node,
    state: ValueState,
    site: "escape" | "return" | "store",
    admitReadOnlyView = false,
    seededTarget?: ts.Symbol,
    witnessExpression?: ts.Expression,
  ): void => {
    if (
      !admitReadOnlyView &&
      hasKernelOwnership(state, "view") &&
      !(
        seededTarget &&
        hasKernelOwnership(stateFor(seededValueStates, seededTarget), "view")
      )
    ) {
      addFinding(
        sourceFile,
        witnessExpression && (state.view & KERNEL_OWNER) === 0
          ? ownershipWitness(witnessExpression, "view")
          : node,
        `kernel-view-${site}`,
      );
    }
    if (
      hasKernelOwnership(state, "buffer") &&
      !(
        seededTarget &&
        hasKernelOwnership(stateFor(seededValueStates, seededTarget), "buffer")
      )
    ) {
      addFinding(
        sourceFile,
        witnessExpression && (state.buffer & KERNEL_OWNER) === 0
          ? ownershipWitness(witnessExpression, "buffer")
          : node,
        `kernel-buffer-${site}`,
      );
    }
    if (
      hasKernelOwnership(state, "memory") &&
      !(
        seededTarget &&
        hasKernelOwnership(stateFor(seededValueStates, seededTarget), "memory")
      )
    ) {
      addFinding(
        sourceFile,
        witnessExpression && (state.memory & KERNEL_OWNER) === 0
          ? ownershipWitness(witnessExpression, "memory")
          : node,
        `kernel-memory-${site}`,
      );
    }
  };

  for (const sourceFile of sourceFiles) {
    let lastVisitedNode: ts.Node = sourceFile;
    const visit = (node: ts.Node): void => {
      lastVisitedNode = node;
      if (
        (ts.isMethodSignature(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isPropertySignature(node) ||
          ts.isPropertyDeclaration(node)) &&
        isScratchAddressSymbol(symbolForDeclaration(checker, node))
      ) {
        // The opaque export-pointer token replaced the irrevocable numeric
        // address. Reintroducing this member would reopen every primitive-flow
        // bypass the contract is intended to eliminate.
        addFinding(sourceFile, node, "scratch-address-contract");
      }
      if (ts.isExpression(node) && invalidSeedAssignmentExpressions.has(node)) {
        // A seed is an ownership root, not a permanent blessing for whatever
        // value is later assigned to that slot.
        addFinding(sourceFile, node, "scratch-address-contract");
      }
      if (ts.isCallExpression(node) && reflectedSeedMutationCalls.has(node)) {
        addFinding(sourceFile, node, "scratch-address-contract");
      }
      if (ts.isIdentifier(node) && isIdentifierValueReference(node)) {
        const leaseOrigin = leaseOriginSymbol(node);
        const leaseCallback = leaseOrigin
          ? leaseOriginCallbacks.get(leaseOrigin)
          : undefined;
        if (
          leaseCallback &&
          !isAllowedActiveLeaseReference(node, leaseCallback)
        ) {
          // WHY: only a lease minted by this exact synchronous callback can
          // create an opaque export pointer or invoke the bound kernel export.
          // Casts, helpers, reflection, and mutable aliases erase that origin.
          addFinding(sourceFile, node, "scratch-address-contract");
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        expressionState(node.initializer, checker, states, programSources)
          .scratchRegion &&
        !expressionTypeHasScratchMember(node.name, "withLease")
      ) {
        // WHY: callback-origin checking depends on the exact withLease symbol.
        // A structurally compatible interface erases that identity and could
        // manufacture an untracked lease parameter.
        addFinding(sourceFile, node.initializer, "scratch-address-contract");
      }
      if (
        ts.isBinaryExpression(node) &&
        isSimpleAssignment(node) &&
        expressionState(node.right, checker, states, programSources)
          .scratchRegion &&
        !expressionTypeHasScratchMember(node.left, "withLease")
      ) {
        addFinding(sourceFile, node.right, "scratch-address-contract");
      }
      if (
        (ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) ||
          ts.isSatisfiesExpression(node)) &&
        expressionState(node.expression, checker, states, programSources)
          .scratchRegion &&
        !expressionTypeHasScratchMember(node, "withLease")
      ) {
        addFinding(sourceFile, node, "scratch-address-contract");
      }
      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        const memberSymbol = symbolAtExpression(checker, node);
        if (
          memberSymbol &&
          destinationFactorySymbols.has(memberSymbol) &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node)
        ) {
          // WHY: the factory's nominal return type is not the provenance
          // proof. Extraction/bind/call/apply can erase the exact formal
          // arguments checked at the direct call site.
          addFinding(sourceFile, node, "kernel-destination-factory-unsafe");
        }
        const receiverState = expressionState(
          node.expression,
          checker,
          states,
          programSources,
        );
        const directSymbol = symbolAtExpression(checker, node);
        const regionMember = isScratchRegionMemberSymbol(directSymbol);
        const regionProperty = accessedPropertyName(node);
        const insideScratchLeaseImplementation = toPosix(
          sourceFile.fileName,
        ).endsWith("/host/src/kernel-scratch.ts");
        const directCall = directCallForMember(node);
        const exactDirectRegionCall = Boolean(
          directCall &&
          ts.isPropertyAccessExpression(node) &&
          regionMember &&
          isExactScratchRegionOrigin(node.expression),
        );
        if (
          receiverState.scratchRegion &&
          (!regionMember ||
            !isExactScratchRegionOrigin(node.expression) ||
            propertyAccessIsMutation(node) ||
            (regionProperty !== "capacity" && !exactDirectRegionCall))
        ) {
          addFinding(sourceFile, node, "scratch-address-contract");
        }
        let addressesScratch = isScratchAddressSymbol(directSymbol);
        let leasesScratch = isScratchWithLeaseSymbol(directSymbol);
        let leaseMember = isScratchLeaseMemberSymbol(directSymbol);
        if (ts.isElementAccessExpression(node)) {
          const property = accessedPropertyName(node);
          if (property === null || property === "address") {
            addressesScratch ||= typeHasScratchMember(
              node.expression,
              "address",
            );
          }
          if (property === null || property === "withLease") {
            leasesScratch ||= typeHasScratchMember(
              node.expression,
              "withLease",
            );
          }
          if (property === null) {
            leaseMember ||= typeHasScratchMember(
              node.expression,
              "invokeKernelExport",
            );
          }
        }
        const exactDirectLeaseMemberCall = Boolean(
          directCall &&
          ts.isPropertyAccessExpression(node) &&
          isRealScratchLeaseMemberCall(directCall),
        );
        const exactDirectWithLeaseCall = Boolean(
          directCall &&
          ts.isPropertyAccessExpression(node) &&
          isRealScratchWithLeaseCall(directCall),
        );
        if (
          addressesScratch ||
          (leaseMember &&
            !insideScratchLeaseImplementation &&
            (!exactDirectLeaseMemberCall || propertyAccessIsMutation(node))) ||
          (leasesScratch && !exactDirectWithLeaseCall)
        ) {
          addFinding(sourceFile, node, "scratch-address-contract");
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const hasAddress = typeHasScratchMember(node.initializer, "address");
        const hasWithLease = typeHasScratchMember(
          node.initializer,
          "withLease",
        );
        const hasLease = typeHasScratchMember(
          node.initializer,
          "invokeKernelExport",
        );
        for (const element of node.name.elements) {
          const property =
            propertyNameText(element.propertyName) ??
            (ts.isIdentifier(element.name) ? element.name.text : null);
          if (
            (hasAddress && (property === null || property === "address")) ||
            hasLease ||
            (hasWithLease && (property === null || property === "withLease"))
          ) {
            addFinding(sourceFile, element, "scratch-address-contract");
          }
        }
      }
      if (
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        isViewConstructor(node, checker, states, programSources)
      ) {
        const state = expressionState(node, checker, states, programSources);
        if (isKernelView(state)) {
          addFinding(sourceFile, node, "kernel-view");
        }
      }
      for (const kind of wasmAuthorityKindsAtNode(node)) {
        addFinding(sourceFile, node, kind);
      }
      if (
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        expressionMayGenerateDynamicCode(node.expression)
      ) {
        addFinding(sourceFile, node, "dynamic-code-contract");
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        expressionCarriesWasmAuthority(node.initializer) &&
        (!ts.isIdentifier(node.name) ||
          !ts.isVariableDeclarationList(node.parent) ||
          (node.parent.flags & ts.NodeFlags.Const) === 0)
      ) {
        // Const identifiers are the one reviewed alias form: assigning the
        // captured intrinsic once cannot redirect later uses. Mutable aliases
        // and container bindings make authority provenance a may-property.
        addFinding(sourceFile, node.initializer, "wasm-authority-escape");
      }
      if (
        (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
        node.initializer &&
        expressionCarriesWasmAuthority(node.initializer)
      ) {
        addFinding(sourceFile, node.initializer, "wasm-authority-escape");
      }
      if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind) &&
        expressionCarriesWasmAuthority(node.right)
      ) {
        addFinding(sourceFile, node.right, "wasm-authority-escape");
      }
      if (
        ts.isReturnStatement(node) &&
        node.expression &&
        expressionCarriesWasmAuthority(node.expression)
      ) {
        addFinding(sourceFile, node.expression, "wasm-authority-escape");
      }
      if (
        ts.isArrowFunction(node) &&
        !ts.isBlock(node.body) &&
        expressionCarriesWasmAuthority(node.body)
      ) {
        addFinding(sourceFile, node.body, "wasm-authority-escape");
      }
      if (
        ts.isYieldExpression(node) &&
        node.expression &&
        expressionCarriesWasmAuthority(node.expression)
      ) {
        addFinding(sourceFile, node.expression, "wasm-authority-escape");
      }
      if (
        ts.isExportAssignment(node) &&
        expressionCarriesWasmAuthority(node.expression)
      ) {
        addFinding(sourceFile, node.expression, "wasm-authority-escape");
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        expressionCarriesWasmAuthority(node.initializer) &&
        ts.isVariableDeclarationList(node.parent) &&
        ts.isVariableStatement(node.parent.parent) &&
        ts
          .getModifiers(node.parent.parent)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        addFinding(sourceFile, node.initializer, "wasm-authority-escape");
      }
      if (
        ts.isBindingElement(node) &&
        node.initializer &&
        expressionCarriesWasmAuthority(node.initializer)
      ) {
        addFinding(sourceFile, node.initializer, "wasm-authority-escape");
      }
      if (
        ts.isExpressionWithTypeArguments(node) &&
        ts.isHeritageClause(node.parent) &&
        expressionCarriesWasmAuthority(node.expression)
      ) {
        addFinding(sourceFile, node.expression, "wasm-authority-escape");
      }
      if (
        ts.isShorthandPropertyAssignment(node) &&
        expressionCarriesWasmAuthority(node.name)
      ) {
        addFinding(sourceFile, node.name, "wasm-authority-escape");
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements) {
          if (
            !ts.isOmittedExpression(element) &&
            !ts.isSpreadElement(element) &&
            expressionCarriesWasmAuthority(element)
          ) {
            addFinding(sourceFile, element, "wasm-authority-escape");
          }
        }
      }
      if (
        ts.isSpreadAssignment(node) &&
        expressionContainsKernelExportNamespace(node.expression)
      ) {
        // Object spread copies every raw export function into an untracked
        // object. Reject the extraction at the authenticated namespace.
        addFinding(sourceFile, node, "kernel-pointer-export-bypass");
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.name.elements.some((element) => element.dotDotDotToken) &&
        node.initializer &&
        expressionContainsKernelExportNamespace(node.initializer)
      ) {
        // Object-rest binding copies every remaining raw export into a new
        // object, erasing the authenticated namespace provenance.
        addFinding(sourceFile, node, "kernel-pointer-export-bypass");
      }
      if (
        ts.isBinaryExpression(node) &&
        isSimpleAssignment(node) &&
        ts.isObjectLiteralExpression(unwrapExpression(node.left)) &&
        (
          unwrapExpression(node.left) as ts.ObjectLiteralExpression
        ).properties.some(ts.isSpreadAssignment) &&
        expressionContainsKernelExportNamespace(node.right)
      ) {
        addFinding(sourceFile, node, "kernel-pointer-export-bypass");
      }
      if (
        ts.isPropertyAssignment(node) &&
        propertyNameText(node.name) === "__proto__" &&
        expressionContainsKernelExportNamespace(node.initializer)
      ) {
        // `__proto__` in an object literal installs the namespace as the new
        // object's prototype; a later ordinary property read would otherwise
        // lose the authenticated namespace provenance.
        addFinding(sourceFile, node, "kernel-pointer-export-bypass");
      }
      if (
        ts.isBinaryExpression(node) &&
        isSimpleAssignment(node) &&
        (ts.isPropertyAccessExpression(node.left) ||
          ts.isElementAccessExpression(node.left)) &&
        accessedPropertyName(node.left) === "__proto__" &&
        expressionContainsKernelExportNamespace(node.right)
      ) {
        addFinding(sourceFile, node, "kernel-pointer-export-bypass");
      }
      if (
        ts.isNewExpression(node) &&
        node.arguments?.some(expressionContainsKernelExportNamespace)
      ) {
        // A constructor can retain, proxy, or redistribute every raw export.
        // No generated export name remains available for exact review.
        addFinding(sourceFile, node, "kernel-pointer-export-bypass");
      }
      if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isTemplateExpression(node.template) &&
        node.template.templateSpans.some((span) =>
          expressionContainsKernelExportNamespace(span.expression),
        )
      ) {
        // A tag receives every substitution as an ordinary callable argument.
        addFinding(sourceFile, node, "kernel-pointer-export-bypass");
      }

      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        const capturedOperation = capturedIntrinsicOperationCall(node, checker);
        if (!callIsReviewedAuthorityInvocation(node)) {
          for (const argument of node.arguments) {
            if (expressionCarriesWasmAuthority(argument)) {
              // A user/helper call can retain or invoke the constructor,
              // namespace, or instantiate capability in syntax the origin
              // classifier cannot prove. Fail closed at the capability escape.
              addFinding(sourceFile, argument, "wasm-authority-escape");
            }
          }
        }
        for (const argument of node.arguments) {
          if (expressionMayGenerateDynamicCode(argument)) {
            addFinding(sourceFile, argument, "dynamic-code-contract");
          }
        }
        if (
          ts.isIdentifier(callee) &&
          callee.text === "eval" &&
          hasIntrinsicLibValueDeclaration(
            symbolAtExpression(checker, callee),
          ) &&
          activeLeaseCallbacks.has(enclosingFunction(node)!)
        ) {
          // Direct eval can name the lexical lease without an identifier node,
          // defeating every symbol/provenance check below.
          addFinding(sourceFile, node, "scratch-address-contract");
        }
        for (const argument of node.arguments) {
          if (
            expressionState(argument, checker, states, programSources)
              .scratchRegion
          ) {
            // Regions may be stored or returned with their exact type, but
            // passing the capability through an arbitrary call makes
            // structural erasure, retention, and reflection indistinguishable.
            addFinding(sourceFile, argument, "scratch-address-contract");
          }
        }
        const calleeState = expressionState(
          node.expression,
          checker,
          states,
          programSources,
        );
        const directReflectedKernelExportKind =
          directReflectedKernelExportUseKind(node);
        if (directReflectedKernelExportKind !== null) {
          addFinding(sourceFile, node, directReflectedKernelExportKind);
        } else if (
          node.arguments.some(expressionContainsKernelExportNamespace)
        ) {
          // WHY: an arbitrary call can retain or redistribute the entire raw
          // namespace, including every pointer-bearing scratch export. Reject
          // the crossing here instead of trying to enumerate all reflective,
          // proxy, prototype, copying, and higher-order extraction APIs.
          addFinding(sourceFile, node, "kernel-pointer-export-bypass");
        }
        const directFactory = symbolAtExpression(checker, node.expression);
        const resolvedFactoryDeclaration =
          checker.getResolvedSignature(node)?.declaration;
        const resolvedFactory = resolvedFactoryDeclaration
          ? symbolForDeclaration(checker, resolvedFactoryDeclaration)
          : undefined;
        const invokesDestinationFactory =
          (directFactory && destinationFactorySymbols.has(directFactory)) ||
          (resolvedFactory && destinationFactorySymbols.has(resolvedFactory));
        if (invokesDestinationFactory) {
          addFinding(sourceFile, node, "kernel-destination-factory-call");
          if (!destinationFactoryArgumentsAreExact(node)) {
            addFinding(sourceFile, node, "kernel-destination-factory-unsafe");
          }
        }
        const kernelExportCallKind = kernelExportUseKind(calleeState);
        if (
          kernelExportCallKind !== null &&
          !calleeState.allocator &&
          !calleeState.reserver &&
          node !== reviewedReservedSpawnCall
        ) {
          // WHY: the generated export set is the fail-closed outer boundary.
          // Known pointer borrowers still receive the more specific finding;
          // every other direct call needs an exact scalar/control review.
          addFinding(sourceFile, node, kernelExportCallKind);
        }
        if (calleeState.allocator) {
          addFinding(sourceFile, node, "scratch-allocator-call");
        }
        if (calleeState.scratchRegionFactory) {
          addFinding(sourceFile, node, "scratch-region-factory-call");
        }
        const intrinsicDispatchTarget =
          intrinsicCallApplyTarget(node, checker) ??
          (isCapturedIntrinsicApply(node.expression, checker)
            ? (node.arguments[0] ?? null)
            : null);
        if (
          calleeState.reserver ||
          (intrinsicDispatchTarget !== null &&
            expressionState(
              intrinsicDispatchTarget,
              checker,
              states,
              programSources,
            ).reserver)
        ) {
          addFinding(sourceFile, node, "scratch-reservation-call");
        }
        if (
          capturedOperation === "uint8-array-set" &&
          node.arguments[1] &&
          isKernelView(
            expressionState(node.arguments[1], checker, states, programSources),
          )
        ) {
          addFinding(sourceFile, node, "kernel-write");
        }
        if (
          isKernelScratchWithLeaseCall(node, checker) &&
          (!isRealScratchWithLeaseCall(node) ||
            !inlineScratchLeaseCallback(node))
        ) {
          addFinding(sourceFile, node, "scratch-address-contract");
        }
        if (invalidTwoPhaseLeaseCalls.has(node)) {
          addFinding(sourceFile, node, "scratch-address-contract");
        }

        const receiver = callReceiver(node);
        const method = callPropertyName(node);
        if (receiver) {
          const receiverState = expressionState(
            receiver,
            checker,
            states,
            programSources,
          );
          const knownViewWrite =
            isKernelView(receiverState) &&
            method !== null &&
            (TYPED_ARRAY_MUTATORS.has(method) ||
              method.startsWith("set") ||
              method.startsWith("write"));
          if (knownViewWrite) {
            addFinding(sourceFile, node, "kernel-write");
          } else if (
            (hasKernelOwnership(receiverState, "view") ||
              hasKernelOwnership(receiverState, "buffer") ||
              hasKernelOwnership(receiverState, "memory")) &&
            !isProvenReadOnlyKernelReceiverCall(node, receiverState, checker)
          ) {
            // WHY: a computed or custom method can be a disguised `.set`,
            // retain the live receiver, or mutate/detach its backing memory.
            // Only an exact standard-library method whose contract is
            // nonmutating may consume an allocator-owned receiver silently.
            addOwnershipFindings(sourceFile, node, receiverState, "escape");
          }
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText(sourceFile) === "Atomics" &&
          ATOMIC_MUTATORS.has(node.expression.name.text) &&
          node.arguments[0] &&
          isKernelView(
            expressionState(node.arguments[0], checker, states, programSources),
          )
        ) {
          addFinding(sourceFile, node, "kernel-write");
        }

        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.declaration;
        const analyzedBody =
          declaration &&
          isInProgram(programSources, declaration) &&
          hasBody(declaration);
        if (
          !analyzedBody &&
          !isViewConstructor(node, checker, states, programSources) &&
          capturedOwnershipGetterCall(node, checker) === null &&
          capturedOperation === null
        ) {
          const escapedKernelExportStates = node.arguments.map((argument) =>
            expressionState(argument, checker, states, programSources),
          );
          const escapesPointerBearingKernelExport =
            escapedKernelExportStates.some((state) =>
              hasAuditedKernelExport(state, kernelScratchExportContract.names),
            );
          const escapesGeneratedKernelExport = escapedKernelExportStates.some(
            (state) => hasAuditedKernelExport(state, auditedKernelExports),
          );
          if (
            !isIntrinsicObjectFreezeCall(node, checker) &&
            escapesGeneratedKernelExport
          ) {
            // Reflect.apply and opaque helpers can invoke or retain the raw
            // function without leaving a direct call expression for the audit.
            addFinding(
              sourceFile,
              node,
              escapesPointerBearingKernelExport
                ? "kernel-pointer-export-bypass"
                : "kernel-export-direct-use",
            );
          }
          node.arguments.forEach((argument, index) => {
            addOwnershipFindings(
              sourceFile,
              node,
              expressionState(argument, checker, states, programSources),
              "escape",
              isKnownReadOnlyKernelViewArgument(node, index, checker),
            );
          });
        }
      }
      if (
        ts.isNewExpression(node) &&
        !isViewConstructor(node, checker, states, programSources)
      ) {
        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.declaration;
        const analyzedBody =
          declaration &&
          isInProgram(programSources, declaration) &&
          hasBody(declaration);
        if (!analyzedBody) {
          for (const argument of node.arguments ?? []) {
            addOwnershipFindings(
              sourceFile,
              node,
              expressionState(argument, checker, states, programSources),
              "escape",
            );
          }
        }
      }

      if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind)
      ) {
        if (
          assignmentWritesKernelView(node.left, checker, states, programSources)
        ) {
          addFinding(sourceFile, node, "kernel-write");
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        ts.isElementAccessExpression(unwrapExpression(node.operand))
      ) {
        const operand = unwrapExpression(
          node.operand,
        ) as ts.ElementAccessExpression;
        if (
          isKernelView(
            expressionState(
              operand.expression,
              checker,
              states,
              programSources,
            ),
          )
        ) {
          addFinding(sourceFile, node, "kernel-write");
        }
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const state = expressionState(
          node.expression,
          checker,
          states,
          programSources,
        );
        addKernelExportUseFinding(sourceFile, node, state);
        const fn = returnFunction(node);
        if (fn) {
          unionState(state, stateFor(seededReturnStates, fn));
        }
        if (
          !fn ||
          transparentCapturedOwnershipGetterWrapper(fn, checker) === null
        ) {
          addOwnershipFindings(
            sourceFile,
            node,
            state,
            "return",
            false,
            undefined,
            node.expression,
          );
        }
      }
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        const state = expressionState(
          node.body,
          checker,
          states,
          programSources,
        );
        addKernelExportUseFinding(sourceFile, node, state);
        addOwnershipFindings(
          sourceFile,
          node,
          state,
          "return",
          false,
          undefined,
          node.body,
        );
      }
      if (
        ts.isBinaryExpression(node) &&
        isSimpleAssignment(node) &&
        isPersistentStoreTarget(node.left, checker, node)
      ) {
        const storedState = expressionState(
          node.right,
          checker,
          states,
          programSources,
        );
        addKernelExportUseFinding(sourceFile, node, storedState);
        addOwnershipFindings(
          sourceFile,
          node,
          storedState,
          "store",
          false,
          symbolAtExpression(checker, node.left),
        );
      }
      if (ts.isPropertyDeclaration(node) && node.initializer) {
        const storedState = expressionState(
          node.initializer,
          checker,
          states,
          programSources,
        );
        addKernelExportUseFinding(sourceFile, node, storedState);
        addOwnershipFindings(
          sourceFile,
          node,
          storedState,
          "store",
          false,
          symbolForDeclaration(checker, node),
        );
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        returnFunction(node) === null
      ) {
        const storedState = expressionState(
          node.initializer,
          checker,
          states,
          programSources,
        );
        addOwnershipFindings(
          sourceFile,
          node,
          storedState,
          "store",
          false,
          symbolForDeclaration(checker, node),
        );
        const statement = ts.isVariableDeclarationList(node.parent)
          ? node.parent.parent
          : undefined;
        if (
          statement &&
          ts.isVariableStatement(statement) &&
          statement.modifiers?.some(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.ExportKeyword ||
              modifier.kind === ts.SyntaxKind.DefaultKeyword,
          )
        ) {
          addKernelExportUseFinding(sourceFile, node, storedState);
        }
      }
      if (
        ts.isExportAssignment(node) ||
        (ts.isYieldExpression(node) && node.expression)
      ) {
        const expression = ts.isExportAssignment(node)
          ? node.expression
          : node.expression!;
        addKernelExportUseFinding(
          sourceFile,
          node,
          expressionState(expression, checker, states, programSources),
        );
      }
      if (ts.isParameter(node)) {
        const property = parameterPropertySymbol(checker, node);
        if (property && ts.isIdentifier(node.name)) {
          const parameterState = expressionState(
            node.name,
            checker,
            states,
            programSources,
          );
          addOwnershipFindings(
            sourceFile,
            node,
            parameterState,
            "store",
            false,
            property,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    try {
      visit(sourceFile);
    } catch (error) {
      if (error instanceof RangeError) {
        const owner = lastVisitedNode.getSourceFile();
        const { line, character } = owner.getLineAndCharacterOfPosition(
          lastVisitedNode.getStart(owner),
        );
        throw new Error(
          `audit traversal overflowed at ${toPosix(owner.fileName)}:${line + 1}:${character + 1} (${ts.SyntaxKind[lastVisitedNode.kind]})`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  findings.sort((a, b) => a.key.localeCompare(b.key));
  const consumedAllowanceCounts = new Map<string, number>();
  const violations: AuditFinding[] = [];
  for (const finding of findings) {
    const allowance = allowanceByKey.get(finding.key);
    const consumed = consumedAllowanceCounts.get(finding.key) ?? 0;
    if (allowance && consumed < (allowance.count ?? 1)) {
      consumedAllowanceCounts.set(finding.key, consumed + 1);
    } else {
      violations.push(finding);
    }
  }
  const unusedAllowances = allowances.filter(
    (entry) =>
      (consumedAllowanceCounts.get(entry.key) ?? 0) !== (entry.count ?? 1),
  );

  return {
    findings,
    violations,
    unusedAllowances,
    unresolvedSeeds,
    contractErrors: [
      ...kernelScratchExportContract.errors,
      ...generatedKernelExportContractErrors,
      ...unresolvedDestinationFactoryDeclarations.map(
        (declaration) =>
          `could not resolve kernel destination factory declaration ${declaration}`,
      ),
      ...authorityClassificationErrors,
      ...(changed
        ? [
            `ownership propagation did not converge after ${propagationPasses} passes`,
          ]
        : []),
    ],
    propagationPasses,
    sourceFiles: sourceFiles
      .map((sourceFile) => relativeFile(options.rootDir, sourceFile))
      .sort(),
  };
}

function isRuntimeSourceFile(fileName: string): boolean {
  if (
    fileName.endsWith(".d.ts") ||
    fileName.endsWith(".d.mts") ||
    fileName.endsWith(".d.cts")
  ) {
    return false;
  }
  return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(fileName);
}

function isOrdinaryTestHarness(relativePath: string): boolean {
  if (
    relativePath === "apps/browser-demos/test/epoll-repro.ts" ||
    relativePath.startsWith("apps/browser-demos/test/fixtures/")
  ) {
    return false;
  }
  return (
    relativePath.startsWith("host/test/") ||
    relativePath.includes("/test/") ||
    /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(relativePath)
  );
}

function gitIgnoredRuntimeSourceFiles(
  rootDir: string,
  files: readonly string[],
): ReadonlySet<string> {
  if (files.length === 0) return new Set();
  const relativeFiles = files.map((file) => path.relative(rootDir, file));
  const result = spawnSync(
    "git",
    ["-C", rootDir, "check-ignore", "--stdin", "-z"],
    {
      input: `${relativeFiles.join("\0")}\0`,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    // A virtual fixture or exported source tree need not be a Git checkout.
    // In that case retain the conservative behavior and audit every source.
    return new Set();
  }
  return new Set(
    result.stdout
      .split("\0")
      .filter((relative) => relative.length > 0)
      .map((relative) => path.resolve(rootDir, relative)),
  );
}

/**
 * Discover JavaScript and TypeScript runtime sources from the repository
 * instead of naming a handful of current files. New production/diagnostic
 * files are therefore in scope automatically regardless of which source
 * language extension they use.
 */
export function repositoryRuntimeSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const visitDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (existsSync(path.join(absolute, ".git"))) {
          // WHY: a nested checkout is a different repository, not another
          // Kandelo source directory. Scanning it duplicates declarations and
          // lets local worktrees/artifacts change this repository's contract.
          continue;
        }
        // These checked-out upstream trees are not Kandelo TypeScript runtime
        // sources and can contain their own nested build products.
        const relative = toPosix(path.relative(rootDir, absolute));
        if (
          relative === "libc/musl" ||
          relative === "tests/libc/libc-test" ||
          relative === "tests/sortix/os-test"
        ) {
          continue;
        }
        visitDirectory(absolute);
        continue;
      }
      if (!entry.isFile() || !isRuntimeSourceFile(entry.name)) continue;
      const relative = toPosix(path.relative(rootDir, absolute));
      if (relative === "scripts/resolve-binary.bundle.mjs") {
        // This minified standalone executable is reproduced exactly from
        // scripts/resolve-binary.ts and host/src/binary-resolver.ts by the
        // resolver-bundle freshness gate. Auditing both sources preserves the
        // ownership contract without propagating through generated aliases.
        continue;
      }
      if (!isOrdinaryTestHarness(relative)) files.push(absolute);
    }
  };
  visitDirectory(rootDir);
  // Package builds leave ignored upstream and generated trees beside their
  // recipes. They are inputs or residue, not Kandelo runtime sources, and
  // allowing them into the TypeScript ownership graph makes this contract
  // depend on which packages happened to be built in the working tree.
  const ignored = gitIgnoredRuntimeSourceFiles(rootDir, files);
  return files.filter((file) => !ignored.has(path.resolve(file))).sort();
}

export function virtualAuditOptions(
  sources: Readonly<Record<string, string>>,
  ownershipSeeds: readonly OwnershipSeed[],
  allowances: readonly AuditAllowance[] = [],
): AuditOptions {
  const rootDir = path.resolve("/virtual");
  const virtualSources = new Map<string, string>();
  for (const [fileName, source] of Object.entries(sources)) {
    virtualSources.set(path.join(rootDir, fileName), source);
  }
  return {
    rootDir,
    sourceFiles: [...virtualSources.keys()],
    ownershipSeeds,
    allowances,
    virtualSources,
  };
}

/** Format failures for one compact Vitest assertion. */
export function formatAuditFailures(result: AuditResult): string[] {
  const failures: string[] = [];
  for (const error of result.contractErrors) {
    failures.push(`kernel scratch export contract: ${error}`);
  }
  for (const seed of result.unresolvedSeeds) {
    failures.push(`unresolved ownership seed: ${seed.declaration}`);
  }
  for (const finding of result.violations) {
    const advice =
      finding.kind === "scratch-address-contract"
        ? ". Use an exact kernel-owned region with an inline synchronous withLease callback; pass lease.exportPointer(...) only to lease.invokeKernelExport(...), and never reintroduce address(), forge or erase the region/lease, mutate its methods, or pass it through an opaque helper."
        : finding.kind === "kernel-destination-factory-unsafe"
          ? ". Create the authenticated destination only by a direct call whose pointer and variable capacity are exact unmodified parameters of the same host-import function, or whose capacity is a reviewed immutable fixed constant."
          : finding.kind === "kernel-pointer-export-bypass"
            ? ". Invoke pointer-bearing kernel exports only through KernelScratchLease.invokeKernelExport with opaque exportPointer range tokens."
            : finding.kind === "kernel-export-direct-use"
              ? ". Add an exact scalar/control occurrence review, use the reservation transaction guard, or route pointer-bearing data through KernelScratchLease."
              : "";
    failures.push(
      `${finding.file}:${finding.line} ${finding.kind} in ${finding.enclosing}: ${finding.text}${advice}`,
    );
  }
  for (const allowance of result.unusedAllowances) {
    failures.push(`stale audit allowance: ${allowance.key}`);
  }
  return failures;
}
