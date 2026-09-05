/**
 * Tracks live GBM buffer objects (`bo`) reported by the kernel on
 * `/dev/dri/renderD128`. v1 CpuShared tier only.
 *
 * Each bo owns a host-side `SharedArrayBuffer` of `size` bytes — the
 * canonical pixel storage. Per-process wasm `Memory` mmaps are
 * synchronized to that SAB on bind-boundary transitions so that
 * cross-process pixel sharing (e.g. PRIME export → fork → PRIME
 * import) actually delivers bytes from the writer to subsequent
 * readers:
 *
 *   - On `bind(new_pid, …)`, every OTHER currently-bound pid's
 *     mmapped region is flushed into the SAB (snapshot of latest
 *     writes), then the SAB is copied into `new_pid`'s region.
 *   - On `unbind(pid, …)`, that pid's region is flushed into the
 *     SAB so a future re-bind (or another pid binding) sees the
 *     latest bytes.
 *
 * The semantics are "snapshot at every bind/unbind boundary," not
 * true live aliasing. Concurrent writers each holding a live
 * mapping are not coherent until one of them un/rebinds. This is
 * sufficient for milestone (A) — the demo pattern is
 * write-then-export-then-fork-then-import — and trades a small
 * cost (one memcpy per bind) for portability across browsers that
 * do not allow re-pointing a `WebAssembly.Memory`'s backing SAB.
 *
 * Lifecycle reported by the kernel:
 *   - `create(pid, bo_id, size, w, h, stride)` — DRM_IOCTL_MODE_CREATE_DUMB.
 *     Allocates the bo's SAB lazily on first create.
 *   - `bind(pid, bo_id, addr, len)` — mmap of bo offset minted by
 *     DRM_IOCTL_MODE_MAP_DUMB. Pixel storage now reflected in process
 *     Memory at `[addr, addr+len)`. Auto-registers the pid as a
 *     consumer of the bo if it wasn't already — covers the PRIME
 *     import path, where the kernel hands a fresh local handle to
 *     a child process without firing `gbm_bo_create` (the bo's
 *     metadata is already in the registry from the creator's
 *     CREATE_DUMB).
 *   - `unbind(pid, bo_id, addr, len)` — munmap. Last-writer state is
 *     flushed back into the SAB.
 *   - `destroy(pid, bo_id)` — bo's global refcount reached zero
 *     (last GEM_CLOSE or process-exit). The entry + SAB are dropped.
 *
 * Internally keyed by `bo_id` (the kernel-global monotonic id) — the
 * earlier `(pid, bo_id)` key broke PRIME imports because a child's
 * mmap fires `bind(child_pid, bo_id, …)` for a bo whose entry was
 * only ever created under the parent's pid. The public API still
 * takes `(pid, bo_id)` and projects per-pid views for backward compat
 * with the existing dri-smoke + browser-mirror tests.
 *
 * The SAB-sync requires per-pid access to `WebAssembly.Memory`.
 * Callers that drive the bind/unbind path (the in-worker
 * `host_gbm_bo_*` import handlers) inject this via the
 * `processMemoryResolver` option at construction time. Consumers
 * with no resolver (the main-thread mirror in browser-kernel-host,
 * unit tests that only check metadata) get pure-metadata behavior
 * — bind/unbind still record the binding but don't touch any
 * Memory.
 */
export type GbmBoCreateInput = {
  pid: number;
  bo_id: number;
  size: number;
  w: number;
  h: number;
  stride: number;
};

export type GbmBoBinding = {
  /** Offset within the process's wasm Memory. */
  addr: number;
  /** Length in bytes — equal to or less than `size`. */
  len: number;
};

/** Projected view of a bo for a specific pid — what `get`/`listForPid`
 *  return. Backward-compatible with the pre-rekey shape so existing
 *  callers reading `e.binding` keep working. */
