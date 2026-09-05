/**
 * Synchronous GL query handler invoked by `host_gl_query`.
 *
 * Sync queries can't ride the cmdbuf — `glGetError`, `glGetUniformLocation`,
 * etc. need a reply *now*. The C side issues `ioctl(GLIO_QUERY)` with
 * `(op, in, out)` buffers; the kernel forwards the call to
 * `HostIO::gl_query`, which lands here.
 *
 * Returns the number of bytes written to `out`, or a negative errno-ish
 * value: `-EPERM` (-1) when the binding has no live context, `-EINVAL`
 * (-22) for an unknown query op.
 *
 * Uniform locations: WebGL hands back opaque `WebGLUniformLocation`
 * objects; the cmdbuf needs an integer. We allocate monotonic indices
 * via `++b.nextUniformLoc` (audit finding #12 — Map.size shrinks on
 * delete and would collide). Indices are number-keyed for clean u32
 * round-tripping.
 */
import type { GlBinding } from "./registry.js";
import * as O from "./ops.js";

export function runGlQuery(
  b: GlBinding,
  op: number,
  input: Uint8Array,
  out: Uint8Array,
): number {
  if (!b.gl) return -1;
  const gl = b.gl;
  const inDv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outDv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  switch (op) {
    case O.QOP_GET_ERROR:
      if (out.byteLength < 4) return -22;
      outDv.setUint32(0, gl.getError(), true);
      return 4;

    // in: u32 name; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_STRING: {
      if (input.byteLength < 4) return -22;
      const name = inDv.getUint32(0, true);
      const s = (gl.getParameter(name) as string | null) ?? "";
      const bytes = new TextEncoder().encode(s);
      const need = 4 + bytes.byteLength;
      if (out.byteLength < need) return -22;
      outDv.setUint32(0, bytes.byteLength, true);
      out.set(bytes, 4);
      return need;
    }

    // in: u32 pname; out: i32 value
    case O.QOP_GET_INTEGERV: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const pname = inDv.getUint32(0, true);
      const value = gl.getParameter(pname);
      outDv.setInt32(0, Number(value ?? 0), true);
      return 4;
    }

    // in: u32 pname; out: f32 value
    case O.QOP_GET_FLOATV: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const pname = inDv.getUint32(0, true);
      const value = gl.getParameter(pname);
      outDv.setFloat32(0, Number(value ?? 0), true);
      return 4;
    }

    // in: u32 program, u32 nameLen, u8 name[nameLen]; out: i32 location-index
    case O.QOP_GET_UNIFORM_LOC: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const programName = inDv.getUint32(0, true);
      const nameLen = inDv.getUint32(4, true);
      if (input.byteLength < 8 + nameLen) return -22;
      const program = b.programs.get(programName);
      const uniformName = new TextDecoder().decode(input.subarray(8, 8 + nameLen));
      const loc = program ? gl.getUniformLocation(program, uniformName) : null;
      if (loc) {
        const idx = ++b.nextUniformLoc;
        b.uniformLocations.set(idx, loc);
        // The pair behind the index, kept because the location object dies
        // with the context and a checkpoint restore has to re-ask a fresh
        // one; see `GlBinding.uniformLocationNames`.
        b.uniformLocationNames.set(idx, {
          program: programName,
          uniform: uniformName,
        });
        outDv.setInt32(0, idx, true);
      } else {
        outDv.setInt32(0, -1, true);
      }
      return 4;
    }

    // in: u32 program, u32 nameLen, u8 name[nameLen]; out: i32 attrib-index
    case O.QOP_GET_ATTRIB_LOC: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const programName = inDv.getUint32(0, true);
      const nameLen = inDv.getUint32(4, true);
      if (input.byteLength < 8 + nameLen) return -22;
      const program = b.programs.get(programName);
      const attrName = new TextDecoder().decode(input.subarray(8, 8 + nameLen));
      const loc = program ? gl.getAttribLocation(program, attrName) : -1;
      outDv.setInt32(0, loc, true);
      return 4;
    }

    // in: u32 shaderName, u32 pname; out: i32 value
    case O.QOP_GET_SHADERIV: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const sh = b.shaders.get(inDv.getUint32(0, true));
      if (!sh) {
        outDv.setInt32(0, 0, true);
        return 4;
      }
      const v = gl.getShaderParameter(sh, inDv.getUint32(4, true));
      outDv.setInt32(0, typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0), true);
      return 4;
    }

    // in: u32 shaderName; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_SHADER_INFO_LOG: {
      if (input.byteLength < 4) return -22;
      const sh = b.shaders.get(inDv.getUint32(0, true));
      const log = (sh && gl.getShaderInfoLog(sh)) ?? "";
      const bytes = new TextEncoder().encode(log);
      const need = 4 + bytes.byteLength;
      if (out.byteLength < need) {
        outDv.setUint32(0, 0, true);
        return 4;
      }
      outDv.setUint32(0, bytes.byteLength, true);
      out.set(bytes, 4);
      return need;
    }

    // in: u32 programName, u32 pname; out: i32 value
    case O.QOP_GET_PROGRAMIV: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      if (!prog) {
        outDv.setInt32(0, 0, true);
        return 4;
      }
      const v = gl.getProgramParameter(prog, inDv.getUint32(4, true));
      outDv.setInt32(0, typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0), true);
      return 4;
    }

    // in: u32 programName; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_PROGRAM_INFO_LOG: {
      if (input.byteLength < 4) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      const log = (prog && gl.getProgramInfoLog(prog)) ?? "";
      const bytes = new TextEncoder().encode(log);
      const need = 4 + bytes.byteLength;
      if (out.byteLength < need) {
        outDv.setUint32(0, 0, true);
        return 4;
      }
      outDv.setUint32(0, bytes.byteLength, true);
      out.set(bytes, 4);
      return need;
    }

    // in: i32 x, i32 y, i32 w, i32 h, u32 format, u32 type; out: u8 pixels[...]
    case O.QOP_READ_PIXELS: {
      if (input.byteLength < 24) return -22;
      const x = inDv.getInt32(0, true);
      const y = inDv.getInt32(4, true);
      const w = inDv.getInt32(8, true);
      const h = inDv.getInt32(12, true);
      const format = inDv.getUint32(16, true);
      const type = inDv.getUint32(20, true);
      // WebGL2 readPixels requires the destination view to match `type`.
      // 0x1406 = GL_FLOAT, 0x1401 = GL_UNSIGNED_BYTE, 0x140B = GL_HALF_FLOAT.
      let view: ArrayBufferView = out;
      if (type === 0x1406) {
        view = new Float32Array(out.buffer, out.byteOffset, (out.byteLength / 4) | 0);
      } else if (type === 0x140B) {
        view = new Uint16Array(out.buffer, out.byteOffset, (out.byteLength / 2) | 0);
      }
      gl.readPixels(x, y, w, h, format, type, view);
      // gl.readPixels writes into `out` directly. Bytes-written depends
      // on (format,type,w,h); the kernel cap (`MAX_QUERY_OUT_LEN`) is
      // the upper bound. Return the full out length — the C side knows
      // the geometry.
      return out.byteLength;
    }

    // in: u32 target; out: u32 status
    case O.QOP_CHECK_FB_STATUS: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const status = gl.checkFramebufferStatus(inDv.getUint32(0, true));
      outDv.setUint32(0, status, true);
      return 4;
    }

    default:
      return -22;
  }
}
