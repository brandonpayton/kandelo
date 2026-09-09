type WasmValueType = "i32" | "i64";

interface WasmFunctionSignature {
  readonly parameters: readonly WasmValueType[];
  readonly result: WasmValueType;
}

function unsignedLeb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function wasmString(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...unsignedLeb128(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...unsignedLeb128(payload.length), ...payload];
}

function signatures(
  pointerWidth: 4 | 8,
): Record<string, WasmFunctionSignature> {
  const pointer: WasmValueType = pointerWidth === 4 ? "i32" : "i64";
  const i32 = "i32" as const;
  const i64 = "i64" as const;
  return {
    kernel_alloc_scratch: {
      parameters: [i32],
      result: pointer,
    },
    kernel_commit_process_exit: {
      parameters: [i32],
      result: i32,
    },
    kernel_clear_fork_child: {
      parameters: [i32],
      result: i32,
    },
    kernel_create_process_with_stdio: {
      parameters: [i32, i32, i32],
      result: i32,
    },
    kernel_dequeue_signal: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_drain_audio: {
      parameters: [pointer, i32],
      result: i32,
    },
    kernel_drain_wakeup_events: {
      parameters: [pointer, i32, i32],
      result: i32,
    },
    kernel_enum_procs: {
      parameters: [pointer, i32],
      result: i32,
    },
    kernel_exec_commit: {
      parameters: [i32, i32, i32],
      result: i32,
    },
    kernel_exec_target_cancel: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_exec_target_prepare: {
      parameters: [i32, i32, i32, pointer, pointer, i32],
      result: i32,
    },
    kernel_exec_target_read: {
      parameters: [i32, i32, i32, i32, pointer, pointer],
      result: i32,
    },
    kernel_exec_target_shebang: {
      parameters: [i32, i32, pointer, pointer],
      result: i32,
    },
    kernel_exec_target_size: {
      parameters: [i32, i32],
      result: i64,
    },
    kernel_spawn_exec_commit: {
      parameters: [i32, i32, i32],
      result: i32,
    },
    kernel_spawn_exec_target_prepare: {
      parameters: [i32, i32, pointer, pointer],
      result: i32,
    },
    kernel_publish_spawn_child: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_fd_is_open: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_fd_supports_mmap_writeback: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_find_listener_fd_by_accept_wake: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_fork_process: {
      parameters: [i32, i32, i32],
      result: i32,
    },
    kernel_ftruncate: {
      parameters: [i32, i64],
      result: i32,
    },
    kernel_get_cwd: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_get_dirfd_path: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_get_fork_count: {
      parameters: [i32],
      result: i64,
    },
    kernel_get_memory_pages: {
      parameters: [],
      result: i32,
    },
    kernel_get_parent_pid: {
      parameters: [i32],
      result: i32,
    },
    kernel_get_process_exit_signal: {
      parameters: [i32],
      result: i32,
    },
    kernel_get_process_exit_status: {
      parameters: [i32],
      result: i32,
    },
    kernel_get_fd_path: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_get_fd_accept_wake_idx: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_get_fd_pipe_idx: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_get_socket_timeout_ms: {
      parameters: [i32, i32, i32],
      result: i64,
    },
    kernel_get_process_state: {
      parameters: [i32],
      result: i32,
    },
    kernel_generate_host_signal: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_has_sa_nocldstop: {
      parameters: [i32],
      result: i32,
    },
    kernel_has_sa_nocldwait: {
      parameters: [i32],
      result: i32,
    },
    kernel_getrusage: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_getsockopt: {
      parameters: [i32, i32, i32, pointer, i32, pointer, i32],
      result: i32,
    },
    kernel_setsockopt: {
      parameters: [i32, i32, i32, pointer, i32],
      result: i32,
    },
    kernel_handle_channel: {
      parameters: [pointer, i32, i32, i64],
      result: i32,
    },
    kernel_blocking_retry_token: {
      parameters: [i32, i32, i32],
      result: i64,
    },
    kernel_blocking_retry_release: {
      parameters: [i32, i32, i64],
      result: i32,
    },
    kernel_inject_datagram: {
      parameters: [
        i32, i32, i32, i32, i32, i32,
        i32, i32, i32, i32, i32,
        pointer, i32,
      ],
      result: i32,
    },
    kernel_inject_mouse_event: {
      parameters: [i32, i32, i32],
      // The production export is void. Returning an ignored i32 keeps this
      // compact fixture's one-result encoder simple while still exercising a
      // genuine Wasm function and the exact gated export lookup.
      result: i32,
    },
    kernel_ioctl: {
      parameters: [i32, i32, pointer, i32, i32],
      result: i32,
    },
    // Workstream H4: SIOCGIFCONF's nested, dynamically-sized output buffer
    // can't fit the generic single-static-size ioctl contract, so it is
    // driven by these two dedicated exports instead of `kernel_ioctl`.
    kernel_network_ifconf_size: {
      parameters: [i32],
      result: i32,
    },
    kernel_network_ifreq_size: {
      parameters: [i32],
      result: i32,
    },
    kernel_network_ifconf_write: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_is_fd_nonblock: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_ipc_shm_read_chunk: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_ipc_shm_write_chunk: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_ipc_shm_lookup_mapping_for_task: {
      parameters: [i32, i32, pointer],
      result: i64,
    },
    kernel_ipc_shm_record_mapping_for_process: {
      parameters: [i32, pointer, i32, i32],
      result: i32,
    },
    kernel_ipc_shm_record_mapping_for_task: {
      parameters: [i32, i32, pointer, i32, i32],
      result: i32,
    },
    kernel_ipc_shmat_for_process: {
      parameters: [i32, i32, i32, i32],
      result: i32,
    },
    kernel_ipc_shmat_for_task: {
      parameters: [i32, i32, i32, i32, i32],
      result: i32,
    },
    kernel_ipc_shmdt_for_process: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_ipc_shmdt_addr: {
      parameters: [pointer],
      result: i32,
    },
    kernel_ipc_shmdt_addr_for_process: {
      parameters: [i32, pointer],
      result: i32,
    },
    kernel_ipc_shmdt_addr_for_task: {
      parameters: [i32, i32, pointer],
      result: i32,
    },
    kernel_ipc_shmdt_for_task: {
      parameters: [i32, i32, i32],
      result: i32,
    },
    kernel_mq_drain_notification: {
      parameters: [pointer, i32],
      result: i32,
    },
    kernel_mq_descriptor_msgsize: {
      parameters: [i32, i32, i32],
      result: i32,
    },
    kernel_mark_process_signaled: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_msqid_ds_bytes: {
      parameters: [i32],
      result: i32,
    },
    kernel_kms_commit_count: {
      parameters: [i32],
      result: i64,
    },
    kernel_kms_last_frame_us: {
      parameters: [i32],
      result: i64,
    },
    kernel_pipe2: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_pipe_close_read: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_pipe_close_write: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_pipe_has_readers: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_pipe_is_read_open: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_pipe_is_write_open: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_pipe_read: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_pipe_write: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_pcm_claim_transport: {
      parameters: [i32],
      result: i32,
    },
    kernel_pcm_clock_update: {
      parameters: [i32],
      result: i32,
    },
    kernel_pcm_reconcile: {
      parameters: [],
      result: i32,
    },
    kernel_pcm_transport_len: {
      parameters: [],
      result: i32,
    },
    kernel_pcm_transport_ptr: {
      parameters: [],
      result: i32,
    },
    kernel_poll: {
      parameters: [pointer, i32, i32, i32],
      result: i32,
    },
    kernel_process_metadata_begin: {
      parameters: [i32],
      result: i32,
    },
    kernel_process_metadata_cancel: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_process_metadata_commit: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_process_metadata_stage: {
      parameters: [i32, i32, i32, pointer, i32],
      result: i32,
    },
    kernel_process_secure_exec: {
      parameters: [i32],
      result: i32,
    },
    kernel_pty_create: {
      parameters: [i32],
      result: i32,
    },
    kernel_pick_signal_target_tid: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_pty_master_read: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_pty_master_write: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_read_proc_maps: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_remove_process: {
      parameters: [i32],
      result: i32,
    },
    kernel_reserve_host_region: {
      parameters: [i32, pointer],
      result: pointer,
    },
    kernel_reserve_host_region_at: {
      parameters: [i32, pointer, pointer],
      result: pointer,
    },
    kernel_reap_exited_child: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_recv: {
      parameters: [i32, pointer, i32, i32],
      result: i32,
    },
    kernel_select: {
      parameters: [
        i32,
        pointer, i32,
        pointer, i32,
        pointer, i32,
        i32,
      ],
      result: i32,
    },
    kernel_semctl_array_bytes: {
      parameters: [i32, i32, i32, i32],
      result: i32,
    },
    kernel_semid_ds_bytes: {
      parameters: [i32],
      result: i32,
    },
    kernel_send: {
      parameters: [i32, pointer, i32, i32],
      result: i32,
    },
    kernel_set_cwd: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_set_brk_base: {
      parameters: [i32, pointer],
      result: i32,
    },
    kernel_set_brk_limit: {
      parameters: [i32, pointer],
      result: i32,
    },
    kernel_set_process_credentials: {
      parameters: [i32, i32, i32],
      result: i32,
    },
    kernel_shmid_ds_bytes: {
      parameters: [i32],
      result: i32,
    },
    kernel_set_current_tid: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_set_max_addr: {
      parameters: [i32, pointer],
      result: i32,
    },
    kernel_set_mmap_base: {
      parameters: [i32, pointer],
      result: i32,
    },
    kernel_socketpair: {
      parameters: [i32, i32, i32, pointer, i32],
      result: i32,
    },
    kernel_spawn_blob_decode: {
      parameters: [pointer, pointer, pointer],
      result: i32,
    },
    kernel_spawn_process: {
      parameters: [i32, i32, pointer, pointer],
      result: i32,
    },
    kernel_spawn_reserved_process: {
      parameters: [i32, i32, i64, pointer],
      result: i32,
    },
    kernel_spawn_scratch_begin: {
      parameters: [pointer],
      result: i64,
    },
    kernel_spawn_scratch_pointer: {
      parameters: [i64],
      result: pointer,
    },
    kernel_spawn_scratch_capacity: {
      parameters: [i64],
      result: pointer,
    },
    kernel_spawn_scratch_cancel: {
      parameters: [i64],
      result: i32,
    },
    kernel_spawn_scratch_retained_capacity: {
      parameters: [],
      result: pointer,
    },
    kernel_tcgetattr: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_tcsetattr: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_thread_exit: {
      parameters: [i32, i32],
      result: i64,
    },
    kernel_thread_has_deliverable: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_pick_tcp_listener_target: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_take_process_timer_cleanup: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_transfer_scratch_begin: {
      parameters: [pointer],
      result: i64,
    },
    kernel_transfer_scratch_pointer: {
      parameters: [i64],
      result: pointer,
    },
    kernel_transfer_scratch_capacity: {
      parameters: [i64],
      result: pointer,
    },
    kernel_transfer_scratch_cancel: {
      parameters: [i64],
      result: i32,
    },
    kernel_transfer_io_execute: {
      parameters: [i32, i32, i64, pointer, i32, i32, i64, i64],
      result: i32,
    },
    kernel_transfer_channel_execute: {
      parameters: [i32, i32, i64, i64],
      result: i32,
    },
    kernel_truncate: {
      parameters: [pointer, i32, i64],
      result: i32,
    },
    kernel_uname: {
      parameters: [pointer, i32],
      result: i32,
    },
    kernel_validate_task: {
      parameters: [i32, i32],
      result: i32,
    },
    kernel_vblank: {
      parameters: [],
      // The production export is void. Returning an ignored i32 keeps this
      // compact fixture's one-result encoder simple while exercising a
      // genuine gated Wasm call.
      result: i32,
    },
    kernel_wait_child_poll: {
      parameters: [i32, i32, i32, i32, i32, pointer, i32],
      result: i32,
    },
  };
}

