# N1-I5 grounding: native fork REFERENCE reconstruction through the co-resident module

Read-only design map. All paths are relative to
`/Users/brandon/kandelo-abi44-reconcile`. No code was changed to produce this
document; `crates/host-native/src/guest.rs` was read only (another agent owns
edits to it for I4).

Scope per the campaign plan (`docs/plans/2026-09-05-rust-first-campaign-to-completion.md`,
Part B, item **B2 / N1-I5**): make native reference reconstruction **live**
through the SAME shared `fork_module32.wasm` that I4 wired for frames-only
replay. The module owns the reconstruction algorithm (Path B); native supplies
only the irreducible `ForkHostCapabilities` (three tag methods) plus the raw
Wasmtime tables/imports the module's reference surface needs to not be inert.

---

## 1. The module's reference-replay interface

All signatures from `crates/fork-module/src/lib.rs`. This is the frozen
Rust-export surface the co-resident module presents; it is IDENTICAL for
every backend (Node, browser, native) because it is the same `.wasm` binary.

### Seeding / coordinator exports

| Export | Signature | Purpose |
|---|---|---|
| `fm_begin_reference_replay` | `(module_state_root: usize, pid: u32)` — void, `fm_last_errno` on failure (lib.rs:3245) | Seed the reference graph for this fork from the KFMS module-state arena rooted at `module_state_root`, and run the D6.2 bookkeeping reconstruction pass (counts externref nodes). Called ONCE per fork, after `fm_begin_child_replay`'s host-side prep but **before** the guest's `wpk_fork_module_state_restore` / any rewind frame touches a reference. `pid` is retained in the signature but unused since M2 (no host root generation is opened here). |
| `fm_funcref_ordinal` | `(recipe_id: u32) -> i32` (lib.rs:3260) | NOT guest-facing. Helper the injected `__wpk_fork_ref_decode_funcref` shim calls to resolve a funcref recipe to a **function-catalog ordinal**. Returns `-1` (`NULL_ORDINAL`) for the canonical Null reference, a non-negative ordinal otherwise, TRAPS on any inconsistency. |
| `fm_static_root_slot` | `(recipe_id: u32) -> i32` (lib.rs:3272) | NOT guest-facing. Helper the injected `fm_drive_execute` shim calls on a `DRIVE_OP_STATIC_ROOT` step to resolve a static-root recipe to a **merged anyref-catalog index** (`base(activation) + ordinal`). TRAPS on inconsistency. |
| `fm_externref_handle` | `(recipe_id: u32) -> i32` (lib.rs:3287) | NOT guest-facing. Helper the injected binder calls (both `__wpk_fork_ref_decode_externref` and the `DRIVE_OP_EXTERNREF_TRANSIT` drive step) to resolve an externref recipe to its captured **broker `handle`** (a `u32`), which is then fed to the single residual host import `resolve_externref(handle) -> externref`. TRAPS on inconsistency. |

### The seven guest-facing RESTORE data-feed exports (item 3a)

These are plain `i32`/`i64`/`usize` signatures — no reference-returning
plumbing needed, so Rust exports them directly (unlike the funcref/externref
decode, which needs a walrus-injected wrapper). The host flips the guest's
matching `__wpk_fork_ref_*` imports to these exports per-activation, exactly
like the funcref-decode flip.

| Export | Signature | Purpose |
|---|---|---|
| `fm_ref_vector_get` | `(ordinal: u32, index: u32) -> i32` (lib.rs:3304) | `__wpk_fork_ref_vector_get(ordinal, index) -> recipe_id`. |
| `fm_ref_gc_route` | `(recipe_id: u32, expected_activation: u32) -> i32` (lib.rs:3310) | `__wpk_fork_ref_gc_route(recipe_id, expected_activation) -> layout\|0\|-1`. |
| `fm_ref_gc_payload_len` | `(recipe_id: u32, expected_activation: u32, expected_layout_id: u32) -> i32` (lib.rs:3316) | `__wpk_fork_ref_gc_payload_len(recipe_id, activation, layout) -> len`. |
| `fm_ref_gc_load` | `(recipe_id: u32, module_activation: u32, type_ordinal: u32, layout_id: u32, kind: u32, scalar_destination: usize, scalar_byte_length: u32) -> i32` (lib.rs:3327) | `__wpk_fork_ref_gc_load(...) -> vector_ordinal\|0`. `scalar_destination` is an absolute guest byte offset. |
| `fm_ref_exn_route` | `(recipe_id: u32, expected_activation: u32) -> i32` (lib.rs:3349) | `__wpk_fork_ref_exn_route(recipe_id, expected_activation) -> layout\|-1`. |
| `fm_ref_exn_load` | `(recipe_id, module_activation, tag_ordinal, layout_id, scalar_destination: usize, scalar_byte_length, reference_ids_destination: usize, reference_count) -> i32` (lib.rs:3357) | `__wpk_fork_ref_exn_load(...) -> 1`. Both destination args are absolute guest byte offsets. |
| `fm_ref_exn_cache_index` | `(recipe_id: u32) -> i32` (lib.rs:3381) | `__wpk_fork_ref_exn_cache_index(recipe_id) -> index`. |

### GC drive-shim exports (item 3b/3c)

