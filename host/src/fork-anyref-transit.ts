/**
 * The ABI 43 transaction-local Wasm-GC routing table.
 *
 * WebKit can import and export `(ref null any)` tables, but its JavaScript
 * `WebAssembly.Table` constructor does not accept `element: "anyref"`.
 * Creating the table in this fixed Wasm provider therefore gives Node and all
 * browser engines the same host-owned object without weakening its type.
 */
export const FORK_ANYREF_TRANSIT_IMPORT = "__wpk_fork_ref_gc_transit";
const FORK_ANYREF_TRANSIT_CLEAR_EXPORT =
  "__wpk_fork_ref_gc_transit_clear";

/*
 * Deterministic encoding of:
 *
 * (module
 *   (table (export "__wpk_fork_ref_gc_transit") 1 (ref null any))
 *   (func (export "__wpk_fork_ref_gc_transit_clear")
 *     i32.const 0
 *     ref.null any
 *     table.size 0
 *     table.fill 0))
 *
 * Keep this provider deliberately closed: no imports, memory, globals, start
 * function, or mutable state other than the exported scratch table.
 */
const FORK_ANYREF_TRANSIT_PROVIDER_BYTES = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60,
  0x00, 0x00, 0x03, 0x02, 0x01, 0x00, 0x04, 0x04, 0x01, 0x6e, 0x00, 0x01,
  0x07, 0x3f, 0x02, 0x19, 0x5f, 0x5f, 0x77, 0x70, 0x6b, 0x5f, 0x66, 0x6f,
  0x72, 0x6b, 0x5f, 0x72, 0x65, 0x66, 0x5f, 0x67, 0x63, 0x5f, 0x74, 0x72,
  0x61, 0x6e, 0x73, 0x69, 0x74, 0x01, 0x00, 0x1f, 0x5f, 0x5f, 0x77, 0x70,
  0x6b, 0x5f, 0x66, 0x6f, 0x72, 0x6b, 0x5f, 0x72, 0x65, 0x66, 0x5f, 0x67,
  0x63, 0x5f, 0x74, 0x72, 0x61, 0x6e, 0x73, 0x69, 0x74, 0x5f, 0x63, 0x6c,
  0x65, 0x61, 0x72, 0x00, 0x00, 0x0a, 0x0e, 0x01, 0x0c, 0x00, 0x41, 0x00,
  0xd0, 0x6e, 0xfc, 0x10, 0x00, 0xfc, 0x11, 0x00, 0x0b,
);

let providerModule: WebAssembly.Module | undefined;

function compileProviderModule(): WebAssembly.Module {
  if (providerModule) return providerModule;
  try {
    providerModule = new WebAssembly.Module(
      FORK_ANYREF_TRANSIT_PROVIDER_BYTES as BufferSource,
    );
  } catch (cause) {
    throw new Error(
      "this host cannot construct the ABI 43 Wasm-GC transit table",
      { cause },
    );
  }
  return providerModule;
}

/** Copy the audited provider binary for cross-engine contract tests. */
export function forkAnyrefTransitProviderBytes(): Uint8Array {
  return FORK_ANYREF_TRANSIT_PROVIDER_BYTES.slice();
}

/**
 * One process-worker owner for the scratch table shared by all activations.
 *
 * The generated codecs may grow the table, but every entry is null-filled by
 * Wasm at transaction boundaries. Using `table.fill` avoids one JS call per
 * recipe while guaranteeing that no stale GC object remains a strong root.
 */
export class ForkAnyrefTransitTable {
  readonly table: WebAssembly.Table;
  private readonly clearTable: (() => void) | null;

  constructor(adopted?: WebAssembly.Table) {
    if (adopted) {
      this.table = adopted;
      this.clearTable = null;
      this.clear();
      return;
    }
    const instance = new WebAssembly.Instance(compileProviderModule());
    const table = instance.exports[FORK_ANYREF_TRANSIT_IMPORT];
    const clearTable = instance.exports[FORK_ANYREF_TRANSIT_CLEAR_EXPORT];
    if (!(table instanceof WebAssembly.Table) || typeof clearTable !== "function") {
      throw new Error("invalid ABI 43 Wasm-GC transit provider exports");
    }
    this.table = table;
    this.clearTable = clearTable as () => void;
    this.clear();
  }

  clear(): void {
    if (this.clearTable) {
      this.clearTable();
      return;
    }
    for (let i = 0; i < this.table.length; i++) this.table.set(i, null);
  }

  /**
   * Reserve the canonical `recipe + 1` slot before generated Wasm publishes
   * an identity there. The table has no maximum, but keeping growth here lets
   * the host reject integer overflow before it becomes an engine-dependent
   * `table.grow` trap.
   */
  ensureRecipeSlot(recipeId: number): void {
    if (
      !Number.isInteger(recipeId)
      || recipeId <= 0
      || recipeId > 0x7fff_fffe
    ) {
      throw new RangeError(`invalid Wasm-GC recipe id ${recipeId}`);
    }
    const requiredLength = recipeId + 2;
    if (this.table.length >= requiredLength) return;
    const delta = requiredLength - this.table.length;
    const previous = this.table.grow(delta, null);
    if (previous + delta !== requiredLength) {
      throw new Error("Wasm-GC transit table grew to an unexpected length");
    }
  }

  get(slot: number): unknown {
    this.assertSlot(slot);
    return this.table.get(slot);
  }

  set(slot: number, value: unknown): void {
    this.assertSlot(slot);
    this.table.set(slot, value);
  }

  clearSlot(slot: number): void {
    this.assertSlot(slot);
    this.table.set(slot, null);
  }

  private assertSlot(slot: number): void {
    if (
      !Number.isInteger(slot)
      || slot < 0
      || slot >= this.table.length
    ) {
      throw new RangeError(`Wasm-GC transit slot ${slot} is out of bounds`);
    }
  }
}