/**
 * Build genuine Wasm exports that forward to mutable JavaScript test doubles.
 *
 * Production scratch regions reject structural `{ exports }` objects. Tests
 * keep that invariant honest by importing their mocks into a real module and
 * re-exporting the resulting native WebAssembly functions. The resolver is
 * intentionally late-bound so a test may replace a mock without mutating the
 * non-extensible genuine exports namespace.
 */
export function createKernelScratchTestInstance(
  pointerWidth: 4 | 8,
  memory: WebAssembly.Memory,
  resolveExports: () => Record<string, unknown>,
  allocator: (capacity: number) => number | bigint,
  memoryAddressWidth: 4 | 8 = 4,
  includedExports?: readonly string[],
  excludedExports: readonly string[] = [],
): WebAssembly.Instance {
  const selected = includedExports === undefined
    ? undefined
    : new Set(["kernel_alloc_scratch", ...includedExports]);
  const excluded = new Set(excludedExports);
  const entries = Object.entries(signatures(pointerWidth)).filter(
    ([name]) =>
      (selected === undefined || selected.has(name))
      && !excluded.has(name),
  );
  if (selected !== undefined) {
    const known = new Set(entries.map(([name]) => name));
    for (const name of selected) {
      if (!known.has(name)) {
        throw new Error(`missing test Wasm signature for ${name}`);
      }
    }
  }
  const memoryIsShared = typeof SharedArrayBuffer !== "undefined"
    && memory.buffer instanceof SharedArrayBuffer;
  const valueType = (type: WasmValueType): number =>
    type === "i32" ? 0x7f : 0x7e;
  const typePayload: number[] = [
    ...unsignedLeb128(entries.length),
  ];
  const importPayload: number[] = [
    ...unsignedLeb128(entries.length + 1),
    ...wasmString("scratch"),
    ...wasmString("memory"),
    2, // memory import
    ...(memoryIsShared
      // WHY: Wasm import types distinguish shared and unshared memories.
      // Shared memories require an advertised maximum; the broad wasm32
      // ceiling accepts every valid test-memory maximum while preserving the
      // exact shared-state bit that instance identity validation relies on.
      ? [
          memoryAddressWidth === 8 ? 0x07 : 0x03,
          0,
          ...unsignedLeb128(65_536),
        ]
      : [memoryAddressWidth === 8 ? 0x04 : 0x00, 0]),
  ];
  const exportPayload: number[] = [
    ...unsignedLeb128(entries.length + 1),
    ...wasmString("memory"),
    2,
    0,
  ];
  const imports: Record<string, (...args: Array<number | bigint>) => number | bigint>
    = {};

  entries.forEach(([name, signature], index) => {
    typePayload.push(
      0x60,
      ...unsignedLeb128(signature.parameters.length),
      ...signature.parameters.map(valueType),
      1,
      valueType(signature.result),
    );
    importPayload.push(
      ...wasmString("scratch"),
      ...wasmString(name),
      0,
      ...unsignedLeb128(index),
    );
    exportPayload.push(
      ...wasmString(name),
      0,
      ...unsignedLeb128(index),
    );
    imports[name] = (...args) => {
      if (name === "kernel_alloc_scratch") {
        return allocator(Number(args[0]));
      }
      const implementation = resolveExports()[name];
      if (typeof implementation !== "function") {
        throw new Error(`missing test implementation for ${name}`);
      }
      const result = Reflect.apply(implementation, undefined, args);
      return signature.result === "i64"
        ? BigInt(result as bigint | number)
        : Number(result);
    };
  });

  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, typePayload),
    ...section(2, importPayload),
    ...section(7, exportPayload),
  ]);
  const module = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(module, {
    scratch: {
      ...imports,
      memory,
    },
  });
}
