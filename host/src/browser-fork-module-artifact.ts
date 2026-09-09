import forkModule32Url from "@fork-module32-wasm?url";

/**
 * Phase 6 D5: the wasm32 co-resident fork-module's bundler URL.
 *
 * This lives in its OWN module — separate from `browser-kernel-default-artifacts`
 * — so importing it (and therefore requiring the staged `fork_module32.wasm`
 * artifact) happens only when a demo opts into `WASM_POSIX_FORK_MODULE`. A
 * default browser boot never resolves this URL, so the fork-module stays an
 * optional build output rather than a hard requirement of every demo build.
 */
export const browserForkModule32ArtifactUrl = forkModule32Url;
