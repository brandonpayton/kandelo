#!/usr/bin/env python3
"""Fork-instrumentation size-overhead measurement harness (kd-ok55).

Compiles raw wasm inputs (hand-authored .wat test fixtures + synthetic
scaling modules), runs `wasm-fork-instrument` on each, and records:
  raw_bytes, instrumented_bytes, delta, %-of-instrumented,
  fork-path function count (--discover-only), and Code-section size
  before/after (wasm-objdump -h).

Everything runs on host; no package build required. Emits a TSV to
stdout and a formatted table to stderr.
"""
import os, re, subprocess, sys, tempfile, json

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TOOL = os.path.join(REPO, "tools", "bin", "wasm-fork-instrument")
FIXDIR = os.path.join(REPO, "crates", "fork-instrument", "tests", "fixtures")
OUT = os.path.join(REPO, "test-runs", "kd-ok55")
WORK = os.path.join(OUT, "work")
os.makedirs(WORK, exist_ok=True)

ENV = dict(os.environ, DEVELOPER_DIR="/Library/Developer/CommandLineTools")

def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, env=ENV, **kw)

def wat2wasm(wat_path, wasm_path):
    r = sh(["wat2wasm", wat_path, "-o", wasm_path])
    if r.returncode != 0:
        r = sh(["wat2wasm", "--enable-all", wat_path, "-o", wasm_path])
    if r.returncode != 0:
        raise RuntimeError(f"wat2wasm failed for {wat_path}: {r.stderr.strip()}")

def instrument(raw, inst):
    r = sh([TOOL, raw, "-o", inst])
    if r.returncode != 0:
        raise RuntimeError(f"instrument failed for {raw}: {r.stderr.strip()}")

def fork_path_count(raw):
    r = sh([TOOL, raw, "--discover-only"])
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)["count"]
    except Exception:
        return None

SEC_RE = re.compile(r"^\s*(\w+)\s+start=0x[0-9a-f]+\s+end=0x[0-9a-f]+\s+\(size=0x([0-9a-f]+)\)(?:\s+count:\s*(\d+))?")

def sections(wasm):
    """Return {section_name: (size_bytes, count_or_None)} from wasm-objdump -h.
    'Custom' rows are keyed by their quoted name so they don't collide."""
    r = sh(["wasm-objdump", "-h", wasm])
    out = {}
    for line in r.stdout.splitlines():
        m = SEC_RE.match(line)
        if not m:
            continue
        name = m.group(1)
        if name == "Custom":
            q = re.search(r'"([^"]+)"', line)
            name = f"Custom:{q.group(1)}" if q else "Custom"
        size = int(m.group(2), 16)
        cnt = int(m.group(3)) if m.group(3) else None
        out[name] = (size, cnt)
    return out

# ---- synthetic generators (mirror crates/.../tests/large_dispatcher.rs) ----
def wat_direct_dispatcher(n):
    body = "".join("        call $fork\n" + ("        drop\n" if i + 1 < n else "")
                   for i in range(n))
    return f'''(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (func $dispatcher (export "dispatcher") (result i32)
{body}  )
  (memory 1))
'''

def wat_many_functions(m):
    fns = "".join(f'  (func $f{i} (export "f{i}") (result i32) call $fork)\n'
                  for i in range(m))
    return f'''(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
{fns}  (memory 1))
'''

def measure(label, raw_wasm):
    inst = os.path.join(WORK, os.path.basename(raw_wasm).replace(".wasm", ".inst.wasm"))
    instrument(raw_wasm, inst)
    raw_b = os.path.getsize(raw_wasm)
    inst_b = os.path.getsize(inst)
    delta = inst_b - raw_b
    pct_inst = 100.0 * delta / inst_b if inst_b else 0.0
    pct_raw = 100.0 * delta / raw_b if raw_b else 0.0
    fpc = fork_path_count(raw_wasm)
    sraw = sections(raw_wasm)
    sinst = sections(inst)
    code_raw = sraw.get("Code", (0, None))
    code_inst = sinst.get("Code", (0, None))
    return dict(label=label, raw=raw_b, inst=inst_b, delta=delta,
                pct_inst=pct_inst, pct_raw=pct_raw, fpc=fpc,
                code_raw=code_raw[0], code_inst=code_inst[0],
                nfuncs_raw=(sraw.get("Function", (0, None))[1] or 0)
                           + (sraw.get("Import", (0, None))[1] or 0),
                nfuncs_inst=(sinst.get("Function", (0, None))[1] or 0),
                sraw=sraw, sinst=sinst)

