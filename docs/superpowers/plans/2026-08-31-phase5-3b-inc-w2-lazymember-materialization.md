# Phase 5 Increment 3b-wiring.2 — Kernel LazyMember materialization + `fetch_archive` op Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a `LazyMember` overlay node serve real bytes. On first touch the
kernel fetches the whole backing archive through a new host transport op
`fetch_archive` (mirrors `blob_read`), decodes the requested member with the
in-kernel `zip` reader (Increment 3b.2), caches it, and serves reads/writes/
truncates from it — turning the RTFS v3 metadata placed in w1 into a working
byte source. Model B: the host is a raw-byte transport (fetch archive bytes by
`archive_id` at `offset`); the KERNEL decodes and owns all VFS I/O. Additive/
dormant end-to-end: no boot manifest emits `KIND_LAZY_FILE` entries yet (that is
w3), so nothing exercises this at runtime until then; the seam is unit-tested
with a mock `fetch_archive` closure serving the committed `tiny.zip` fixture.

**Architecture / grounding (read the ACTUAL source before coding — do not trust
this summary if it differs):**
- `blob_read` transport op is the exact template. Its 4-file wiring:
  1. `crates/runtime-core/src/process.rs:67` — `HostIO::blob_read` trait method, default `Err(ENOSYS)`.
  2. `crates/kernel/src/wasm_api.rs:79` — `host_blob_read` extern import (blob_id + offset each split lo/hi across the JS boundary).
  3. `crates/kernel/src/wasm_api.rs:361` — `impl HostIO::blob_read` calling the extern (split-words via `>> 32`).
  4. `host/src/kernel.ts` — `#rootfsBlobProvider` field (`:860`), `setRootfsBlobProvider` (`:959`), `#hostBlobRead` staging shim (`:2685`), `host_blob_read` import (`:1588`). Provider unset → ENOSYS.
- Materialization plumbing in `crates/runtime-core/src/rootfs.rs`: `read` (`:1188`), `write` (`:1103`), `truncate_handle` (`:1136`), `ensure_materialized` (`:1060`) each take a `blob_read` closure `F: FnMut(u64 blob_id, u64 offset, &mut [u8]) -> Result<usize, Errno>`. The BaseRegular pattern: `read` serves base bytes from the byte store each call WITHOUT converting the node (`Plan::Base`); `write`/`truncate` copy-on-write via `ensure_materialized` (BaseRegular→`Regular(Vec)`), doing the host byte read OUTSIDE the store lock (capture-under-lock, fetch-outside, re-store-under-lock, re-check).
- Archive registry: `RootfsState.archives: BTreeMap<u32, u64>` (`:249`) = `archive_id → archive_size`, populated from the v3 manifest trailing table in `load_manifest_inner`, cleared by `reset()`. Test accessor `archive_size(id) -> Option<u64>`.
- `InodeKind::LazyMember { archive_id: u32, source_path: Vec<u8>, size: u64 }` (`:114`). Its byte/mutation arms currently return `ENOSYS` (read `:1219`, ensure_materialized `:1072`) or `EISDIR` (truncate(0) `:1148-1154`, TODO to align).
- zip decode API (`crates/runtime-core/src/zip.rs`): `read_central_directory(&[u8]) -> Vec<ZipEntry>` (`ZipEntry.name: Vec<u8>` = exact member name bytes); `extract(&[u8], &ZipEntry) -> Vec<u8>` (inflated member bytes; handles stored + raw DEFLATE). Committed fixture `crates/runtime-core/src/testdata/tiny.zip` (has member `bin/big.txt` = 4096 `a` bytes, plus a symlink/dir — confirm member names by reading the zip.rs tests).

