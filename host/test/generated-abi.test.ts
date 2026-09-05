import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WPK_FORK_EXPORTS } from "../src/constants";
import { SIDE_MODULE_FORK_EXPORTS } from "../src/dylink";
import {
  ABI_CUSTOM_SECTION,
  ABI_KERNEL_EXPORT,
  ABI_SYSCALL_NAMES,
  ABI_SYSCALLS,
  ABI_VERSION,
  ACCESS_MODES,
  AT_FLAGS,
  CHANNEL_STATUS,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_CHECKPOINT_AREA_SIZE,
  CH_CHECKPOINT_BASE,
  CH_CHECKPOINT_REQUEST,
  CH_CHECKPOINT_REQUEST_UNWIND,
  CH_CHECKPOINT_WIRE_SIZE,
  CH_DATA,
  CH_DATA_SIZE,
  CH_ERRNO,
  CH_HEADER_SIZE,
  CH_REQUEST_FLAGS,
  CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
  CH_RETURN,
  CH_SIG_ALT_SIZE,
  CH_SIG_ALT_SP,
  CH_SIG_AREA_SIZE,
  CH_SIG_BASE,
  CH_SIG_DELIVERY_SIZE,
  CH_SIG_FLAGS,
  CH_SIG_HANDLER,
  CH_SIGINFO_WORD_1,
  CH_SIGINFO_WORD_2,
  CH_SIG_OLD_MASK,
  CH_SIG_SI_CODE,
  CH_SIG_SI_VALUE,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  DIRENT_TYPES,
  EPOLL_EVENTS,
  FCNTL_COMMANDS,
  FD_FLAGS,
  FILE_MODES,
  HOST_ADAPTER_MANIFEST_FIELDS,
  HOST_ADAPTER_MANIFEST_MAGIC,
  HOST_ADAPTER_MANIFEST_SIZE,
  HOST_ADAPTER_MANIFEST_VERSION,
  HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS,
  HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES,
  HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS,
  HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
  HOST_ADAPTER_VERSION,
  HOST_ADAPTER_WORKER_FEATURES,
  HOST_INTERCEPTED_SYSCALLS,
  OPEN_FLAGS,
  PROCESS_MEMORY_DEFAULT_INITIAL_PAGES,
  PROCESS_MEMORY_DEFAULT_MAX_PAGES,
  PROCESS_MEMORY_DEFAULT_THREAD_SLOTS,
  PROCESS_MEMORY_FALLBACK_BRK_BASE,
  PROCESS_MEMORY_FORK_SAVE_BUFFER_SIZE,
  PROCESS_MEMORY_FORK_SAVE_CONTROL_PREFIX_SIZE,
  PROCESS_MEMORY_LEGACY_MMAP_BASE,
  PROCESS_MEMORY_MAIN_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_MAIN_CHANNEL_SPILL_PAGE,
  PROCESS_MEMORY_MAIN_FORK_SAVE_PAGE,
  PROCESS_MEMORY_PAGES_PER_THREAD_SLOT,
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_SPILL_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_DECL_EXPORT,
  PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE,
  PROCESS_MEMORY_THREAD_SLOTS_NONE,
  PROCESS_MEMORY_THREAD_SLOTS_USE_HOST_DEFAULT,
  PROCESS_MEMORY_WASM_PAGE_SIZE,
  PROCESS_METADATA_KIND_ARGV,
  PROCESS_METADATA_KIND_ENVIRONMENT,
  POLL_EVENTS,
  PROCESS_SNAPSHOT_CMDLINE_LEN_OFFSET,
  PROCESS_SNAPSHOT_COMM_LEN_OFFSET,
  PROCESS_SNAPSHOT_COUNT_BYTES,
  PROCESS_SNAPSHOT_COUNT_OFFSET,
  PROCESS_SNAPSHOT_GID_OFFSET,
  PROCESS_SNAPSHOT_HEADER_BYTES,
  PROCESS_SNAPSHOT_PID_OFFSET,
  PROCESS_SNAPSHOT_PPID_OFFSET,
  PROCESS_SNAPSHOT_RECORDS_OFFSET,
  PROCESS_SNAPSHOT_STATE_OFFSET,
  PROCESS_SNAPSHOT_UID_OFFSET,
  PROCESS_SNAPSHOT_VSIZE_OFFSET,
  PROCESS_SIGINFO_CODE_OFFSET,
  PROCESS_SIGINFO_ERRNO_OFFSET,
  PROCESS_SIGINFO_SIGNO_OFFSET,
  PROCESS_SIGINFO_WASM32_PID_OFFSET,
  PROCESS_SIGINFO_WASM32_SIZE,
  PROCESS_SIGINFO_WASM32_UID_OFFSET,
  PROCESS_SIGINFO_WASM32_VALUE_OFFSET,
  PROCESS_SIGINFO_WASM32_VALUE_SIZE,
  PROCESS_SIGINFO_WASM64_PID_OFFSET,
  PROCESS_SIGINFO_WASM64_SIZE,
  PROCESS_SIGINFO_WASM64_UID_OFFSET,
  PROCESS_SIGINFO_WASM64_VALUE_OFFSET,
  PROCESS_SIGINFO_WASM64_VALUE_SIZE,
  STRUCT_SIZE_WASM_DIRENT,
  STRUCT_SIZE_WASM_POLL_FD,
  STRUCT_SIZE_WASM_STAT,
  STRUCT_SIZE_WASM_STATFS,
  STRUCT_SIZE_WASM_TIMESPEC,
  SYSCALL_ARGS,
  SELECT_FD_SET_BYTES,
  SELECT_FD_SETSIZE,
  SEEK_WHENCE,
  WAKEUP_EVENT_FIELDS,
  WAKEUP_EVENT_RECORD_BYTES,
  WAKEUP_EVENT_TYPES,
  WASM_DIRENT_INO_OFFSET,
  WASM_DIRENT_NAME_LENGTH_OFFSET,
  WASM_DIRENT_TYPE_OFFSET,
  WPK_FORK_CAPABILITIES_SECTION,
  WPK_FORK_CAPABILITIES_VERSION,
  WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
  WPK_FORK_CAP_DYLINK_MAIN,
  WPK_FORK_CAP_KNOWN_MASK,
  WPK_FORK_CAP_REQUIRED_FLAGS,
  WPK_FORK_CAP_SIDE_ENTRY,
  WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE,
  WPK_FORK_LINKED_FRAME_FORMAT_MAGIC,
  WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
  WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
  WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
  WPK_FORK_MODULE_STATE_ARENA_VERSION,
  WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT,
  WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED,
  WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS,
  WPK_FORK_MODULE_STATE_CHUNK_MAGIC,
  WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
  WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS,
  WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER,
  WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES,
  WPK_FORK_MODULE_STATE_FORMAT_MAGIC,
  WPK_FORK_MODULE_STATE_FORMAT_SECTION,
  WPK_FORK_MODULE_STATE_FORMAT_VERSION,
  WPK_FORK_MODULE_STATE_KNOWN_FLAGS,
  WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT,
  WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT,
  WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT,
  WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS,
  WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE,
  WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE,
  WPK_FORK_MODULE_STATE_POINTER_WIDTHS,
  WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT,
  WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_RECORD_KINDS,
  WPK_FORK_MODULE_STATE_RECORD_MAGIC,
  WPK_FORK_MODULE_STATE_RECORD_VERSION,
  WPK_FORK_MODULE_STATE_REQUIRED_FLAGS,
  WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
  WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE,
  WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE,
  WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES,
  WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS,
  WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE,
  WPK_FORK_REQUIRED_EXPORTS,
  WPK_FORK_REQUIRED_IMPORTS,
  WPK_FORK_REQUIRED_TABLE_IMPORTS,
  WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
  WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE,
  WPK_FORK_STATIC_ROOT_CATALOG_MAGIC,
  WPK_FORK_STATIC_ROOT_CATALOG_SECTION,
  WPK_FORK_STATIC_ROOT_CATALOG_VERSION,
  WPK_FORK_UNWIND_TAG_IMPORT_MODULE,
  WPK_FORK_UNWIND_TAG_IMPORT_NAME,
  WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY,
  WPK_FORK_UNWIND_TRANSPORT_SECTION,
  WPK_FORK_UNWIND_TRANSPORT_VERSION,
} from "../src/generated/abi";