rows = []

# Group A: real hand-authored raw fixtures (import kernel_fork, no wpk_* yet)
fixtures = []
for root, _, files in os.walk(FIXDIR):
    for fn in sorted(files):
        if not fn.endswith(".wat"):
            continue
        p = os.path.join(root, fn)
        txt = open(p).read()
        if "kernel_fork" in txt and "wpk_fork_" not in txt:
            fixtures.append(p)
for p in sorted(fixtures):
    name = os.path.relpath(p, FIXDIR)
    w = os.path.join(WORK, name.replace("/", "__").replace(".wat", ".wasm"))
    wat2wasm(p, w)
    rows.append(("fixture", measure(name, w)))

# Group B: synthetic direct-dispatcher (single fn, N fork call-sites)
for n in (1, 10, 100, 1000):
    wat = os.path.join(WORK, f"dispatcher_n{n}.wat")
    open(wat, "w").write(wat_direct_dispatcher(n))
    w = wat.replace(".wat", ".wasm"); wat2wasm(wat, w)
    rows.append(("dispatcher", measure(f"dispatcher_n{n} (1 fn, {n} fork-calls)", w)))

# Group C: synthetic many-functions (M fns each 1 fork call)
for m in (1, 10, 100, 1000):
    wat = os.path.join(WORK, f"manyfn_m{m}.wat")
    open(wat, "w").write(wat_many_functions(m))
    w = wat.replace(".wat", ".wasm"); wat2wasm(wat, w)
    rows.append(("manyfn", measure(f"manyfn_m{m} ({m} fork-path fns)", w)))

# ---- output TSV ----
tsv = os.path.join(OUT, "measurements.tsv")
with open(tsv, "w") as f:
    f.write("group\tlabel\traw_bytes\tinst_bytes\tdelta_bytes\tpct_of_inst\tpct_of_raw\tforkpath_fns\tnfuncs_raw\tnfuncs_inst\tcode_raw\tcode_inst\tcode_delta\n")
    for grp, r in rows:
        f.write(f"{grp}\t{r['label']}\t{r['raw']}\t{r['inst']}\t{r['delta']}\t"
                f"{r['pct_inst']:.1f}\t{r['pct_raw']:.1f}\t{r['fpc']}\t"
                f"{r['nfuncs_raw']}\t{r['nfuncs_inst']}\t{r['code_raw']}\t"
                f"{r['code_inst']}\t{r['code_inst']-r['code_raw']}\n")

# ---- pretty table to stderr ----
def p(*a): print(*a, file=sys.stderr)
p(f"\n{'label':<42} {'raw':>8} {'inst':>8} {'delta':>8} {'%inst':>6} {'fp':>4} {'code_raw':>8} {'code_inst':>9} {'code_Δ':>8}")
p("-" * 110)
for grp, r in rows:
    p(f"{r['label']:<42} {r['raw']:>8} {r['inst']:>8} {r['delta']:>8} "
      f"{r['pct_inst']:>5.1f}% {str(r['fpc']):>4} {r['code_raw']:>8} "
      f"{r['code_inst']:>9} {r['code_inst']-r['code_raw']:>8}")

# section breakdown for one representative + largest synthetic
p("\n=== Section breakdown (bytes): dispatcher_n1000 raw vs instrumented ===")
for grp, r in rows:
    if r['label'].startswith("dispatcher_n1000"):
        keys = sorted(set(r['sraw']) | set(r['sinst']))
        p(f"{'section':<20} {'raw':>10} {'inst':>10} {'delta':>10}")
        for k in keys:
            a = r['sraw'].get(k, (0, None))[0]
            b = r['sinst'].get(k, (0, None))[0]
            p(f"{k:<20} {a:>10} {b:>10} {b-a:>10}")
print(f"TSV written: {tsv}")
