/**
 * Host-runtime diagnostic delivered outside a guest process's fd 2 stream.
 *
 * `status` is present when the diagnostic describes a process disposition.
 * Protocol/setup failures that are not tied to an exit status leave it absent.
 */
export interface HostDiagnostic {
  pid: number;
  status?: number;
  source: string;
  message: string;
}

export interface HostDiagnosticMessage extends HostDiagnostic {
  type: "host_diagnostic";
}

/**
 * Co-resident fork-module proof-of-use telemetry (frame/reference reconstruction
 * counts). This is an INFORMATIONAL success signal, NOT a host problem: it rides
 * a channel separate from `HostDiagnosticMessage` so that a clean fork never
 * pollutes the problem-diagnostic stream a caller inspects for failures. Only
 * a consumer that explicitly opts in (`onForkModuleProof`) receives it; ordinary
 * hosts and tests never see a fork emit proof-of-use as a diagnostic.
 */
export interface ForkModuleProofMessage extends HostDiagnostic {
  type: "fork_module_proof";
}