**Design decisions (decisive — implement as written):**
- **Per-archive fetch, per-member lazy inflate, both cached.** On first touch of ANY member of archive N, fetch the WHOLE archive once (`archive_size` bytes) and cache the raw bytes + parsed central directory. Inflate each member on first read of THAT member and cache the inflated bytes. Amortizes the (expensive) fetch across all members and the (expensive) inflate per member. Do NOT eagerly inflate every member on first touch (a lazy interpreter archive expands to 100s of MB). Eviction is out of scope (future work; note it).
- **Registry value becomes a struct.** Replace `archives: BTreeMap<u32, u64>` with `BTreeMap<u32, ArchiveEntry>` where
  `struct ArchiveEntry { size: u64, raw: Option<Vec<u8>>, directory: Option<Vec<zip::ZipEntry>>, members: BTreeMap<Vec<u8>, Vec<u8>> }`.
  `size` is authoritative manifest metadata; `raw`/`directory`/`members` are the fetched/decoded cache (all `None`/empty until first touch). `archive_size(id)` returns `size`. `reset()` clears (already does — verify the whole struct is dropped).
- **EAGAIN is idempotent restart.** If `fetch_archive` returns `Err(EAGAIN)` mid-fetch, discard the partial buffer and propagate `EAGAIN`; the host parks and retries the whole syscall, which re-enters materialization from scratch (raw still `None`). Never cache a partial archive. (Matches the 3a poll-retry model.) Document this.
- **Lock discipline mirrors `ensure_materialized`.** The whole-archive fetch and the zip inflate run OUTSIDE the `ROOTFS.with` store lock (they are heavy and, for fetch, may re-enter the host). Capture what you need under the lock, work outside, re-acquire to store, and re-check state hasn't changed.
- **Second closure, threaded alongside `blob_read`.** `read`/`write`/`truncate_handle`/`ensure_materialized`/`read_file_at` gain a second closure param `fetch_archive: G` where `G: FnMut(u32 archive_id, u64 offset, &mut [u8]) -> Result<usize, Errno>`. This is mechanical churn at the call sites (`wasm_api.rs:1539`, `:1584`, `exec_target.rs:439`, plus any other `rootfs::read/write/truncate_handle/read_file_at` callers — grep to find them all). Keep `blob_read` for BaseRegular unchanged; `fetch_archive` is only consumed on the LazyMember arms. Do NOT bundle them into a trait/struct (keeps the existing bare-closure style; smaller diff).
- **truncate(0) on a LazyMember is now a real truncate**, not ENOSYS/EISDIR: materialization exists, so truncate-to-0 converts the node to `Regular(Vec::new())` (like a BaseRegular truncate-to-0, which needs no bytes). This resolves the w1-deferred `EISDIR→ENOSYS` minor by making it a correct success instead.

**Global Constraints**
- Rust: `no_std + alloc`; `Errno = wasm_posix_shared::Errno`; panic-free/bounds-checked. Test target: `cargo test -p runtime-core --target "$(rustc -vV | sed -n 's/^host: //p')" rootfs`. Wasm build: `cargo build -p kandelo -Z build-std=core,alloc` (from repo root; must stay warning-clean).
- TS: `cd host && npx vitest run <file>` inside `scripts/dev-shell.sh`. `tsc` clean.
- Commit hygiene: `git add <specific files>` ONLY (never `-A`/`.`); confirm `git status --short` before each commit (worktree has unrelated untracked noise). cwd RESETS between bash commands — prefix `cd /Users/brandon/kandelo-epoll &&`.
- ABI: `host_fetch_archive` is a NEW kernel→host import. Adding a host import the kernel calls is an ABI-adjacent change to the host/kernel import surface — regenerate `abi/snapshot.json` if the snapshot enumerates kernel imports (check: does `abi/snapshot.json` list `host_blob_read`? If yes, add `host_fetch_archive` and regen per `docs/abi-versioning.md`; if the snapshot does not enumerate host imports, no bump). Confirm in Task 3, do not guess.
- SONNET implementers for all logic tasks. Warning-clean. Read the real current source per task step 1.

---

### Task 1: Rust — `fetch_archive` HostIO seam + archive cache struct

**Files:** Modify `crates/runtime-core/src/process.rs`; Modify `crates/runtime-core/src/rootfs.rs`.

