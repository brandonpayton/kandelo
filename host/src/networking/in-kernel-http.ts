/**
 * External HTTP request interface — shared types and HTTP/1.1 framing helpers.
 *
 * These let host code send an HTTP request to a server running inside the
 * kernel ("in-kernel server") and receive a parsed response, without going
 * through real TCP. The actual pump runs inside the kernel worker via
 * {@link CentralizedKernelWorker.sendHttpRequest}; this file holds the
 * data shapes and the byte-level codec that both ends share.
 *
 * Prototype scope (see docs/plans/2026-04-30-external-kernel-http-request-interface.md):
 *   - Request and response bodies are buffered in full (no streaming).
 *   - Plain HTTP/1.1 only.
 *   - Each call opens a fresh injected connection (no pipelining).
 */

export interface HttpRequest {
  /** HTTP method, e.g. "GET", "POST". */
  method: string;
  /** Request-target — what goes after the method on the request line, e.g.
   * `/foo?x=1`. Typically a path; absolute URLs work for proxy-style requests
   * but the in-kernel server determines the routing. */
  url: string;
  /** Header name → value. Header names are sent verbatim. If
   *  `Content-Length` is missing and `body` is non-empty, it's added
   *  automatically. If `Connection` is missing, `Connection: close` is
   *  added so the server closes the response cleanly. */
  headers: Record<string, string>;
  /** Optional request body. */
  body: Uint8Array | null;
}

export interface HttpResponse {
  /** Numeric HTTP status code, e.g. 200. */
  status: number;
  /** Response headers, with `Transfer-Encoding: chunked` stripped if the
   *  body was already de-chunked here. */
  headers: Record<string, string>;
  /** Decoded response body. */
  body: Uint8Array;
}

/**
 * One HTTP injection as the guest observes it: the listener port it was
 * dispatched to, the synthetic peer port the host drew, and the raw request
 * bytes written into the pipe. What a replication log records, and what a
 * replaying machine is handed back.
 */
export interface HttpExchangeInjection {
  port: number;
  remotePort: number;
  request: Uint8Array;
}

/**
 * Replication's hand on `sendHttpRequest`.
 *
 * A recording machine hands every injection to `record` before the guest can
 * observe it. A replaying machine installs the replay mode, which makes any
 * live send refuse — its injections come from the log, via
 * `replayHttpExchange`, or the machine diverges.
 */
export type HttpExchangeTap =
  | { mode: "record"; record: (injection: HttpExchangeInjection) => void }
  | { mode: "replay" };

/** Options for {@link CentralizedKernelWorker.sendHttpRequest}. */
export interface SendHttpRequestOptions {
  /** Time to wait for a complete response before bailing with status 504.
   *  Defaults to 60 seconds. */
  timeoutMs?: number;
  /** Optional label appended to log lines for grepping in busy demos. */
  debugLabel?: string;
  /** Internal retry budget for a server-side close before any HTTP bytes. */
  emptyResponseRetries?: number;
  /** Maximum raw response bytes retained before parsing. */
  maxResponseBytes?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class BoundedHttpResponseChunks {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("HTTP response byte bound must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength > this.maximumBytes - this.bytes) {
      throw new Error(
        `in-kernel HTTP response exceeds its ${this.maximumBytes}-byte bound`,
      );
    }
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
  }