const snapshot = JSON.parse(
  readFileSync(new URL("../../abi/snapshot.json", import.meta.url), "utf8"),
);

interface NamedNumber {
  name: string;
  number: number;
}

function fieldOffset(name: string): number {
  const field = snapshot.channel_header.fields.find((f: { name: string }) => f.name === name);
  if (!field) throw new Error(`missing channel_header field ${name}`);
  return field.offset;
}

function structFieldOffset(structName: string, fieldName: string): number {
  const field = snapshot.marshalled_structs[structName].fields.find(
    (candidate: { name: string }) => candidate.name === fieldName,
  );
  if (!field) {
    throw new Error(`missing ${structName} field ${fieldName}`);
  }
  return field.offset;
}

function processSnapshotFieldOffset(fieldName: string): number {
  const field = snapshot.process_snapshot_wire.header.fields.find(
    (candidate: { name: string }) => candidate.name === fieldName,
  );
  if (!field) {
    throw new Error(`missing process snapshot field ${fieldName}`);
  }
  return field.offset;
}

function wakeupEventField(
  fieldName: string,
): { offset: number; size: number; type: string } {
  const field = snapshot.wakeup_event_wire.fields.find(
    (candidate: { name: string }) => candidate.name === fieldName,
  );
  if (!field) {
    throw new Error(`missing wakeup event field ${fieldName}`);
  }
  return { offset: field.offset, size: field.size, type: field.type };
}