**Interfaces — Produces:** `HostIO::fetch_archive(&mut self, archive_id: u32, buf: &mut [u8], offset: u64) -> Result<usize, Errno>` (trait default `Err(ENOSYS)`, doc-comment mirroring `blob_read`'s: "narrow raw-archive transport seam; host is a byte store addressed by manifest `archive_id`"). `ArchiveEntry` struct replacing the `u64` registry value; `archives: BTreeMap<u32, ArchiveEntry>`; `load_manifest_inner` stores `ArchiveEntry { size, raw: None, directory: None, members: empty }`; `archive_size(id) -> Option<u64>` returns `.size`; `reset()` clears.

- [ ] **Step 1: failing/adjusting tests** — the existing w1 archive tests (`archive_size`, `load_manifest_v3_rejects_truncated_archive_table`) must still pass after the registry value becomes a struct; adjust their internals only if they construct the registry directly. Add nothing behavioral yet. (This task is a pure refactor + new trait method; run the rootfs suite → green.)
- [ ] **Step 2-3:** add the trait method (process.rs, default ENOSYS); change the registry type + `load_manifest_inner` insert + `archive_size` accessor + confirm `reset()` drops the new fields. `cargo test -p runtime-core rootfs` green; `cargo build -p kandelo` clean; warning-clean.
- [ ] **Step 4: commit** the two files: `VFS: fetch_archive HostIO seam + archive cache struct (Phase 5 3b-wiring.2)`.

---

### Task 2: Rust — LazyMember materialization (fetch → zip decode → cache → serve)

**Files:** Modify `crates/runtime-core/src/rootfs.rs`.

**Interfaces — Produces:** an internal `fn ensure_archive_member<G>(archive_id, source_path, fetch_archive: &mut G) -> Result<Vec<u8>, Errno>` (returns the inflated member bytes, fetching+decoding+caching as needed; ENOENT if the archive_id is not in the registry or the member is absent; propagates EAGAIN from `fetch_archive`); `read`/`write`/`truncate_handle`/`ensure_materialized`/`read_file_at` gain the `fetch_archive: G` closure param (`G: FnMut(u32,u64,&mut[u8])->Result<usize,Errno>`) and handle `InodeKind::LazyMember`:
- `read`: `ensure_archive_member` → serve `[offset..]` bytes (clamp at member size). Do NOT convert the node (stays LazyMember; served from the archive `members` cache, mirroring how BaseRegular stays lazy).
- `ensure_materialized` (COW for write/nonzero-truncate): for LazyMember, `ensure_archive_member` → convert node to `InodeKind::Regular(member_bytes)`.
- `truncate_handle` `new_len==0`: LazyMember → `Regular(Vec::new())` success (no fetch needed); remove the `_ => EISDIR` LazyMember fall-through + its TODO.

**Steps:**
- [ ] **Step 1: failing tests** — extend the rootfs test module. Add a `make_archive_fetcher(entries: Vec<(u32 archive_id, Vec<u8> raw_bytes)>)` helper returning a closure (mirrors `make_blob_reader` at `:1900`). `include_bytes!("testdata/tiny.zip")` for real archive bytes. CONFIRMED fixture facts (from zip.rs tests): member `bin/big.txt` = DEFLATE, uncompressed 4096 bytes all `b'a'` (exercises the inflate path); member `etc/small.txt` = STORE, bytes `b"hello\n"` (6 bytes). Build a manifest (in-test, like w1 Task 1) with a `LazyMember` at `/lazy/f` → archive_id=7, source_path=`bin/big.txt`, size=4096; archive table {7, tiny.zip.len()}. Assert the read returns 4096 `b'a'`. (Use `etc/small.txt` for a second, stored-method member case if useful.) Tests: (a) open+read `/lazy/f` returns the 4096 member bytes, fetcher invoked; (b) a SECOND read is served from cache — fetcher NOT invoked again (assert call count); (c) `fetch_archive` returns `Err(EAGAIN)` → read returns `EAGAIN`, nothing cached (next call re-fetches); (d) source_path absent from the archive → ENOENT; (e) archive_id absent from the registry → ENOENT; (f) write at offset 0 COWs (node becomes Regular) then read-back reflects the write; (g) truncate to 0 succeeds → size 0, node Regular. Run → fail.
- [ ] **Step 2-4:** implement `ensure_archive_member` (capture size/raw-present under lock; fetch whole archive outside lock on `raw==None`, EAGAIN→propagate+discard; re-store raw+parse+cache directory; find member by `name == source_path`, `zip::extract`, cache in `members`; return clone) + thread `fetch_archive` through the five fns + the LazyMember arms + the truncate(0) change. Fetch/inflate OUTSIDE the store lock. Run rootfs suite → pass; `cargo build -p kandelo` clean; warning-clean.
- [ ] **Step 5: commit** `crates/runtime-core/src/rootfs.rs`: `VFS: LazyMember byte materialization via fetch_archive + zip decode (Phase 5 3b-wiring.2)`.

---

### Task 3: Rust — unify byte-source closure (`ByteReq`) + kernel `host_fetch_archive` extern/impl + call sites

> **DESIGN CORRECTION (from Task 2):** Task 2 added `fetch_archive` as a SECOND closure param alongside `blob_read`. That is defeated by borrow-checker error **E0524**: two closures each capturing `&mut host` (`|..| host.blob_read(..)` and `|..| host.fetch_archive(..)`) cannot both be live at one call, even though only one is invoked per call. The safe fix (NO `unsafe`) is to **collapse the two closures into ONE** dispatched by an enum — a single `&mut host` capture. Task 3 does this refactor (it re-touches `rootfs.rs`, crossing the original T2/T3 boundary — expected).

**Files:** Modify `crates/runtime-core/src/rootfs.rs` (collapse the two closure params into one), `crates/kernel/src/wasm_api.rs`, `crates/runtime-core/src/syscalls.rs`, `crates/runtime-core/src/exec_target.rs`; possibly regen `abi/snapshot.json`.

**Interfaces — Produces:**
- In `rootfs.rs`: `pub enum ByteReq { Base { blob_id: u64, offset: u64 }, Archive { archive_id: u32, offset: u64 } }`. Replace the two params `blob_read: F` + `fetch_archive: G` on `read`/`write`/`truncate_handle`/`ensure_materialized`/`read_file_at`/`write_file_at` with ONE param `byte_source: F where F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>`. Internal calls: the BaseRegular byte read becomes `byte_source(ByteReq::Base { blob_id, offset }, buf)`; the archive fetch inside `ensure_archive_member` becomes `byte_source(ByteReq::Archive { archive_id, offset }, buf)`. Update the rootfs UNIT TEST fetcher helpers accordingly: merge `make_blob_reader` + `make_archive_fetcher` into a single `make_byte_source(...)` that matches on `ByteReq` (a base-only test passes a source that returns ENOSYS for `Archive`, and vice-versa) — keep the invocation-count assertions.
- In `wasm_api.rs`: `host_fetch_archive(archive_id: u32, buf_ptr: *mut u8, buf_len: u32, offset_lo: u32, offset_hi: u32) -> i32` extern (mirror `host_blob_read` `:79`; `archive_id` is u32 → no split, only `offset` splits lo/hi); `impl HostIO::fetch_archive` (mirror `blob_read` `:361`: `checked_host_buffer_len`, split offset via `>> 32`, `checked_host_transfer_result`).
- At EVERY call site (`wasm_api.rs` `read_file_at`/`write_file_at` ~`:1539`/`:1584`; `syscalls.rs` ~`:5032,5290,5817,6265,16963`; `exec_target.rs:439`; + any others found by grep): pass ONE closure that dispatches — `|req, b| match req { ByteReq::Base { blob_id, offset } => host.blob_read(blob_id, b, offset), ByteReq::Archive { archive_id, offset } => host.fetch_archive(archive_id, b, offset) }`. One `&mut host` capture ⇒ compiles.

- [ ] **Step 1:** grep every `rootfs::(read|write|truncate_handle|read_file_at|write_file_at)(` caller across `runtime-core` + `kernel`; list them in the ledger (Task 2 found: `syscalls.rs` ~5032/5290/5817/6265/16963, `exec_target.rs:439`, `wasm_api.rs` ~1539/1584 — verify + find any more).
- [ ] **Step 2-4:** add `ByteReq` + collapse the rootfs params to one `byte_source` + update internal calls + merge the rootfs test fetcher helpers; add the `host_fetch_archive` extern + `impl fetch_archive`; convert every call site to the single match-dispatch closure. Validate: `cargo test -p runtime-core --target "$(rustc -vV | sed -n 's/^host: //p')" rootfs` green (now compiles standalone — the whole crate builds); `scripts/dev-shell.sh -c "cargo build -p kandelo -Z build-std=core,alloc"` clean (34-warning baseline, none new). ABI: check `abi/snapshot.json` — if it enumerates kernel host-imports (grep `host_blob_read`), add `host_fetch_archive` and regenerate per `docs/abi-versioning.md` (bump `ABI_VERSION` only if the snapshot policy requires it for a new import — follow the doc, do not guess); if it does NOT list host imports, note that and skip. Record the decision + evidence in the ledger.
- [ ] **Step 5: commit** the touched files (+ snapshot if regenerated): `Kernel: unify rootfs byte-source (ByteReq) + host_fetch_archive import (Phase 5 3b-wiring.2)`.

---

### Task 4: TS host — `fetch_archive` provider shim (Node + browser peers)

**Files:** Modify `host/src/kernel.ts`; add/extend a host test.

**Interfaces — Produces:** `#rootfsArchiveProvider: ((archiveId: number, offset: bigint, dest: Uint8Array) => number) | undefined` (mirror `#rootfsBlobProvider` `:860`); `setRootfsArchiveProvider(provider)` (mirror `:959`); `#hostFetchArchive(archiveId, offset, destination)` staging shim (mirror `#hostBlobRead` `:2685`: stage outside kernel memory, publish once, ENOSYS when unset, EIO on provider contract violation, negative-errno passthrough); `host_fetch_archive` import in the imports object (mirror `host_blob_read` `:1588`; `archiveId` is a plain number, `offset` from `u64FromWords(offsetLo, offsetHi)`). The provider stays UNSET here (wired from the boot manifest + lazy fetcher in w3) → `host_fetch_archive` reports ENOSYS, exactly as `blob_read` landed unbacked in Increment 2. This is a single shared host file → Node and browser get it identically (host-parity satisfied by construction; note it).

- [ ] **Step 1: failing test** — in the appropriate `host/test/*.ts` (find where `#hostBlobRead`/`setRootfsBlobProvider` is unit-tested and mirror it; if none, a focused new test): assert `host_fetch_archive` reports ENOSYS (-38) when no provider is set, and that a set provider's returned bytes are staged into the destination (mirror the blob test). Run → fail.
- [ ] **Step 2-3:** implement the field + setter + shim + import. `npx vitest run <file>` green; `tsc` clean.
- [ ] **Step 4: commit** the touched files: `Host: fetch_archive provider seam for lazy-archive transport (Phase 5 3b-wiring.2)`.

---

## Self-review notes
- Dormant end-to-end: no manifest emits `KIND_LAZY_FILE` yet (w3), and the host archive provider stays unset (w3), so runtime behavior is unchanged; the whole path is proven by unit tests with a mock `fetch_archive` closure + the real `tiny.zip` fixture decoded by the real in-kernel `zip` reader.
- Resolves the w1-deferred minor: truncate(0) on a LazyMember is now a correct success (Regular empty), not EISDIR/ENOSYS.
- Deferred beyond w2: w3 = host archive provider (backed by the lazy fetcher) + emitter detects lazy stubs (`lazyArchiveInodes`) and emits `KIND_LAZY_FILE` linkage (Node+browser); w4 = exec-target EAGAIN park/retry so an interpreter binary living in a lazy archive can be exec'd; archive cache eviction (memory) is future work.
- Executor confirmations: the exact `tiny.zip` member names (read zip.rs tests); whether `abi/snapshot.json` enumerates kernel host-imports (Task 3); the full set of `rootfs::read/write/truncate_handle/read_file_at` call sites (Task 3 step 1).