export type GbmBoEntry = {
  pid: number;
  bo_id: number;
  size: number;
  w: number;
  h: number;
  stride: number;
  /** This pid's binding, or null if the pid holds a handle but
   *  hasn't mmap'd (post-create / post-unbind). */
  binding: GbmBoBinding | null;
};

/** One buffer object with its canonical pixels, as a checkpoint carries it. */
export type GbmBoSnapshot = {
  readonly bo_id: number;
  readonly size: number;
  readonly w: number;
  readonly h: number;
  readonly stride: number;
  /** Every pid holding a handle: the creator plus any PRIME importer. */
  readonly pids: readonly number[];
  readonly bindings: readonly (GbmBoBinding & { readonly pid: number })[];
  readonly pixels: Uint8Array;
};

export type GbmBoChangeEvent = "create" | "bind" | "unbind" | "destroy";
export type GbmBoChangeListener = (
  pid: number,
  bo_id: number,
  ev: GbmBoChangeEvent,
) => void;

type InternalEntry = {
  bo_id: number;
  size: number;
  w: number;
  h: number;
  stride: number;
  /** Canonical pixel storage. Pre-`mmap_shared`, this is also the
   *  authoritative buffer that bind/unbind syncs each pid's wasm
   *  Memory against. Allocated on the first `create` for the bo. */
  sab: SharedArrayBuffer;
  /** Every pid currently holding a handle to this bo (creator +
   *  any PRIME importers). A pid lands here on `create` or on its
   *  first `bind` — see the import-path note in the file header. */
  pids: Set<number>;
  /** Per-pid bindings. A pid has at most one bo mmap in v1 (the
   *  shim always maps the whole bo). */
  bindingsByPid: Map<number, GbmBoBinding>;
};

/** Per-pid Memory resolver. Returning `undefined` for a pid that
 *  currently has a binding signals the bind/unbind path that the
 *  process has gone away (post-exit) and the sync should be
 *  skipped for that pid. */
export type ProcessMemoryResolver = (
  pid: number,
) => WebAssembly.Memory | undefined;

export interface GbmBoRegistryOptions {
  /** Lets `bind`/`unbind` reach a pid's `WebAssembly.Memory` to
   *  flush/prime the bo's SAB. When omitted, the registry is
   *  pure-metadata and bind/unbind do not touch any Memory. */
  getProcessMemory?: ProcessMemoryResolver;
}

export class GbmBoRegistry {
  private bos = new Map<number, InternalEntry>();
  private listeners = new Set<GbmBoChangeListener>();
  private getProcessMemory: ProcessMemoryResolver | null;

  constructor(opts: GbmBoRegistryOptions = {}) {
    this.getProcessMemory = opts.getProcessMemory ?? null;
  }

  setProcessMemoryResolver(fn: ProcessMemoryResolver | null): void {
    this.getProcessMemory = fn;
  }

  create(b: GbmBoCreateInput): void {
    const existing = this.bos.get(b.bo_id);
    if (existing) {
      // Defensive: a second create for the same bo_id should never
      // happen (the kernel allocates monotonic ids and tears down on
      // destroy). Treat it as an additional consumer if it does —
      // safer than clobbering live bindings under the same id.
      existing.pids.add(b.pid);
    } else {
      this.bos.set(b.bo_id, {
        bo_id: b.bo_id,
        size: b.size,
        w: b.w,
        h: b.h,
        stride: b.stride,
        sab: new SharedArrayBuffer(b.size),
        pids: new Set([b.pid]),
        bindingsByPid: new Map(),
      });
    }
    for (const l of this.listeners) l(b.pid, b.bo_id, "create");
  }

  destroy(pid: number, bo_id: number): void {
    if (!this.bos.delete(bo_id)) return;
    for (const l of this.listeners) l(pid, bo_id, "destroy");
  }