function statusNumber(name: string): number {
  const status = snapshot.channel_status_codes.find((s: { name: string }) => s.name === name);
  if (!status) throw new Error(`missing channel_status_codes entry ${name}`);
  return status.number;
}

function requestFlag(name: string): number {
  const flag = snapshot.channel_request_flags.find(
    (entry: { name: string }) => entry.name === name,
  );
  if (!flag) throw new Error(`missing channel_request_flags entry ${name}`);
  return flag.bit;
}

function signalOffset(name: string): number {
  const slot = snapshot.channel_signal_area.slots.find((s: { name: string }) => s.name === name);
  if (!slot) throw new Error(`missing channel_signal_area slot ${name}`);
  return slot.offset;
}

function namedNumberMap(entries: NamedNumber[]): Record<string, number> {
  return Object.fromEntries(entries.map(({ name, number }) => [name, number]));
}

function namedValueMap(
  entries: Array<{ name: string; value: number }>,
): Record<string, number> {
  return Object.fromEntries(entries.map(({ name, value }) => [name, value]));
}

function hostAdapterManifestField(name: string): { offset: number; size: number } {
  const field = snapshot.host_adapter.manifest_fields.find((f: { name: string }) => f.name === name);
  if (!field) throw new Error(`missing host_adapter manifest field ${name}`);
  return { offset: field.offset, size: field.size };
}

