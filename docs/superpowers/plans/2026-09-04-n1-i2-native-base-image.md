# N1-I2: Native host serves a real (in-memory) base VFS image via host_blob_read

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** The native wasmtime host (`crates/host-native`) serves **real base-file content** at `/` — not just an empty overlay. It constructs a small **in-memory** base image, emits an RTFS manifest, loads it into the in-kernel rootfs overlay (`kernel_rootfs_load_manifest`), and serves the file bytes through a native `host_blob_read` import backed by its own `blob_id→bytes` map. A guest can then `open`/`read` a real base file (e.g. `/etc/hello`). This is the first native proof that `/` serves real base content — the substrate for later running a shipped binary. It stays sandboxed + in-memory (the image is host-held bytes served read-only; overlay writes remain in-memory COW). The FULL `rootfs.vfs` image (SFFS parser + heavy build) is explicitly OUT OF SCOPE / deferred.

**Architecture (host-side-only; no kernel/ABI change — verified by grounding):** N1-I1 enables an empty overlay `/`. I2 adds (a) an RTFS-manifest builder mirroring `host/src/vfs/rootfs-manifest.ts` `emitRootfsManifest` (magic `0x5346_5452` "RTFS" LE, version 3, parent-first entries with `kind/mode/uid/gid/ino/blob_id/size/mtime/path[/target][/archive]`, trailing archive table; **`blob_id = ino`**), (b) an in-memory `blob_id→Vec<u8>` map, (c) a `host_blob_read(blob_id_lo,blob_id_hi,buf_ptr,buf_len,offset_lo,offset_hi)->i32` import (signature per `crates/kernel/src/wasm_api.rs:79-86`) that copies image bytes into kernel memory (mirror the existing `host_read` write pattern), and (d) a boot step loading the manifest before `kernel_set_rootfs_enabled(1)` (mirror `kernel-worker.ts #maybeLoadKernelRootfs`). The kernel's `rootfs::load_manifest` + `BaseRegular` + `ByteReq::Base` path already consumes exactly this (proven by `crates/runtime-core/src/rootfs.rs` unit tests `enc_entry`/`make_byte_source`).

**Tech Stack:** Rust + `wasmtime = "35"` (host-only, `--target <host>`), Kandelo SDK for the C fixture, `wasm-posix-shared`.

**Spec:** `docs/plans/2026-09-04-rust-first-remaining-purpose-framed.md` §6 (N1 roadmap, I2) + the I2 grounding.