| Export | Signature | Purpose |
|---|---|---|
| `fm_drive_table_base` | `(activation: u32) -> i32` (lib.rs:3463) | The first `env.__wpk_fork_drive_table` slot for `activation`. Host binds each activation's `_gc_allocate`/`_gc_fill`/`_exception_materialize` guest exports at `base + {ALLOC=0, FILL=1, EXN=2}`. |
| `fm_build_trivial_plan` | `(activation: u32, recipe: u32, pid: u32) -> usize` (lib.rs:3475) | Serializes a TRIVIAL single-struct plan (ALLOC then FILL) into module scratch, returns guest address for `fm_drive_execute`. Proves the drive mechanism only; superseded in production by `fm_build_gc_plan`. |
| `fm_trivial_plan_count` | `() -> i32` (lib.rs:3491) | Always `2` (ALLOC+FILL). |
| `fm_build_gc_plan` | `(pid: u32) -> usize` (lib.rs:3504) | Builds the REAL topological GC drive plan for the fork's whole reference graph (reproducing the JS `materializeTypedGraph` order) and returns its guest address. Requires `fm_begin_reference_replay` to have seeded the driver and each participating activation's `fm_set_activation_gc_codec` to have seeded its layout catalog. Returns `0` + `fm_last_errno` on failure (missing driver, un-seeded activation, mismatched coordinate, unallocatable cycle). |
| `fm_gc_plan_count` | `() -> i32` (lib.rs:3520) | Step count of the last `fm_build_gc_plan` build; `0` before first build. |
| `fm_drive_bump` | `()` (lib.rs:3532) | NOT guest-facing. The injected `fm_drive_execute` wasm loop `call`s this once per plan step it drives — Rust owns the counter, the injected loop owns the `call_indirect`. |

### Proof-of-use counters