  concat(): Uint8Array {
    const result = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

/**
 * Serialize an {@link HttpRequest} to raw HTTP/1.1 bytes ready to write into
 * a kernel pipe.
 *
 * Adds `Content-Length` if the request has a body but no explicit one.
 * Adds `Connection: close` if not specified, so the server cleanly closes
 * the response and the host pump sees a clean EOF.
 */
export function buildRawHttpRequest(req: HttpRequest): Uint8Array {
  let header = `${req.method} ${req.url} HTTP/1.1\r\n`;
  const lowerKeys = Object.keys(req.headers).map((k) => k.toLowerCase());
  for (const [key, value] of Object.entries(req.headers)) {
    header += `${key}: ${value}\r\n`;
  }
  if (req.body && req.body.length > 0 && !lowerKeys.includes("content-length")) {
    header += `Content-Length: ${req.body.length}\r\n`;
  }
  if (!lowerKeys.includes("connection")) {
    header += `Connection: close\r\n`;
  }
  header += `\r\n`;

  const headerBytes = encoder.encode(header);
  if (!req.body || req.body.length === 0) return headerBytes;

  const out = new Uint8Array(headerBytes.length + req.body.length);
  out.set(headerBytes, 0);
  out.set(req.body, headerBytes.length);
  return out;
}

/**
 * The method and request-target on a raw request's request line.
 *
 * A recorded injection carries bytes rather than a parsed request. The
 * response parser needs the method back — HEAD forbids a body — and a viewer
 * pairing its page's requests with replayed exchanges needs the target, so
 * both come from the one place they are authoritative.
 */
export function parseRawRequestLine(
  rawRequest: Uint8Array,
): { method: string; target: string } {
  const lineEnd = rawRequest.indexOf(0x0d);
  const line = decoder.decode(
    rawRequest.subarray(0, lineEnd > 0 ? lineEnd : rawRequest.length),
  );
  const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) HTTP\/1\.[01]$/u.exec(
    line,
  );
  if (match === null) {
    throw new Error("in-kernel HTTP request line is malformed");
  }
  return { method: match[1]!, target: match[2]! };
}

/**
 * Parse a complete raw HTTP/1.1 response (as a single byte buffer) into an
 * {@link HttpResponse}. Decodes chunked transfer encoding when present and
 * removes the `Transfer-Encoding` header so callers see a flat body.
 */
export function parseRawHttpResponse(
  data: Uint8Array,
  requestMethod = "GET",
): HttpResponse {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(requestMethod)) {
    throw new Error("in-kernel HTTP request method is malformed");
  }
  const headerEnd = findHeaderEnd(data);
  if (headerEnd < 0) {
    throw new Error("in-kernel HTTP response lacks a header terminator");
  }

  const headerText = decoder.decode(data.subarray(0, headerEnd));
  const lines = headerText.split("\r\n");
  const statusMatch = lines[0]?.match(
    /^HTTP\/(?:1\.0|1\.1) ([1-5][0-9]{2})(?: [^\r\n]*)?$/u,
  );
  if (statusMatch === undefined || statusMatch === null) {
    throw new Error("in-kernel HTTP response has a malformed status line");
  }
  const status = parseInt(statusMatch[1]!, 10);

  const headers: Record<string, string> = {};
  const valuesByLowerName = new Map<string, string[]>();
  for (let i = 1; i < lines.length; i++) {
    const { key, value } = parseHttpFieldLine(lines[i]!, "header");
    const lowerName = key.toLowerCase();
    const values = valuesByLowerName.get(lowerName) ?? [];
    values.push(value);
    valuesByLowerName.set(lowerName, values);
    const existingKey = Object.keys(headers).find(
      (candidate) => candidate.toLowerCase() === lowerName,
    );
    if (lowerName === "set-cookie" && existingKey !== undefined) {
      headers[existingKey] += "\n" + value;
    } else {
      headers[key] = value;
    }
  }

  let body = data.subarray(headerEnd + 4);
  const bodyForbidden = requestMethod.toUpperCase() === "HEAD" ||
    status >= 100 && status < 200 || status === 204 || status === 304;
  if (bodyForbidden && body.byteLength !== 0) {
    throw new Error("in-kernel HTTP response must not contain a body");
  }
  const transferEncodings = valuesByLowerName.get("transfer-encoding") ?? [];
  const contentLengths = valuesByLowerName.get("content-length") ?? [];
  if (transferEncodings.length > 0 && contentLengths.length > 0) {
    throw new Error("in-kernel HTTP response has conflicting body framing");
  }
  if (transferEncodings.length > 0) {
    if (
      transferEncodings.length !== 1 ||
      transferEncodings[0]!.trim().toLowerCase() !== "chunked"
    ) {
      throw new Error("in-kernel HTTP response has unsupported transfer encoding");
    }
    if (!bodyForbidden) body = decodeChunked(body);
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "transfer-encoding") delete headers[key];
    }
  } else if (contentLengths.length > 0) {
    if (
      !contentLengths.every((value) => value === contentLengths[0]) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(contentLengths[0]!)
    ) {
      throw new Error("in-kernel HTTP response has an invalid Content-Length");
    }
    const expected = Number(contentLengths[0]);
    if (
      !Number.isSafeInteger(expected) ||
      (!bodyForbidden && body.byteLength !== expected)
    ) {
      throw new Error("in-kernel HTTP response differs from its Content-Length");
    }
  }

  return { status, headers, body: new Uint8Array(body) };
}