## Global Constraints
- Worktree `/Users/brandon/kandelo-abi44-reconcile` (branch `brandonpayton/rust-first-abi44-reconcile`). Dev-shell + isolated cache: `export KANDELO_SOURCE_CACHE_ROOT="$HOME/.cache/kandelo/reconcile-abi44"; scripts/dev-shell.sh bash -lc '<cmd>'`. Test: `cargo test -p host-native --target $(rustc -vV|sed -n 's/^host: //p')`.
- **Host-side-only in `crates/host-native`.** No `crates/kernel`/`runtime-core`/`abi` change. Uses existing kernel export `kernel_rootfs_load_manifest` (`wasm_api.rs:1503`) + import `host_blob_read` (`wasm_api.rs:79`).
- **Lightweight / self-contained:** build the image in memory from a hardcoded small tree; do NOT require a `rootfs.vfs` artifact or the projection build. `host_fetch_archive` stays trapped (no lazy archives in I2).
- **Sandboxed preserved:** base files are read-only host-held bytes; overlay writes stay in-memory COW; no real host FS reached (that's only the N1-I1b explicit mount). The default with no image is still I1's empty overlay.
- RTFS byte layout + `host_blob_read` copy semantics must match the shared format / kernel expectations (a wrong layout fails silently-ish) — verify against `rootfs-manifest.ts` + `rootfs.rs::load_manifest` + the `enc_entry`/`make_byte_source` tests.
- All pre-existing host-native tests stay green.

---

### Task 1: RTFS manifest builder + in-memory base image + host_blob_read import

**Files:** Modify `crates/host-native/src/guest.rs` (a base-image struct + RTFS builder + the `host_blob_read` import in `define_kernel_host_imports`); Test: a Rust unit test in `crates/host-native/src/{guest.rs,lib.rs}`.

**Interfaces:** Produces (for Task 2): a base-image type, e.g. `struct BaseImage { manifest: Vec<u8>, blobs: BTreeMap<u64, Vec<u8>> }` with a builder that takes a small tree spec (dirs + files) and emits a valid RTFS-v3 manifest (`blob_id = ino`, parent-first) + the blob map; and a `host_blob_read` import wired to serve from that map. Name the type + builder signature in your report.

- [ ] **Step 1: Write the failing test.** A Rust unit test (no guest needed) that builds a `BaseImage` for a tiny tree (`/` dir ino 1, `/etc` dir ino 2, `/etc/hello` file ino 3 → `b"hi from base\n"`) and asserts: the manifest starts with magic `0x5346_5452` + version 3 + correct entry count; parsing the manifest back (a small reader in the test, mirroring `rootfs-manifest.ts`'s decoder or the `rootfs.rs` test decoder) yields the 3 entries with `blob_id==ino` for the file; and `blobs[&3] == b"hi from base\n"`. (This locks the wire format independent of the kernel.)

- [ ] **Step 2: Run RED.** `cargo test -p host-native --target <host> <builder_test>`. Expected: FAIL — the builder/`BaseImage` doesn't exist.

- [ ] **Step 3: Implement.** Add `BaseImage` + the RTFS-v3 builder in `guest.rs` (mirror `emitRootfsManifest` exactly: header magic/version/count, per-entry fields in order, `mode & 0o7777`, `blob_id = ino` for files, mtime, path, and the trailing archive table `archive_count=0`; parent-first ordering). Add the `host_blob_read` import to `define_kernel_host_imports`: reassemble the 64-bit `blob_id`/`offset` from lo/hi words, look up `blobs.get(&blob_id)`, copy `min(buf_len, remaining)` bytes into kernel memory at `buf_ptr` (reuse the `write_bytes`/`host_read` copy pattern), return bytes written / 0 at EOF / negative errno (ENOENT=-2 for an unknown blob_id). (Leave `host_fetch_archive` trapped.)

- [ ] **Step 4: Run GREEN** (same command) + full host-native suite green.

- [ ] **Step 5: Commit.** `git commit -m "Host-native: RTFS base-image builder + host_blob_read import (N1-I2)"`

---

### Task 2: Load the base image at boot + prove a guest reads a real base file

**Files:** Modify `crates/host-native/src/guest.rs` (boot: load the manifest before `kernel_set_rootfs_enabled(1)`; a way to pass a `BaseImage` via `GuestOptions` or a default small image); Create `crates/host-native/fixtures/native_base_read.c` (+ `.wasm`); Test in `crates/host-native/src/lib.rs`.

**Interfaces:** Consumes Task 1's `BaseImage` + `host_blob_read` import.

- [ ] **Step 1: Write the failing test.** `native_base_read.c`: `open("/etc/hello", O_RDONLY)`, `read`, write the contents to stdout, exit 0. Build to `.wasm`. `#[test] smoke_reads_base_file`: run the fixture (via `run_guest`) with a `BaseImage` containing `/etc/hello -> "hi from base\n"` loaded into the overlay, assert stdout == `"hi from base\n"` + exit 0.

- [ ] **Step 2: Run RED.** `cargo test -p host-native --target <host> smoke_reads_base_file`. Expected: FAIL — without loading the manifest, `/etc/hello` doesn't exist in the empty overlay (ENOENT).

- [ ] **Step 3: Implement.** In `run_guest` boot, after `kernel_set_tmpfs_enabled(1)`/`kernel_set_rootfs_now` and BEFORE `kernel_set_rootfs_enabled(1)`: if a `BaseImage` is provided, grab `kernel_rootfs_load_manifest` (typed func), `kernel_alloc_scratch` the manifest length, write the manifest bytes into kernel memory, call `load(ptr,len)` (on `<0`, leave `/` empty — truthful failure, don't proceed with a partial tree). The `host_blob_read` import (Task 1) is already live to serve the bytes. Provide the `BaseImage` through `GuestOptions` (default `None` → I1's empty overlay unchanged).

- [ ] **Step 4: Run GREEN** (same command) + full suite green (I1's `smoke_runs_inmemory_vfs` — no base image — must still pass unchanged).

- [ ] **Step 5: Commit.** `git commit -m "Host-native: load in-memory base image at boot; guest reads a real base file (N1-I2)"`

---

## Notes for the executor
- The authoritative RTFS format is `host/src/vfs/rootfs-manifest.ts` (`emit`, `:187-231`; header `:35-36`; archive table `:284-290`); the kernel parser is `crates/runtime-core/src/rootfs.rs` `load_manifest` (`:968-1036`) and the `enc_entry`/`make_byte_source` unit tests (`:2940-2994`) are the exact host-side pattern to mirror — read them, don't guess the layout.
- `host_blob_read` returns bytes WRITTEN into `buf_ptr` (0 = EOF), negative = -errno; blob_id/offset are 64-bit split into lo/hi u32 words (`wasm_api.rs:79-86`).
- Do NOT pull in `rootfs.vfs`/SFFS (`crates/runtime-core/src/sffs.rs`) — that's the deferred full-image path. Build the image in memory.
- Keep the no-base-image default = I1's empty overlay (sandboxed), unchanged.