  bind(pid: number, bo_id: number, addr: number, len: number): number {
    const e = this.bos.get(bo_id);
    if (!e) return -1;
    // First bind for an importer pid registers it in the bo's pids
    // set — PRIME_FD_TO_HANDLE doesn't fire a host-side create.
    // Pure metadata at this point: the actual SAB→Memory prime is
    // deferred to `primeBindFromSab`, called after the kernel-worker
    // post-syscall path has grown the Memory and zero-filled the
    // mmap region. If we wrote here, the zero-fill would clobber
    // our primed bytes.
    e.pids.add(pid);
    e.bindingsByPid.set(pid, { addr, len });
    for (const l of this.listeners) l(pid, bo_id, "bind");
    return 0;
  }

  unbind(pid: number, bo_id: number): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    // Flush the unbinding pid's current bytes into the SAB before
    // dropping the binding — a subsequent bind (in another pid or
    // the same pid re-importing) needs to see the latest writes.
    // The kernel fires `gbm_bo_unbind` BEFORE `proc.memory.munmap`
    // releases pages (see crates/kernel/src/syscalls.rs sys_munmap),
    // so the Memory still has the bytes here.
    const binding = e.bindingsByPid.get(pid);
    if (binding) this.flushMemoryToSab(e, pid, binding);
    e.bindingsByPid.delete(pid);
    for (const l of this.listeners) l(pid, bo_id, "unbind");
  }

  /**
   * Remove every binding and handle owned by one process.
   *
   * WHY: a trapped/force-terminated Worker cannot run the normal GEM_CLOSE and
   * munmap hooks. Flush its last visible pixels while the process Memory
   * resolver is still valid, then remove only that pid's ownership. Shared
   * bos survive while another process still owns them.
   */
  releaseProcess(pid: number): void {
    for (const [bo_id, e] of Array.from(this.bos)) {
      const binding = e.bindingsByPid.get(pid);
      if (binding) {
        this.flushMemoryToSab(e, pid, binding);
        e.bindingsByPid.delete(pid);
        for (const l of this.listeners) l(pid, bo_id, "unbind");
      }
      if (!e.pids.delete(pid)) continue;
      if (e.pids.size !== 0) continue;
      this.bos.delete(bo_id);
      for (const l of this.listeners) l(pid, bo_id, "destroy");
    }
  }

  /** Find the bo bound for `pid` at `addr`. Used by kernel-worker's
   *  post-mmap hook to decide whether to run `primeBindFromSab`. */
  findBindingByAddr(pid: number, addr: number): number | undefined {
    for (const e of this.bos.values()) {
      const b = e.bindingsByPid.get(pid);
      if (b && b.addr === addr) return e.bo_id;
    }
    return undefined;
  }

  /** Post-mmap prime — flushes every OTHER bound pid's wasm Memory
   *  into the bo's SAB, then copies the SAB into `pid`'s `memory`
   *  at the recorded [addr, len). Caller (kernel-worker.ts) invokes
   *  this AFTER `ensureProcessMemoryCovers` has grown the Memory and
   *  the anonymous-mmap zero-fill has run, so our primed bytes are
   *  the final state seen by the user program. */
  primeBindFromSab(
    pid: number,
    bo_id: number,
    memory: WebAssembly.Memory,
  ): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    const binding = e.bindingsByPid.get(pid);
    if (!binding) return;
    for (const [otherPid, otherBinding] of e.bindingsByPid) {
      if (otherPid === pid) continue;
      this.flushMemoryToSab(e, otherPid, otherBinding);
    }
    const copyLen = Math.min(binding.len, e.size);
    if (binding.addr + copyLen > memory.buffer.byteLength) return;
    const dst = new Uint8Array(memory.buffer, binding.addr, copyLen);
    const src = new Uint8Array(e.sab, 0, copyLen);
    dst.set(src);
  }

  private flushMemoryToSab(
    e: InternalEntry,
    pid: number,
    binding: GbmBoBinding,
  ): void {
    const resolver = this.getProcessMemory;
    if (!resolver) return;
    const mem = resolver(pid);
    if (!mem) return;
    const copyLen = Math.min(binding.len, e.size);
    if (binding.addr + copyLen > mem.buffer.byteLength) return;
    const dst = new Uint8Array(e.sab, 0, copyLen);
    const src = new Uint8Array(mem.buffer, binding.addr, copyLen);
    dst.set(src);
  }

  get(pid: number, bo_id: number): GbmBoEntry | undefined {
    const e = this.bos.get(bo_id);
    if (!e || !e.pids.has(pid)) return undefined;
    return this.project(e, pid);
  }

  listForPid(pid: number): GbmBoEntry[] {
    const out: GbmBoEntry[] = [];
    for (const e of this.bos.values()) {
      if (e.pids.has(pid)) out.push(this.project(e, pid));
    }
    return out;
  }

  /** Direct view onto a bo's canonical pixel SAB. Undefined for unknown bos. */
  pixelView(bo_id: number): Uint8Array | undefined {
    const e = this.bos.get(bo_id);
    if (!e) return undefined;
    return new Uint8Array(e.sab);
  }

  /** Flush each bound pid's Memory into the SAB (KMS scanout calls this
   *  per vblank so mid-bind paints land without an explicit munmap). */
  syncFromMemory(bo_id: number): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    for (const [pid, binding] of e.bindingsByPid) {
      this.flushMemoryToSab(e, pid, binding);
    }
  }

  /**
   * Every buffer object, with each one's pixels flushed out of process memory.
   *
   * A bound pid's latest paint sits in its wasm Memory until a bind boundary
   * moves it, so the flush runs first. The bytes are then copied out, leaving
   * the SAB serving the machine the checkpoint gives back.
   *
   * Every bo's pixels are carried, not only an unbound one's. A bound bo's
   * bytes do also ride inside the process memory copy, but `scanoutBytes`
   * reads the SAB rather than process memory, so a restore that rebuilt only
   * the mapped ranges would scan out a black frame.
   */
  snapshot(): GbmBoSnapshot[] {
    const out: GbmBoSnapshot[] = [];
    for (const e of this.bos.values()) {
      this.syncFromMemory(e.bo_id);
      out.push({
        bo_id: e.bo_id,
        size: e.size,
        w: e.w,
        h: e.h,
        stride: e.stride,
        pids: [...e.pids],
        bindings: [...e.bindingsByPid].map(([pid, binding]) => ({
          pid,
          addr: binding.addr,
          len: binding.len,
        })),
        pixels: new Uint8Array(e.sab).slice(),
      });
    }
    return out;
  }

  /**
   * Adopt checkpointed buffer objects, replacing whatever this registry holds.
   *
   * The pixels land in fresh SABs. Nothing here writes into process memory: a
   * restored process adopts a byte copy of its captured memory, so a mapped
   * range already holds the same pixels this seeds the SAB with.
   */
  restore(buffers: readonly GbmBoSnapshot[]): void {
    this.bos.clear();
    for (const b of buffers) {
      const sab = new SharedArrayBuffer(b.size);
      new Uint8Array(sab).set(b.pixels.subarray(0, b.size));
      this.bos.set(b.bo_id, {
        bo_id: b.bo_id,
        size: b.size,
        w: b.w,
        h: b.h,
        stride: b.stride,
        sab,
        pids: new Set(b.pids),
        bindingsByPid: new Map(
          b.bindings.map(({ pid, addr, len }) => [pid, { addr, len }]),
        ),
      });
    }
  }

  onChange(fn: GbmBoChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private project(e: InternalEntry, pid: number): GbmBoEntry {
    return {
      pid,
      bo_id: e.bo_id,
      size: e.size,
      w: e.w,
      h: e.h,
      stride: e.stride,
      binding: e.bindingsByPid.get(pid) ?? null,
    };
  }
}