function parseHttpFieldLine(
  line: string,
  kind: "header" | "trailer",
): { key: string; value: string } {
  const colon = line.indexOf(":");
  if (colon < 1) {
    throw new Error(`in-kernel HTTP response has a malformed ${kind} line`);
  }
  const key = line.slice(0, colon);
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key)) {
    throw new Error(`in-kernel HTTP response has a malformed ${kind} name`);
  }
  const rawValue = line.slice(colon + 1);
  if (/[^\t\x20-\x7e\x80-\xff]/u.test(rawValue)) {
    throw new Error(`in-kernel HTTP response has a malformed ${kind} value`);
  }
  return {
    key,
    value: rawValue.replace(/^[\t ]*/u, "").replace(/[\t ]*$/u, ""),
  };
}

/** Byte offset of the `\r\n\r\n` at the end of headers, or -1. */
function findHeaderEnd(data: Uint8Array): number {
  for (let i = 0; i + 3 < data.length; i++) {
    if (
      data[i] === 0x0d && data[i + 1] === 0x0a &&
      data[i + 2] === 0x0d && data[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}

/** Decode a complete HTTP/1.1 chunked body, including its terminal trailers. */
function decodeChunked(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  for (;;) {
    const lineEnd = findCrlf(data, pos);
    if (lineEnd < 0) {
      throw new Error("in-kernel HTTP chunk size line is truncated");
    }
    const sizeLine = decoder.decode(data.subarray(pos, lineEnd));
    const sizeMatch = /^([0-9A-Fa-f]+)(?:;[^\r\n]*)?$/u.exec(sizeLine);
    if (sizeMatch === null) {
      throw new Error("in-kernel HTTP response has a malformed chunk size");
    }
    const chunkSize = Number.parseInt(sizeMatch[1]!, 16);
    if (!Number.isSafeInteger(chunkSize)) {
      throw new Error("in-kernel HTTP response chunk size exceeds its bound");
    }
    const chunkStart = lineEnd + 2;
    if (chunkSize === 0) {
      pos = chunkStart;
      for (;;) {
        const trailerEnd = findCrlf(data, pos);
        if (trailerEnd < 0) {
          throw new Error("in-kernel HTTP response lacks its terminating chunk");
        }
        if (trailerEnd === pos) {
          if (trailerEnd + 2 !== data.byteLength) {
            throw new Error("in-kernel HTTP response has bytes after its chunked body");
          }
          return concatChunks(chunks);
        }
        const trailer = decoder.decode(data.subarray(pos, trailerEnd));
        parseHttpFieldLine(trailer, "trailer");
        pos = trailerEnd + 2;
      }
    }
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > data.length) {
      throw new Error("in-kernel HTTP response chunk is truncated");
    }
    if (
      chunkEnd + 2 > data.length ||
      data[chunkEnd] !== 0x0d || data[chunkEnd + 1] !== 0x0a
    ) {
      throw new Error("in-kernel HTTP response chunk lacks its terminator");
    }
    chunks.push(data.subarray(chunkStart, chunkEnd));
    pos = chunkEnd + 2;
  }
}

function findCrlf(data: Uint8Array, start: number): number {
  for (let index = start; index + 1 < data.length; index++) {
    if (data[index] === 0x0d && data[index + 1] === 0x0a) return index;
  }
  return -1;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