describe("generated host ABI bindings", () => {
  it("match the complete fork-artifact contract", () => {
    const fork = snapshot.program_artifact.fork_instrumentation;
    const capabilities = fork.capabilities;
    const descriptor = fork.linked_frame_descriptor;
    const staticRoots = fork.static_root_catalog;
    const unwind = fork.unwind_transport;
    expect(WPK_FORK_CAPABILITIES_SECTION).toBe(capabilities.section);
    expect(WPK_FORK_CAPABILITIES_VERSION).toBe(capabilities.version);
    expect(WPK_FORK_CAP_KNOWN_MASK).toBe(capabilities.known_mask);
    expect(WPK_FORK_CAP_REQUIRED_FLAGS).toBe(capabilities.required_flags);
    expect([
      { bit: WPK_FORK_CAP_SIDE_ENTRY, name: "side_entry" },
      { bit: WPK_FORK_CAP_DYLINK_MAIN, name: "dylink_main" },
      {
        bit: WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
        name: "activation_state_safe",
      },
    ]).toEqual(capabilities.flags);
    expect(WPK_FORK_LINKED_FRAME_FORMAT_SECTION).toBe(descriptor.section);
    expect(WPK_FORK_LINKED_FRAME_FORMAT_VERSION).toBe(descriptor.version);
    expect(WPK_FORK_LINKED_FRAME_FORMAT_MAGIC).toEqual(descriptor.magic_bytes);
    expect(WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE).toBe(descriptor.descriptor_size);
    expect(WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT).toBe(descriptor.alignment);
    expect(WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS).toBe(descriptor.required_flags);
    expect(WPK_FORK_STATIC_ROOT_CATALOG_EXPORT).toBe(staticRoots.export);
    expect(WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE).toBe(
      staticRoots.header_size,
    );
    expect(WPK_FORK_STATIC_ROOT_CATALOG_MAGIC).toEqual(staticRoots.magic_bytes);
    expect(WPK_FORK_STATIC_ROOT_CATALOG_SECTION).toBe(staticRoots.section);
    expect(WPK_FORK_STATIC_ROOT_CATALOG_VERSION).toBe(staticRoots.version);
    expect(WPK_FORK_UNWIND_TAG_IMPORT_MODULE).toBe(unwind.import.module);
    expect(WPK_FORK_UNWIND_TAG_IMPORT_NAME).toBe(unwind.import.name);
    expect(WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY).toBe(
      unwind.payload_arity,
    );
    expect(WPK_FORK_UNWIND_TRANSPORT_SECTION).toBe(unwind.section);
    expect(WPK_FORK_UNWIND_TRANSPORT_VERSION).toBe(unwind.version);
    expect(WPK_FORK_LINKED_FRAME_POINTER_WIDTHS).toEqual(
      descriptor.pointer_widths.map(
        (format: {
          bytes: number;
          chunk_header_size: number;
          node_header_size: number;
        }) => ({
          bytes: format.bytes,
          chunkHeaderSize: format.chunk_header_size,
          nodeHeaderSize: format.node_header_size,
        }),
      ),
    );

    const moduleState = fork.module_state;
    const moduleStateDescriptor = moduleState.descriptor;
    expect(WPK_FORK_MODULE_STATE_FORMAT_SECTION).toBe(moduleStateDescriptor.section);
    expect(WPK_FORK_MODULE_STATE_FORMAT_VERSION).toBe(moduleStateDescriptor.version);
    expect(WPK_FORK_MODULE_STATE_FORMAT_MAGIC).toEqual(moduleStateDescriptor.magic_bytes);
    expect(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE).toBe(
      moduleStateDescriptor.descriptor_size,
    );
    expect(WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT).toBe(
      moduleStateDescriptor.alignment,
    );
    expect(WPK_FORK_MODULE_STATE_KNOWN_FLAGS).toBe(moduleStateDescriptor.known_flags);
    expect(WPK_FORK_MODULE_STATE_REQUIRED_FLAGS).toBe(
      moduleStateDescriptor.required_flags,
    );
    expect(WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET).toBe(
      moduleStateDescriptor.root_pointer_word_offset,
    );
    expect([
      {
        bit: WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER,
        name: "root_prefix_pointer",
      },
      {
        bit: WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS,
        name: "explicit_owners",
      },
      {
        bit: WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES,
        name: "sparse_tables",
      },
    ]).toEqual(moduleStateDescriptor.flags);

    const moduleStateArena = moduleState.arena;
    expect(WPK_FORK_MODULE_STATE_ARENA_VERSION).toBe(moduleStateArena.version);
    expect(WPK_FORK_MODULE_STATE_CHUNK_MAGIC).toEqual(
      moduleStateArena.chunk_magic_bytes,
    );
    expect(WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS).toBe(
      moduleStateArena.known_chunk_flags,
    );
    expect([
      { bit: WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT, name: "root" },
      { bit: WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED, name: "sealed" },
    ]).toEqual(moduleStateArena.chunk_flags);
    expect(WPK_FORK_MODULE_STATE_POINTER_WIDTHS).toEqual(
      moduleStateArena.pointer_widths.map(
        (format: { bytes: number; chunk_header_size: number }) => ({
          bytes: format.bytes,
          chunkHeaderSize: format.chunk_header_size,
        }),
      ),
    );
    expect(WPK_FORK_MODULE_STATE_RECORD_VERSION).toBe(
      moduleStateArena.record.version,
    );
    expect(WPK_FORK_MODULE_STATE_RECORD_MAGIC).toEqual(
      moduleStateArena.record.magic_bytes,
    );
    expect(WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE).toBe(
      moduleStateArena.record.header_size,
    );
    expect(WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT).toBe(
      moduleStateArena.record.alignment,
    );
    expect(WPK_FORK_MODULE_STATE_RECORD_KINDS).toEqual(
      moduleStateArena.record.kinds,
    );

    const modulePayload = moduleState.record_payloads.module;
    expect(WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE).toBe(
      modulePayload.template_id_size,
    );
    expect(WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE).toBe(
      modulePayload.payload_size,
    );
    expect(WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS).toBe(
      modulePayload.known_flags,
    );
    const tablePayload = moduleState.record_payloads.table;
    expect(WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE).toBe(
      tablePayload.baseline_fingerprint_size,
    );
    expect(WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE).toBe(
      tablePayload.descriptor_payload_size,
    );
    expect(WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS).toBe(tablePayload.known_flags);
    expect([
      {
        bit: WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES,
        name: "sparse_overrides",
      },
    ]).toEqual(tablePayload.flags);
    expect(WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE).toBe(
      tablePayload.page_header_size,
    );
    expect(WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE).toBe(
      tablePayload.run_header_size,
    );
    expect(WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT).toBe(
      tablePayload.min_page_shift,
    );
    expect(WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT).toBe(
      tablePayload.max_page_shift,
    );
    expect(WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT).toBe(
      tablePayload.page_shift,
    );
    expect(WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE).toBe(
      moduleState.record_payloads.element_segments.header_size,
    );

    expect(WPK_FORK_REQUIRED_IMPORTS).toEqual(
      fork.required_imports
        .filter(({ kind }: { kind: string }) => kind === "func")
        .map(({ kind: _kind, ...requirement }: { kind: string }) => requirement),
    );
    expect(WPK_FORK_REQUIRED_TABLE_IMPORTS).toEqual(
      fork.required_imports
        .filter(({ kind }: { kind: string }) => kind === "table")
        .map(({ kind: _kind, ...requirement }: { kind: string }) => requirement),
    );
    expect(WPK_FORK_REQUIRED_EXPORTS).toEqual(
      fork.required_exports.map(({ kind: _kind, ...requirement }: { kind: string }) =>
        requirement
      ),
    );
    const generatedExportNames = WPK_FORK_REQUIRED_EXPORTS.map(({ name }) => name);
    expect(WPK_FORK_EXPORTS).toEqual(generatedExportNames);
    expect(SIDE_MODULE_FORK_EXPORTS).toEqual(generatedExportNames);
  });

  it("match the ABI version and channel layout snapshot", () => {
    expect(ABI_VERSION).toBe(snapshot.abi_version);
    expect(snapshot.custom_sections).toContain(ABI_CUSTOM_SECTION);
    expect(snapshot.custom_sections).toContain(WPK_FORK_MODULE_STATE_FORMAT_SECTION);
    expect(snapshot.kernel_exports.some((e: { name: string }) => e.name === ABI_KERNEL_EXPORT)).toBe(true);

    expect(CH_STATUS).toBe(fieldOffset("status"));
    expect(CH_SYSCALL).toBe(fieldOffset("syscall"));
    expect(CH_ARGS).toBe(fieldOffset("args"));
    expect(CH_RETURN).toBe(fieldOffset("ret"));
    expect(CH_ERRNO).toBe(fieldOffset("errno"));
    expect(CH_REQUEST_FLAGS).toBe(fieldOffset("request_flags"));
    expect(CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY).toBe(
      requestFlag("defer_signal_delivery"),
    );

    expect(CH_ARG_SIZE).toBe(8);
    expect(CH_ARGS_COUNT).toBe(6);
    expect(CH_HEADER_SIZE).toBe(snapshot.channel_header.size);
    expect(CH_DATA).toBe(snapshot.channel_buffers.data_offset);
    expect(CH_DATA_SIZE).toBe(snapshot.channel_buffers.data_size);
    expect(CH_TOTAL_SIZE).toBe(snapshot.channel_buffers.min_channel_size);
  });

  it("match the packed process-snapshot wire contract", () => {
    expect(PROCESS_SNAPSHOT_COUNT_OFFSET)
      .toBe(snapshot.process_snapshot_wire.count_offset);
    expect(PROCESS_SNAPSHOT_COUNT_BYTES)
      .toBe(snapshot.process_snapshot_wire.count_size);
    expect(PROCESS_SNAPSHOT_RECORDS_OFFSET)
      .toBe(snapshot.process_snapshot_wire.records_offset);
    expect(PROCESS_SNAPSHOT_HEADER_BYTES)
      .toBe(snapshot.process_snapshot_wire.header.size);
    expect(PROCESS_SNAPSHOT_PID_OFFSET)
      .toBe(processSnapshotFieldOffset("pid"));
    expect(PROCESS_SNAPSHOT_PPID_OFFSET)
      .toBe(processSnapshotFieldOffset("ppid"));
    expect(PROCESS_SNAPSHOT_UID_OFFSET)
      .toBe(processSnapshotFieldOffset("uid"));
    expect(PROCESS_SNAPSHOT_GID_OFFSET)
      .toBe(processSnapshotFieldOffset("gid"));
    expect(PROCESS_SNAPSHOT_VSIZE_OFFSET)
      .toBe(processSnapshotFieldOffset("vsize"));
    expect(PROCESS_SNAPSHOT_STATE_OFFSET)
      .toBe(processSnapshotFieldOffset("state"));
    expect(PROCESS_SNAPSHOT_COMM_LEN_OFFSET)
      .toBe(processSnapshotFieldOffset("comm_len"));
    expect(PROCESS_SNAPSHOT_CMDLINE_LEN_OFFSET)
      .toBe(processSnapshotFieldOffset("cmdline_len"));
  });

  it("match the packed wakeup-event wire contract", () => {
    expect(WAKEUP_EVENT_RECORD_BYTES)
      .toBe(snapshot.wakeup_event_wire.record_size);
    expect(WAKEUP_EVENT_FIELDS.idx).toEqual(wakeupEventField("idx"));
    expect(WAKEUP_EVENT_FIELDS.wakeType)
      .toEqual(wakeupEventField("wakeType"));
    expect(Object.entries(WAKEUP_EVENT_TYPES)).toEqual(
      snapshot.wakeup_event_wire.types.map(
        (eventType: { name: string; bit: number }) => [
          eventType.name,
          eventType.bit,
        ],
      ),
    );
  });

  it("match Rust-owned I/O multiplexing metadata", () => {
    expect(POLL_EVENTS).toEqual(
      namedValueMap(snapshot.io_multiplexing.poll_events),
    );
    expect(EPOLL_EVENTS).toEqual(
      namedValueMap(snapshot.io_multiplexing.epoll_events),
    );
    expect(SELECT_FD_SETSIZE)
      .toBe(snapshot.io_multiplexing.select.fd_setsize);
    expect(SELECT_FD_SET_BYTES)
      .toBe(snapshot.io_multiplexing.select.fd_set_bytes);
  });

  it("match Rust-owned VFS metadata", () => {
    expect(OPEN_FLAGS).toEqual(namedValueMap(snapshot.vfs_metadata.open_flags));
    expect(AT_FLAGS).toEqual(namedValueMap(snapshot.vfs_metadata.at_flags));
    expect(FD_FLAGS).toEqual(namedValueMap(snapshot.vfs_metadata.fd_flags));
    expect(FCNTL_COMMANDS).toEqual(
      namedValueMap(snapshot.vfs_metadata.fcntl_commands),
    );
    expect(ACCESS_MODES).toEqual(
      namedValueMap(snapshot.vfs_metadata.access_modes),
    );
    expect(FILE_MODES).toEqual(namedValueMap(snapshot.vfs_metadata.file_modes));
    expect(DIRENT_TYPES).toEqual(
      namedValueMap(snapshot.vfs_metadata.dirent_types),
    );
    expect(SEEK_WHENCE).toEqual(
      namedValueMap(snapshot.vfs_metadata.seek_whence),
    );
  });

  it("match the atomic process-metadata transaction contract", () => {
    expect(PROCESS_METADATA_KIND_ARGV)
      .toBe(snapshot.process_metadata_contract.kind_argv);
    expect(PROCESS_METADATA_KIND_ENVIRONMENT)
      .toBe(snapshot.process_metadata_contract.kind_environment);
  });

  it("match status and signal delivery metadata", () => {
    expect(CHANNEL_STATUS.Idle).toBe(statusNumber("Idle"));
    expect(CHANNEL_STATUS.Pending).toBe(statusNumber("Pending"));
    expect(CHANNEL_STATUS.Complete).toBe(statusNumber("Complete"));
    expect(CHANNEL_STATUS.Error).toBe(statusNumber("Error"));

    expect(CH_SIG_BASE).toBe(snapshot.channel_signal_area.base);
    expect(CH_SIG_SIGNUM).toBe(signalOffset("SIG_SIGNUM"));
    expect(CH_SIG_HANDLER).toBe(signalOffset("SIG_HANDLER"));
    expect(CH_SIG_FLAGS).toBe(signalOffset("SIG_FLAGS"));
    expect(CH_SIG_SI_VALUE).toBe(signalOffset("SIG_SI_VALUE"));
    expect(CH_SIG_OLD_MASK).toBe(signalOffset("SIG_OLD_MASK"));
    expect(CH_SIG_SI_CODE).toBe(signalOffset("SIG_SI_CODE"));
    expect(CH_SIGINFO_WORD_1).toBe(signalOffset("SIGINFO_WORD_1"));
    expect(CH_SIGINFO_WORD_2).toBe(signalOffset("SIGINFO_WORD_2"));
    expect(CH_SIG_ALT_SP).toBe(signalOffset("SIG_ALT_SP"));
    expect(CH_SIG_ALT_SIZE).toBe(signalOffset("SIG_ALT_SIZE"));
    expect(CH_SIG_AREA_SIZE).toBe(snapshot.channel_signal_area.area_size);
    expect(CH_SIG_DELIVERY_SIZE).toBe(
      snapshot.channel_signal_area.delivery_size,
    );
    expect(
      CH_SIG_AREA_SIZE - CH_SIG_DELIVERY_SIZE,
    ).toBe(snapshot.channel_signal_area.reserved_tail_size);
  });

  it("reserve the checkpoint request below the signal delivery area", () => {
    expect(CH_CHECKPOINT_BASE + CH_CHECKPOINT_AREA_SIZE).toBe(CH_SIG_BASE);
    expect(
      CH_CHECKPOINT_REQUEST + CH_CHECKPOINT_WIRE_SIZE,
    ).toBeLessThanOrEqual(CH_SIG_BASE);
    expect(CH_CHECKPOINT_BASE).toBeGreaterThanOrEqual(CH_DATA);
    expect(CH_CHECKPOINT_REQUEST_UNWIND).not.toBe(0);
  });

  it("match Rust-owned syscall and struct metadata", () => {
    expect(HOST_INTERCEPTED_SYSCALLS).toEqual(
      namedNumberMap(snapshot.host_intercepted_syscalls),
    );
    expect(ABI_SYSCALLS).toEqual(namedNumberMap(snapshot.syscalls));
    expect(ABI_SYSCALL_NAMES[ABI_SYSCALLS.Seek]).toBe("lseek");
    expect(ABI_SYSCALL_NAMES[ABI_SYSCALLS.Llseek]).toBe("_llseek");
    expect(ABI_SYSCALL_NAMES[ABI_SYSCALLS.Getrandom]).toBe("getrandom");
    expect(ABI_SYSCALL_NAMES[ABI_SYSCALLS.TimerGetoverrun]).toBe("timer_getoverrun");
    expect(ABI_SYSCALL_NAMES[HOST_INTERCEPTED_SYSCALLS.SYS_EXECVE]).toBe("execve");
    expect(ABI_SYSCALL_NAMES[HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN]).toBe("spawn");

    expect(STRUCT_SIZE_WASM_STAT).toBe(snapshot.marshalled_structs.WasmStat.size);
    expect(STRUCT_SIZE_WASM_DIRENT).toBe(snapshot.marshalled_structs.WasmDirent.size);
    expect(WASM_DIRENT_INO_OFFSET).toBe(structFieldOffset("WasmDirent", "d_ino"));
    expect(WASM_DIRENT_TYPE_OFFSET).toBe(structFieldOffset("WasmDirent", "d_type"));
    expect(WASM_DIRENT_NAME_LENGTH_OFFSET).toBe(
      structFieldOffset("WasmDirent", "d_namlen"),
    );
    expect(STRUCT_SIZE_WASM_TIMESPEC).toBe(snapshot.marshalled_structs.WasmTimespec.size);
    expect(STRUCT_SIZE_WASM_POLL_FD).toBe(snapshot.marshalled_structs.WasmPollFd.size);
    expect(STRUCT_SIZE_WASM_STATFS).toBe(snapshot.marshalled_structs.WasmStatfs.size);

    expect(SYSCALL_ARGS).toEqual(snapshot.syscall_arg_descriptors);
  });

  it("match caller-native siginfo layouts for both pointer widths", () => {
    const siginfo = snapshot.process_native_layouts.siginfo;
    expect(PROCESS_SIGINFO_SIGNO_OFFSET).toBe(siginfo.signo_offset);
    expect(PROCESS_SIGINFO_ERRNO_OFFSET).toBe(siginfo.errno_offset);
    expect(PROCESS_SIGINFO_CODE_OFFSET).toBe(siginfo.code_offset);
    expect({
      size: PROCESS_SIGINFO_WASM32_SIZE,
      pid_offset: PROCESS_SIGINFO_WASM32_PID_OFFSET,
      uid_offset: PROCESS_SIGINFO_WASM32_UID_OFFSET,
      value_offset: PROCESS_SIGINFO_WASM32_VALUE_OFFSET,
      value_size: PROCESS_SIGINFO_WASM32_VALUE_SIZE,
    }).toEqual(siginfo.wasm32);
    expect({
      size: PROCESS_SIGINFO_WASM64_SIZE,
      pid_offset: PROCESS_SIGINFO_WASM64_PID_OFFSET,
      uid_offset: PROCESS_SIGINFO_WASM64_UID_OFFSET,
      value_offset: PROCESS_SIGINFO_WASM64_VALUE_OFFSET,
      value_size: PROCESS_SIGINFO_WASM64_VALUE_SIZE,
    }).toEqual(siginfo.wasm64);
  });

  it("makes every generated pointer nullability decision explicit", () => {
    for (const [syscall, descriptors] of Object.entries(SYSCALL_ARGS)) {
      for (const descriptor of descriptors) {
        const nullable = descriptor.nullable === true;
        const required = descriptor.required === true;
        if (nullable === required) {
          throw new Error(
            `syscall ${syscall} arg ${descriptor.argIndex} must be exactly one of nullable or required`,
          );
        }
      }
    }
    expect(SYSCALL_ARGS[ABI_SYSCALLS.Prctl]).toBeUndefined();
  });

  it("match Rust-owned host adapter manifest metadata", () => {
    expect(HOST_ADAPTER_VERSION).toBe(snapshot.host_adapter.version);
    expect(HOST_ADAPTER_MANIFEST_MAGIC).toBe(snapshot.host_adapter.manifest.magic);
    expect(HOST_ADAPTER_MANIFEST_VERSION).toBe(snapshot.host_adapter.manifest.manifest_version);
    expect(HOST_ADAPTER_MANIFEST_SIZE).toBe(snapshot.host_adapter.manifest.manifest_size);
    expect(HOST_ADAPTER_REQUIRED_WORKER_FEATURES).toBe(
      snapshot.host_adapter.required_worker_features,
    );
    expect(HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES).toBe(
      snapshot.host_adapter.optional_kernel_features,
    );
    expect(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS).toEqual(
      snapshot.host_adapter.required_kernel_exports,
    );
    expect(HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS).toEqual(
      snapshot.host_adapter.optional_kernel_exports,
    );

    expect(Object.entries(HOST_ADAPTER_WORKER_FEATURES)).toEqual(
      snapshot.host_adapter.worker_features.map((f: { name: string; bit: number }) => [
        f.name,
        f.bit,
      ]),
    );

    for (const fieldName of Object.keys(HOST_ADAPTER_MANIFEST_FIELDS)) {
      expect(
        HOST_ADAPTER_MANIFEST_FIELDS[
          fieldName as keyof typeof HOST_ADAPTER_MANIFEST_FIELDS
        ],
      ).toEqual(hostAdapterManifestField(fieldName));
    }
  });

  it("match Rust-owned process memory layout metadata", () => {
    const layout = snapshot.process_memory_layout;
    expect(PROCESS_MEMORY_WASM_PAGE_SIZE).toBe(layout.wasm_page_size);
    expect(PROCESS_MEMORY_FORK_SAVE_BUFFER_SIZE).toBe(layout.fork_save_buffer_size);
    expect(PROCESS_MEMORY_FORK_SAVE_CONTROL_PREFIX_SIZE)
      .toBe(layout.fork_save_control_prefix_size);
    expect(PROCESS_MEMORY_DEFAULT_INITIAL_PAGES).toBe(layout.defaults.initial_pages);
    expect(PROCESS_MEMORY_DEFAULT_MAX_PAGES).toBe(layout.defaults.max_pages);
    expect(PROCESS_MEMORY_DEFAULT_THREAD_SLOTS).toBe(layout.defaults.thread_slots);
    expect(PROCESS_MEMORY_LEGACY_MMAP_BASE).toBe(layout.legacy.mmap_base);
    expect(PROCESS_MEMORY_FALLBACK_BRK_BASE).toBe(layout.legacy.fallback_brk_base);
    expect(PROCESS_MEMORY_THREAD_SLOT_DECL_EXPORT)
      .toBe(layout.process_wasm_declarations.thread_slot_export);
    expect(PROCESS_MEMORY_THREAD_SLOTS_USE_HOST_DEFAULT)
      .toBe(layout.process_wasm_declarations.use_host_default);
    expect(PROCESS_MEMORY_THREAD_SLOTS_NONE).toBe(layout.process_wasm_declarations.none);

    expect(PROCESS_MEMORY_MAIN_FORK_SAVE_PAGE)
      .toBe(layout.main_control.pages.find((p: { name: string }) => p.name === "fork_save_scratch").page_offset);
    expect(PROCESS_MEMORY_MAIN_CHANNEL_PRIMARY_PAGE)
      .toBe(layout.main_control.pages.find((p: { name: string }) => p.name === "syscall_channel_primary").page_offset);
    expect(PROCESS_MEMORY_MAIN_CHANNEL_SPILL_PAGE)
      .toBe(layout.main_control.pages.find((p: { name: string }) => p.name === "syscall_channel_spill").page_offset);

    expect(PROCESS_MEMORY_PAGES_PER_THREAD_SLOT).toBe(layout.thread_slot.pages_per_slot);
    expect(PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE)
      .toBe(layout.thread_slot.pages.find((p: { name: string }) => p.name === "tls_control").page_offset);
    expect(PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE)
      .toBe(layout.thread_slot.pages.find((p: { name: string }) => p.name === "fork_save_scratch").page_offset);
    expect(PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE)
      .toBe(layout.thread_slot.pages.find((p: { name: string }) => p.name === "syscall_channel_primary").page_offset);
    expect(PROCESS_MEMORY_THREAD_SLOT_CHANNEL_SPILL_PAGE)
      .toBe(layout.thread_slot.pages.find((p: { name: string }) => p.name === "syscall_channel_spill").page_offset);
  });
});
