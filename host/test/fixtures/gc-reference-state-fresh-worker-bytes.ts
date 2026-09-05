// WHY: the dev shell's WABT parser does not accept current typed-reference
// syntax even with --enable-gc. These are the Rust `wat` crate's deterministic
// bytes for the adjacent, reviewed gc-reference-state-fresh-worker.wat source.
// Node and browser integration tests share the exact input artifact.
const RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX = [
  "0061736d01000000011e065f027f0163000160017f0060017f017f6000017f60016400017f60000002520403656e76066d656d6f727902030180800103656e760e5f5f6368616e6e656c5f62617365037f01066b65726e656c0b6b65726e656c5f657869740001066b65726e656c0b6b65726e656c5f666f",
  "726b0002030504030204050406016300010101060e02630001d0000b7f01418080040b072c030f5f5f737461636b5f706f696e74657203020d5f5f6162695f76657273696f6e0002065f737461727400050ad402040400412b0ba60101027f23002101200141046a418b01360200200141086a2000ac3703",
  "00200141106a428008370300200141186a4200370300200141206a4200370300200141286a4200370300200141306a420037030020014101fe17020020014101fe0002001a024003402001fe1002004101470d0120014101427ffe0102001a0c000b0b200141c0006a2802000440417f210205200141386a",
  "290300a721020b20014100fe17020020020b5502016300027f20004100100121022101200245044020012000d323012000d371410025002000d3712000fb02000041cd00467120002000fb020001d4d3712103200345044041db001000000b41001000000b20020b4f02016300017f41cd00d000fb000021",
  "002000d42000fb050001200024014100200026002000d41004210120011003200147044041dc001000000b418008280200044041dc001000000b41001000000b00e401046e616d65014204000b6b65726e656c5f65786974010b6b65726e656c5f666f726b030a776169745f6368696c640419666f726b5f",
  "776974685f7265666572656e63655f7374617465024003030300037069640104626173650206726573756c74040400046e6f64650107636172726965640203706964030576616c6964050200046e6f6465010370696403130103020008636f6d706c65746501047761697404070100046e6f6465050e0100",
  "0b73617665645f7461626c65072903000e5f5f6368616e6e656c5f6261736501057361766564020f5f5f737461636b5f706f696e746572",
].join("");

/** The `__abi_version` body the reviewed .wat source compiles to: `i32.const 43`. */
const AUTHORED_ABI_VERSION_BODY = "0400412b0b";

/**
 * The fixture bytes, with `__abi_version` restamped to the host's ABI.
 *
 * The host refuses any program whose declared ABI is not its own, so a
 * checked-in blob that names one fixed version stops running at the next bump.
 * It stops with a bare non-zero exit and no guest output, which reads as a
 * broken fixture rather than a stale one. Stamping keeps the reviewed bytes
 * authoritative for everything except the one number the fixture does not own.
 */
export function rawGcReferenceStateFreshWorkerBytes(
  abiVersion: number,
): Uint8Array {
  if (!Number.isInteger(abiVersion) || abiVersion < 0 || abiVersion > 0x7f) {
    throw new Error(
      `ABI ${abiVersion} does not fit the fixture's one-byte i32.const`,
    );
  }
  const hex = RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX;
  const at = hex.indexOf(AUTHORED_ABI_VERSION_BODY);
  if (at < 0 || at !== hex.lastIndexOf(AUTHORED_ABI_VERSION_BODY)) {
    throw new Error(
      "the gc-reference fixture no longer carries exactly one __abi_version body",
    );
  }
  const stamped = `040041${abiVersion.toString(16).padStart(2, "0")}0b`;
  return Uint8Array.from(
    Buffer.from(hex.replace(AUTHORED_ABI_VERSION_BODY, stamped), "hex"),
  );
}
