# Phase 5 Increment 3b-wiring.1 — RTFS manifest v3 (lazy-member linkage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend the RTFS boot manifest to carry per-lazy-file `(archive_id, source_path)` linkage + a trailing archive table, on BOTH sides (TS emitter `rootfs-manifest.ts` + Rust loader `rootfs.rs`), and place lazy files as a new `LazyMember` overlay node. Additive/dormant: emitters still emit no lazy entries yet (that's a later increment); this increment lands the format + parser + node placement + a cross-language round-trip. First slice of the 3b wiring (Model B).

**Architecture:** RTFS `version 2 → 3`. New entry `KIND_LAZY_FILE = 4` = the standard entry fields **plus** `archive_id u32`, `source_path_len u32`, `source_path`. After all entries, a trailing **archive table**: `archive_count u32`, then per archive `archive_id u32 | archive_size u64`. The Rust loader accepts v2 **and** v3; a v3 KIND_LAZY_FILE places `InodeKind::LazyMember { archive_id, source_path, size }` (metadata from the manifest; byte-materialization is the NEXT increment — a LazyMember read returns `ENOSYS` here). Design: `docs/plans/2026-08-28-phase5-vfs-to-rust.md` (# Increment 3b wiring).

**Spec/authoritative format refs:** `host/src/vfs/rootfs-manifest.ts` (`emitRootfsManifest`, `RTFS_MAGIC=0x5346_5452`, `RTFS_VERSION=2`, the per-entry writer + its vitest decoder in `host/test/rootfs-manifest.test.ts`) and `crates/runtime-core/src/rootfs.rs` (`load_manifest`/`load_manifest_inner`, the positional parser, `insert_base_dir/file/symlink`, `InodeKind`).

## Global Constraints
- Current per-entry wire format (LE), which v3 preserves for kinds 1-3 and extends for kind 4: `kind u8 | mode u32 | uid u32 | gid u32 | ino u64 | blob_id u64 | size u64 | mtime_sec u64 | mtime_nsec u32 | path_len u32 | path[path_len] | target_len u32 | target[target_len]`. **Read `rootfs-manifest.ts` + `rootfs.rs` first to confirm the EXACT field order/sizes before coding — do not trust this summary if the source differs.**
- v3 additions: for `KIND_LAZY_FILE=4`, after `target` append `archive_id u32 | source_path_len u32 | source_path[...]` (target is empty for a lazy file). After the final entry, append the archive table `archive_count u32 | (archive_id u32, archive_size u64)*`.
- Backward compat: the Rust loader must accept BOTH version 2 (no archive table, no kind-4) and version 3. A v3 manifest with zero lazy files has `archive_count = 0` and no kind-4 entries — byte-behaviorally identical tree to v2.
- Rust: `no_std + alloc`; `Errno = wasm_posix_shared::Errno`; bounds-checked/panic-free parsing (the manifest is trusted-ish but keep the existing defensive parse: reset-to-empty on any malformed field). Test target: `cargo test -p runtime-core --target "$(rustc -vV | sed -n 's/^host: //p')" rootfs`. Wasm build: `cargo build -p kandelo -Z build-std=core,alloc`.
- TS: `cd host && npx vitest run test/rootfs-manifest.test.ts` inside `scripts/dev-shell.sh`.
- Commit hygiene: `git add <specific files>` ONLY (never `-A`/`.`); confirm `git status --short` before each commit (the worktree has unrelated untracked noise). cwd RESETS between bash commands — prefix `cd /Users/brandon/kandelo-epoll &&`.
- ABI: RTFS is a host↔kernel manifest, NOT the guest ABI snapshot. The kernel exports (`kernel_rootfs_load_manifest`) are unchanged in signature; regen `abi/snapshot.json` only if an export signature changes (it should not here).

---

### Task 1: Rust loader — accept v3, parse KIND_LAZY_FILE + archive table, place LazyMember

**Files:** Modify `crates/runtime-core/src/rootfs.rs`.

**Interfaces — Produces:** `InodeKind::LazyMember { archive_id: u32, source_path: alloc::vec::Vec<u8>, size: u64 }`; `pub fn insert_lazy_file(path, archive_id, source_path, size, mode, uid, gid, ino) -> Result<(), Errno>` (places the node like `insert_base_file` but as LazyMember; `size`/`lstat`/`fstat`/`getdents` use the manifest metadata); an archive registry storing `archive_id -> archive_size` from the table (a global like the inode store); `load_manifest` accepts version 2 OR 3, parses kind-4 (`archive_id`+`source_path`) and the trailing archive table. A `read`/`open`-for-read of a LazyMember returns `Err(Errno::ENOSYS)` with a `// TODO(3b-wiring.2): materialize via fetch_archive` comment (byte-serving is the next increment).

- [ ] **Step 1: failing test** — build a v3 manifest byte buffer in the test (magic, version=3, count=3: a dir `/a`, a base file `/a/f`, a lazy file `/a/g` with archive_id=7 + source_path `bin/g`; then archive table count=1: archive_id=7,size=1234). `load_manifest` it; assert `/a/g` `lstat` reports the manifest size/mode, is placed under `/a`, and the stored `(archive_id, source_path)` round-trips (via a test accessor); assert a v2 manifest (version=2, no table) still loads. Run → fail.
- [ ] **Step 2-4:** implement (extend `load_manifest_inner`: after reading `target`, if kind==4 read archive_id + source_path; after the entry loop, if version>=3 read the archive table; add the InodeKind + insert_lazy_file + the archive registry). Reset-to-empty on any malformed field (match existing behavior). Run → pass; `cargo build -p kandelo` clean; warning-clean.
- [ ] **Step 5: commit** `crates/runtime-core/src/rootfs.rs`: `VFS: RTFS v3 loader + LazyMember placement (Phase 5 3b-wiring.1)`.

---

### Task 2: TS emitter — RTFS v3, archive table, optional lazy entries

**Files:** Modify `host/src/vfs/rootfs-manifest.ts`; Modify `host/test/rootfs-manifest.test.ts`.

**Interfaces — Produces:** `RTFS_VERSION = 3`; `emitRootfsManifest` writes the v3 header + a trailing archive table (empty by default) and gains an OPTIONAL input describing lazy files (`Map<vfsPath, {archive_id, source_path}>` + an archive list `{archive_id, size}[]`); when provided it emits those nodes as `KIND_LAZY_FILE` (with `archive_id`+`source_path`) and populates the archive table. Existing callers pass nothing → identical tree, version=3, `archive_count=0`. Keep the `EmittedRootfsManifest` return shape (add the archive list if useful).

- [ ] **Step 1: failing test** in `rootfs-manifest.test.ts` — extend the wire-format decoder to v3 (kind-4 fields + archive table); a test that emits WITH a synthetic lazy entry (`/a/g` → archive_id 7, source_path `bin/g`; archive {7, 1234}) and asserts the decoded manifest has version 3, a KIND_LAZY_FILE entry with those fields, and the archive table; plus a test that the default (no lazy input) emits version 3 with `archive_count=0` and no kind-4 entries. Run → fail.
- [ ] **Step 2-4:** implement the emitter changes + decoder. Run vitest → pass. Confirm the 3 existing rootfs-manifest tests still pass (v3 default is tree-identical).
- [ ] **Step 5: commit** the two files: `VFS: RTFS v3 emitter + archive table (Phase 5 3b-wiring.1)`.

---

### Task 3: Cross-language round-trip fixture (TS emits → Rust loads)

**Files:** Create `host/scripts/gen-rtfs-v3-fixture.mts` (or a vitest that writes it); Create (committed) `crates/runtime-core/src/testdata/rtfs-v3-lazy.bin`; Modify `crates/runtime-core/src/rootfs.rs` (test module).

**Interfaces:** a committed binary RTFS v3 manifest emitted by the TS `emitRootfsManifest` (a small tree with one dir, one base file, one lazy file + a 1-entry archive table), plus a Rust test that `include_bytes!`-loads it and asserts the lazy node is placed with the right size/mode and `(archive_id, source_path)`. This proves the TS emitter and Rust loader agree byte-for-byte on the v3 format — the critical cross-language contract.

- [ ] **Step 1:** write the generator (run in dev-shell) producing the committed `.bin`; verify its first 8 bytes are `52 54 46 53` ("RTFS") + version 3 LE.
- [ ] **Step 2:** add the Rust test loading the fixture; run → pass; wasm build clean.
- [ ] **Step 3: commit** the generator + fixture + test: `VFS: RTFS v3 cross-language round-trip fixture (Phase 5 3b-wiring.1)`.

---

## Self-review notes
- Dormant: no runtime behavior change (emitters emit no lazy entries yet; LazyMember read is ENOSYS until 3b-wiring.2). v2 manifests still load; v3-default manifests are tree-identical.
- Deferred to 3b-wiring.2: LazyMember byte materialization (`fetch_archive` op + zip decode + registry fill), and the emitter actually DETECTING lazy stubs from `lazyArchiveInodes` (3b-wiring.3).
- Executor confirmations: exact current RTFS field order in both files (Task 1/2 step 1); whether `*.bin` under `src/testdata` is gitignored (`git add -f` if so).
