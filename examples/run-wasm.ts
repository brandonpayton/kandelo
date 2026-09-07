/**
 * run-wasm.ts — Run a single self-contained .wasm on the kernel.
 *
 * Unlike run-example.ts, this deliberately performs NO builtin-program
 * discovery: it boots a NodeKernelHost, spawns exactly the given module,
 * and exits with the guest's status. Use it for standalone programs that
 * need no /bin tools (e.g. the Rust guest fixtures under programs/rust/),
 * where run-example's package-closure resolution is unnecessary overhead.
 *
 * Usage:
 *   npx tsx examples/run-wasm.ts <path-to.wasm> [args...]
 *
 * Env:
 *   TIMEOUT  guest wall-clock budget in ms (default 30000)
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { NodeKernelHost } from "../host/src/node-kernel-host";

async function main(): Promise<void> {
    const wasmArg = process.argv[2];
    if (wasmArg === undefined) {
        console.error("usage: run-wasm.ts <path-to.wasm> [args...]");
        process.exit(2);
    }
    const wasmPath = resolve(wasmArg);
    const bytes = readFileSync(wasmPath);
    const program = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    const host = new NodeKernelHost({
        maxWorkers: 4,
        onStdout: (_pid, data) => process.stdout.write(data),
        onStderr: (_pid, data) => process.stderr.write(data),
    });
    await host.init();

    let status = 1;
    try {
        const argv = [wasmPath, ...process.argv.slice(3)];
        const timeoutMs = parseInt(process.env.TIMEOUT || "30000", 10);
        const exitPromise = host.spawn(program, argv, { env: [] });
        const timeoutPromise = new Promise<number>((_, reject) => {
            setTimeout(() => reject(new Error("guest timed out")), timeoutMs);
        });
        status = await Promise.race([exitPromise, timeoutPromise]);
    } finally {
        await host.destroy().catch(() => {});
    }
    process.exit(status);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