`fm_frames_committed`/`fm_frames_replayed` (frame-only, lib.rs:3210/3221),
`fm_ref_feed_reads` (lib.rs:3393), `fm_references_reconstructed` (lib.rs:3403,
funcref/null), `fm_externrefs_resolved` (lib.rs:3414, "re-rooted through the
`wpk_fork_host` engine-floor seam" — historical doc wording; actually advances
via the drive/decode path since M2, see the doc comment's own qualifier),
`fm_exnrefs_reconstructed` (lib.rs:3427), `fm_gc_nodes_reconstructed`
(lib.rs:3441), `fm_static_roots_published` (lib.rs:3452),
`fm_drive_steps_executed` (lib.rs:3544). All `() -> i64`, monotonic, never
reset. These are the acceptance signal for I5 ("`fm_*_reconstructed>0`") —
each stays at `0` on a silent JS/ENOSYS fallback.

### The DRIVE model

There is **no Rust `fm_drive_execute` export** — grep confirms it does not
exist in `fork-module/src/lib.rs`; it is a **walrus-injected wasm function**
(`crates/fork-module-inject/src/main.rs:314-330`, `inject_drive_execute`,
`DRIVE_EXECUTE_EXPORT = "fm_drive_execute"`). Rust cannot emit `call_indirect`
or hold a `funcref`/`anyref`, so the drive LOOP itself is hand-encoded WAT
injected into the compiled module post-hoc:

1. Rust (`fm_build_gc_plan`) walks the decoded reference graph and serializes a
   flat array of 16-byte steps (`fork_codec::drive_plan`; 4 little-endian `u32`
   fields: `op`, `slot`, `recipe`, `arg` — `fork-module-inject/src/main.rs:98-116`)
   into module-owned scratch memory, matching the JS `materializeTypedGraph`
   topological order exactly.
2. The host calls the injected `fm_drive_execute(plan_ptr, count)`. For each
   step it `call_indirect`s the host-bound `env.__wpk_fork_drive_table` slot
   (`DRIVE_OP_ALLOC`/`FILL`/`EXN` → the guest's own `_gc_allocate`/`_gc_fill`/
   `_exception_materialize` exports, bound post-instantiation because the
   module is instantiated BEFORE the guest) or, for `DRIVE_OP_STATIC_ROOT`
   (op 3) / `DRIVE_OP_EXTERNREF_TRANSIT` (op 4), drives no guest export at all
   — it resolves via `fm_static_root_slot`/`fm_externref_handle` +
   `table.get`/`resolve_externref` + `any.convert_extern`, and `table.set`s the
   result into the shared anyref transit at slot `recipe + 1`.
3. After each ALLOC step the shim reads back `env.__wpk_fork_ref_gc_transit`
   (STORE #2 — the module-owned, module-EXPORTED `(ref null any)` table the
   guest's `_gc_allocate` actually publishes into and `_gc_fill` consumes) with
   `table.get` + `ref.is_null`, and branches to `unreachable` on a null slot —
   the R1 post-allocate integrity guard, expressed in wasm because Rust cannot
   hold the `anyref` needed to read it.
4. `fm_drive_bump()` is called once per driven step so the Rust-owned
   `fm_drive_steps_executed` counter proves the MODULE (not a JS fallback)
   drove the order.

**How the guest feeds references during replay** (call order confirmed at
`host/src/fork-process-continuation.ts:1081-1100`, the Node/browser
`attachChild`/child-replay path — native must reproduce this order):

1. `backend.beginReferenceReplay(rootAddress)` → `fm_begin_reference_replay` —
   seeds the whole-arena reference graph, BEFORE any module-state restore
   (a dlopen fork's table-baked funcrefs need the graph to exist first).
2. `registry.restoreModuleState(typedDrive)` — the JS-owned PHASE A/B (static
   root pin + externref publish) runs first, then invokes `typedDrive` (→
   `backend.driveTypedGraph()` → `fm_build_gc_plan` + `fm_drive_execute`) in
   place of the JS `materializeAllTyped` sub-loop, then drives each guest's
   global/table restore against the now-reconstructed identities.
3. `backend.beginChildReplay(...)` → `fm_begin_child_replay` — drives the
   per-frame REWIND. During this pass the guest's OWN reference codec (walking
   its captured frames) calls back into the module through the flipped
   `__wpk_fork_ref_decode_funcref`/`__wpk_fork_ref_decode_externref` imports
   and the seven `__wpk_fork_ref_{vector_get,gc_route,gc_payload_len,gc_load,
   exn_route,exn_load,exn_cache_index}` imports (bound to the `fm_ref_*`
   exports in section above) — this is the "feed": the guest pulls recipe data
   from the module one call at a time as it reconstructs each frame's locals
   and typed values.

---

## 2. The reference IMPORTS the module needs from the host/env

All stubbed INERT by I4 Task 1 (`crates/host-native/src/guest.rs:2661-2709`:
empty tables + `define_unknown_imports_as_traps` for every remaining function
import). Declared/documented at `crates/fork-module/tests/harness.mjs:69-93`
and `crates/fork-codec/src/host_capabilities.rs`.

| Import | What | Who populates it | What native must do for it to be LIVE |
|---|---|---|---|
| `env.__wpk_fork_function_catalog` (funcref table) | The merged, activation-namespaced funcref catalog the injected `__wpk_fork_ref_decode_funcref` shim `table.get`s. | Host mirrors EVERY activation's guest-exported `__wpk_fork_function_catalog` funcref table into this ONE table at `[base[a], base[a]+len_a)` (Node/browser: `host/src/worker-main.ts:4780-4825`); a single-activation fork seeds no base (module defaults `base=0`). | Native's `instantiate_fork_module` currently supplies this table EMPTY (`Ref::Func(None)`, initial 0 — `guest.rs:2663`). I5 must, once the guest instance(s) exist, `table.grow` + `table.set` real `wasmtime::Func` values copied out of each guest's own `__wpk_fork_function_catalog` export, and (for >1 activation) call `fm_set_activation_catalog_base` (lib.rs:3147) per activation. |
| `env.__wpk_fork_drive_table` (funcref table) | The mutable table `fm_drive_execute`'s injected loop `call_indirect`s for `DRIVE_OP_ALLOC/FILL/EXN`. | Host binds each activation's guest `_gc_allocate`/`_gc_fill`/`_exception_materialize` exports at `fm_drive_table_base(act) + {0,1,2}` (`worker-main.ts:4839-4874`). | Same shape: native supplies this table EMPTY today (`guest.rs:2664`). I5 must grow + `table.set` the guest's `Func` exports at the slots `fm_drive_table_base` returns, once the guest instance and its GC-codec-bearing exports exist. |
| `env.__wpk_fork_static_root_catalog` (anyref table) | The static-root binder: `fm_drive_execute`'s `DRIVE_OP_STATIC_ROOT` step `table.get`s this to publish an immutable root into the anyref transit. | Host builds a per-fork mirror from `activationRegistry.decodeStaticRoot`, only for REFERENCED ordinals, at `[base,base+width)` per activation, seeded via `fm_set_activation_static_root_base` (lib.rs:3167) for >1 static-root activation (`worker-main.ts:4915-4982`). | Native supplies this EMPTY too (`Ref::Any(None)`, `guest.rs:2665`). I5 must populate it per-fork from the child's live static roots (an `anyref`/GC-ref value obtained however native represents a guest's exported global/table static root — likely a `wasmtime::Val`/`Rooted<AnyRef>`), mirroring the Node/browser per-activation-base scheme. |
| `env.__wpk_fork_ref_gc_transit` (module-defined, module-EXPORTED `(ref null any)` table = STORE #2) | The shared Wasm-GC transit table the guest's `_gc_allocate` publishes structs/arrays/i31 into at `recipe+1`, and that `_gc_fill` consumes. The GUEST imports this name; the fork-module DEFINES and EXPORTS it (`fork-module-inject/src/main.rs:70-82`, "M1: ... Rust cannot emit an anyref table, so the injector is where the module acquires ownership of it"). | The module itself, at compile/inject time. The HOST's only job is to read `forkModuleInstance.exports.__wpk_fork_ref_gc_transit` and bind it as the GUEST's `env.__wpk_fork_ref_gc_transit` import (`host/src/fork-module-instance.ts:186-260,558`). | Native does not even declare this wiring today — `guest.rs`'s guest-instantiation path (searched: no `__wpk_fork_ref_gc_transit` hits anywhere in `crates/host-native/`) has no code binding a guest's own reference-carrying imports to anything module-owned. I5 must add: after `instantiate_fork_module` runs, read its `__wpk_fork_ref_gc_transit` table export and pass it into the GUEST's import object under `env.__wpk_fork_ref_gc_transit` wherever the guest program declares that import. |
| `env.resolve_externref` (function import, `(i32) -> externref`) | The single residual externref host import (M2). Called directly by two injected wasm sites: `__wpk_fork_ref_decode_externref`'s body, and the `DRIVE_OP_EXTERNREF_TRANSIT` branch of `fm_drive_execute` (`fork-module-inject/src/main.rs:137-156,222-312`). | Node/browser: `createForkModuleHostCapabilities` (`host/src/fork-module-host-capabilities.ts:56-73`) — body is `backing.tokens.materialize(handle)` against a `ForkExternrefTokenCache`. | Today native's `linker.define_unknown_imports_as_traps` makes this TRAP unconditionally (`guest.rs:2700-2709`). I5 must define a REAL `Func` for `env.resolve_externref` whose body maps `handle: i32` → a `Rooted<ExternRef>` (or the store's externref representation) via a native `handle -> Rooted<ExternRef>` map that is **idempotent per handle** (see §5). |
| `wpk_fork_host.host_mint_exception_tag` / `host_provide_unwind_transport_tag` / `host_recognize_unwind_transport` / `host_last_errno` (+ `host_instantiate_child`/`host_spawn_thread`, lifecycle) | The `ForkHostCapabilities`/`ForkLifecycleCapabilities` Wasm-import backend (`crates/fork-module/src/host_capabilities.rs`), declared but "NOT WIRED TO THE GUEST" per that file's own doc comment — the module declares these imports so `wasm-ld` retains them, but nothing in the module's live drive path calls them yet (see §3 for exactly when each becomes live). | N/A on the module side (JS bodies today: `fork-unwind-transport.ts`, `fork-worker-import-exceptions.ts`). | Native's path bypasses `crates/fork-module/src/host_capabilities.rs` entirely — `NativeForkHost` (`native_sketch.rs`) implements the SAME `fork_codec::ForkHostCapabilities` trait directly against Wasmtime, with no Wasm-import hop. So for native these don't need to be wired as `wpk_fork_host.*` **wasm imports** to the fork-module at all (they trap-stub today, harmlessly, exactly like resolve_externref did pre-I5) — what native actually needs is a live `impl ForkHostCapabilities for NativeStore` used by whatever Rust code plays the role `fork-worker-import-exceptions.ts`/`fork-unwind-transport.ts` play on Node/browser (see §3, §6). |

---

## 3. `ForkHostCapabilities` (the 3 tag methods) — native impl requirements

Trait: `crates/fork-codec/src/host_capabilities.rs:137-232`. Since Phase 6
item 5 + M2 ("minimize host surface"), this trait has been trimmed to
**exactly three methods** — `resolve_funcref`/`resolve_static_root`/
`install_reference_global` (item 5) and `begin_generation`/
`resolve_externref`/`transit_publish`/`transit_read`/`release_generation` (M2)
were REMOVED because that work moved into injected wasm (table.get/table.set/
the `DRIVE_OP_EXTERNREF_TRANSIT` step). So the ENTIRE reference-reconstruction
data path (§1, §2) does **not** go through `ForkHostCapabilities` at all —
only the residual tag/identity primitives Wasm genuinely cannot express do.

| Method | Signature | wasmtime 48 mapping (`native_sketch.rs:35-63`) | When actually CALLED |
|---|---|---|---|
| `mint_exception_tag` | `(&mut self, generation: HostGeneration, module_activation: u32, layout_id: u32) -> Result<HostTag, Errno>` (host_capabilities.rs:192) | `Tag::new(&mut store, &TagType::new(params))` for the activation's exception layout. | **STAYS INERT on the Wasm/exnref path through D6.3a** (host_capabilities.rs:184-191 doc comment): a program exception tag is GUEST-MODULE-LOCAL — the guest's own `__wpk_fork_exception_materialize` throws/`catch_ref`s against ITS OWN tag; the co-resident module neither mints a tag nor throws during an exnref drive, so it never calls this. The doc explicitly says: "This method exists for the NATIVE backend... When it becomes live in the Wasm backend it would be called once per distinct exception tag before materializing any exnref that uses it." I.e., for native's `NativeForkHost` this is a REAL primitive some future native-side exception-materialization path would call, but it is not on I5's fork-module reference-replay call path at all — the fork-module's exnref drive step (`DRIVE_OP_EXN`) calls the GUEST's `_exception_materialize` export directly via `call_indirect`, not this trait method. |
| `provide_unwind_transport_tag` | `(&mut self) -> Result<HostTag, Errno>` (host_capabilities.rs:209) | One process-wide `Tag::new(&mut store, TagType::new([]))`, cached; idempotent for the worker's life. | Worker lifetime (both capture-unwind and replay) — backs `createForkUnwindTag` (`fork-unwind-transport.ts`). This IS on the frame-capture/replay hot path (unwind catch-all rethrow), i.e. it is I4/frames territory as much as I5's, but native's `NativeForkHost` stub (`native_sketch.rs:108-110`) is still `ENOSYS` — I4 apparently never needed a live unwind-transport tag because native's unwind mechanism (see guest.rs `fm_begin_unwind`/`fm_finish_unwind` call sites) evidently doesn't yet route program-level exceptions through a transport tag the way Node/browser's catch-all-rethrow scheme does. Confirm at I5 time whether native's unwind path needs this BEFORE references, or whether it stays deferred with exceptions. |
| `recognize_unwind_transport` | `(&mut self, tag: HostTag, candidate: HostRef) -> Result<bool, Errno>` (host_capabilities.rs:227) | Compare the caught value's `Tag` to the transport tag via `Tag::eq` — native identity, no `Exception.is` JS hop. | Doc comment (host_capabilities.rs:219-226): "STAYS INERT through D6.3a: admitting exnref forks (D6.3a) needs no new engine-floor callback... The signature is the intended shape; the caller wiring is deferred to the later unwind/exec slice (it does NOT land with D6.3a)." So this is explicitly OUT OF SCOPE for reference reconstruction proper — it belongs to the unwind/exec slice (closer to B5's fork/exec residuals than B2/I5's reference work). |

**Net for I5**: the `NativeForkHost`/`ForkHostCapabilities` swap-in
(`mint_exception_tag`/`provide_unwind_transport_tag`/`recognize_unwind_transport`
going from `ENOSYS` to real `Tag::new`/`Tag::eq` calls) is real work the
campaign plan bundles into I5 ("Step 2"), but by the trait's OWN documented
call-timing, none of the three is actually exercised by a funcref/externref/
struct/array/i31/static-root reference-replay fork — they are unwind-transport
and future native-exception plumbing. I5's "references reconstruct" acceptance
bar (`fm_*_reconstructed>0`, funcref+externref+anyref) can be met without
these three ever firing; they should still be de-ENOSYSed as part of I5 (per
the plan's explicit Step 2), but the reference DATA path (§1/§2) is
independent of them.

---

## 4. Node/browser reference-replay wiring — the shape to mirror

Read from `host/src/worker-main.ts:4593-4984`, `fork-module-instance.ts`,
`fork-module-backend.ts`, `fork-reference-broker.ts`,
`fork-module-host-capabilities.ts`.

**Guest import flip** (`worker-main.ts:4593-4607`, gated on
`moduleReferenceKindsSupported && forkModuleInstance`):
```
__wpk_fork_ref_decode_funcref:    forkModuleInstance.exports.__wpk_fork_ref_decode_funcref
__wpk_fork_ref_decode_externref:  forkModuleInstance.exports.__wpk_fork_ref_decode_externref
```
plus `moduleReferenceFeedFlip()` (`worker-main.ts:3730-3750`), applied at BOTH
the main-instantiation import object (line 4606) and an earlier
early-child-references import object (line 4237):
```
__wpk_fork_ref_vector_get:      forkModuleInstance.exports.fm_ref_vector_get
__wpk_fork_ref_gc_route:        forkModuleInstance.exports.fm_ref_gc_route
__wpk_fork_ref_gc_payload_len:  forkModuleInstance.exports.fm_ref_gc_payload_len
__wpk_fork_ref_gc_load:         forkModuleInstance.exports.fm_ref_gc_load
__wpk_fork_ref_exn_route:       forkModuleInstance.exports.fm_ref_exn_route
__wpk_fork_ref_exn_load:        forkModuleInstance.exports.fm_ref_exn_load
__wpk_fork_ref_exn_cache_index: forkModuleInstance.exports.fm_ref_exn_cache_index
```
A flag-off / non-admitted fork leaves these as `{}`, so the guest keeps its
JS-provider imports (the byte-identical fallback path) — this is the "silent
JS fallback" the `fm_*` proof-of-use counters are designed to catch if it ever
fires when it shouldn't.

**Funcref catalog mirror** (`worker-main.ts:4780-4825`): for each activation
sorted by id, grow `forkModuleInstance.functionCatalog` (a host-owned
`WebAssembly.Table`) to fit, then `mirror.set(base+slot, guestCatalog.get(slot))`
copying the LIVE funcref values (identity-preserving `table.get`/`table.set`,
no re-creation) out of that activation's own guest-exported
`__wpk_fork_function_catalog`; only seeds `setActivationCatalogBase` for
`>1` activation.

**Drive table bind** (`worker-main.ts:4839-4874`): for each activation, look
up `activation.instance.exports[WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE]` /
`_FILL` / (optionally) `WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE`, grow
`forkModuleInstance.driveTable`, `driveTable.set(slotBase+{ALLOC,FILL,EXN}, fn)`.
Guests with no typed-GC codec simply have empty slots (never driven).

**Static-root catalog mirror** (`worker-main.ts:4915-4982`): only for
referenced static-root ordinals (never derefs an unreferenced/possibly
collected root), built per-activation `[base,base+width)`, `mirror.set(...,
activationRegistry.decodeStaticRoot(activation, ordinal))`, seeding
`setActivationStaticRootBase` only for `>1` static-root activation. Cleared
right after the drive so it never pins a child root past replay.

**GC codec + host-exception-owner seed** (`worker-main.ts:4885-4914`):
`forkModuleBackend.setActivationGcCodec(activationId, bytes)` from
`childGcCodecBytes` (captured pre-instantiation), and
`forkModuleBackend.setHostExceptionOwner(childHostExceptionOwner)`.

**`resolve_externref` wiring** (`worker-main.ts:3597-3608`,
`fork-module-host-capabilities.ts:56-73`):
```ts
forkModuleHostCapabilities = createForkModuleHostCapabilities({ tokens: externrefTokens });
forkModuleInstance = instantiateForkModule({
  ...,
  resolveExternref: forkModuleHostCapabilities.imports.resolve_externref,
});
```
Body: `resolve_externref(handle) => backing.tokens.materialize(handle)` where
`tokens` is a `ForkExternrefTokenCache` (`fork-reference-broker.ts:590-632`) —
a `Map<number, WeakRef<ForkExternrefToken>>` that returns the SAME frozen
`{[HANDLE_TOKEN]: handle, [WORKER_GENERATION_TOKEN]: generationId}` object for
repeat calls with the same handle. This is NOT the original live JS value —
it's an opaque per-worker token; a downstream host-import adapter that needs
the real value calls `tokens.encode(candidateValue)` to recover the handle and
then asks the process-wide `ForkExternrefBroker` (a different class,
`fork-reference-broker.ts:119+`) for the value behind that handle.

**What's host-provided vs module-owned, mapped to `ForkHostCapabilities`
vs staying in the module**:

| Piece | Owner today (Node/browser) | I5 native disposition |
|---|---|---|
| Funcref/drive-table/static-root table MIRRORING (copy guest exports into the fork-module's imported tables) | Host TS (`worker-main.ts`) — pure per-fork bookkeeping, no reference-identity decision-making | Native equivalent: Rust glue in `host-native` (NOT `ForkHostCapabilities` — this is table plumbing, analogous to `instantiate_child`'s import-object assembly, not a reference-identity primitive) |
| Funcref/anyref/GC-transit reference DECODE/PUBLISH algorithm | The injected wasm binder (`fork-module-inject`) + the module's Rust helpers (`fm_funcref_ordinal`/`fm_static_root_slot`/`fm_externref_handle`/`fm_ref_*`) | Stays in the module — UNCHANGED, shared across all 3 hosts (Path B) |
| `resolve_externref` body (handle → canonical token/value) | Host TS closure (`fork-module-host-capabilities.ts`) over a `ForkExternrefTokenCache` | Native: a real `Func` closure over a native `handle -> Rooted<ExternRef>` map — see §5/§6. NOT part of the `ForkHostCapabilities` trait (that trait was already trimmed of the externref seam in M2); it's a raw Wasmtime import binding, same shape as `resolveExternref` is a raw closure param to `instantiateForkModule` on Node/browser |
| Tag mint/recognize (unwind transport, future native exception tags) | JS closures (`fork-unwind-transport.ts`, `fork-worker-import-exceptions.ts`) | `ForkHostCapabilities` (`NativeForkHost`) — genuinely the only piece of §4 that maps onto the trait |

---

## 5. The externref-identity floor

Documented floor (campaign memory / `docs/plans/2026-09-05-rust-first-campaign-to-completion.md:172-174`):
*"honor the one documented floor (internalized externref not eq-comparable;
handle→externref host materialization)"*.

**What the current design already does to route around it** (confirmed in
`crates/fork-codec/src/reference_replay.rs:343-364`, the `drive_reconstruction`
doc comment): the R1 post-allocate integrity guard used to be a HOST read-back
compare over a distinct "store #1" (an externref transit the exnref/externref
Phase B code populated) — the "Phase6 3c R1 transit-store conflation" bug (see
project memory) was exactly this: the guard was reading the WRONG store for a
GC-drive recipe. The fix (documented at
`fork-module-inject/src/main.rs:322-329`) replaced a **comparison** with a
**non-null check** on STORE #2 (`env.__wpk_fork_ref_gc_transit`, the table the
guest's own `_gc_allocate` publishes into): `table.get` + `ref.is_null` +
`unreachable` on null. So the current design does **not** rely on Wasm-level
`ref.eq`/identity-comparison of an internalized-then-reconverted externref
anywhere in the hot path — it relies on:

1. **Idempotent materialization at the SOURCE**: `resolve_externref(handle)`
   (whether the JS `ForkExternrefTokenCache.materialize` or a future native
   `handle -> Rooted<ExternRef>` map) must return the exact SAME externref
   value for a given `handle` every time it's called, for the life of the
   fork's reconstruction. Identity is then "preserved" purely because every
   caller (the decode-externref shim, the transit-publish drive step) that
   needs "the externref for recipe N" always asks via the same handle and
   gets the same answer — never by comparing two independently-obtained
   values.
2. **Non-null liveness checks** (`ref.is_null`), not equality checks, wherever
   the injected wasm needs to assert the drive worked.

**What native's `resolve_externref` + broker must do**: maintain a
`HashMap<u32, wasmtime::Rooted<ExternRef>>` (per the `native_sketch.rs:20-23`
mapping — "The backend holds `wasmtime::Rooted<ExternRef>` ... DIRECTLY in its
own `HashMap<u32, _>`"), keyed by the SAME opaque broker `handle` the recipe
carries, and:
- `resolve_externref(handle)` looks up (or lazily creates, if this is the
  first ask for that handle in this generation) the entry and returns that
  SAME `Rooted<ExternRef>` — never constructs a fresh `ExternRef::new` per
  call for the same handle, mirroring `materialize`'s idempotence.
- The "generation" (`HostGeneration` in the now-removed M2 trait methods;
  `native_sketch.rs:24-33` notes it collapses to a `wasmtime::RootScope` whose
  `Drop` reclaims every root at once) scopes the map's lifetime to one fork's
  execution image — a `RootScope` per process-image generation, matching
  `ForkExternrefGeneration`'s PID-does-not-survive-exec semantics
  (`fork-reference-broker.ts:26-38`).
- Because native never crosses a JS/engine boundary to obtain the "real" host
  value in the first place (unlike Node/browser, where the externref usually
  IS a live JS object minted by some other host import and stashed in the
  broker), a native `externref`-producing host import would construct it via
  `ExternRef::new(&mut store, T)` wrapping a genuine Rust value; `resolve_
  externref`'s job in a FORK is simply to re-root the SAME `Rooted<ExternRef>`
  handle for the new (child) instance/generation, not to re-derive a value
  from nothing.

**Does wasmtime 48 `Rooted<ExternRef>`/`RootScope` support this?** Per
`native_sketch.rs`'s own per-method table (lines 37-44) and its narrative
(lines 12-33), yes by construction: `Rooted<T>` gives a handle into the
`Store`'s root set scoped to a `RootScope`, and dropping the scope reclaims
every root minted within it in one step — this is presented as a straight
substitute for the JS-side per-fork "begin_generation"/"release_generation"
pair that M2 already deleted from the trait (because injected wasm now owns
that scoping via `table.fill(null)` on the transit + the host token cache's
idempotence). The `any.convert_extern`/`extern.internalize` bridge itself
(what the "eq-comparable" floor is actually about) is executed by
**wasmtime's own Wasm-GC implementation**, not by a JS engine — so this is a
genuinely different execution environment than the WebKit-2311 probe that
established the floor's exact shape (project memory:
`fork-reference-engine-floor-is-migratable.md`). The current design (non-null
check, not eq-comparison) sidesteps needing to know whether wasmtime 48's
`any.convert_extern`/`ref.eq` pairing has the same quirk WebKit did, because
the shared module's drive step never performs that comparison. **This makes
externref identity NOT the hardest remaining case in absolute terms** — the
hard case is making sure native's `resolve_externref` is genuinely idempotent
per handle across the SAME fork's decode-externref call sites AND its
transit-publish drive step (both must see the identical `Rooted<ExternRef>`
for one recipe), which is a bookkeeping discipline, not an engine limitation.
I5 should still explicitly PROVE eq/identity across a fork (per the plan's
Step 3 acceptance line) — e.g., a native fixture that forks a program holding
one externref-producing handle referenced from two recipe sites, and asserts
both reconstructed sites yield an `ExternRef` whose backing Rust value
(`.data(&store)`) is the same object — since the campaign's own probe found
this floor via EMPIRICAL testing, not analysis, and native (wasmtime) has not
yet been through that same empirical proof.

---

## 6. The frames→refs delta for native (from I4)

I4's `instantiate_fork_module` (`crates/host-native/src/guest.rs:2611-2743`)
today:
- Supplies `__wpk_fork_function_catalog`, `__wpk_fork_drive_table` as EMPTY
  `Ref::Func(None)` tables (initial size 0, per the module's OWN declared
  `TableType`), and `__wpk_fork_static_root_catalog` as an EMPTY `Ref::Any(None)`
  table (`guest.rs:2661-2677`).
- Defines EVERY remaining function import (`wpk_fork_host.host_*`,
  `env.resolve_externref`) as a TRAPPING stub via
  `linker.define_unknown_imports_as_traps(&module)` (`guest.rs:2709`).
- Binds ONLY the frame-coordinator `fm_*` exports into `ForkModule` (`fm_set_format`,
  `fm_set_resume_catalog`, `fm_begin_unwind`, `fm_finish_unwind`,
  `fm_serialize_journal_alloc`, `fm_journal_image_len`, `fm_begin_replay`,
  `fm_finish_replay`, `fm_begin_child_replay`, `fm_last_errno`,
  `fm_frames_committed`, `fm_frames_replayed`, plus the four `*_reconstructed`
  counters as read-only proof-of-use taps) — `guest.rs:2721-2742`. NONE of the
  §1 reference-seeding/decode/drive exports (`fm_begin_reference_replay`,
  `fm_funcref_ordinal`, `fm_static_root_slot`, `fm_externref_handle`, the seven
  `fm_ref_*`, `fm_drive_table_base`, `fm_build_gc_plan`/`fm_gc_plan_count`,
  `fm_drive_execute`, `fm_set_activation_gc_codec`, `fm_set_host_exception_owner`,
  `fm_set_activation_catalog_base`, `fm_set_activation_static_root_base`) are
  bound in `ForkModule` yet.
- No wiring at all exists in `host-native` today for a GUEST's own
  `__wpk_fork_ref_decode_funcref`/`__wpk_fork_ref_decode_externref`/
  `__wpk_fork_ref_gc_transit`/the seven `__wpk_fork_ref_*` feed imports —
  `guest.rs`'s guest-instantiation path has never been reference-aware (grep
  for `__wpk_fork_ref_gc_transit` across `crates/host-native/` returns nothing).

**Precisely what I5 must change:**

1. **Populate the fork-module's own imported tables, live, once guest
   instance(s) exist** (mirrors `worker-main.ts:4780-4874`):
   - `__wpk_fork_function_catalog`: `Table::grow` + `Table::set(idx, Ref::Func(Some(guest_func)))` per activation, at `base[a]..base[a]+len_a`, copying the guest's own exported `__wpk_fork_function_catalog` table entries (real `wasmtime::Func` values — identity preserved automatically since Wasmtime funcrefs ARE `Func` handles into the same `Store`, no separate object needed). Call `fm_set_activation_catalog_base` (lib.rs:3147) for `>1` activation.
   - `__wpk_fork_drive_table`: `Table::grow` + `Table::set` at `fm_drive_table_base(act)+{0,1,2}` with the guest's `_gc_allocate`/`_gc_fill`/`_exception_materialize` `Func` exports (skip EXN slot when the guest has no exception codec).
   - `__wpk_fork_static_root_catalog`: `Table::grow` + `Table::set` with the child's live static-root `anyref`/GC values, at a per-activation `[base,base+width)` slice for only-referenced ordinals; call `fm_set_activation_static_root_base` for `>1` static-root activation.
2. **Bind the fork-module's `__wpk_fork_ref_gc_transit` EXPORT into the
   GUEST's import object** under `env.__wpk_fork_ref_gc_transit` — currently
   entirely unwired on native (§2 row 4). This must happen at GUEST
   instantiation time (the guest is instantiated after the fork-module per
   the existing I4 ordering), analogous to how `fork-module-instance.ts:558`
   exposes `gcTransitTable` for `worker-main.ts` to feed into the guest's
   import object.
3. **Flip the guest's reference imports** to the fork-module's exports,
   mirroring §4's guest-import-flip block: `__wpk_fork_ref_decode_funcref` →
   `fm_ref_decode_funcref`-shim export (named `__wpk_fork_ref_decode_funcref`
   on the module), `__wpk_fork_ref_decode_externref` likewise, and the seven
   `__wpk_fork_ref_*` feed imports → the seven `fm_ref_*` exports (§1 table).
   Native guest imports are synchronous `Func::wrap`/`func_wrap` closures (no
   async boundary to cross, unlike Node's `WebAssembly.instantiate` await),
   so this is a straight `linker.define(&mut store, "env", name,
   forkmodule_instance.get_export(name))`-style rebind rather than a
   JS-object-literal merge — simpler than the TS side, not harder.
4. **Implement `env.resolve_externref` as a real Wasmtime `Func`** (currently
   trapped by `define_unknown_imports_as_traps`) — body per §5: look up/insert
   into a `HashMap<u32, Rooted<ExternRef>>` scoped by a `RootScope` tied to the
   fork's generation, return the `Rooted<ExternRef>`.
5. **Implement the 3 `ForkHostCapabilities` methods** on a native
   `impl ForkHostCapabilities for <native store wrapper>` (replacing
   `native_sketch::NativeForkHost`'s `ENOSYS` bodies) via `Tag::new`/`Tag::eq`
   per `native_sketch.rs`'s own mapping table — needed for I5's Step 2 per the
   plan, though (per §3) not on the funcref/externref/GC reference-replay hot
   path itself; primarily the unwind-transport tag, which IS on the
   capture/replay hot path already (I4 territory) but is apparently still
   ENOSYS.
6. **Bind the newly-needed `fm_*` exports into `ForkModule`** (the struct at
   `guest.rs:2480-2522`): `fm_begin_reference_replay`, `fm_set_activation_
   catalog_base`, `fm_set_activation_static_root_base`, `fm_set_activation_
   gc_codec`, `fm_set_host_exception_owner`, `fm_build_gc_plan`,
   `fm_gc_plan_count`, `fm_drive_execute`, `fm_drive_table_base`, plus reading
   the `__wpk_fork_ref_gc_transit` table export.
7. **Sequence the calls exactly as `fork-process-continuation.ts:1081-1100`
   does**: `fm_begin_reference_replay` BEFORE any module-state restore →
   (native equivalent of PHASE A/B static-root pin + externref publish, if
   native has an analogous restore step) → `fm_build_gc_plan` +
   `fm_drive_execute` in place of any native "materializeAllTyped" →
   `fm_begin_child_replay` / the rewind that then calls back through the
   flipped decode/feed imports.

**What I4's `instantiate_fork_module` can be reused as-is:** the module
loading (`Module::new`), PIC region placement math
(`compute_fork_module_region`/`read_fork_module_mem_info`), the placement
globals (`__memory_base`/`__table_base`/`__stack_pointer`), `env.memory`
sharing, and the frame-coordinator `fm_*` bindings already present in
`ForkModule` — none of that changes for I5. I5 is additive: swap the four
table imports from empty/trap to populated/live, add `env.resolve_externref`
as a real func, bind the additional `fm_*` reference exports, and — the piece
with no I4 precedent at all — wire the GUEST's own reference imports for the
first time.

---

## 7. I5 scope vs F6 (M3) boundary

Per `docs/plans/2026-09-05-rust-first-campaign-to-completion.md` Part B:

- **B2 / N1-I5 ("native fork REFERENCES")**: get the MACHINERY live for the
  reference kinds the module's existing drive/decode path already handles
  when driven correctly — funcref, externref (including the simple
  directly-held case), and "anyref" in the sense of the transit/table
  plumbing working end-to-end. Acceptance line (plan line 175-177): *"a fork
  fixture that captures references (funcref + externref + anyref)
  reconstructs them correctly across the fork; `fm_*_reconstructed>0`;
  identity preserved."* This is explicitly NARROWER than "every kind" — it is
  the three kinds named in the acceptance line, proven once, on native.
- **B3 / F6 (M3, "All reference kinds — completeness")**: *"Enable + prove
  each kind end-to-end across a fork, on native AND (module is shared)
  available to Node/browser: externref incl. **GC-derived**, **struct**,
  **array**, **i31**, **static-root**. Remove each `EOPNOTSUPP`/gated-abort
  arm as its kind is proven (`worker-main.ts` gated arms + `lib.rs` gates +
  the module's `fm_build_gc_plan`/`fm_drive_*`)."* Acceptance: *"no
  `EOPNOTSUPP` reference-kind gate remains; a fixture exercising every kind
  forks correctly."* Milestone M3's gate statement (line 70-73) is explicit:
  *"NO `EOPNOTSUPP` reference gate anywhere; externref (incl. GC-derived),
  struct, array, i31, static-root all fork correctly; funcref-capture residue
  eliminated (re-instrument); truth-in-gating arms fixed."*

**The clean line**: I5 proves the SHARED-MODULE MACHINERY works at all on a
native Wasmtime store for the kinds simple enough not to need dedicated
per-kind gate removal work — funcref (decode via catalog `table.get`),
externref (decode via `resolve_externref` direct call), and the anyref
transit plumbing itself (the table exists, is bound, and a value can be
published/read through it, e.g. via a static-root or simple GC-drive step
exercised in the acceptance fixture). It also brings up `ForkHostCapabilities`
for real (Step 2) and nails the externref-identity discipline (Step 3). It
does NOT need to remove every `EOPNOTSUPP` gate that currently forces
struct/array/i31/GC-derived-externref/full static-root graphs onto the
JS-only path for Node/browser — those gates (cited by B3 as living in
`worker-main.ts` gated arms + `lib.rs` gates + `fm_build_gc_plan`/`fm_drive_*`)
stay in place; F6/M3's job is to prove each of those specific kinds correct
and delete its gate, one kind at a time, building on the now-working native
substrate I5 delivers. B6 ("truth-in-gating tidy-up",
`worker-main.ts:4444`/`lib.rs:2258`) and B4 ("funcref-capture re-instrument
residue") are explicitly scoped to F6/M3 as well, not I5.

In short: **I5 = "the wires are live and carry current for the easy kinds,
on native, with identity proven."** **M3 = "every kind the module's design
already accounts for (GC struct/array/i31, GC-derived externref, full
static-root graphs) is actually turned on, with zero remaining `EOPNOTSUPP`,
on every host."**

---

## Net-new native reference surface for I5

Concrete deliverables, all additive to `crates/host-native/src/guest.rs`
(`instantiate_fork_module`, `ForkModule`, guest-instantiation path) and a new
`impl ForkHostCapabilities for <native wrapper>` replacing
`fork_codec::native_sketch::NativeForkHost`:

1. Populate `__wpk_fork_function_catalog` + `__wpk_fork_drive_table` (funcref
   tables) with real `wasmtime::Func` values copied from each guest
   activation's own catalog/GC exports, with per-activation base seeding via
   `fm_set_activation_catalog_base`.
2. Populate `__wpk_fork_static_root_catalog` (anyref table) with the child's
   live static-root values, per-activation base seeding via
   `fm_set_activation_static_root_base`.
3. Bind the fork-module's EXPORTED `__wpk_fork_ref_gc_transit` table into the
   guest's `env.__wpk_fork_ref_gc_transit` import (net-new: no prior native
   wiring exists for this at all).
4. Flip the guest's `__wpk_fork_ref_decode_funcref`/`_decode_externref` and
   the seven `__wpk_fork_ref_{vector_get,gc_route,gc_payload_len,gc_load,
   exn_route,exn_load,exn_cache_index}` imports to the fork-module's matching
   `fm_ref_*`/decode exports (native `Func`s are synchronous — a straight
   linker rebind, no async merge needed).
5. Implement `env.resolve_externref(handle: i32) -> externref` as a real
   `Func::wrap` closure over a `HashMap<u32, Rooted<ExternRef>>` scoped by a
   `RootScope` per fork generation — idempotent per handle (§5).
6. Implement `ForkHostCapabilities::{mint_exception_tag,
   provide_unwind_transport_tag, recognize_unwind_transport}` via wasmtime 48
   `Tag::new`/`Tag::eq`, replacing `native_sketch::NativeForkHost`'s `ENOSYS`
   stubs.
7. Call `fm_set_activation_gc_codec` / `fm_set_host_exception_owner` /
   `fm_begin_reference_replay` / `fm_build_gc_plan` + `fm_drive_execute` /
   `fm_begin_child_replay` in the exact sequence
   `fork-process-continuation.ts:1081-1100` uses, and bind all the
   newly-needed `fm_*` typed functions into the `ForkModule` struct.
8. A native fork fixture that captures funcref + externref + a
   transit-exercising anyref value, forks, and asserts `fm_references_
   reconstructed`, `fm_externrefs_resolved`, and (if the fixture exercises the
   transit) `fm_drive_steps_executed`/`fm_static_roots_published` are all
   `>0`, plus an explicit externref-identity check across the fork (§5).

## I5 / M3 boundary (one line)

I5 = native's wiring is live and every `fm_*_reconstructed` counter can go
nonzero for funcref + externref + the anyref transit mechanism, with identity
proven and `ForkHostCapabilities` no longer `ENOSYS`. M3 = every reference
KIND the module's design supports (GC struct/array/i31, GC-derived externref,
full static-root graphs, funcref-capture re-instrument) is turned on with its
`EOPNOTSUPP` gate removed, on every host, not just native.
