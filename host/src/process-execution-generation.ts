/**
 * Serialisable execution identity shared by the Node and browser hosts.
 *
 * A numeric PID is not an execution identity: exec keeps the PID while
 * replacing its worker and WebAssembly.Memory. A checkpoint that keyed process
 * memories by PID could not tell a pre-exec generation from its successor, so
 * every process launch stamps one of these numbers instead.
 *
 * The number is host-local. Both hosts count from one per session, so two
 * keepers hand out the same number for different processes. A checkpoint
 * therefore carries the mapping and a receiver allocates its own, exactly as it
 * does for host handles.
 *
 * This is deliberately not the browser's framebuffer `generation`. That number
 * keys framebuffer messages and its lifetime belongs to the framebuffer
 * registry; binding process identity to it would couple two unrelated
 * lifetimes.
 */
export class ProcessExecutionGenerationAllocator {
  private next = 1;

  allocate(): number {
    const generation = this.next++;
    if (!Number.isSafeInteger(generation)) {
      throw new Error("process execution generation space exhausted");
    }
    return generation;
  }
}
