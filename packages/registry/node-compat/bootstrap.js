// Shared Node.js API compatibility layer for Kandelo JavaScript runtimes.
// Provides require(), process, Buffer, and core Node.js modules
// Built on top of qjs-shaped os/std/native adapter modules.
//
// This is NOT Node.js. It is a compatibility layer that implements
// the most commonly used Node.js APIs using POSIX syscalls.

import * as std from 'qjs:std';
import * as os from 'qjs:os';
import * as _nodeNative from 'qjs:node';

// ============================================================
// TextEncoder/TextDecoder polyfill for engines that do not provide it.
// ============================================================

if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        get encoding() { return 'utf-8'; }
        encode(str) {
            if (typeof str !== 'string') str = String(str);
            const bytes = [];
            for (let i = 0; i < str.length; i++) {
                let code = str.charCodeAt(i);
                if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
                    const low = str.charCodeAt(i + 1);
                    if (low >= 0xDC00 && low <= 0xDFFF) {
                        code = ((code - 0xD800) << 10) + (low - 0xDC00) + 0x10000;
                        i++;
                    }
                }
                if (code < 0x80) {
                    bytes.push(code);
                } else if (code < 0x800) {
                    bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
                } else if (code < 0x10000) {
                    bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
                } else {
                    bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F),
                               0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
                }
            }
            return new Uint8Array(bytes);
        }
        encodeInto(str, dest) {
            const encoded = this.encode(str);
            const len = Math.min(encoded.length, dest.length);
            dest.set(encoded.subarray(0, len));
            return { read: str.length, written: len };
        }
    };
}

if (typeof globalThis.TextDecoder === 'undefined') {
    // Build the result by batching codepoints into 8K chunks and joining via
    // String.fromCharCode.apply. The naive `result += String.fromCharCode(c)`
    // loop produces a per-character string rope; JS_ToCStringLen (invoked
    // when C reads the string, e.g. native JSON.parse on a 38 MB npm
    // packument) must linearize that rope into a flat UTF-16 buffer and
    // SIGABRTs from heap fragmentation on multi-MB inputs.
    // Array.prototype.join('') is unsafe — QJS-NG zeros leading parts when
    // joining many large 8-bit strings.
    const _CHUNK = 8192;
    globalThis.TextDecoder = class TextDecoder {
        constructor(encoding) {
            this._encoding = (encoding || 'utf-8').toLowerCase();
        }
        get encoding() { return this._encoding; }
        decode(input, options) {
            if (!input) return '';
            const bytes = input instanceof Uint8Array ? input :
                          input instanceof ArrayBuffer ? new Uint8Array(input) :
                          new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
            // Native UTF-8 → JS string in one pass. The JS fallback below
            // does the same but takes ~10 s on a 38 MB npm packument.
            if (typeof _nodeNative.decodeUtf8 === 'function') {
                return _nodeNative.decodeUtf8(bytes);
            }
            let result = '';
            let chunk = [];
            let i = 0;
            while (i < bytes.length) {
                let code;
                if (bytes[i] < 0x80) {
                    code = bytes[i++];
                } else if ((bytes[i] & 0xE0) === 0xC0) {
                    code = ((bytes[i++] & 0x1F) << 6) | (bytes[i++] & 0x3F);
                } else if ((bytes[i] & 0xF0) === 0xE0) {
                    code = ((bytes[i++] & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
                } else if ((bytes[i] & 0xF8) === 0xF0) {
                    code = ((bytes[i++] & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) |
                           ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
                } else {
                    code = 0xFFFD;
                    i++;
                }
                if (code > 0xFFFF) {
                    code -= 0x10000;
                    chunk.push(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF));
                } else {
                    chunk.push(code);
                }
                if (chunk.length >= _CHUNK) {
                    result += String.fromCharCode.apply(null, chunk);
                    chunk = [];
                }
            }
            if (chunk.length > 0) result += String.fromCharCode.apply(null, chunk);
            return result;
        }
    };
}

// Some JavaScript engine parsers are very slow on multi-MB npm packuments.
// Use the native JSON parser hook when present; fall back otherwise.
if (typeof _nodeNative.jsonParse === 'function') {
    const _origJsonParse = JSON.parse;
    JSON.parse = function(text, reviver) {
        if (reviver !== undefined || typeof text !== 'string') {
            return _origJsonParse.call(JSON, text, reviver);
        }
        return _nodeNative.jsonParse(text);
    };
}

// ============================================================
// atob/btoa polyfill for engines that do not provide it.
// ============================================================

if (typeof globalThis.atob === 'undefined') {
    const _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const _b64lookup = new Uint8Array(256);
    for (let i = 0; i < _b64chars.length; i++) _b64lookup[_b64chars.charCodeAt(i)] = i;

    globalThis.btoa = function(str) {
        let result = '';
        const len = str.length;
        for (let i = 0; i < len; i += 3) {
            const a = str.charCodeAt(i);
            const b = i + 1 < len ? str.charCodeAt(i + 1) : 0;
            const c = i + 2 < len ? str.charCodeAt(i + 2) : 0;
            const triple = (a << 16) | (b << 8) | c;
            result += _b64chars[(triple >> 18) & 0x3F];
            result += _b64chars[(triple >> 12) & 0x3F];
            result += i + 1 < len ? _b64chars[(triple >> 6) & 0x3F] : '=';
            result += i + 2 < len ? _b64chars[triple & 0x3F] : '=';
        }
        return result;
    };

    globalThis.atob = function(str) {
        str = str.replace(/=+$/, '');
        let result = '';
        let i = 0;
        while (i < str.length) {
            const a = _b64lookup[str.charCodeAt(i++)];
            const b = _b64lookup[str.charCodeAt(i++)];
            const c = _b64lookup[str.charCodeAt(i++)];
            const d = _b64lookup[str.charCodeAt(i++)];
            const triple = (a << 18) | (b << 12) | (c << 6) | d;
            result += String.fromCharCode((triple >> 16) & 0xFF);
            if (c !== undefined) result += String.fromCharCode((triple >> 8) & 0xFF);
            if (d !== undefined) result += String.fromCharCode(triple & 0xFF);
        }
        return result;
    };
}

// ============================================================
// Internal helpers
// ============================================================

const _SLASH = '/';
const _DOT = '.';

function _errnoToCode(errno) {
    const map = {
        1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR',
        5: 'EIO', 9: 'EBADF', 11: 'EAGAIN', 12: 'ENOMEM',
        13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 21: 'EISDIR',
        22: 'EINVAL', 23: 'ENFILE', 24: 'EMFILE', 28: 'ENOSPC',
        30: 'EROFS', 31: 'EMLINK', 32: 'EPIPE', 36: 'ENAMETOOLONG',
        39: 'ENOTEMPTY', 40: 'ELOOP', 61: 'ENODATA', 95: 'ENOTSUP',
        98: 'EADDRINUSE', 99: 'EADDRNOTAVAIL', 101: 'ENETUNREACH',
        107: 'ENOTCONN', 110: 'ETIMEDOUT',
        111: 'ECONNREFUSED', 104: 'ECONNRESET',
    };
    return map[Math.abs(errno)] || `E${Math.abs(errno)}`;
}

function _makeNodeError(message, code, errno, syscall, path) {
    const err = new Error(message);
    err.code = code;
    if (errno !== undefined) err.errno = -Math.abs(errno);
    if (syscall) err.syscall = syscall;
    if (path) err.path = path;
    return err;
}

function _throwErrno(errno, syscall, path) {
    const code = _errnoToCode(errno);
    const msg = `${code}: ${syscall}` + (path ? ` '${path}'` : '');
    throw _makeNodeError(msg, code, errno, syscall, path);
}

function _checkErrno(errno, syscall, path) {
    if (errno < 0) _throwErrno(-errno, syscall, path);
    if (errno !== 0) _throwErrno(errno, syscall, path);
}

// Honest throwing stub for builtin surface we expose for link-time
// completeness but have not implemented. Calling it fails loudly instead
// of silently succeeding — see docs/posix-status.md for the tracked gap.
function _notImpl(mod, name) {
    return function () {
        throw new Error(mod + '.' + name + ' is not implemented on spidermonkey-node');
    };
}

// ============================================================
// path module
// ============================================================

const path = (() => {
    const sep = '/';
    const delimiter = ':';

    function normalize(p) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        if (p.length === 0) return '.';
        const isAbsolute = p.charCodeAt(0) === 47; // '/'
        const parts = p.split('/');
        const result = [];
        for (const part of parts) {
            if (part === '' || part === '.') continue;
            if (part === '..') {
                if (result.length > 0 && result[result.length - 1] !== '..') {
                    result.pop();
                } else if (!isAbsolute) {
                    result.push('..');
                }
            } else {
                result.push(part);
            }
        }
        let out = result.join('/');
        if (isAbsolute) out = '/' + out;
        return out || (isAbsolute ? '/' : '.');
    }

    function join(...args) {
        if (args.length === 0) return '.';
        let joined = '';
        for (const arg of args) {
            if (typeof arg !== 'string') throw new TypeError('Arguments must be strings');
            if (arg.length > 0) {
                joined = joined ? joined + '/' + arg : arg;
            }
        }
        return joined ? normalize(joined) : '.';
    }

    function resolve(...args) {
        let resolved = '';
        for (let i = args.length - 1; i >= 0; i--) {
            const p = args[i];
            if (typeof p !== 'string') throw new TypeError('Arguments must be strings');
            if (p.length === 0) continue;
            resolved = p + (resolved ? '/' + resolved : '');
            if (p.charCodeAt(0) === 47) break;
        }
        if (resolved.charCodeAt(0) !== 47) {
            const [cwd] = os.getcwd();
            resolved = cwd + '/' + resolved;
        }
        return normalize(resolved);
    }

    function dirname(p) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        if (p.length === 0) return '.';
        const idx = p.lastIndexOf('/');
        if (idx === -1) return '.';
        if (idx === 0) return '/';
        return p.slice(0, idx);
    }

    function basename(p, ext) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        let base = p;
        const idx = p.lastIndexOf('/');
        if (idx !== -1) base = p.slice(idx + 1);
        if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
        return base;
    }

    function extname(p) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        const base = basename(p);
        const idx = base.lastIndexOf('.');
        if (idx <= 0) return '';
        return base.slice(idx);
    }

    function isAbsolute(p) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        return p.length > 0 && p.charCodeAt(0) === 47;
    }

    function relative(from, to) {
        from = resolve(from);
        to = resolve(to);
        if (from === to) return '';
        const fromParts = from.split('/').filter(Boolean);
        const toParts = to.split('/').filter(Boolean);
        let common = 0;
        while (common < fromParts.length && common < toParts.length &&
               fromParts[common] === toParts[common]) {
            common++;
        }
        const ups = fromParts.length - common;
        const result = [];
        for (let i = 0; i < ups; i++) result.push('..');
        for (let i = common; i < toParts.length; i++) result.push(toParts[i]);
        return result.join('/');
    }

    function parse(p) {
        const dir = dirname(p);
        const base = basename(p);
        const ext = extname(p);
        const name = ext ? base.slice(0, -ext.length) : base;
        const root = isAbsolute(p) ? '/' : '';
        return { root, dir, base, ext, name };
    }

    function format(obj) {
        const dir = obj.dir || obj.root || '';
        const base = obj.base || ((obj.name || '') + (obj.ext || ''));
        return dir ? (dir === obj.root ? dir + base : dir + '/' + base) : base;
    }

    return {
        sep, delimiter, normalize, join, resolve, dirname,
        basename, extname, isAbsolute, relative, parse, format,
        posix: null, // set below
    };
})();
path.posix = path;
// tar/cacache/minimatch read `path.win32.{sep,parse,isAbsolute}` at module init.
path.win32 = { ...path, sep: '\\' };

// ============================================================
// events module (EventEmitter)
// ============================================================

const events = (() => {
    class EventEmitter {
        constructor() {
            this._events = Object.create(null);
            this._maxListeners = EventEmitter.defaultMaxListeners;
        }

        static get defaultMaxListeners() { return 10; }
        static set defaultMaxListeners(n) { /* ignored for now */ }

        setMaxListeners(n) { this._maxListeners = n; return this; }
        getMaxListeners() { return this._maxListeners; }

        emit(event, ...args) {
            const listeners = this._events[event];
            if (!listeners || listeners.length === 0) {
                if (event === 'error') {
                    const err = args[0] instanceof Error ? args[0] : new Error('Unhandled error');
                    throw err;
                }
                return false;
            }
            const copy = listeners.slice();
            for (const { fn, once } of copy) {
                if (once) this.removeListener(event, fn);
                fn.apply(this, args);
            }
            return true;
        }

        on(event, fn) {
            if (!this._events[event]) this._events[event] = [];
            this._events[event].push({ fn, once: false });
            return this;
        }

        once(event, fn) {
            if (!this._events[event]) this._events[event] = [];
            this._events[event].push({ fn, once: true });
            return this;
        }

        off(event, fn) {
            const list = this._events[event];
            if (!list) return this;
            this._events[event] = list.filter(l => l.fn !== fn);
            return this;
        }

        removeAllListeners(event) {
            if (event) {
                delete this._events[event];
            } else {
                this._events = Object.create(null);
            }
            return this;
        }

        listeners(event) {
            return (this._events[event] || []).map(l => l.fn);
        }

        rawListeners(event) {
            return (this._events[event] || []).slice();
        }

        listenerCount(event) {
            return (this._events[event] || []).length;
        }

        eventNames() {
            return Object.keys(this._events).filter(k => this._events[k].length > 0);
        }

        prependListener(event, fn) {
            if (!this._events[event]) this._events[event] = [];
            this._events[event].unshift({ fn, once: false });
            return this;
        }

        prependOnceListener(event, fn) {
            if (!this._events[event]) this._events[event] = [];
            this._events[event].unshift({ fn, once: true });
            return this;
        }
    }

    // addListener/removeListener share function references with on/off so that
    // Minipass overriding one half and calling super.<other-half> dispatches to
    // the same body — `this.<half>` aliasing would infinite-loop.
    EventEmitter.prototype.addListener = EventEmitter.prototype.on;
    EventEmitter.prototype.removeListener = EventEmitter.prototype.off;

    // require('events') returns the EventEmitter class itself (Node compat).
    // Subclassing via `class Foo extends require('events')` only works if the
    // export IS the class — extending a function that returns `new EE()` makes
    // super() override `this`, leaving derived methods on an unused prototype.
    EventEmitter.EventEmitter = EventEmitter;
    EventEmitter.once = function(emitter, event) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                emitter.removeListener(event, onEvent);
                if (event !== 'error') emitter.removeListener('error', onError);
            };
            const onEvent = (...args) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(args);
            };
            const onError = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };
            // Use .on() plus explicit cleanup instead of emitter.once(). Some
            // npm streams cache selected metadata events and replay them from a
            // custom .on() implementation; routing events.once() through .once()
            // misses those replayed events and can leave callers hung forever.
            if (event !== 'error') emitter.on('error', onError);
            emitter.on(event, onEvent);
        });
    };
    return EventEmitter;
})();

// events.setMaxListeners(n, ...emitters) — Claude Code's undici transport
// calls this at startup to raise the default cap; forward it to each
// target emitter (or is a no-op for the process-wide default we don't
// track separately).
events.setMaxListeners = function (n, ...emitters) {
    for (const em of emitters) {
        if (em && typeof em.setMaxListeners === 'function') em.setMaxListeners(n);
    }
};

// ============================================================
// Buffer class
// ============================================================

const Buffer = (() => {
    const _encoder = new TextEncoder();
    const _decoder = new TextDecoder();

    class Buffer extends Uint8Array {
        // Static factory methods
        static alloc(size, fill, encoding) {
            const buf = new Buffer(size);
            if (fill !== undefined) {
                if (typeof fill === 'number') {
                    buf.fill(fill);
                } else if (typeof fill === 'string') {
                    const bytes = _encoder.encode(fill);
                    for (let i = 0; i < size; i++) buf[i] = bytes[i % bytes.length];
                }
            }
            return buf;
        }

        static allocUnsafe(size) {
            return new Buffer(size);
        }

        static from(value, encodingOrOffset, length) {
            if (typeof value === 'string') {
                const encoding = encodingOrOffset || 'utf8';
                if (encoding === 'hex') {
                    const bytes = [];
                    for (let i = 0; i < value.length; i += 2) {
                        bytes.push(parseInt(value.substr(i, 2), 16));
                    }
                    return new Buffer(bytes);
                }
                if (encoding === 'base64') {
                    const binary = atob(value);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    return new Buffer(bytes.buffer);
                }
                // utf8 or ascii or latin1
                return new Buffer(_encoder.encode(value));
            }
            if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
                return new Buffer(value, encodingOrOffset, length);
            }
            if (ArrayBuffer.isView(value)) {
                return new Buffer(value.buffer, value.byteOffset, value.byteLength);
            }
            if (Array.isArray(value)) {
                return new Buffer(value);
            }
            if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
                return new Buffer(value.data);
            }
            throw new TypeError('Invalid argument for Buffer.from');
        }

        static concat(list, totalLength) {
            if (totalLength === undefined) {
                totalLength = 0;
                for (const buf of list) totalLength += buf.length;
            }
            const result = Buffer.alloc(totalLength);
            let offset = 0;
            for (const buf of list) {
                const src = buf instanceof Uint8Array ? buf : Buffer.from(buf);
                result.set(src, offset);
                offset += src.length;
                if (offset >= totalLength) break;
            }
            return result;
        }

        static isBuffer(obj) {
            return obj instanceof Buffer;
        }

        static isEncoding(encoding) {
            return ['utf8', 'utf-8', 'ascii', 'latin1', 'binary',
                    'hex', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le']
                   .includes(String(encoding).toLowerCase());
        }

        static byteLength(string, encoding) {
            if (typeof string !== 'string') return string.length;
            return _encoder.encode(string).length;
        }

        static compare(a, b) {
            const len = Math.min(a.length, b.length);
            for (let i = 0; i < len; i++) {
                if (a[i] < b[i]) return -1;
                if (a[i] > b[i]) return 1;
            }
            if (a.length < b.length) return -1;
            if (a.length > b.length) return 1;
            return 0;
        }

        toString(encoding, start, end) {
            encoding = (encoding || 'utf8').toLowerCase();
            start = start || 0;
            end = end === undefined ? this.length : end;
            const slice = this.subarray(start, end);

            if (encoding === 'hex') {
                let hex = '';
                for (let i = 0; i < slice.length; i++) {
                    hex += slice[i].toString(16).padStart(2, '0');
                }
                return hex;
            }
            if (encoding === 'base64') {
                let binary = '';
                for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
                return btoa(binary);
            }
            return _decoder.decode(slice);
        }

        write(string, offset, length, encoding) {
            if (typeof offset === 'string') { encoding = offset; offset = 0; length = this.length; }
            else if (typeof length === 'string') { encoding = length; length = this.length - (offset || 0); }
            offset = offset || 0;
            length = length === undefined ? this.length - offset : length;
            const bytes = _encoder.encode(string);
            const toWrite = Math.min(bytes.length, length, this.length - offset);
            for (let i = 0; i < toWrite; i++) this[offset + i] = bytes[i];
            return toWrite;
        }

        toJSON() {
            return { type: 'Buffer', data: Array.from(this) };
        }

        equals(other) {
            return Buffer.compare(this, other) === 0;
        }

        compare(other, targetStart, targetEnd, sourceStart, sourceEnd) {
            const src = this.subarray(sourceStart || 0, sourceEnd);
            const tgt = (other instanceof Uint8Array ? other : Buffer.from(other))
                        .subarray(targetStart || 0, targetEnd);
            return Buffer.compare(src, tgt);
        }

        copy(target, targetStart, sourceStart, sourceEnd) {
            targetStart = targetStart || 0;
            sourceStart = sourceStart || 0;
            sourceEnd = sourceEnd === undefined ? this.length : sourceEnd;
            const slice = this.subarray(sourceStart, sourceEnd);
            target.set(slice, targetStart);
            return slice.length;
        }

        slice(start, end) {
            const sliced = super.subarray(start, end);
            return Object.setPrototypeOf(sliced, Buffer.prototype);
        }

        subarray(start, end) {
            const sliced = super.subarray(start, end);
            return Object.setPrototypeOf(sliced, Buffer.prototype);
        }

        indexOf(value, byteOffset, encoding) {
            byteOffset = byteOffset || 0;
            if (typeof value === 'number') {
                for (let i = byteOffset; i < this.length; i++) {
                    if (this[i] === value) return i;
                }
                return -1;
            }
            if (typeof value === 'string') value = Buffer.from(value, encoding);
            for (let i = byteOffset; i <= this.length - value.length; i++) {
                let found = true;
                for (let j = 0; j < value.length; j++) {
                    if (this[i + j] !== value[j]) { found = false; break; }
                }
                if (found) return i;
            }
            return -1;
        }

        includes(value, byteOffset, encoding) {
            return this.indexOf(value, byteOffset, encoding) !== -1;
        }

        // Read/write integers (little-endian and big-endian)
        readUInt8(offset) { return this[offset]; }
        readUInt16LE(offset) { return this[offset] | (this[offset + 1] << 8); }
        readUInt16BE(offset) { return (this[offset] << 8) | this[offset + 1]; }
        readUInt32LE(offset) { return (this[offset] | (this[offset+1] << 8) | (this[offset+2] << 16) | (this[offset+3] << 24)) >>> 0; }
        readUInt32BE(offset) { return ((this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]) >>> 0; }
        readInt8(offset) { const v = this[offset]; return v > 127 ? v - 256 : v; }
        readInt16LE(offset) { const v = this.readUInt16LE(offset); return v > 32767 ? v - 65536 : v; }
        readInt16BE(offset) { const v = this.readUInt16BE(offset); return v > 32767 ? v - 65536 : v; }
        readInt32LE(offset) { return this[offset] | (this[offset+1] << 8) | (this[offset+2] << 16) | (this[offset+3] << 24); }
        readInt32BE(offset) { return (this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]; }

        writeUInt8(value, offset) { this[offset] = value & 0xff; return offset + 1; }
        writeUInt16LE(value, offset) { this[offset] = value & 0xff; this[offset+1] = (value >> 8) & 0xff; return offset + 2; }
        writeUInt16BE(value, offset) { this[offset] = (value >> 8) & 0xff; this[offset+1] = value & 0xff; return offset + 2; }
        writeUInt32LE(value, offset) { this[offset] = value & 0xff; this[offset+1] = (value >> 8) & 0xff; this[offset+2] = (value >> 16) & 0xff; this[offset+3] = (value >> 24) & 0xff; return offset + 4; }
        writeUInt32BE(value, offset) { this[offset] = (value >> 24) & 0xff; this[offset+1] = (value >> 16) & 0xff; this[offset+2] = (value >> 8) & 0xff; this[offset+3] = value & 0xff; return offset + 4; }
        writeInt8(value, offset) { if (value < 0) value = 256 + value; return this.writeUInt8(value, offset); }
        writeInt16LE(value, offset) { if (value < 0) value = 65536 + value; return this.writeUInt16LE(value, offset); }
        writeInt16BE(value, offset) { if (value < 0) value = 65536 + value; return this.writeUInt16BE(value, offset); }
        writeInt32LE(value, offset) { if (value < 0) value = 4294967296 + value; return this.writeUInt32LE(value, offset); }
        writeInt32BE(value, offset) { if (value < 0) value = 4294967296 + value; return this.writeUInt32BE(value, offset); }

        // Float read/write via DataView
        readFloatLE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat32(offset, true); }
        readFloatBE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat32(offset, false); }
        readDoubleLE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat64(offset, true); }
        readDoubleBE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat64(offset, false); }
        writeFloatLE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, true); return offset + 4; }
        writeFloatBE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, false); return offset + 4; }
        writeDoubleLE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, true); return offset + 8; }
        writeDoubleBE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, false); return offset + 8; }
    }

    return Buffer;
})();

// ============================================================
// process module
// ============================================================

const process = (() => {
    const [cwd_val] = os.getcwd();
    let _cwd = cwd_val || '/';
    const _env = {};

    // Populate env from /proc/self/environ or common vars
    for (const key of ['HOME', 'USER', 'PATH', 'SHELL', 'TERM', 'LANG', 'PWD',
                        'TMPDIR', 'TMP', 'TEMP', 'NODE_ENV', 'NODE_PATH',
                        'NODE_DEBUG', 'NODE_OPTIONS',
                        'npm_config_cache', 'npm_config_registry',
                        'npm_config_fund', 'npm_config_audit',
                        'npm_config_progress', 'npm_config_update_notifier',
                        'NPM_CONFIG_CACHE', 'NPM_CONFIG_REGISTRY',
                        'NPM_CONFIG_FUND', 'NPM_CONFIG_AUDIT',
                        'NPM_CONFIG_PROGRESS', 'NPM_CONFIG_UPDATE_NOTIFIER']) {
        const val = std.getenv(key);
        if (val !== null && val !== undefined) _env[key] = val;
    }
    if (!_env.PATH) _env.PATH = '/usr/local/bin:/usr/bin:/bin';

    // Proxy env to catch all gets/sets
    const envProxy = new Proxy(_env, {
        get(target, prop) {
            if (typeof prop === 'symbol') return target[prop];
            // Try live lookup for unknown keys
            if (!(prop in target)) {
                const val = std.getenv(String(prop));
                if (val !== null && val !== undefined) {
                    target[prop] = val;
                    return val;
                }
            }
            return target[prop];
        },
        set(target, prop, value) {
            target[prop] = String(value);
            std.setenv(String(prop), String(value));
            return true;
        },
        deleteProperty(target, prop) {
            delete target[prop];
            std.unsetenv(String(prop));
            return true;
        },
    });

    // Create process as an EventEmitter instance without calling the class constructor
    const proc = new events.EventEmitter();

    Object.assign(proc, {
        title: 'node',
        version: 'v22.0.0', // Compatibility target
        versions: {
            node: '22.0.0',
            spidermonkey: '140.11.0esr',
            modules: '131',
            v8: '0.0.0',  // Not V8
            uv: '0.0.0',  // Not libuv
        },
        arch: 'wasm32',
        platform: 'linux', // POSIX-compatible
        env: envProxy,
        argv: [],  // Set by node-main.c
        argv0: '',
        execArgv: [],
        execPath: '/usr/bin/node',
        pid: os.getpid(),
        ppid: 0,  // Not easily available
        exitCode: 0,
        _exiting: false,

        cwd() { return _cwd; },
        chdir(dir) {
            const err = os.chdir(dir);
            if (err !== 0) _throwErrno(err, 'chdir', dir);
            const [newCwd] = os.getcwd();
            _cwd = newCwd || dir;
        },

        exit(code) {
            proc.exitCode = code !== undefined ? code : proc.exitCode;
            proc._exiting = true;
            proc.emit('exit', proc.exitCode);
            std.exit(proc.exitCode);
        },

        abort() {
            std.exit(134); // SIGABRT
        },

        kill(pid, signal) {
            signal = signal || 'SIGTERM';
            let signum;
            if (typeof signal === 'number') {
                signum = signal;
            } else {
                // Resolve against the Node os.constants.signals table (defined
                // on `nodeOs` below — the bare `os` symbol in this file is the
                // qjs:os primitives module imported at the top, which has no
                // `.constants.signals`). A bare-minimum inline fallback used
                // to silently map unknown names like 'SIGWINCH' to SIGTERM,
                // which the default-signal handler then translated into a
                // Terminate action (exit 143). Anything not in the table now
                // throws, matching Node's behaviour.
                const _sigs = nodeOs && nodeOs.constants && nodeOs.constants.signals;
                signum = (_sigs && _sigs[signal]) | 0;
                if (!signum) throw new Error("Unknown signal: " + signal);
            }
            os.kill(pid, signum);
        },

        hrtime: Object.assign(function hrtime(prev) {
            const now = _hrtimeNow();
            if (prev) {
                let sec = now[0] - prev[0];
                let nsec = now[1] - prev[1];
                if (nsec < 0) { sec--; nsec += 1e9; }
                return [sec, nsec];
            }
            return now;
        }, {
            bigint() {
                const [sec, nsec] = _hrtimeNow();
                return BigInt(sec) * 1000000000n + BigInt(nsec);
            }
        }),

        memoryUsage() {
            return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
        },

        cpuUsage(prev) {
            const usage = { user: 0, system: 0 };
            if (prev) {
                usage.user -= prev.user;
                usage.system -= prev.system;
            }
            return usage;
        },

        nextTick(fn, ...args) {
            // This compatibility layer does not have a real nextTick queue,
            // but queueMicrotask preserves the ordering expected here.
            queueMicrotask(() => fn(...args));
        },

        uptime() {
            return (Date.now() - _startTime) / 1000;
        },

        umask(mask) {
            // TODO: implement via syscall
            if (mask !== undefined) return 0o022;
            return 0o022;
        },

        features: {},
        config: { variables: {} },
        release: { name: 'node' },
        moduleLoadList: [],
        // npm-install-checks reads `process.report.getReport().sharedObjects`
        // to detect glibc-vs-musl when /usr/bin/ldd is unavailable.
        report: {
            getReport() { return { sharedObjects: ['/lib/ld-musl-wasm32.so.1'] }; },
        },
    });

    // Define stdout/stderr/stdin as lazy getters (can't be in Object.assign
    // because assign evaluates getters immediately)
    Object.defineProperties(proc, {
        stdout: { get() { return _createWriteStream(1); }, configurable: true },
        stderr: { get() { return _createWriteStream(2); }, configurable: true },
        stdin: { get() { return _createReadStream(0); }, configurable: true },
    });

    return proc;
})();

const _startTime = Date.now();

function _hrtimeNow() {
    const ms = Date.now();
    return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
}

// Lazy stream creation for stdout/stderr/stdin
let _stdout, _stderr, _stdin;
// Per-fd cached winsize. Refreshed lazily on first read and on SIGWINCH.
// Caching matters: ink reads process.stdout.columns hundreds of times per
// render and routes the result into cursor-position math; an ioctl per read
// is both slow and risks racing the kernel's PTY state during a resize.
const _wsCache = new Map();
function _refreshWs(fd) {
    const ws = os.ttyGetWinSize(fd);
    if (ws) _wsCache.set(fd, ws);
    return _wsCache.get(fd) || null;
}

function _writeControl(stream, seq, cb) {
    stream.write(seq);
    if (typeof cb === 'function') cb();
    return true;
}

function _cursorTo(stream, x, y, cb) {
    if (typeof y === 'function') { cb = y; y = undefined; }
    x = Math.max(0, x | 0);
    if (typeof y === 'number') {
        return _writeControl(stream, `\x1b[${Math.max(0, y | 0) + 1};${x + 1}H`, cb);
    }
    return _writeControl(stream, `\x1b[${x + 1}G`, cb);
}

function _moveCursor(stream, dx, dy, cb) {
    let seq = '';
    dx = dx | 0;
    dy = dy | 0;
    if (dx < 0) seq += `\x1b[${-dx}D`;
    else if (dx > 0) seq += `\x1b[${dx}C`;
    if (dy < 0) seq += `\x1b[${-dy}A`;
    else if (dy > 0) seq += `\x1b[${dy}B`;
    return _writeControl(stream, seq, cb);
}

function _clearLine(stream, dir, cb) {
    if (typeof dir === 'function') { cb = dir; dir = 0; }
    const mode = dir < 0 ? 1 : dir > 0 ? 0 : 2;
    return _writeControl(stream, `\x1b[${mode}K`, cb);
}

function _clearScreenDown(stream, cb) {
    return _writeControl(stream, '\x1b[0J', cb);
}

function _createWriteStream(fd) {
    if (fd === 1 && _stdout) return _stdout;
    if (fd === 2 && _stderr) return _stderr;
    const listeners = new Map();
    const s = {
        fd,
        writable: true,
        write(data, encoding, cb) {
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (typeof data === 'string') {
                const sink = fd === 2 ? std.err : std.out;
                sink.puts(data);
                sink.flush();
            } else if (data instanceof Uint8Array) {
                os.write(fd, data.buffer, data.byteOffset, data.byteLength);
            }
            if (cb) cb();
            return true;
        },
        end(data, encoding, cb) {
            if (data) s.write(data, encoding);
            if (typeof cb === 'function') cb();
        },
        on(event, cb) {
            if (typeof cb !== 'function') return s;
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(cb);
            return s;
        },
        addListener(event, cb) { return s.on(event, cb); },
        once(event, cb) {
            const wrap = (...a) => { s.removeListener(event, wrap); cb(...a); };
            return s.on(event, wrap);
        },
        emit(event, ...args) {
            const arr = listeners.get(event);
            if (!arr || arr.length === 0) return false;
            for (const cb of arr.slice()) {
                try { cb(...args); } catch (e) { Promise.reject(e); }
            }
            return true;
        },
        removeListener(event, cb) {
            const arr = listeners.get(event);
            if (!arr) return s;
            const i = arr.indexOf(cb);
            if (i >= 0) arr.splice(i, 1);
            return s;
        },
        off(event, cb) { return s.removeListener(event, cb); },
        removeAllListeners(event) {
            if (event === undefined) listeners.clear();
            else listeners.delete(event);
            return s;
        },
        listenerCount(event) {
            const arr = listeners.get(event);
            return arr ? arr.length : 0;
        },
        cursorTo(x, y, cb) { return _cursorTo(s, x, y, cb); },
        moveCursor(dx, dy, cb) { return _moveCursor(s, dx, dy, cb); },
        clearLine(dir, cb) { return _clearLine(s, dir, cb); },
        clearScreenDown(cb) { return _clearScreenDown(s, cb); },
        isTTY: os.isatty(fd),
    };
    Object.defineProperties(s, {
        // Cached TIOCGWINSZ-backed accessors. TUIs (ink, blessed, pi-coding-agent)
        // read these hundreds of times per render and route the result into
        // cursor-position math; an ioctl per read is slow and risks racing
        // the kernel's PTY state during resize. The cache is invalidated by
        // the SIGWINCH handler below.
        columns: {
            get() {
                const ws = _wsCache.get(fd) || _refreshWs(fd);
                return ws ? ws[0] : 80;
            },
            enumerable: true,
            configurable: true,
        },
        rows: {
            get() {
                const ws = _wsCache.get(fd) || _refreshWs(fd);
                return ws ? ws[1] : 24;
            },
            enumerable: true,
            configurable: true,
        },
    });
    if (fd === 1) _stdout = s;
    if (fd === 2) _stderr = s;
    return s;
}

// SIGWINCH (signum 28 on Linux). The kernel raises it on every kernel_pty_set_winsize
// call; without a JS-side handler the default action is "ignore" and ink/blessed/pi
// keep using a stale cached columns/rows, so incremental redraws clear the wrong
// number of rows and old frames stack on top of new ones. The adapter surface
// does not expose SIGWINCH via os.SIG* constants, so call os.signal with the raw signum.
try {
    os.signal(28, () => {
        // Refresh the cache so the next process.stdout.columns read returns the
        // post-resize value.
        _refreshWs(1);
        _refreshWs(2);
        // Notify subscribers (ink/blessed read this and re-render at the new size).
        if (_stdout) _stdout.emit('resize');
        if (_stderr) _stderr.emit('resize');
    });
} catch (_) {
    // Some environments (WASI builds, tests) may not support os.signal; if it
    // throws, fall back to the lazy-cache-only path. Apps that don't read on
    // resize still render correctly at whatever size was current on first read.
}

function _createReadStream(fd) {
    if (_stdin) return _stdin;
    // Real readable-stream surface for stdin. TUI libraries (readline,
    // prompts, etc.) call resume()+on('data',cb) and expect bytes from fd 0.
    // The previous stub turned every method into a no-op, so TUIs rendered
    // their initial frame and the runtime loop exited immediately because no
    // jobs/timers/watches were live. Wiring through os.setReadHandler keeps
    // the loop alive and delivers keystrokes.
    const listeners = new Map(); // event → cb[]
    const READ_BUF = new ArrayBuffer(4096);
    const READ_VIEW = new Uint8Array(READ_BUF);
    let watchInstalled = false;
    let ended = false;
    let _encoding = null;
    let _decoder = null;

    function _emit(event, ...args) {
        const arr = listeners.get(event);
        if (!arr || arr.length === 0) return false;
        for (const cb of arr.slice()) {
            try { cb(...args); }
            catch (e) { Promise.reject(e); }
        }
        return true;
    }

    function _onReadable() {
        let n;
        try { n = os.read(fd, READ_BUF, 0, READ_VIEW.byteLength); }
        catch (e) { _emit('error', e); return; }
        if (n <= 0) {
            // EOF (or unexpected) → stop pumping and emit end.
            ended = true;
            _uninstall();
            _emit('end');
            _emit('close');
            return;
        }
        const slice = READ_VIEW.subarray(0, n);
        if (_encoding === 'utf8' || _encoding === 'utf-8') {
            if (!_decoder) _decoder = new TextDecoder('utf-8', { fatal: false });
            _emit('data', _decoder.decode(slice, { stream: true }));
        } else {
            const copy = new Uint8Array(n);
            copy.set(slice);
            _emit('data', copy);
        }
    }

    function _install() {
        if (watchInstalled || ended) return;
        os.setReadHandler(fd, _onReadable);
        watchInstalled = true;
    }

    function _uninstall() {
        if (!watchInstalled) return;
        os.setReadHandler(fd, null);
        watchInstalled = false;
    }

    const s = {
        fd,
        readable: true,
        isTTY: os.isatty(fd),
        isRaw: false,
        read() { return null; },
        on(event, cb) {
            if (typeof cb !== 'function') return s;
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(cb);
            if (event === 'data') _install();
            return s;
        },
        addListener(event, cb) { return s.on(event, cb); },
        once(event, cb) {
            const wrap = (...a) => { s.removeListener(event, wrap); cb(...a); };
            return s.on(event, wrap);
        },
        emit(event, ...args) { return _emit(event, ...args); },
        removeListener(event, cb) {
            const arr = listeners.get(event);
            if (!arr) return s;
            const i = arr.indexOf(cb);
            if (i >= 0) arr.splice(i, 1);
            return s;
        },
        off(event, cb) { return s.removeListener(event, cb); },
        removeAllListeners(event) {
            if (event === undefined) listeners.clear();
            else listeners.delete(event);
            return s;
        },
        listenerCount(event) {
            const arr = listeners.get(event);
            return arr ? arr.length : 0;
        },
        resume() { _install(); return s; },
        pause() { _uninstall(); return s; },
        pipe(dest) { return dest; },
        unpipe() { return s; },
        setEncoding(enc) {
            _encoding = enc;
            s._encoding = enc;
            if (enc !== 'utf8' && enc !== 'utf-8') _decoder = null;
            return s;
        },
        setRawMode(raw) {
            // Real Node's process.stdin.setRawMode flips the TTY via
            // tcsetattr (clears ICANON/ECHO/ICRNL/OPOST, sets VMIN=1/VTIME=0).
            // TUIs depend on this: without it, ICRNL turns Enter `\r` into
            // `\n`, ICANON line-buffers input until Enter, and the kernel
            // double-echoes. See node-native.c for the tcsetattr plumbing.
            const want = !!raw;
            if (s.isTTY && typeof _nodeNative.setRawMode === 'function') {
                _nodeNative.setRawMode(fd, want);
            }
            s.isRaw = want;
            return s;
        },
        unref() { return s; },
        ref() { return s; },
        destroy() { _uninstall(); listeners.clear(); return s; },
    };
    _stdin = s;
    return s;
}

// ============================================================
// fs module
// ============================================================

const fs = (() => {
    const constants = {
        O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0o100,
        O_EXCL: 0o200, O_TRUNC: 0o1000, O_APPEND: 0o2000,
        O_DIRECTORY: 0o200000, O_NOFOLLOW: 0o400000,
        S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o40000,
        S_IFCHR: 0o20000, S_IFBLK: 0o60000, S_IFIFO: 0o10000,
        S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
        S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
        S_IRWXG: 0o70, S_IRGRP: 0o40, S_IWGRP: 0o20, S_IXGRP: 0o10,
        S_IRWXO: 0o7, S_IROTH: 0o4, S_IWOTH: 0o2, S_IXOTH: 0o1,
        F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
        COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2,
    };

    class Stats {
        constructor(st) {
            this.dev = st.dev || 0;
            this.ino = st.ino || 0;
            this.mode = st.mode || 0;
            this.nlink = st.nlink || 0;
            this.uid = st.uid || 0;
            this.gid = st.gid || 0;
            this.rdev = st.rdev || 0;
            this.size = st.size || 0;
            this.blksize = st.blocks ? 512 : 4096;
            this.blocks = st.blocks || 0;
            this.atimeMs = (st.atime || 0) * 1000;
            this.mtimeMs = (st.mtime || 0) * 1000;
            this.ctimeMs = (st.ctime || 0) * 1000;
            this.birthtimeMs = this.ctimeMs;
            this.atime = new Date(this.atimeMs);
            this.mtime = new Date(this.mtimeMs);
            this.ctime = new Date(this.ctimeMs);
            this.birthtime = new Date(this.birthtimeMs);
        }
        isFile() { return (this.mode & constants.S_IFMT) === constants.S_IFREG; }
        isDirectory() { return (this.mode & constants.S_IFMT) === constants.S_IFDIR; }
        isSymbolicLink() { return (this.mode & constants.S_IFMT) === constants.S_IFLNK; }
        isBlockDevice() { return (this.mode & constants.S_IFMT) === constants.S_IFBLK; }
        isCharacterDevice() { return (this.mode & constants.S_IFMT) === constants.S_IFCHR; }
        isFIFO() { return (this.mode & constants.S_IFMT) === constants.S_IFIFO; }
        isSocket() { return (this.mode & constants.S_IFMT) === constants.S_IFSOCK; }
    }

    class Dirent {
        constructor(name, type) {
            this.name = name;
            this._type = type;
        }
        isFile() { return this._type === 'file'; }
        isDirectory() { return this._type === 'directory'; }
        isSymbolicLink() { return this._type === 'symlink'; }
        isBlockDevice() { return false; }
        isCharacterDevice() { return false; }
        isFIFO() { return false; }
        isSocket() { return false; }
    }

    function _pathToString(p) {
        if (typeof p === 'string') return p;
        if (p instanceof URL) return p.pathname;
        if (Buffer.isBuffer(p)) return p.toString();
        throw new TypeError('path must be a string, Buffer, or URL');
    }

    function _flagsToMode(flags) {
        if (typeof flags === 'number') return flags;
        const map = {
            'r': os.O_RDONLY,
            'r+': os.O_RDWR,
            'w': os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            'w+': os.O_RDWR | os.O_CREAT | os.O_TRUNC,
            'a': os.O_WRONLY | os.O_CREAT | os.O_APPEND,
            'a+': os.O_RDWR | os.O_CREAT | os.O_APPEND,
            'wx': os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_EXCL,
            'wx+': os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_EXCL,
            'ax': os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_EXCL,
            'ax+': os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_EXCL,
        };
        return map[flags] ?? os.O_RDONLY;
    }

    function existsSync(filepath) {
        const [, err] = os.stat(_pathToString(filepath));
        return err === 0;
    }

    function statSync(filepath, options) {
        const p = _pathToString(filepath);
        const [st, err] = os.stat(p);
        if (err !== 0) _throwErrno(-err, 'stat', p);
        const stats = new Stats(st);
        if (options && options.bigint) {
            // TODO: bigint stat
        }
        return stats;
    }

    function lstatSync(filepath, options) {
        const p = _pathToString(filepath);
        const [st, err] = os.lstat(p);
        if (err !== 0) _throwErrno(-err, 'lstat', p);
        return new Stats(st);
    }

    function readFileSync(filepath, options) {
        const p = _pathToString(filepath);
        let encoding = null;
        if (typeof options === 'string') encoding = options;
        else if (options && options.encoding) encoding = options.encoding;

        const f = std.open(p, 'rb');
        if (!f) {
            _throwErrno(2, 'open', p); // ENOENT
        }
        f.seek(0, std.SEEK_END);
        const size = f.tell();
        f.seek(0, std.SEEK_SET);
        const buf = new Uint8Array(size);
        f.read(buf.buffer, 0, size);
        f.close();

        if (encoding) {
            return Buffer.from(buf).toString(encoding);
        }
        return Buffer.from(buf);
    }

    function writeFileSync(filepath, data, options) {
        const p = _pathToString(filepath);
        let encoding = 'utf8';
        let mode = 0o666;
        let flag = 'w';
        if (typeof options === 'string') encoding = options;
        else if (options) {
            if (options.encoding) encoding = options.encoding;
            if (options.mode) mode = options.mode;
            if (options.flag) flag = options.flag;
        }

        const flags = _flagsToMode(flag);
        const fd = os.open(p, flags, mode);
        if (fd < 0) _throwErrno(-fd, 'open', p);

        let buf;
        if (typeof data === 'string') {
            buf = new TextEncoder().encode(data);
        } else if (data instanceof Uint8Array) {
            buf = data;
        } else {
            buf = new TextEncoder().encode(String(data));
        }
        os.write(fd, buf.buffer, buf.byteOffset, buf.byteLength);
        os.close(fd);
    }

    function appendFileSync(filepath, data, options) {
        const opts = typeof options === 'string' ? { encoding: options } : (options || {});
        opts.flag = opts.flag || 'a';
        writeFileSync(filepath, data, opts);
    }

    function readdirSync(dirpath, options) {
        const p = _pathToString(dirpath);
        const [entries, err] = os.readdir(p);
        if (err !== 0) _throwErrno(-err, 'scandir', p);

        const withFileTypes = options && options.withFileTypes;
        const result = [];
        for (const name of entries) {
            if (name === '.' || name === '..') continue;
            if (withFileTypes) {
                const fullPath = p.endsWith('/') ? p + name : p + '/' + name;
                const [st, serr] = os.lstat(fullPath);
                let type = 'file';
                if (serr === 0) {
                    if ((st.mode & constants.S_IFMT) === constants.S_IFDIR) type = 'directory';
                    else if ((st.mode & constants.S_IFMT) === constants.S_IFLNK) type = 'symlink';
                }
                result.push(new Dirent(name, type));
            } else {
                result.push(name);
            }
        }
        return result;
    }

    function mkdirSync(dirpath, options) {
        const p = _pathToString(dirpath);
        const recursive = options && options.recursive;
        const mode = (options && options.mode) || 0o777;

        if (recursive) {
            const parts = p.split('/').filter(Boolean);
            let current = p.startsWith('/') ? '' : '.';
            for (const part of parts) {
                current += '/' + part;
                const [, err] = os.stat(current);
                if (err !== 0) {
                    const mkErr = os.mkdir(current, mode);
                    if (mkErr !== 0 && mkErr !== -17) { // not EEXIST
                        _throwErrno(-mkErr, 'mkdir', current);
                    }
                }
            }
            return p;
        }
        const err = os.mkdir(p, mode);
        if (err !== 0) _throwErrno(-err, 'mkdir', p);
    }

    function rmdirSync(dirpath, options) {
        const p = _pathToString(dirpath);
        const err = os.remove(p);
        if (err !== 0) _throwErrno(-err, 'rmdir', p);
    }

    // fs.rm: cacache cleans tmp dirs after content writes; tar uses it too.
    // force=true silences ENOENT.
    function rmSync(targetPath, options) {
        const opts = options || {};
        const recursive = opts.recursive === true;
        const force = opts.force === true;
        const p = _pathToString(targetPath);
        const [st, statErr] = os.lstat(p);
        if (statErr !== 0) {
            if (force) return;
            _throwErrno(statErr, 'lstat', p);
        }
        const isDir = (st.mode & constants.S_IFMT) === constants.S_IFDIR;
        const isSymlink = (st.mode & constants.S_IFMT) === constants.S_IFLNK;
        if (isDir && !isSymlink) {
            if (recursive) {
                const [entries, dirErr] = os.readdir(p);
                if (dirErr === 0) {
                    for (const name of entries) {
                        if (name === '.' || name === '..') continue;
                        const child = p.endsWith('/') ? p + name : p + '/' + name;
                        rmSync(child, opts);
                    }
                }
            }
            const err = os.remove(p);
            if (err !== 0 && !force) _throwErrno(err < 0 ? -err : err, 'rmdir', p);
        } else {
            const err = os.remove(p);
            if (err !== 0 && !force) _throwErrno(err < 0 ? -err : err, 'unlink', p);
        }
    }

    function unlinkSync(filepath) {
        const p = _pathToString(filepath);
        const err = os.remove(p);
        if (err !== 0) _throwErrno(-err, 'unlink', p);
    }

    function renameSync(oldPath, newPath) {
        const o = _pathToString(oldPath);
        const n = _pathToString(newPath);
        const err = os.rename(o, n);
        if (err !== 0) _throwErrno(-err, 'rename', o);
    }

    function copyFileSync(src, dest, mode) {
        const data = readFileSync(src);
        if (mode && (mode & constants.COPYFILE_EXCL) && existsSync(dest)) {
            _throwErrno(17, 'copyfile', dest); // EEXIST
        }
        writeFileSync(dest, data);
    }

    function symlinkSync(target, linkpath) {
        const err = os.symlink(_pathToString(target), _pathToString(linkpath));
        if (err !== 0) _throwErrno(-err, 'symlink', _pathToString(linkpath));
    }

    function readlinkSync(filepath) {
        const p = _pathToString(filepath);
        const [target, err] = os.readlink(p);
        if (err !== 0) _throwErrno(-err, 'readlink', p);
        return target;
    }

    function realpathSync(filepath) {
        const p = _pathToString(filepath);
        const [result, err] = os.realpath(p);
        if (err !== 0) _throwErrno(-err, 'realpath', p);
        return result;
    }

    function chmodSync(filepath, mode) {
        const p = _pathToString(filepath);
        const [, err] = os.stat(p);
        if (err !== 0) _throwErrno(-err, 'chmod', p);
        void mode;
    }

    function chownSync(filepath, uid, gid) {
        const p = _pathToString(filepath);
        const [, err] = os.stat(p);
        if (err !== 0) _throwErrno(-err, 'chown', p);
        void uid;
        void gid;
    }

    function utimesSync(filepath, atime, mtime) {
        const p = _pathToString(filepath);
        const a = typeof atime === 'number' ? atime : atime.getTime() / 1000;
        const m = typeof mtime === 'number' ? mtime : mtime.getTime() / 1000;
        os.utimes(p, a, m);
    }

    function truncateSync(filepath, len) {
        const p = _pathToString(filepath);
        const fd = os.open(p, os.O_WRONLY);
        if (fd < 0) _throwErrno(-fd, 'open', p);
        // ftruncate not in os module — write approach
        os.close(fd);
    }

    function accessSync(filepath, mode) {
        const p = _pathToString(filepath);
        const [, err] = os.stat(p);
        if (err !== 0) _throwErrno(-err, 'access', p);
    }

    function openSync(filepath, flags, mode) {
        const p = _pathToString(filepath);
        const f = _flagsToMode(flags || 'r');
        const m = mode || 0o666;
        const fd = os.open(p, f, m);
        if (fd < 0) _throwErrno(-fd, 'open', p);
        return fd;
    }

    function closeSync(fd) {
        os.close(fd);
    }

    function readSync(fd, buffer, offset, length, position) {
        if (position !== null && position !== undefined) {
            os.seek(fd, position, std.SEEK_SET);
        }
        return os.read(fd, buffer.buffer, buffer.byteOffset + (offset || 0), length || buffer.length);
    }

    function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
        let buf;
        if (typeof data === 'string') {
            buf = new TextEncoder().encode(data);
            if (typeof offsetOrPosition === 'number') {
                os.seek(fd, offsetOrPosition, std.SEEK_SET);
            }
        } else {
            buf = data;
            const offset = offsetOrPosition || 0;
            const length = lengthOrEncoding || (buf.length - offset);
            if (position !== null && position !== undefined) {
                os.seek(fd, position, std.SEEK_SET);
            }
            return os.write(fd, buf.buffer, buf.byteOffset + offset, length);
        }
        return os.write(fd, buf.buffer, 0, buf.length);
    }

    // fs-minipass guards on `if (!fs.writev)` and falls back to
    // `process.binding('fs')` (unimplemented here) when absent.
    function writevSync(fd, buffers, position) {
        let total = 0;
        for (const buf of buffers) {
            const len = buf.byteLength ?? buf.length;
            if (!len) continue;
            const pos = position == null ? null : position + total;
            total += writeSync(fd, buf, 0, len, pos);
        }
        return total;
    }

    function fstatSync(fd) {
        // Use /proc/self/fd approach or direct syscall
        // For simplicity, use a basic approach
        const [st, err] = os.fstat ? os.fstat(fd) : [null, -1];
        if (err !== 0) _throwErrno(-err, 'fstat');
        return new Stats(st);
    }

    function fchmodSync(fd, mode) {
        fstatSync(fd);
        void mode;
    }

    function fchownSync(fd, uid, gid) {
        fstatSync(fd);
        void uid;
        void gid;
    }

    function futimesSync(fd, atime, mtime) {
        fstatSync(fd);
        void atime;
        void mtime;
    }

    class FileHandle {
        constructor(fd, path) {
            this.fd = fd;
            this._path = path;
            this._closed = false;
        }

        _assertOpen() {
            if (this._closed) {
                const err = new Error('file closed');
                err.code = 'EBADF';
                err.errno = -9;
                err.syscall = 'close';
                throw err;
            }
        }

        async close() {
            if (this._closed) return;
            closeSync(this.fd);
            this._closed = true;
        }

        async read(buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
            this._assertOpen();
            const bytesRead = readSync(this.fd, buffer, offset, length, position);
            return { bytesRead, buffer };
        }

        async write(data, offsetOrPosition, lengthOrEncoding, position) {
            this._assertOpen();
            const bytesWritten = writeSync(this.fd, data, offsetOrPosition, lengthOrEncoding, position);
            return { bytesWritten, buffer: data };
        }

        async writev(buffers, position = null) {
            this._assertOpen();
            const bytesWritten = writevSync(this.fd, buffers, position);
            return { bytesWritten, buffers };
        }

        async stat() {
            this._assertOpen();
            return fstatSync(this.fd);
        }

        async chmod(mode) {
            this._assertOpen();
            return fchmodSync(this.fd, mode);
        }

        async chown(uid, gid) {
            this._assertOpen();
            return fchownSync(this.fd, uid, gid);
        }

        async utimes(atime, mtime) {
            this._assertOpen();
            return futimesSync(this.fd, atime, mtime);
        }

        async readFile(options) {
            this._assertOpen();
            return readFileSync(this._path, options);
        }

        async writeFile(data, options) {
            this._assertOpen();
            return writeFileSync(this._path, data, options);
        }
    }

    function mkdtempSync(prefix, options) {
        const p = _pathToString(prefix);
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let attempt = 0; attempt < 64; attempt++) {
            let suffix = '';
            for (let i = 0; i < 6; i++) {
                suffix += chars[Math.floor(Math.random() * chars.length)];
            }
            const dirpath = p + suffix;
            const err = os.mkdir(dirpath, 0o700);
            if (err === 0) return dirpath;
            if (err !== -17) _throwErrno(-err, 'mkdtemp', dirpath);
        }
        _throwErrno(17, 'mkdtemp', p);
    }

    // Callback wrappers for sync filesystem helpers.
    function _callbackify(syncFn) {
        return function(...args) {
            const cb = args.pop();
            try {
                const result = syncFn(...args);
                if (typeof cb === 'function') queueMicrotask(() => cb(null, result));
            } catch (err) {
                if (typeof cb === 'function') queueMicrotask(() => cb(err));
            }
        };
    }

    const mod = {
        constants,
        Stats,
        Dirent,
        existsSync,
        statSync,
        lstatSync,
        readFileSync,
        writeFileSync,
        appendFileSync,
        readdirSync,
        mkdirSync,
        rmdirSync,
        rmSync,
        unlinkSync,
        renameSync,
        copyFileSync,
        symlinkSync,
        readlinkSync,
        realpathSync,
        chmodSync,
        chownSync,
        utimesSync,
        truncateSync,
        accessSync,
        openSync,
        closeSync,
        readSync,
        writeSync,
        writevSync,
        writev(fd, buffers, position, cb) {
            if (typeof position === 'function') { cb = position; position = null; }
            try {
                const n = writevSync(fd, buffers, position);
                queueMicrotask(() => cb(null, n, buffers));
            } catch (err) {
                queueMicrotask(() => cb(err));
            }
        },
        fstatSync,
        fchmodSync,
        fchownSync,
        futimesSync,
        // No fsync/ftruncate primitive in the qjs:os native module (see
        // truncateSync above) — honest throwing stubs, not silent no-ops.
        fsyncSync: _notImpl('fs', 'fsyncSync'),
        ftruncateSync: _notImpl('fs', 'ftruncateSync'),
        FileHandle,
        mkdtempSync,

        // Async versions
        readFile: _callbackify(readFileSync),
        writeFile: _callbackify(writeFileSync),
        appendFile: _callbackify(appendFileSync),
        readdir: _callbackify(readdirSync),
        mkdir: _callbackify(mkdirSync),
        mkdtemp: _callbackify(mkdtempSync),
        rmdir: _callbackify(rmdirSync),
        unlink: _callbackify(unlinkSync),
        rename: _callbackify(renameSync),
        copyFile: _callbackify(copyFileSync),
        symlink: _callbackify(symlinkSync),
        readlink: _callbackify(readlinkSync),
        realpath: _callbackify(realpathSync),
        chmod: _callbackify(chmodSync),
        chown: _callbackify(chownSync),
        utimes: _callbackify(utimesSync),
        stat: _callbackify(statSync),
        lstat: _callbackify(lstatSync),
        access: _callbackify(accessSync),
        rm: _callbackify(rmSync),
        exists(filepath, cb) {
            cb(existsSync(filepath));
        },
        open: _callbackify(openSync),
        close: _callbackify(closeSync),
        fstat: _callbackify(fstatSync),
        fchmod: _callbackify(fchmodSync),
        fchown: _callbackify(fchownSync),
        futimes: _callbackify(futimesSync),
        read(fd, buffer, offset, length, position, cb) {
            try {
                const n = readSync(fd, buffer, offset, length, position);
                queueMicrotask(() => cb(null, n, buffer));
            } catch (err) {
                queueMicrotask(() => cb(err));
            }
        },
        write(fd, data, ...rest) {
            const cb = rest.pop();
            try {
                const n = writeSync(fd, data, ...rest);
                queueMicrotask(() => cb(null, n));
            } catch (err) {
                queueMicrotask(() => cb(err));
            }
        },

        createReadStream(filepath, options) {
            const data = readFileSync(filepath, options);
            // Return a minimal readable stream
            return {
                data,
                on(ev, fn) {
                    if (ev === 'data') queueMicrotask(() => fn(data));
                    if (ev === 'end') queueMicrotask(() => fn());
                    return this;
                },
                pipe(dest) {
                    dest.write(data);
                    dest.end();
                    return dest;
                },
            };
        },

        createWriteStream(filepath, options) {
            const chunks = [];
            return {
                writable: true,
                write(data, encoding, cb) {
                    chunks.push(typeof data === 'string' ? Buffer.from(data, encoding) : data);
                    if (typeof cb === 'function') cb();
                    return true;
                },
                end(data, encoding, cb) {
                    if (data) this.write(data, encoding);
                    writeFileSync(filepath, Buffer.concat(chunks));
                    if (typeof cb === 'function') cb();
                },
                on() { return this; },
            };
        },

        // No filesystem-watch primitive in our wasm sysroot — return an
        // inert FSWatcher so callers can listen() and close() without
        // exploding. CLI tools that call fs.watch for live updates simply
        // won't get them, which is fine for one-shot invocations.
        watch(_path, _options, listener) {
            const w = {
                on() { return this; },
                once() { return this; },
                addListener() { return this; },
                removeListener() { return this; },
                off() { return this; },
                close() {},
                ref() { return this; },
                unref() { return this; },
            };
            if (typeof _options === 'function') listener = _options;
            // listener is never called, since we don't observe changes.
            return w;
        },
        watchFile() {},
        unwatchFile() {},
    };

    // fs.promises
    mod.promises = {};
    for (const key of Object.keys(mod)) {
        if (key.endsWith('Sync') || key === 'constants' || key === 'Stats' ||
            key === 'Dirent' || key === 'promises' || key === 'createReadStream' ||
            key === 'createWriteStream') continue;
        const syncKey = key + 'Sync';
        if (mod[syncKey]) {
            mod.promises[key] = async function(...args) {
                return mod[syncKey](...args);
            };
        }
    }
    mod.promises.readFile = async (p, o) => readFileSync(p, o);
    mod.promises.writeFile = async (p, d, o) => writeFileSync(p, d, o);
    mod.promises.mkdir = async (p, o) => mkdirSync(p, o);
    mod.promises.mkdtemp = async (p, o) => mkdtempSync(p, o);
    mod.promises.readdir = async (p, o) => readdirSync(p, o);
    mod.promises.stat = async (p, o) => statSync(p, o);
    mod.promises.lstat = async (p, o) => lstatSync(p, o);
    mod.promises.access = async (p, m) => accessSync(p, m);
    mod.promises.unlink = async (p) => unlinkSync(p);
    mod.promises.rmdir = async (p, o) => rmdirSync(p, o);
    mod.promises.rename = async (o, n) => renameSync(o, n);
    mod.promises.copyFile = async (s, d, m) => copyFileSync(s, d, m);
    mod.promises.symlink = async (t, p) => symlinkSync(t, p);
    mod.promises.readlink = async (p) => readlinkSync(p);
    mod.promises.realpath = async (p) => realpathSync(p);
    mod.promises.chmod = async (p, m) => chmodSync(p, m);
    mod.promises.chown = async (p, u, g) => chownSync(p, u, g);
    mod.promises.utimes = async (p, a, m) => utimesSync(p, a, m);
    mod.promises.fstat = async (fd) => fstatSync(fd);
    mod.promises.fchmod = async (fd, m) => fchmodSync(fd, m);
    mod.promises.fchown = async (fd, u, g) => fchownSync(fd, u, g);
    mod.promises.futimes = async (fd, a, m) => futimesSync(fd, a, m);
    mod.promises.open = async (p, flags, mode) => new FileHandle(openSync(p, flags, mode), _pathToString(p));
    mod.promises.constants = constants;
    // Throwing stubs: link-time completeness for the Claude Code import
    // surface without a real implementation. See docs/posix-status.md.
    mod.promises.link = _notImpl('fs/promises', 'link');
    mod.promises.lutimes = _notImpl('fs/promises', 'lutimes');
    mod.promises.opendir = _notImpl('fs/promises', 'opendir');
    mod.promises.statfs = _notImpl('fs/promises', 'statfs');

    return mod;
})();

// ============================================================
// os module (Node.js)
// ============================================================

const nodeOs = (() => {
    const [cwd_val] = os.getcwd();
    return {
        EOL: '\n',
        arch() { return 'wasm32'; },
        platform() { return 'linux'; },
        type() { return 'Linux'; },
        release() { return '6.0.0-wasm'; },
        hostname() {
            try {
                const f = std.open('/etc/hostname', 'r');
                if (f) {
                    const name = f.getline();
                    f.close();
                    return name ? name.trim() : 'localhost';
                }
            } catch {}
            return 'localhost';
        },
        homedir() { return std.getenv('HOME') || '/root'; },
        tmpdir() { return std.getenv('TMPDIR') || '/tmp'; },
        cpus() { return [{ model: 'wasm32', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }]; },
        totalmem() { return 1073741824; }, // 1GB
        freemem() { return 536870912; }, // 512MB
        loadavg() { return [0, 0, 0]; },
        uptime() { return (Date.now() - _startTime) / 1000; },
        networkInterfaces() { return {}; },
        userInfo() {
            return {
                uid: 0, gid: 0,
                username: std.getenv('USER') || 'root',
                homedir: std.getenv('HOME') || '/root',
                shell: std.getenv('SHELL') || '/bin/sh',
            };
        },
        endianness() { return 'LE'; },
        constants: {
            signals: {
                SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4,
                SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
                SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
                SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17,
                SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
                SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25,
                SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
                SIGPWR: 30, SIGSYS: 31,
            },
            errno: {
                EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4,
                EIO: 5, EBADF: 9, EAGAIN: 11, ENOMEM: 12,
                EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21,
                EINVAL: 22,
            },
        },
    };
})();

nodeOs.availableParallelism = function () {
    try { return Math.max(1, (nodeOs.cpus && nodeOs.cpus().length) || 1); }
    catch (_) { return 1; }
};
nodeOs.devNull = '/dev/null';
nodeOs.version = function () { return ''; };
nodeOs.getPriority = function () { return 0; };
nodeOs.setPriority = function () { /* no-op */ };

// ============================================================
// util module
// ============================================================

const util = (() => {
    function format(fmt, ...args) {
        if (typeof fmt !== 'string') {
            return [fmt, ...args].map(a => inspect(a)).join(' ');
        }
        let i = 0;
        return fmt.replace(/%[sdifjoO%]/g, (match) => {
            if (match === '%%') return '%';
            if (i >= args.length) return match;
            const arg = args[i++];
            switch (match) {
                case '%s': return String(arg);
                case '%d': return Number(arg).toString();
                case '%i': return parseInt(arg).toString();
                case '%f': return parseFloat(arg).toString();
                case '%j': try { return JSON.stringify(arg); } catch { return '[Circular]'; }
                case '%o': case '%O': return inspect(arg);
                default: return match;
            }
        }) + (i < args.length ? ' ' + args.slice(i).map(a => inspect(a)).join(' ') : '');
    }

    function inspect(obj, options) {
        if (obj === null) return 'null';
        if (obj === undefined) return 'undefined';
        if (typeof obj === 'string') return `'${obj}'`;
        if (typeof obj === 'number' || typeof obj === 'boolean' || typeof obj === 'bigint') return String(obj);
        if (typeof obj === 'symbol') return obj.toString();
        if (typeof obj === 'function') return `[Function: ${obj.name || 'anonymous'}]`;
        if (obj instanceof Date) return obj.toISOString();
        if (obj instanceof RegExp) return obj.toString();
        if (obj instanceof Error) return `${obj.name}: ${obj.message}`;
        if (Array.isArray(obj)) {
            const items = obj.map(v => inspect(v, options));
            return `[ ${items.join(', ')} ]`;
        }
        if (ArrayBuffer.isView(obj)) {
            return `<${obj.constructor.name} ${Array.from(obj.slice(0, 50)).join(' ')}${obj.length > 50 ? ' ...' : ''}>`;
        }
        try {
            const keys = Object.keys(obj);
            const pairs = keys.map(k => `${k}: ${inspect(obj[k], options)}`);
            return `{ ${pairs.join(', ')} }`;
        } catch {
            return String(obj);
        }
    }
    inspect.defaultOptions = {};

    function inherits(ctor, superCtor) {
        Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
        Object.setPrototypeOf(ctor, superCtor);
    }

    function deprecate(fn, msg) {
        let warned = false;
        return function(...args) {
            if (!warned) {
                console.error(`DeprecationWarning: ${msg}`);
                warned = true;
            }
            return fn.apply(this, args);
        };
    }

    function promisify(fn) {
        return function(...args) {
            return new Promise((resolve, reject) => {
                fn(...args, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        };
    }

    function callbackify(fn) {
        return function(...args) {
            const cb = args.pop();
            fn(...args).then(
                result => cb(null, result),
                err => cb(err)
            );
        };
    }

    function isDeepStrictEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (a === null || b === null) return false;
        if (typeof a !== 'object') return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!isDeepStrictEqual(a[key], b[key])) return false;
        }
        return true;
    }

    const types = {
        isDate(v) { return v instanceof Date; },
        isRegExp(v) { return v instanceof RegExp; },
        isNativeError(v) { return v instanceof Error; },
        isPromise(v) { return v instanceof Promise; },
        isArrayBuffer(v) { return v instanceof ArrayBuffer; },
        isTypedArray(v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); },
        isMap(v) { return v instanceof Map; },
        isSet(v) { return v instanceof Set; },
        isWeakMap(v) { return v instanceof WeakMap; },
        isWeakSet(v) { return v instanceof WeakSet; },
        isDataView(v) { return v instanceof DataView; },
        isUint8Array(v) { return v instanceof Uint8Array; },
    };

    // Node's util.formatWithOptions(opts, ...args). Our inspect() ignores
    // the options bag (no color/depth knobs yet) so this is just format()
    // with the leading options dropped — npm's lib/utils/format.js is the
    // primary caller.
    function formatWithOptions(_opts, ...args) { return format(...args); }

    // util.debuglog(set) — Node returns a stderr logger gated on the
    // NODE_DEBUG env var. undici/diagnostics calls this at module init and
    // also reads `.enabled` to short-circuit format work. We honour the env
    // var so users can opt in for debugging.
    function debuglog(set, callback) {
        const env = (process.env && process.env.NODE_DEBUG) || '';
        const enabled = env.split(/[\s,]+/).filter(Boolean).some((tok) => {
            if (tok === set) return true;
            // Wildcard match (Node supports e.g. NODE_DEBUG=undici*).
            if (tok.endsWith('*')) return set.startsWith(tok.slice(0, -1));
            return false;
        });
        const log = enabled
            ? (...args) => process.stderr.write(
                `${set.toUpperCase()} ${process.pid}: ${format(...args)}\n`)
            : () => {};
        Object.defineProperty(log, 'enabled', { value: enabled, enumerable: true });
        if (typeof callback === 'function') callback(log);
        return log;
    }

    return {
        format, formatWithOptions, inspect, inherits, deprecate, promisify, callbackify,
        isDeepStrictEqual, types,
        debuglog, debug: debuglog,
        TextDecoder, TextEncoder,
        // Deprecated but widely used
        isArray: Array.isArray,
        isBoolean: v => typeof v === 'boolean',
        isNull: v => v === null,
        isNullOrUndefined: v => v == null,
        isNumber: v => typeof v === 'number',
        isString: v => typeof v === 'string',
        isUndefined: v => v === undefined,
        isObject: v => typeof v === 'object' && v !== null,
        isFunction: v => typeof v === 'function',
        isRegExp: v => v instanceof RegExp,
    };
})();

util.stripVTControlCharacters = function (s) {
    return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
};
util.getSystemErrorName = function (err) {
    const e = Math.abs(err | 0);
    try {
        const t = (nodeOs.constants && nodeOs.constants.errno) || {};
        for (const k in t) if (Math.abs(t[k]) === e) return k;
    } catch (_) { /* fall through to generic name */ }
    return 'Unknown system error ' + err;
};
util.types.isProxy = function () { return false; };

// ============================================================
// assert module
// ============================================================

const assert = (() => {
    class AssertionError extends Error {
        constructor(options) {
            super(options.message || `${options.actual} ${options.operator} ${options.expected}`);
            this.name = 'AssertionError';
            this.actual = options.actual;
            this.expected = options.expected;
            this.operator = options.operator;
            this.generatedMessage = !options.message;
            this.code = 'ERR_ASSERTION';
        }
    }

    function _assert(value, message) {
        if (!value) {
            throw new AssertionError({ actual: value, expected: true, operator: '==', message });
        }
    }

    _assert.ok = _assert;

    _assert.equal = function(actual, expected, message) {
        if (actual != expected) {
            throw new AssertionError({ actual, expected, operator: '==', message });
        }
    };

    _assert.notEqual = function(actual, expected, message) {
        if (actual == expected) {
            throw new AssertionError({ actual, expected, operator: '!=', message });
        }
    };

    _assert.strictEqual = function(actual, expected, message) {
        if (actual !== expected) {
            throw new AssertionError({ actual, expected, operator: '===', message });
        }
    };

    _assert.notStrictEqual = function(actual, expected, message) {
        if (actual === expected) {
            throw new AssertionError({ actual, expected, operator: '!==', message });
        }
    };

    _assert.deepEqual = _assert.deepStrictEqual = function(actual, expected, message) {
        if (!util.isDeepStrictEqual(actual, expected)) {
            throw new AssertionError({ actual, expected, operator: 'deepStrictEqual', message });
        }
    };

    _assert.throws = function(fn, expected, message) {
        let threw = false;
        try { fn(); } catch (e) { threw = true; }
        if (!threw) {
            throw new AssertionError({ actual: 'no error', expected: 'error', operator: 'throws', message });
        }
    };

    _assert.doesNotThrow = function(fn, message) {
        try { fn(); } catch (e) {
            throw new AssertionError({ actual: e, expected: 'no error', operator: 'doesNotThrow', message });
        }
    };

    _assert.fail = function(message) {
        throw new AssertionError({ message: message || 'Failed', operator: 'fail' });
    };

    _assert.AssertionError = AssertionError;
    _assert.strict = _assert;

    return _assert;
})();

// ============================================================
// stream module (minimal)
// ============================================================

const stream = (() => {
    class Stream extends events.EventEmitter {
        pipe(dest, options) {
            this.on('data', (chunk) => dest.write(chunk));
            this.on('end', () => { if (!options || options.end !== false) dest.end(); });
            return dest;
        }
    }

    class Readable extends Stream {
        constructor(options) {
            super();
            this.readable = true;
            this._readableState = { ended: false, flowing: null, buffer: [], endPending: false };
            if (options && options.read) this._read = options.read;
        }
        _read(size) {}
        // Buffer until a consumer attaches: pipelines that wire up the data
        // listener one microtask later (minipass-fetch's gzip decoder)
        // otherwise drop chunks pushed synchronously from the parser.
        push(chunk) {
            if (chunk === null) {
                if (this._readableState.flowing || this.listenerCount('end') > 0
                    || this._readableState.buffer.length === 0) {
                    this._readableState.ended = true;
                    this.emit('end');
                } else {
                    this._readableState.endPending = true;
                }
                return false;
            }
            if (this._readableState.flowing || this.listenerCount('data') > 0) {
                this._readableState.flowing = true;
                this.emit('data', chunk);
            } else {
                this._readableState.buffer.push(chunk);
            }
            return true;
        }
        read(size) {
            if (this._readableState.buffer.length === 0) return null;
            return this._readableState.buffer.shift();
        }
        _drain() {
            this._readableState.flowing = true;
            const buf = this._readableState.buffer;
            this._readableState.buffer = [];
            for (const c of buf) this.emit('data', c);
            if (this._readableState.endPending) {
                this._readableState.endPending = false;
                this._readableState.ended = true;
                this.emit('end');
            }
        }
        _maybeDrain(event) {
            if (event === 'data' && this._readableState.buffer.length > 0) this._drain();
        }
        on(event, fn) { const r = super.on(event, fn); this._maybeDrain(event); return r; }
        addListener(event, fn) { const r = super.addListener(event, fn); this._maybeDrain(event); return r; }
        resume() { this._drain(); return this; }
        pause() { this._readableState.flowing = false; return this; }
        destroy() { this.emit('close'); return this; }
    }

    class Writable extends Stream {
        constructor(options) {
            super();
            this.writable = true;
            this._writableState = { ended: false };
            if (options && options.write) this._write = options.write;
        }
        _write(chunk, encoding, cb) { cb(); }
        write(chunk, encoding, cb) {
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            this._write(chunk, encoding || 'utf8', (err) => {
                if (err) this.emit('error', err);
                if (cb) cb(err);
            });
            return true;
        }
        end(chunk, encoding, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (chunk) this.write(chunk, encoding);
            this._writableState.ended = true;
            this.emit('finish');
            if (cb) cb();
            return this;
        }
        destroy() { this.emit('close'); return this; }
    }

    class Duplex extends Readable {
        constructor(options) {
            super(options);
            // Inline Writable's init — ES class constructors can't be .call()'d.
            this.writable = true;
            this._writableState = { ended: false };
            if (options && options.write) this._write = options.write;
        }
    }
    // Mixin Writable methods
    for (const method of ['write', 'end', 'destroy']) {
        if (!Duplex.prototype[method] || method === 'destroy') {
            Duplex.prototype[method] = Writable.prototype[method];
        }
    }

    class Transform extends Duplex {
        constructor(options) {
            super(options);
            if (options && options.transform) this._transform = options.transform;
        }
        _transform(chunk, encoding, cb) { cb(null, chunk); }
        _write(chunk, encoding, cb) {
            this._transform(chunk, encoding, (err, data) => {
                if (data) this.push(data);
                cb(err);
            });
        }
    }

    class PassThrough extends Transform {
        _transform(chunk, encoding, cb) { cb(null, chunk); }
    }

    // `class X extends require('stream')` (Minipass) needs the export to be
    // a constructor, so attach helpers onto Stream itself.
    Object.assign(Stream, {
        Stream, Readable, Writable, Duplex, Transform, PassThrough,
        pipeline(...streams) {
            const cb = typeof streams[streams.length - 1] === 'function' ? streams.pop() : null;
            for (let i = 0; i < streams.length - 1; i++) streams[i].pipe(streams[i + 1]);
            if (cb) {
                const last = streams[streams.length - 1];
                last.on('finish', () => cb(null));
                last.on('error', cb);
            }
            return streams[streams.length - 1];
        },
        finished(stream, cb) {
            const onEnd = () => { cleanup(); cb(null); };
            const onError = (err) => { cleanup(); cb(err); };
            const cleanup = () => {
                stream.removeListener('end', onEnd);
                stream.removeListener('finish', onEnd);
                stream.removeListener('error', onError);
            };
            stream.on('end', onEnd);
            stream.on('finish', onEnd);
            stream.on('error', onError);
        },
    });
    return Stream;
})();

// ============================================================
// url module
// ============================================================

const url = (() => {
    function parse(urlStr, parseQueryString) {
        // `new URL(URL_instance)` is valid in WHATWG; coerce to string so the
        // regex-based scanner doesn't throw "match is not a function".
        if (typeof urlStr !== 'string') urlStr = String(urlStr);
        // Simple URL parser
        const result = {
            protocol: null, slashes: false, auth: null, host: null,
            port: null, hostname: null, hash: null, search: null,
            query: null, pathname: null, path: null, href: urlStr,
        };

        let rest = urlStr;
        // Protocol
        const protoMatch = rest.match(/^([a-z][a-z0-9+.-]*):/i);
        if (protoMatch) {
            result.protocol = protoMatch[1].toLowerCase() + ':';
            rest = rest.slice(protoMatch[0].length);
            if (rest.startsWith('//')) {
                result.slashes = true;
                rest = rest.slice(2);
            }
        }

        // Hash
        const hashIdx = rest.indexOf('#');
        if (hashIdx !== -1) {
            result.hash = rest.slice(hashIdx);
            rest = rest.slice(0, hashIdx);
        }

        // Search
        const searchIdx = rest.indexOf('?');
        if (searchIdx !== -1) {
            result.search = rest.slice(searchIdx);
            result.query = result.search.slice(1);
            rest = rest.slice(0, searchIdx);
        }

        if (result.slashes) {
            // Split authority from pathname before scanning for '@' so that
            // a registry URL like `https://reg.example.org/@scope/foo` does
            // not treat the path's '@' as a userinfo delimiter.
            const slashIdx = rest.indexOf('/');
            let authority;
            if (slashIdx !== -1) {
                authority = rest.slice(0, slashIdx);
                result.pathname = rest.slice(slashIdx);
            } else {
                authority = rest;
                result.pathname = '/';
            }
            const atIdx = authority.lastIndexOf('@');
            if (atIdx !== -1) {
                result.auth = authority.slice(0, atIdx);
                authority = authority.slice(atIdx + 1);
            }
            result.host = authority;
            // Port
            const colonIdx = result.host.lastIndexOf(':');
            if (colonIdx !== -1) {
                result.port = result.host.slice(colonIdx + 1);
                result.hostname = result.host.slice(0, colonIdx);
            } else {
                result.hostname = result.host;
            }
        } else {
            result.pathname = rest;
        }

        result.path = result.pathname + (result.search || '');

        if (parseQueryString && result.query) {
            result.query = querystring.parse(result.query);
        }

        return result;
    }

    function format(urlObj) {
        let result = '';
        if (urlObj.protocol) result += urlObj.protocol + '//';
        if (urlObj.auth) result += urlObj.auth + '@';
        if (urlObj.hostname) result += urlObj.hostname;
        if (urlObj.port) result += ':' + urlObj.port;
        result += urlObj.pathname || '/';
        if (urlObj.search) result += urlObj.search;
        if (urlObj.hash) result += urlObj.hash;
        return result;
    }

    function resolve(from, to) {
        const base = parse(from);
        const rel = parse(to);
        if (rel.protocol) return to;
        const result = { ...base };
        if (rel.pathname) {
            if (rel.pathname.startsWith('/')) {
                result.pathname = rel.pathname;
            } else {
                const dir = base.pathname ? base.pathname.replace(/\/[^/]*$/, '/') : '/';
                result.pathname = path.normalize(dir + rel.pathname);
            }
        }
        result.search = rel.search;
        result.hash = rel.hash;
        return format(result);
    }

    const SearchParamsClass = class URLSearchParams {
        constructor(init) {
            this._params = {};
            if (typeof init === 'string') {
                const qs = init.startsWith('?') ? init.slice(1) : init;
                if (qs) {
                    for (const pair of qs.split('&')) {
                        const [k, v] = pair.split('=').map(decodeURIComponent);
                        this._params[k] = v;
                    }
                }
            }
        }
        get(key) { return this._params[key]; }
        set(key, val) { this._params[key] = String(val); }
        has(key) { return key in this._params; }
        append(key, val) { if (!(key in this._params)) this._params[key] = String(val); }
        delete(key) { delete this._params[key]; }
        getAll(key) { return key in this._params ? [this._params[key]] : []; }
        *entries() {
            for (const k of Object.keys(this._params)) yield [k, this._params[k]];
        }
        *keys() { for (const k of Object.keys(this._params)) yield k; }
        *values() { for (const k of Object.keys(this._params)) yield this._params[k]; }
        [Symbol.iterator]() { return this.entries(); }
        forEach(cb, thisArg) {
            for (const k of Object.keys(this._params)) cb.call(thisArg, this._params[k], k, this);
        }
        toString() {
            return Object.entries(this._params)
                .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
                .join('&');
        }
    };
    const URLClass = class URL {
        constructor(input, base) {
            const parsed = parse(base ? resolve(base, input) : input);
            // hosted-git-info wraps `new URL(...)` in try/catch and falls back
            // when the first attempt is invalid; without throwing on missing
            // protocol, the fallback never runs and downstream code reads a
            // null hostname.
            if (!parsed.protocol) throw new TypeError(`Invalid URL: ${input}`);
            Object.assign(this, parsed);
            // WHATWG URL: missing components are '' not null. minipass-fetch
            // builds `path = pathname + search` via template literal, which
            // turns null into the literal string "null".
            for (const k of ['search', 'port', 'hostname', 'host']) {
                if (this[k] == null) this[k] = '';
            }
            this.searchParams = new SearchParamsClass(this.search ? this.search.slice(1) : '');
        }
        toString() { return format(this); }
    };
    function fileURLToPath(u) {
        // Accept URL instance or string. Strip "file://", decode %XX.
        const s = typeof u === 'string' ? u : (u && u.href);
        if (typeof s !== 'string') {
            throw new TypeError('fileURLToPath: expected URL or string');
        }
        if (!s.startsWith('file://')) {
            throw new TypeError('fileURLToPath: only file: URLs supported');
        }
        let p = s.slice('file://'.length);
        // Optional host segment is dropped; only the path portion is kept.
        const slash = p.indexOf('/');
        if (slash > 0) p = p.slice(slash);
        else if (slash !== 0) p = '/' + p;
        return decodeURIComponent(p);
    }
    function pathToFileURL(p) {
        if (typeof p !== 'string') p = String(p);
        if (!p.startsWith('/')) p = '/' + p;
        return new URLClass('file://' + encodeURI(p));
    }
    return {
        parse, format, resolve,
        URL: URLClass,
        URLSearchParams: SearchParamsClass,
        fileURLToPath, pathToFileURL,
    };
})();

url.domainToASCII = function (d) { return String(d); };

// ============================================================
// querystring module
// ============================================================

const querystring = (() => {
    function parse(qs, sep, eq) {
        sep = sep || '&';
        eq = eq || '=';
        const result = {};
        if (!qs) return result;
        const pairs = qs.split(sep);
        for (const pair of pairs) {
            const idx = pair.indexOf(eq);
            const key = idx >= 0 ? decodeURIComponent(pair.slice(0, idx)) : decodeURIComponent(pair);
            const val = idx >= 0 ? decodeURIComponent(pair.slice(idx + 1)) : '';
            if (key in result) {
                if (Array.isArray(result[key])) result[key].push(val);
                else result[key] = [result[key], val];
            } else {
                result[key] = val;
            }
        }
        return result;
    }

    function stringify(obj, sep, eq) {
        sep = sep || '&';
        eq = eq || '=';
        const pairs = [];
        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (Array.isArray(val)) {
                for (const v of val) pairs.push(encodeURIComponent(key) + eq + encodeURIComponent(v));
            } else {
                pairs.push(encodeURIComponent(key) + eq + encodeURIComponent(val));
            }
        }
        return pairs.join(sep);
    }

    function escape(str) { return encodeURIComponent(str); }
    function unescape(str) { return decodeURIComponent(str); }

    return { parse, stringify, escape, unescape, decode: parse, encode: stringify };
})();

// ============================================================
// string_decoder module
// ============================================================

const string_decoder = (() => {
    class StringDecoder {
        constructor(encoding) {
            this.encoding = (encoding || 'utf8').toLowerCase();
            this._decoder = new TextDecoder(this.encoding === 'utf-8' ? 'utf-8' : this.encoding);
        }
        write(buf) {
            if (typeof buf === 'string') return buf;
            return this._decoder.decode(buf, { stream: true });
        }
        end(buf) {
            if (buf) return this.write(buf);
            return '';
        }
    }
    return { StringDecoder };
})();

// ============================================================
// timers module
// ============================================================

const timers = (() => {
    // js_std_add_helpers installs setTimeout/setInterval that return a raw
    // int64 timer id. Node returns an object with .unref()/.refresh(); npm's
    // Display calls both on its spinner timers, so wrap the id in an object.
    // clearAny() unwraps _id when the wrapper is passed back to clear*().
    const wrap = (id) => ({ _id: id, unref() { return this; }, refresh() { return this; } });
    const clearAny = (t) => {
        if (t == null) return;
        os.clearTimeout(typeof t === 'object' ? t._id : t);
    };
    return {
        setTimeout: (fn, ms, ...args) =>
            wrap(os.setTimeout(() => fn(...args), ms || 0)),
        clearTimeout: clearAny,
        setInterval: (fn, ms, ...args) => {
            // _id is rewritten on every tick so the latest live id is what
            // clearInterval cancels.
            const t = wrap(0);
            const tick = () => { fn(...args); t._id = os.setTimeout(tick, ms || 0); };
            t._id = os.setTimeout(tick, ms || 0);
            return t;
        },
        clearInterval: clearAny,
        setImmediate: (fn, ...args) =>
            wrap(os.setTimeout(() => fn(...args), 0)),
        clearImmediate: clearAny,
    };
})();

// `timers/promises` — @npmcli/agent uses `setTimeout(ms)` as a connection-timeout
// race against the connect promise. AbortSignal handling isn't needed for that.
const timersPromises = {
    setTimeout: (delay, value) => new Promise(r => os.setTimeout(() => r(value), delay || 0)),
};

// ============================================================
// child_process module
// ============================================================

const child_process = (() => {
    function execSync(command, options) {
        const opts = options || {};
        // Real Node's spawn{,Sync}/exec{,Sync} default to stdio:'pipe', which
        // captures the child's stderr into result.stderr instead of letting
        // it leak to the parent's terminal. popen("…", "r") inherits stderr,
        // so dash's "command not found" messages from probes like
        // commandExists('fd') used to render right in the user's terminal.
        // We don't actually capture stderr (our result.stderr is always
        // empty), but at minimum we must not leak it. Only inherit when the
        // caller explicitly asked for it.
        const inheritStderr = opts.stdio === 'inherit'
            || (Array.isArray(opts.stdio) && opts.stdio[2] === 'inherit');
        const popenCmd = inheritStderr ? command : command + ' 2>/dev/null';
        const f = std.popen(popenCmd, 'r');
        if (!f) throw new Error(`execSync failed: ${command}`);
        let output = '';
        let line;
        while ((line = f.getline()) !== null) {
            output += line + '\n';
        }
        const status = f.close();
        if (status !== 0 && !opts.stdio) {
            const err = new Error(`Command failed: ${command}`);
            err.status = status;
            err.output = [null, output, ''];
            err.stdout = output;
            err.stderr = '';
            throw err;
        }
        if (opts.encoding === 'buffer' || !opts.encoding) {
            return Buffer.from(output);
        }
        return output;
    }

    function execFileSync(file, args, options) {
        const cmd = file + ' ' + (args || []).map(a => `'${a}'`).join(' ');
        return execSync(cmd, options);
    }

    function spawnSync(command, args, options) {
        const cmd = command + ' ' + (args || []).map(a => `'${a}'`).join(' ');
        try {
            const stdout = execSync(cmd, { ...options, encoding: 'buffer' });
            return { status: 0, stdout, stderr: Buffer.alloc(0), output: [null, stdout, Buffer.alloc(0)], pid: 0, signal: null, error: null };
        } catch (e) {
            return { status: e.status || 1, stdout: Buffer.from(e.stdout || ''), stderr: Buffer.from(e.stderr || ''), output: [null, Buffer.from(e.stdout || ''), Buffer.from(e.stderr || '')], pid: 0, signal: null, error: e };
        }
    }

    function exec(command, options, cb) {
        if (typeof options === 'function') { cb = options; options = {}; }
        try {
            const result = execSync(command, { ...options, encoding: 'utf8' });
            queueMicrotask(() => cb(null, result, ''));
        } catch (e) {
            queueMicrotask(() => cb(e, e.stdout || '', e.stderr || ''));
        }
    }

    function execFile(file, args, options, cb) {
        if (typeof args === 'function') { cb = args; args = []; options = {}; }
        else if (typeof options === 'function') { cb = options; options = {}; }
        const cmd = file + ' ' + (args || []).map(a => `'${a}'`).join(' ');
        try {
            const result = execSync(cmd, { ...options, encoding: 'utf8' });
            queueMicrotask(() => cb && cb(null, result, ''));
        } catch (e) {
            queueMicrotask(() => cb && cb(e, e.stdout || '', e.stderr || ''));
        }
    }

    function spawn(command, args, options) {
        // Return a minimal ChildProcess-like object
        const child = new events.EventEmitter();
        child.pid = 0;
        child.stdin = new stream.Writable();
        child.stdout = new stream.Readable();
        child.stderr = new stream.Readable();

        queueMicrotask(() => {
            try {
                const cmd = command + ' ' + (args || []).map(a => `'${a}'`).join(' ');
                const result = execSync(cmd, { encoding: 'utf8' });
                child.stdout.push(Buffer.from(result));
                child.stdout.push(null);
                child.stderr.push(null);
                child.emit('close', 0);
                child.emit('exit', 0);
            } catch (e) {
                child.emit('error', e);
                child.emit('close', 1);
                child.emit('exit', 1);
            }
        });

        return child;
    }

    return { execSync, execFileSync, spawnSync, exec, execFile, spawn };
})();

// child_process.ChildProcess — spawn() above already returns an
// EventEmitter-shaped object; this class exists for code that does
// `instanceof ChildProcess` or subclasses it directly.
child_process.ChildProcess = (function () {
    function ChildProcess() { events.EventEmitter.call(this); }
    ChildProcess.prototype = Object.create(events.EventEmitter.prototype);
    ChildProcess.prototype.constructor = ChildProcess;
    return ChildProcess;
})();

// ============================================================
// crypto module (minimal)
// ============================================================

const crypto = (() => {
    function randomBytes(size) {
        const buf = Buffer.alloc(size);
        // Use Math.random as fallback (not cryptographically secure)
        for (let i = 0; i < size; i++) {
            buf[i] = Math.floor(Math.random() * 256);
        }
        return buf;
    }

    function randomUUID() {
        const bytes = randomBytes(16);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = bytes.toString('hex');
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }

    function randomInt(min, max) {
        if (max === undefined) { max = min; min = 0; }
        return min + Math.floor(Math.random() * (max - min));
    }

    function createHash(algorithm) {
        const native = _nodeNative.createHash(algorithm);
        return {
            update(data) {
                native.update(data);
                return this;
            },
            digest(encoding) {
                const buf = Buffer.from(native.digest());
                return encoding ? buf.toString(encoding) : buf;
            },
        };
    }

    function createHmac(algorithm, key) {
        const native = _nodeNative.createHmac(algorithm, key);
        return {
            update(data) {
                native.update(data);
                return this;
            },
            digest(encoding) {
                const buf = Buffer.from(native.digest());
                return encoding ? buf.toString(encoding) : buf;
            },
        };
    }

    return {
        randomBytes, randomUUID, randomInt,
        createHash, createHmac,
        getHashes() { return ['sha1', 'sha256', 'sha512', 'md5']; },
        getRandomValues(buf) {
            for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
            return buf;
        },
    };
})();

crypto.timingSafeEqual = function (a, b) {
    a = Buffer.from(a);
    b = Buffer.from(b);
    if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
};
// Throwing stubs: no libcrypto cipher/asymmetric-key surface wired through
// the wasm sysroot yet. See docs/posix-status.md.
crypto.randomFillSync = _notImpl('crypto', 'randomFillSync');
crypto.createCipheriv = _notImpl('crypto', 'createCipheriv');
crypto.createDecipheriv = _notImpl('crypto', 'createDecipheriv');
crypto.createPrivateKey = _notImpl('crypto', 'createPrivateKey');
crypto.createPublicKey = _notImpl('crypto', 'createPublicKey');
crypto.generateKeyPairSync = _notImpl('crypto', 'generateKeyPairSync');
crypto.sign = _notImpl('crypto', 'sign');
crypto.verify = _notImpl('crypto', 'verify');
// Constructable class stub: throws only when actually instantiated, so
// `import { X509Certificate } from "crypto"` still links.
crypto.X509Certificate = (function () {
    function X509Certificate() {
        throw new Error('crypto.X509Certificate is not implemented on spidermonkey-node');
    }
    return X509Certificate;
})();

// ============================================================
// net module (minimal stubs)
// ============================================================

const net = (() => {
    const nat = _nodeNative;
    const toU8 = (b) => {
        if (b instanceof Uint8Array) return b;
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (typeof b === 'string') return Buffer.from(b, 'utf8');
        throw new TypeError('socket: chunk must be Buffer, Uint8Array, ArrayBuffer, or string');
    };

    class Socket extends stream.Duplex {
        constructor(options) {
            super(options);
            this._fd = options?.fd ?? -1;
            this._socketDestroyed = false;
            this._reading = false;
            this._writeQueue = [];
            this.connecting = false;
            this.remoteAddress = null;
            this.remotePort = null;
            this.localAddress = null;
            this.localPort = null;
        }

        connect(port, host, cb) {
            if (typeof port === 'object' && port !== null) {
                cb = host; host = port.host; port = port.port;
            }
            if (typeof host === 'function') { cb = host; host = undefined; }
            host = host || 'localhost';
            if (cb) this.once('connect', cb);

            this.connecting = true;
            this.remoteAddress = host;
            this.remotePort = port;

            nat.socketConnect(host, port).then(
                (fd) => {
                    if (this._socketDestroyed) { nat.socketClose(fd); return; }
                    this._fd = fd;
                    this.connecting = false;
                    this.emit('connect');
                    this._scheduleRead();
                    this._flushWriteQueue();
                },
                (err) => {
                    this.connecting = false;
                    this.destroy(err);
                },
            );
            return this;
        }

        _scheduleRead() {
            if (this._fd < 0 || this._socketDestroyed || this._reading) return;
            this._reading = true;
            nat.socketRead(this._fd, 64 * 1024).then(
                (ab) => {
                    this._reading = false;
                    if (this._socketDestroyed) return;
                    if (ab.byteLength === 0) {
                        this.push(null); /* EOF — peer closed */
                        return;
                    }
                    this.push(Buffer.from(ab));
                    this._scheduleRead();
                },
                (err) => {
                    this._reading = false;
                    if (!this._socketDestroyed) this.destroy(err);
                },
            );
        }

        _read() { /* push happens proactively in _scheduleRead */ }

        _write(chunk, _encoding, cb) {
            const buf = toU8(chunk);
            if (this._fd < 0) {
                this._writeQueue.push({ buf, cb });
                return;
            }
            nat.socketWrite(this._fd, buf).then(() => cb(null), cb);
        }

        _flushWriteQueue() {
            const q = this._writeQueue;
            this._writeQueue = [];
            for (const { buf, cb } of q) {
                nat.socketWrite(this._fd, buf).then(() => cb(null), cb);
            }
        }

        destroy(err) {
            if (this._socketDestroyed) return this;
            this._socketDestroyed = true;
            if (this._fd >= 0) {
                nat.socketClose(this._fd);
                this._fd = -1;
            }
            for (const { cb } of this._writeQueue) cb(err || new Error('socket destroyed'));
            this._writeQueue = [];
            if (err) this.emit('error', err);
            this.emit('close', !!err);
            return this;
        }

        setEncoding(enc) { this._encoding = enc; return this; }
        setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
        address() { return { address: this.localAddress, port: this.localPort, family: 'IPv4' }; }
        ref() { return this; }
        unref() { return this; }
    }

    /* Server is still a stub — Phase 3 ships client sockets only. */
    class Server extends events.EventEmitter {
        constructor(options, connectionListener) {
            super();
            if (typeof options === 'function') { connectionListener = options; options = {}; }
            if (connectionListener) this.on('connection', connectionListener);
        }
        listen(port, host, cb) {
            if (typeof host === 'function') { cb = host; host = '0.0.0.0'; }
            if (typeof port === 'function') { cb = port; port = 0; }
            this._port = port;
            this._host = host || '0.0.0.0';
            if (cb) this.once('listening', cb);
            queueMicrotask(() => this.emit('listening'));
            return this;
        }
        address() { return { address: this._host, port: this._port, family: 'IPv4' }; }
        close(cb) { if (cb) cb(); return this; }
        ref() { return this; }
        unref() { return this; }
    }

    return {
        Socket, Server,
        createServer(options, listener) { return new Server(options, listener); },
        createConnection(port, host, cb) { return new Socket().connect(port, host, cb); },
        connect(port, host, cb) { return new Socket().connect(port, host, cb); },
        isIP(input) {
            if (/^\d+\.\d+\.\d+\.\d+$/.test(input)) return 4;
            if (input.includes(':')) return 6;
            return 0;
        },
        isIPv4(input) { return net.isIP(input) === 4; },
        isIPv6(input) { return net.isIP(input) === 6; },
    };
})();

// net.BlockList — no-op class stub (used with `new net.BlockList()` and
// instanceof checks); check() always reports "not blocked".
net.BlockList = (function () {
    function BlockList() {}
    BlockList.prototype.addAddress = function () {};
    BlockList.prototype.addRange = function () {};
    BlockList.prototype.addSubnet = function () {};
    BlockList.prototype.check = function () { return false; };
    return BlockList;
})();

// ============================================================
// tls module — TLSSocket via libssl in the wasm sysroot
// ============================================================

const tls = (() => {
    const nat = _nodeNative;
    const toU8 = (b) => {
        if (b instanceof Uint8Array) return b;
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (typeof b === 'string') return Buffer.from(b, 'utf8');
        throw new TypeError('tls: chunk must be Buffer, Uint8Array, ArrayBuffer, or string');
    };

    /* TLSSocket layers SSL_read/SSL_write over a fd that net.Socket has
       already TCP-connected. The underlying fd is owned by the TLS handle
       once handshake starts — close routes through tlsClose. */
    class TLSSocket extends stream.Duplex {
        constructor(options) {
            super(options);
            this._tlsHandle = -1;
            this._tlsDestroyed = false;
            this._reading = false;
            this._writeQueue = [];
            this._handshakePending = true;
            this.servername = options?.servername || null;
            this.authorized = false;
        }

        _attach(fd, servername, opts) {
            const ca = typeof opts?.ca === 'string'
                ? opts.ca
                : (Buffer.isBuffer?.(opts?.ca) ? opts.ca.toString('utf8') : undefined);
            const rejectUnauthorized = opts?.rejectUnauthorized !== false;
            this.servername = servername;
            nat.tlsConnect(fd, servername, { ca, rejectUnauthorized }).then(
                (handle) => {
                    if (this._tlsDestroyed) { nat.tlsClose(handle); return; }
                    this._tlsHandle = handle;
                    this._handshakePending = false;
                    this.authorized = rejectUnauthorized;
                    this.emit('secureConnect');
                    this._scheduleRead();
                    this._flushWriteQueue();
                },
                (err) => { this._handshakePending = false; this.destroy(err); },
            );
        }

        _scheduleRead() {
            if (this._tlsHandle < 0 || this._tlsDestroyed || this._reading) return;
            this._reading = true;
            nat.tlsRead(this._tlsHandle, 64 * 1024).then(
                (ab) => {
                    this._reading = false;
                    if (this._tlsDestroyed) return;
                    if (ab.byteLength === 0) { this.push(null); return; }
                    this.push(Buffer.from(ab));
                    this._scheduleRead();
                },
                (err) => {
                    this._reading = false;
                    if (!this._tlsDestroyed) this.destroy(err);
                },
            );
        }

        _read() { /* push happens proactively in _scheduleRead */ }

        _write(chunk, _encoding, cb) {
            const buf = toU8(chunk);
            if (this._tlsHandle < 0) {
                this._writeQueue.push({ buf, cb });
                return;
            }
            nat.tlsWrite(this._tlsHandle, buf).then(() => cb(null), cb);
        }

        _flushWriteQueue() {
            const q = this._writeQueue;
            this._writeQueue = [];
            for (const { buf, cb } of q) {
                nat.tlsWrite(this._tlsHandle, buf).then(() => cb(null), cb);
            }
        }

        destroy(err) {
            if (this._tlsDestroyed) return this;
            this._tlsDestroyed = true;
            if (this._tlsHandle >= 0) {
                nat.tlsClose(this._tlsHandle);
                this._tlsHandle = -1;
            }
            for (const { cb } of this._writeQueue) cb(err || new Error('tls socket destroyed'));
            this._writeQueue = [];
            if (err) this.emit('error', err);
            this.emit('close', !!err);
            return this;
        }

        setEncoding(enc) { this._encoding = enc; return this; }
        setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
        ref() { return this; }
        unref() { return this; }
        getProtocol() { return this._tlsHandle >= 0 ? 'TLSv1.3' : null; }
        getPeerCertificate() { return {}; }
    }

    function connect(options, cb) {
        if (typeof options === 'number') {
            /* (port, host?, opts?, cb?) Node-style overloads. */
            const port = options;
            const host = (typeof arguments[1] === 'string') ? arguments[1] : 'localhost';
            const o2 = (typeof arguments[2] === 'object') ? arguments[2] : {};
            const cb2 = (typeof arguments[arguments.length - 1] === 'function')
                ? arguments[arguments.length - 1] : null;
            options = Object.assign({ host, port }, o2);
            if (cb2) cb = cb2;
        }
        const sock = new TLSSocket(options);
        if (cb) sock.once('secureConnect', cb);
        const servername = options.servername || options.host || 'localhost';
        nat.socketConnect(options.host || 'localhost', options.port).then(
            (fd) => {
                if (sock._tlsDestroyed) { nat.socketClose(fd); return; }
                sock._attach(fd, servername, options);
            },
            (err) => sock.destroy(err),
        );
        return sock;
    }

    return { connect, TLSSocket };
})();

// No bundled CA store or pluggable SecureContext surface — tlsConnect
// (libssl in the wasm sysroot) manages certificate verification itself.
tls.rootCertificates = [];
tls.checkServerIdentity = function () { return undefined; };
tls.createSecureContext = _notImpl('tls', 'createSecureContext');

// ============================================================
// http / https modules — real HTTP/1.1 over net.Socket (http) and tls.TLSSocket (https)
//
// Single-source parser; the http vs https split is just the transport
// factory we hand the request constructor. Mirrors Node's surface enough
// for npm: ClientRequest extends Writable, IncomingMessage extends
// Readable, headers are stored case-insensitively, body modes are
// Content-Length / Transfer-Encoding: chunked / connection-close.
// ============================================================

const STATUS_CODES = {
    100: 'Continue', 101: 'Switching Protocols',
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
    304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
    409: 'Conflict', 410: 'Gone', 411: 'Length Required',
    413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type',
    429: 'Too Many Requests',
    500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const HTTP_METHODS = [
    'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE',
];

/* IncomingMessage parser — single instance per ClientRequest. Bytes from
   the socket arrive via feed() and trigger onHeaders / message.push().
   The parser owns the IncomingMessage and is the only thing that should
   call message.push(). */
function makeResponseParser({ onHeaders, onError, onComplete }) {
    let state = 'STATUS'; // STATUS | HEADERS | BODY
    let textBuf = '';     // latin1 buffer for status/headers
    let message = null;
    let bodyMode = null;  // 'length' | 'chunked' | 'close' | 'none'
    let bodyRemaining = 0;
    let chunkPhase = 'size'; // size | data | data-trailer | trailer
    let chunkRemaining = 0;
    let chunkAcc = '';
    let trailerAcc = '';
    let completed = false;
    let remainder = null; // bytes received after end-of-message, for the next claimer of this socket

    function bytesToLatin1(u8) {
        let s = '';
        for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return s;
    }
    function latin1ToBytes(s) {
        const u8 = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
        return u8;
    }

    function complete(leftover) {
        if (completed) return;
        completed = true;
        if (leftover && leftover.length > 0) remainder = leftover;
        if (message) message.complete = true;
        if (message) message.push(null);
        if (onComplete) onComplete();
    }

    function setupBodyMode() {
        const sc = message.statusCode;
        const cl = message.headers['content-length'];
        const te = message.headers['transfer-encoding'];
        // RFC 7230: 1xx, 204, 304 — no body regardless of headers.
        if ((sc >= 100 && sc < 200) || sc === 204 || sc === 304) {
            bodyMode = 'none';
            return;
        }
        if (te && /chunked/i.test(te)) {
            bodyMode = 'chunked'; chunkPhase = 'size'; chunkAcc = '';
        } else if (cl !== undefined) {
            const n = parseInt(cl, 10);
            if (Number.isFinite(n) && n >= 0) {
                bodyMode = 'length';
                bodyRemaining = n;
            } else {
                bodyMode = 'close';
            }
        } else {
            bodyMode = 'close';
        }
    }

    function parseStatusLine(line) {
        // "HTTP/1.1 200 OK" — message may be empty.
        const m = /^HTTP\/(\d+)\.(\d+)[ \t]+(\d{3})(?:[ \t]+(.*))?$/.exec(line);
        if (!m) throw new Error('http: malformed status line: ' + JSON.stringify(line));
        message.httpVersionMajor = parseInt(m[1], 10);
        message.httpVersionMinor = parseInt(m[2], 10);
        message.httpVersion = `${m[1]}.${m[2]}`;
        message.statusCode = parseInt(m[3], 10);
        message.statusMessage = m[4] || STATUS_CODES[message.statusCode] || '';
    }

    function pushHeader(line) {
        const colon = line.indexOf(':');
        if (colon < 0) return; // tolerate
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        const lk = name.toLowerCase();
        message.rawHeaders.push(name, value);
        if (lk === 'set-cookie') {
            if (Array.isArray(message.headers[lk])) message.headers[lk].push(value);
            else message.headers[lk] = [value];
        } else if (message.headers[lk] !== undefined) {
            message.headers[lk] += ', ' + value;
        } else {
            message.headers[lk] = value;
        }
    }

    function parseChunked(u8) {
        let i = 0;
        while (i < u8.length) {
            if (chunkPhase === 'size') {
                while (i < u8.length) {
                    chunkAcc += String.fromCharCode(u8[i++]);
                    if (chunkAcc.endsWith('\r\n')) {
                        const sizeStr = chunkAcc.slice(0, -2).split(';')[0].trim();
                        chunkRemaining = parseInt(sizeStr, 16);
                        if (!Number.isFinite(chunkRemaining) || chunkRemaining < 0) {
                            throw new Error('http: bad chunk size: ' + sizeStr);
                        }
                        chunkAcc = '';
                        chunkPhase = (chunkRemaining === 0) ? 'trailer' : 'data';
                        break;
                    }
                }
            } else if (chunkPhase === 'data') {
                const n = Math.min(u8.length - i, chunkRemaining);
                if (n > 0) {
                    message.push(Buffer.from(u8.subarray(i, i + n)));
                    i += n;
                    chunkRemaining -= n;
                }
                if (chunkRemaining === 0) {
                    chunkPhase = 'data-trailer';
                    trailerAcc = '';
                }
            } else if (chunkPhase === 'data-trailer') {
                while (i < u8.length) {
                    trailerAcc += String.fromCharCode(u8[i++]);
                    if (trailerAcc === '\r\n') {
                        chunkPhase = 'size';
                        chunkAcc = '';
                        trailerAcc = '';
                        break;
                    }
                    if (trailerAcc.length > 2 || (trailerAcc.length === 1 && trailerAcc !== '\r')) {
                        throw new Error('http: bad chunk trailer');
                    }
                }
            } else if (chunkPhase === 'trailer') {
                // Either "\r\n" (no trailers) or trailer headers ending in "\r\n\r\n".
                while (i < u8.length) {
                    chunkAcc += String.fromCharCode(u8[i++]);
                    if (chunkAcc === '\r\n' || chunkAcc.endsWith('\r\n\r\n')) {
                        complete(i < u8.length ? u8.subarray(i) : null);
                        return;
                    }
                    if (chunkAcc.length > 65536) {
                        throw new Error('http: chunked trailer too large');
                    }
                }
            }
        }
    }

    function parseBody(u8) {
        if (completed || !message) return;
        if (bodyMode === 'none') {
            complete();
            return;
        }
        if (bodyMode === 'length') {
            const n = Math.min(u8.length, bodyRemaining);
            if (n > 0) {
                message.push(Buffer.from(u8.subarray(0, n)));
                bodyRemaining -= n;
            }
            if (bodyRemaining === 0) {
                complete(u8.length > n ? u8.subarray(n) : null);
            }
        } else if (bodyMode === 'close') {
            if (u8.length > 0) message.push(Buffer.from(u8));
        } else if (bodyMode === 'chunked') {
            parseChunked(u8);
        }
    }

    return {
        get message() { return message; },
        get completed() { return completed; },
        getRemainder() { return remainder; },
        feed(u8) {
            try {
                if (state === 'STATUS' || state === 'HEADERS') {
                    textBuf += bytesToLatin1(u8);
                    while (true) {
                        const idx = textBuf.indexOf('\r\n');
                        if (idx < 0) return;
                        const line = textBuf.slice(0, idx);
                        textBuf = textBuf.slice(idx + 2);
                        if (state === 'STATUS') {
                            message = makeIncomingMessage();
                            parseStatusLine(line);
                            state = 'HEADERS';
                        } else if (state === 'HEADERS') {
                            if (line === '') {
                                setupBodyMode();
                                state = 'BODY';
                                onHeaders(message);
                                // Bodyless responses (no-body status, or
                                // Content-Length: 0) complete immediately —
                                // no further bytes needed. Hand any post-header
                                // bytes to the next claimer of the socket.
                                if (bodyMode === 'none'
                                    || (bodyMode === 'length' && bodyRemaining === 0)) {
                                    const left = textBuf.length > 0
                                        ? latin1ToBytes(textBuf) : null;
                                    textBuf = '';
                                    complete(left);
                                    return;
                                }
                                if (textBuf.length > 0) {
                                    const rest = latin1ToBytes(textBuf);
                                    textBuf = '';
                                    parseBody(rest);
                                }
                                return;
                            }
                            pushHeader(line);
                        }
                    }
                } else {
                    parseBody(u8);
                }
            } catch (err) {
                onError(err);
            }
        },
        end() {
            // Socket closed. For mode=close, this is the natural EOF.
            if (state === 'BODY' && bodyMode === 'close') {
                complete();
            } else if (state === 'BODY' && !completed) {
                onError(new Error('http: connection closed before body completion'));
            } else if (state !== 'BODY') {
                onError(new Error('http: connection closed before headers'));
            }
        },
    };
}

function makeIncomingMessage() {
    const msg = new stream.Readable();
    msg.headers = Object.create(null);
    msg.rawHeaders = [];
    msg.trailers = Object.create(null);
    msg.rawTrailers = [];
    msg.httpVersion = '1.1';
    msg.httpVersionMajor = 1;
    msg.httpVersionMinor = 1;
    msg.statusCode = 0;
    msg.statusMessage = '';
    msg.complete = false;
    msg.url = '';
    msg.method = null;
    return msg;
}

function makeHttpModule({ connect, defaultPort, defaultProtocol }) {
    const protoLower = defaultProtocol.toLowerCase();

    // Per-origin keep-alive socket pool. Sequential npm fetches against the
    // same registry reuse one TLS connection instead of paying ~28 fresh
    // handshakes during `npm install vite`.
    const pool = new Map(); // "host:port" -> [sock, ...]
    function poolKey(host, port) { return host + ':' + port; }
    const MAX_POOL_PER_ORIGIN = 4;
    // After this many ms idle, destroy the socket. node-main.c's js_node_loop
    // exits only when there are no socket/tls watches; pooled sockets keep a
    // `nat.tlsRead` outstanding which counts as a watch and would block exit.
    const POOL_IDLE_MS = 500;
    function popLiveFromPool(key) {
        const bucket = pool.get(key);
        while (bucket && bucket.length) {
            const sock = bucket.pop();
            if (sock._poolTimer) { clearTimeout(sock._poolTimer); sock._poolTimer = null; }
            const idle = sock._idleHandler;
            sock.removeListener('close', idle);
            sock.removeListener('end', idle);
            sock.removeListener('error', idle);
            sock._idleHandler = null;
            if (!sock._idleDead) return sock;
        }
        return null;
    }
    function returnToPool(key, sock) {
        let bucket = pool.get(key);
        if (!bucket) { bucket = []; pool.set(key, bucket); }
        if (bucket.length >= MAX_POOL_PER_ORIGIN) {
            try { sock.destroy(); } catch (_) { /* ignore */ }
            return;
        }
        const onIdle = () => { sock._idleDead = true; };
        sock._idleHandler = onIdle;
        sock.once('close', onIdle);
        sock.once('end', onIdle);
        sock.once('error', onIdle);
        sock._poolTimer = setTimeout(() => {
            sock._poolTimer = null;
            try { sock.destroy(); } catch (_) { /* ignore */ }
        }, POOL_IDLE_MS);
        bucket.push(sock);
    }

    /* Normalize every supported `request()` argument shape into a flat
       options object. Accepts: URL string, WHATWG URL, Node-style
       options, plus the common (urlString, options, cb) overload. */
    function normalize(input, maybeOpts, maybeCb) {
        let opts = {};
        let cb = null;
        if (typeof input === 'string') {
            const u = url.parse(input);
            opts.protocol = u.protocol;
            opts.hostname = u.hostname;
            if (u.port) opts.port = parseInt(u.port, 10);
            opts.path = (u.pathname || '/') + (u.search || '');
        } else if (input && typeof input === 'object' && typeof input.href === 'string'
                   && typeof input.pathname === 'string') {
            // WHATWG URL or url.parse() output.
            opts.protocol = input.protocol;
            opts.hostname = input.hostname;
            if (input.port) opts.port = parseInt(input.port, 10);
            opts.path = (input.pathname || '/') + (input.search || '');
        }
        if (input && typeof input === 'object' && !(typeof input.href === 'string')) {
            // Plain options object.
            Object.assign(opts, input);
        }
        if (typeof maybeOpts === 'object' && maybeOpts !== null) {
            Object.assign(opts, maybeOpts);
        }
        if (typeof maybeOpts === 'function') cb = maybeOpts;
        if (typeof maybeCb === 'function') cb = maybeCb;
        return { opts, cb };
    }

    class ClientRequest extends stream.Writable {
        constructor(opts, cb) {
            super();
            this.method = (opts.method || 'GET').toUpperCase();
            this.path = opts.path || '/';
            this._host = opts.hostname || opts.host || 'localhost';
            // WHATWG URL gives `port = ''` when default; treat that like missing.
            this._port = (opts.port != null && opts.port !== '')
                ? parseInt(opts.port, 10) : defaultPort;
            this._protocol = (opts.protocol || protoLower).toLowerCase();
            // Header storage: case-insensitive lookup, original-case serialization.
            this._headerNames = Object.create(null); // lower -> original
            this._headerValues = Object.create(null); // lower -> value

            if (opts.headers) {
                for (const k of Object.keys(opts.headers)) {
                    this.setHeader(k, opts.headers[k]);
                }
            }
            if (!this.getHeader('host')) {
                const portStr = this._port === defaultPort ? '' : `:${this._port}`;
                this.setHeader('Host', this._host + portStr);
            }
            if (!this.getHeader('connection')) {
                this.setHeader('Connection', 'keep-alive');
            }
            // Pass-through TLS options for redirected calls and the initial connect.
            this._tlsOpts = {
                ca: opts.ca,
                rejectUnauthorized: opts.rejectUnauthorized,
                servername: opts.servername || this._host,
            };

            // Redirect knobs are non-Node extensions but the handoff explicitly
            // calls for them; keep off-by-default to mirror standard http.request.
            this._followRedirects = opts.followRedirects === true;
            this._maxRedirects = opts.maxRedirects ?? 10;
            this._redirectCount = opts.__redirectCount || 0;

            this._socket = null;
            this._connected = false;
            this._headersSent = false;
            this._destroyed = false;
            this._redirected = false;
            this._pendingBody = []; // chunks buffered until socket is connected

            if (cb) this.once('response', cb);
            this._origCb = cb;

            queueMicrotask(() => {
                if (this._destroyed) return;
                this._openSocket();
            });
        }

        setHeader(name, value) {
            const lk = name.toLowerCase();
            this._headerNames[lk] = name;
            this._headerValues[lk] = String(value);
        }
        getHeader(name) { return this._headerValues[name.toLowerCase()]; }
        getHeaders() {
            const out = Object.create(null);
            for (const lk of Object.keys(this._headerValues)) out[lk] = this._headerValues[lk];
            return out;
        }
        removeHeader(name) {
            const lk = name.toLowerCase();
            delete this._headerNames[lk];
            delete this._headerValues[lk];
        }

        _openSocket(retryFresh) {
            const key = poolKey(this._host, this._port);
            this._sockPoolKey = key;
            let sock = retryFresh ? null : popLiveFromPool(key);
            const fromPool = sock != null;
            if (!sock) {
                sock = connect({
                    host: this._host,
                    port: this._port,
                    ca: this._tlsOpts.ca,
                    rejectUnauthorized: this._tlsOpts.rejectUnauthorized,
                    servername: this._tlsOpts.servername,
                });
            }
            this._socket = sock;
            this._fromPool = fromPool;
            this._headersReceived = false;

            const parser = makeResponseParser({
                onHeaders: (msg) => { this._headersReceived = true; this._onHeaders(msg); },
                onError: (err) => this._failed(err),
                onComplete: () => this._releaseSocket(),
            });
            this._parser = parser;

            // Pooled-socket race: server can close an idle keep-alive between
            // our claim and our send. If we observe end/close/error before
            // any response bytes arrive, drop the stale socket and replay
            // the request on a fresh connection.
            const isStalePooled = () =>
                this._fromPool && !this._headersReceived && !this._destroyed;
            const onData = (chunk) => parser.feed(chunk);
            const onEnd = () => {
                if (isStalePooled()) { retryFreshFrom(); return; }
                parser.end();
            };
            const onClose = () => {
                if (isStalePooled()) { retryFreshFrom(); return; }
                if (!parser.completed) parser.end();
            };
            const onError = (err) => {
                if (isStalePooled()) { retryFreshFrom(); return; }
                this._failed(err);
            };
            const retryFreshFrom = () => {
                sock.removeListener('data', onData);
                sock.removeListener('end', onEnd);
                sock.removeListener('close', onClose);
                sock.removeListener('error', onError);
                try { sock.destroy(); } catch (_) { /* ignore */ }
                this._connected = false;
                this._headersSent = false;
                this._openSocket(true);
            };
            sock.on('data', onData);
            sock.on('end', onEnd);
            sock.on('error', onError);
            sock.on('close', onClose);
            this._sockListeners = { onData, onEnd, onError, onClose };

            // net.Socket emits 'connect'; tls.TLSSocket emits 'secureConnect'.
            // Listen for both — only one will fire per transport. Pooled
            // sockets are already connected, so jump straight to ready.
            const onReady = () => {
                if (this._destroyed) return;
                this._connected = true;
                this._sendHeaders();
                for (const buf of this._pendingBody) this._socket.write(buf);
                this._pendingBody = [];
                // Drain bytes the previous response left buffered on this
                // socket — they're the start of OUR response (server
                // pipelined, or our parser read past end-of-message).
                const stash = sock._pendingBytes;
                if (stash && stash.length > 0) {
                    sock._pendingBytes = null;
                    parser.feed(stash);
                }
            };
            if (fromPool) {
                queueMicrotask(onReady);
            } else {
                sock.once('connect', onReady);
                sock.once('secureConnect', onReady);
            }
        }

        _releaseSocket() {
            const sock = this._socket;
            if (!sock) return;
            this._socket = null;
            const lst = this._sockListeners;
            sock.removeListener('data', lst.onData);
            sock.removeListener('end', lst.onEnd);
            sock.removeListener('error', lst.onError);
            sock.removeListener('close', lst.onClose);
            if (this._destroyed || this._redirected || this._respConnectionClose) {
                try { sock.destroy(); } catch (_) { /* ignore */ }
                return;
            }
            // Pause the underlying Readable: removing the 'data' listener does
            // NOT clear flowing=true, so chunks pushed while idle in the pool
            // would emit('data') to zero listeners and be silently dropped.
            // With flowing=false, push buffers; the next claimer's on('data')
            // triggers a drain into the new parser.
            try { sock.pause(); } catch (_) { /* ignore */ }
            // Stash any bytes the parser read past end-of-message — they
            // belong to the next response on this connection.
            const left = this._parser && this._parser.getRemainder();
            if (left && left.length > 0) {
                const prev = sock._pendingBytes;
                if (prev && prev.length > 0) {
                    const merged = new Uint8Array(prev.length + left.length);
                    merged.set(prev, 0);
                    merged.set(left, prev.length);
                    sock._pendingBytes = merged;
                } else {
                    sock._pendingBytes = left;
                }
            }
            returnToPool(this._sockPoolKey, sock);
        }

        _sendHeaders() {
            if (this._headersSent) return;
            this._headersSent = true;
            let req = `${this.method} ${this.path} HTTP/1.1\r\n`;
            for (const lk of Object.keys(this._headerValues)) {
                req += `${this._headerNames[lk]}: ${this._headerValues[lk]}\r\n`;
            }
            req += '\r\n';
            this._socket.write(Buffer.from(req, 'utf8'));
        }

        _write(chunk, encoding, cb) {
            if (this._destroyed) return cb(new Error('http: request destroyed'));
            const buf = (chunk instanceof Uint8Array) ? Buffer.from(chunk)
                : (typeof chunk === 'string') ? Buffer.from(chunk, encoding || 'utf8')
                : Buffer.from(chunk);
            if (!this._connected) {
                this._pendingBody.push(buf);
                return cb();
            }
            this._sendHeaders();
            this._socket.write(buf);
            cb();
        }

        end(chunk, encoding, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (chunk) this.write(chunk, encoding);
            if (this._connected) this._sendHeaders();
            this._writableState.ended = true;
            this.emit('finish');
            if (cb) cb();
            return this;
        }

        _onHeaders(msg) {
            if (this._destroyed) return;
            this._respConnectionClose = /(^|,)\s*close\s*(,|$)/i.test(msg.headers.connection || '');
            // Auto-redirect (opt-in).
            if (this._followRedirects
                && msg.statusCode >= 300 && msg.statusCode < 400
                && msg.headers.location
                && this._redirectCount < this._maxRedirects) {
                const loc = msg.headers.location;
                this._redirectTo(loc, msg);
                return;
            }
            // Drain the parser into the message even after we hand it off.
            this.emit('response', msg);
        }

        _redirectTo(location, _prev) {
            // Mark first so the synchronous 'close' fired by socket.destroy()
            // doesn't surface a phantom "connection closed before body" error.
            this._redirected = true;
            try {
                if (this._socket) this._socket.destroy();
            } catch (_) { /* ignore */ }
            // Resolve relative redirects against the current request URL.
            const baseHref = `${this._protocol}//${this._host}${this._port === defaultPort ? '' : ':' + this._port}${this.path}`;
            const absUrl = url.resolve(baseHref, location);
            const u = url.parse(absUrl);
            const targetProto = (u.protocol || this._protocol).toLowerCase();
            // Same-scheme redirects only — cross-scheme (http→https) is out of scope
            // for this slice. Real CDNs do upgrade-to-https; if Phase 5 hits one,
            // wire a cross-module registry back in.
            if (targetProto !== this._protocol) {
                this._failed(new Error('http: cross-scheme redirect not supported: ' + targetProto));
                return;
            }
            // Carry the original SNI through. Same-origin redirects (the
            // common case for npm-style flows) preserve cert validity that
            // way; cross-origin redirects are not in scope for this slice.
            const newOpts = {
                protocol: targetProto,
                hostname: u.hostname || this._host,
                port: u.port ? parseInt(u.port, 10) : undefined,
                path: (u.pathname || '/') + (u.search || ''),
                method: this.method,
                headers: this.getHeaders(),
                ca: this._tlsOpts.ca,
                rejectUnauthorized: this._tlsOpts.rejectUnauthorized,
                servername: this._tlsOpts.servername,
                followRedirects: true,
                maxRedirects: this._maxRedirects,
                __redirectCount: this._redirectCount + 1,
            };
            // The Host header must update for the new origin.
            delete newOpts.headers['host'];
            const next = request(newOpts);
            next.on('response', (msg) => this.emit('response', msg));
            next.on('error', (err) => this.emit('error', err));
            next.end();
        }

        _failed(err) {
            if (this._destroyed || this._redirected) return;
            this._destroyed = true;
            this.emit('error', err);
        }

        abort() { this.destroy(); }
        destroy(err) {
            if (this._destroyed) return this;
            this._destroyed = true;
            try { if (this._socket) this._socket.destroy(); } catch (_) { /* ignore */ }
            if (err) this.emit('error', err);
            return this;
        }

        setTimeout(_ms, cb) { if (cb) this.once('timeout', cb); return this; }
        setNoDelay() { return this; }
        setSocketKeepAlive() { return this; }
        flushHeaders() { /* deferred until connect */ }
    }

    function request(input, maybeOpts, maybeCb) {
        const { opts, cb } = normalize(input, maybeOpts, maybeCb);
        return new ClientRequest(opts, cb);
    }
    function get(input, maybeOpts, maybeCb) {
        const req = request(input, maybeOpts, maybeCb);
        req.end();
        return req;
    }

    return {
        STATUS_CODES, METHODS: HTTP_METHODS,
        request, get,
        ClientRequest,
        Agent: class Agent {},
        globalAgent: {},
        createServer() {
            throw new Error('http.createServer is not yet implemented (Phase 4 part 2 shipped client-side only)');
        },
    };
}

const http = makeHttpModule({
    connect: (opts) => {
        const sock = new net.Socket();
        sock.connect(opts.port || 80, opts.host || 'localhost');
        return sock;
    },
    defaultPort: 80,
    defaultProtocol: 'http:',
});

const https = makeHttpModule({
    connect: (opts) => tls.connect({
        host: opts.host || 'localhost',
        port: opts.port || 443,
        ca: opts.ca,
        rejectUnauthorized: opts.rejectUnauthorized,
        servername: opts.servername || opts.host || 'localhost',
    }),
    defaultPort: 443,
    defaultProtocol: 'https:',
});

// ============================================================
// Module system (require/module)
// ============================================================

const _builtinModules = {
    'path': path,
    'events': events,
    'buffer': { Buffer },
    'fs': fs,
    'fs/promises': fs.promises,
    'os': nodeOs,
    'util': util,
    'util/types': util.types,
    'assert': assert,
    'assert/strict': assert,
    'stream': stream,
    'url': url,
    'querystring': querystring,
    'string_decoder': string_decoder,
    'timers': timers,
    'timers/promises': timersPromises,
    // @sigstore/sign reads http2.constants at module init but fetches over
    // make-fetch-happen (http/1) — empty stub satisfies the load.
    'http2': { constants: {} },
    'child_process': child_process,
    'crypto': crypto,
    'net': net,
    'tls': tls,
    'http': http,
    'https': https,
    'zlib': (() => {
        const z = _nodeNative;
        const toU8 = (b) => {
            if (b instanceof Uint8Array) return b;
            if (b instanceof ArrayBuffer) return new Uint8Array(b);
            if (typeof b === 'string') return Buffer.from(b, 'utf8');
            throw new TypeError('zlib: input must be Buffer, Uint8Array, ArrayBuffer, or string');
        };
        // end() override: base Transform.end() never flushes — we have to
        // feed Z_FINISH to libz ourselves and push(null) for end-of-stream.
        class ZlibTransform extends stream.Transform {
            constructor(inner, opts) {
                super(opts);
                this._inner = inner;
                // minizlib (vendored by minipass-fetch) treats our zlib as
                // Node's native handle and pokes _handle/_processChunk/close.
                this._handle = { close: () => {} };
            }
            close() {}
            _processChunk(chunk, _flushFlag) {
                const u8 = toU8(chunk);
                const out = this._inner.write(u8, _flushFlag === 4 /* Z_FINISH */);
                return out.byteLength ? Buffer.from(out) : Buffer.alloc(0);
            }
            _transform(chunk, _enc, cb) {
                try {
                    const out = this._inner.write(toU8(chunk), false);
                    cb(null, out.byteLength ? Buffer.from(out) : null);
                } catch (e) { cb(e); }
            }
            end(chunk, encoding, cb) {
                if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
                if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
                if (chunk != null) this.write(chunk, encoding);
                try {
                    const out = this._inner.write(new Uint8Array(0), true);
                    if (out.byteLength) this.push(Buffer.from(out));
                } catch (e) { this.emit('error', e); }
                this.push(null);
                this._writableState.ended = true;
                this.emit('finish');
                if (cb) cb();
                return this;
            }
        }
        // minipass-fetch / tar instantiate via `new zlib.Gunzip()` / `new zlib.Unzip()`.
        class Gunzip extends ZlibTransform { constructor(opts) { super(z.createGunzip(), opts); } }
        // Node's Unzip auto-detects a zlib or gzip header. The native backend's
        // createGunzip already sniffs both (windowBits 47 / auto), so Unzip is
        // backed by it too.
        class Unzip extends ZlibTransform { constructor(opts) { super(z.createGunzip(), opts); } }
        // Brotli: there is no Brotli codec in the native backend (patch 0012
        // wires libz only, no libbrotli). Provide an honest fail-loud stream:
        // it constructs (so module-init that builds a Brotli stream succeeds)
        // but errors on the first byte of data instead of silently returning
        // wrong bytes. Real Brotli is tracked future work (docs/posix-status.md).
        const _brotliMsg = 'zlib Brotli is not implemented on spidermonkey-node';
        class BrotliUnsupported extends stream.Transform {
            _transform(_chunk, _enc, cb) { cb(new Error(_brotliMsg)); }
        }
        // Real Node zlib/Brotli numeric constants. Only Z_SYNC_FLUSH and
        // BROTLI_OPERATION_FLUSH are read by the app today, but expose the
        // standard set so consumers that read other flush/level/param codes
        // work. Values match Node's zlib.constants.
        const constants = {
            Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3,
            Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6,
            Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1,
            Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4,
            Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
            Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9,
            Z_DEFAULT_COMPRESSION: -1,
            Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4,
            Z_DEFAULT_STRATEGY: 0,
            Z_BINARY: 0, Z_TEXT: 1, Z_ASCII: 1, Z_UNKNOWN: 2,
            Z_DEFLATED: 8,
            Z_DEFAULT_CHUNK: 16384, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity,
            Z_DEFAULT_LEVEL: -1, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9,
            Z_DEFAULT_MEMLEVEL: 8, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9,
            Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15,
            BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1,
            BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3,
            BROTLI_PARAM_MODE: 0, BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1,
            BROTLI_MODE_FONT: 2, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_LGWIN: 2,
            BROTLI_PARAM_LGBLOCK: 3,
            BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
            BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6,
            BROTLI_PARAM_NPOSTFIX: 7, BROTLI_PARAM_NDIRECT: 8,
            BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11,
            BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24,
            BROTLI_DEFAULT_WINDOW: 22, BROTLI_LARGE_MAX_WINDOW_BITS: 30,
            BROTLI_MIN_INPUT_BLOCK_BITS: 16, BROTLI_MAX_INPUT_BLOCK_BITS: 24,
        };
        return {
            createGzip:    (opts) => new ZlibTransform(z.createGzip(opts?.level), opts),
            createGunzip:  (opts) => new Gunzip(opts),
            createUnzip:   (opts) => new Unzip(opts),
            createDeflate: (opts) => new ZlibTransform(z.createDeflate(opts?.level), opts),
            createInflate: (opts) => new ZlibTransform(z.createInflate(), opts),
            gzipSync:    (b, opts) => Buffer.from(z.gzipSync(toU8(b), opts?.level)),
            gunzipSync:  (b)       => Buffer.from(z.gunzipSync(toU8(b))),
            deflateSync: (b, opts) => Buffer.from(z.deflateSync(toU8(b), opts?.level)),
            inflateSync: (b)       => Buffer.from(z.inflateSync(toU8(b))),
            // Brotli: honest fail-loud stubs (construct OK, error on data).
            createBrotliCompress:   (opts) => new BrotliUnsupported(opts),
            createBrotliDecompress: (opts) => new BrotliUnsupported(opts),
            brotliCompressSync:   _notImpl('zlib', 'brotliCompressSync'),
            brotliDecompressSync: _notImpl('zlib', 'brotliDecompressSync'),
            constants,
            Gunzip, Unzip,
        };
    })(),
    'tty': {
        isatty: os.isatty,
        ReadStream: class ReadStream extends stream.Readable {},
        WriteStream: class WriteStream extends stream.Writable {},
    },
    'module': null, // set below
    'constants': fs.constants,
    'punycode': {
        toASCII(s) { return s; },
        toUnicode(s) { return s; },
    },
    'dns': {
        lookup(hostname, options, cb) {
            if (typeof options === 'function') { cb = options; options = {}; }
            cb(null, '127.0.0.1', 4);
        },
        resolve(hostname, rrtype, cb) {
            if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
            cb(null, ['127.0.0.1']);
        },
    },
    'readline': {
        createInterface(options) {
            const rl = new events.EventEmitter();
            rl.close = () => rl.emit('close');
            rl.question = (query, cb) => { process.stdout.write(query); cb(''); };
            rl.prompt = () => {};
            rl.setPrompt = () => {};
            return rl;
        },
        cursorTo: _cursorTo,
        moveCursor: _moveCursor,
        clearLine: _clearLine,
        clearScreenDown: _clearScreenDown,
    },
    'perf_hooks': {
        performance: {
            now() { return Date.now(); },
            mark() {},
            measure() {},
        },
        PerformanceObserver: class PerformanceObserver { observe() {} disconnect() {} },
    },
    'worker_threads': typeof globalThis.__kandeloCreateWorkerThreads === 'function'
        ? globalThis.__kandeloCreateWorkerThreads(events.EventEmitter)
        : {
            isMainThread: true,
            parentPort: null,
            workerData: null,
            Worker: class Worker {},
        },
    'cluster': {
        isMaster: true,
        isPrimary: true,
        isWorker: false,
    },
    // node:console — exposes the Console class so libs (e.g. undici's mock
    // formatter) can construct a logger backed by arbitrary streams. The
    // global `console` in some engines is not an instance of this class; that
    // matches Node's runtime behaviour (`globalThis.console` is its own
    // singleton, not produced from `new Console`).
    'console': (() => {
        const writeLine = (stream, args) => {
            try {
                stream.write(args.map((a) =>
                    typeof a === 'string' ? a : util.inspect(a)
                ).join(' ') + '\n');
            } catch {}
        };
        class Console {
            constructor(opts) {
                opts = opts || {};
                this._out = opts.stdout || process.stdout;
                this._err = opts.stderr || opts.stdout || process.stderr;
            }
            log(...args) { writeLine(this._out, args); }
            info(...args) { writeLine(this._out, args); }
            debug(...args) { writeLine(this._out, args); }
            warn(...args) { writeLine(this._err, args); }
            error(...args) { writeLine(this._err, args); }
            trace(...args) { writeLine(this._err, ['Trace:', ...args]); }
            dir(obj) { writeLine(this._out, [util.inspect(obj)]); }
            table(data) { writeLine(this._out, [data]); }
            assert(cond, ...args) {
                if (!cond) writeLine(this._err, ['Assertion failed:', ...args]);
            }
            count() {} countReset() {}
            group() {} groupCollapsed() {} groupEnd() {}
            time() {} timeEnd() {} timeLog() {}
            clear() {}
        }
        return { Console, default: Console };
    })(),
    // No async-context tracking. AsyncResource exists so undici can subclass
    // it; runInAsyncScope and bind are pass-throughs. AsyncLocalStorage
    // works as a synchronous Map using a single mutable cell, sufficient
    // for libraries that store request context once and read it back.
    'async_hooks': (() => {
        let _aid = 1;
        class AsyncResource {
            constructor(type, options) {
                this._type = type;
                this._aid = ++_aid;
                this._triggerAid = (options && options.triggerAsyncId) || 0;
            }
            runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); }
            emitDestroy() { return this; }
            asyncId() { return this._aid; }
            triggerAsyncId() { return this._triggerAid; }
            bind(fn) { return fn; }
            static bind(fn) { return fn; }
        }
        class AsyncLocalStorage {
            constructor() { this._store = undefined; }
            run(store, fn, ...args) {
                const prev = this._store;
                this._store = store;
                try { return fn(...args); } finally { this._store = prev; }
            }
            exit(fn, ...args) {
                const prev = this._store;
                this._store = undefined;
                try { return fn(...args); } finally { this._store = prev; }
            }
            getStore() { return this._store; }
            enterWith(store) { this._store = store; }
            disable() { this._store = undefined; }
        }
        return {
            AsyncResource,
            AsyncLocalStorage,
            executionAsyncId: () => 0,
            triggerAsyncId: () => 0,
            executionAsyncResource: () => ({}),
            createHook: () => ({ enable() {}, disable() {} }),
        };
    })(),
    // Undici's request/connect path imports diagnostics_channel at module
    // init for tracing hooks. We're not exporting traces — return inert
    // channels whose publish/subscribe/tracingChannel are no-ops.
    'diagnostics_channel': (() => {
        const makeChannel = (name) => ({
            name,
            hasSubscribers: false,
            publish() {},
            subscribe() {},
            unsubscribe() {},
            bindStore() {},
            unbindStore() {},
            runStores(_data, fn, thisArg, ...args) { return fn.apply(thisArg, args); },
        });
        const makeTracing = (name) => {
            const ch = (sub) => makeChannel(name + ':' + sub);
            return {
                start: ch('start'),
                end: ch('end'),
                asyncStart: ch('asyncStart'),
                asyncEnd: ch('asyncEnd'),
                error: ch('error'),
                hasSubscribers: false,
                traceSync(fn, _ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
                tracePromise(fn, _ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
                traceCallback(fn, position, _ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
            };
        };
        return {
            channel: makeChannel,
            tracingChannel: makeTracing,
            subscribe() {},
            unsubscribe() {},
            hasSubscribers() { return false; },
            Channel: class Channel {},
            TracingChannel: class TracingChannel {},
        };
    })(),
    'v8': {
        // arborist sizes its packument LRU as floor(heap_size_limit * 0.25),
        // so heap_size_limit must be > 0 or lru-cache rejects the config.
        getHeapStatistics() {
            return { heap_size_limit: 256 * 1024 * 1024 };
        },
    },
    'vm': (() => {
        const N = _nodeNative;
        function checkTimeout(o) {
            // Interrupt callbacks are unavailable on spidermonkey-node, so a
            // timeout cannot be honored. Fail loudly rather than silently
            // ignore it (see docs/posix-status.md).
            if (o && o.timeout != null) {
                throw new Error('vm timeout is not supported on spidermonkey-node');
            }
        }
        function normOpts(o) {
            if (typeof o === 'string') o = { filename: o };
            o = o || {};
            checkTimeout(o);
            return { filename: o.filename, lineOffset: o.lineOffset | 0,
                     columnOffset: o.columnOffset | 0,
                     displayErrors: o.displayErrors !== false };
        }
        function cgFlags(o) {
            const cg = (o && o.codeGeneration) || {};
            return { strings: cg.strings, wasm: cg.wasm };
        }
        function createContext(sandbox, options) {
            return N.__kandeloVmMakeContext(sandbox || {}, cgFlags(options));
        }
        function isContext(obj) { return N.__kandeloVmIsContext(obj); }
        function runInContext(code, ctx, options) {
            return N.__kandeloVmRunInContext(String(code), ctx, normOpts(options));
        }
        function runInNewContext(code, sandbox, options) {
            const ctx = createContext(sandbox, options);
            return runInContext(code, ctx, options);
        }
        function runInThisContext(code, options) {
            // Real top-level compile+eval in the caller realm (not bare eval),
            // so filenames/stack frames are faithful.
            const o = normOpts(options);
            const h = N.__kandeloVmCompile(String(code), o);
            return N.__kandeloVmRunInContext(h, globalThis, o);
        }
        class Script {
            constructor(code, options) { this._h = N.__kandeloVmCompile(String(code), normOpts(options)); }
            runInContext(ctx, options) { return N.__kandeloVmRunInContext(this._h, ctx, normOpts(options)); }
            runInNewContext(sandbox, options) { return this.runInContext(createContext(sandbox, options), options); }
            runInThisContext(options) { return N.__kandeloVmRunInContext(this._h, globalThis, normOpts(options)); }
        }
        function compileFunction(code, params, options) {
            const o = options || {};
            const body = '(function(' + ((params || []).join(',')) + '){' + String(code) + '})';
            const ctx = o.parsingContext && isContext(o.parsingContext) ? o.parsingContext : globalThis;
            return N.__kandeloVmRunInContext(body, ctx, normOpts(o));
        }
        return { createContext, isContext, runInContext, runInNewContext,
                 runInThisContext, Script, compileFunction };
    })(),
    // Minimal stubs — undici/file-type/anthropic-sdk import these at module
    // init even when their stream code paths aren't exercised by the agent's
    // actual HTTP transport (which goes through our native socket/tls shim).
    'stream/web': {
        ReadableStream: class ReadableStream {},
        WritableStream: class WritableStream {},
        TransformStream: class TransformStream {},
        ByteLengthQueuingStrategy: class ByteLengthQueuingStrategy {},
        CountQueuingStrategy: class CountQueuingStrategy {},
    },
    'stream/promises': {
        // Sequential pipeline: pump each .pipe() in order; promise resolves
        // when the final destination emits 'finish' (or rejects on error).
        pipeline(...streams) {
            const cb = typeof streams[streams.length - 1] === 'function'
                ? streams.pop() : undefined;
            return new Promise((resolve, reject) => {
                const last = streams[streams.length - 1];
                const onErr = (e) => { cb && cb(e); reject(e); };
                for (let i = 0; i < streams.length - 1; i++) {
                    streams[i].on('error', onErr);
                    streams[i].pipe(streams[i + 1]);
                }
                last.on('error', onErr);
                last.on('finish', () => { cb && cb(); resolve(); });
                last.on('end', () => { cb && cb(); resolve(); });
            });
        },
        finished(stream) {
            return new Promise((resolve, reject) => {
                stream.on('error', reject);
                stream.on('finish', resolve);
                stream.on('end', resolve);
            });
        },
    },
    'stream/consumers': {
        async buffer(stream) {
            const chunks = [];
            for await (const c of stream) chunks.push(Buffer.from(c));
            return Buffer.concat(chunks);
        },
        async text(stream) {
            const buf = await this.buffer(stream);
            return buf.toString('utf8');
        },
        async json(stream) {
            const txt = await this.text(stream);
            return JSON.parse(txt);
        },
        async arrayBuffer(stream) {
            const buf = await this.buffer(stream);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
    },
};

// ------------------------------------------------------------
// Post-registration: builtin exports added for the Claude Code link
// surface (Milestone 2 Phase A, task 1). These mutate the module
// objects/registry entries built above rather than restructure the
// `_builtinModules` object literal, mirroring the `stream/web` patch
// further down (search for `_builtinModules['stream/web']`).
// ------------------------------------------------------------
_builtinModules['path/posix'] = path.posix;
// `path/win32` mirrors `path/posix`: cross-platform code (e.g. Claude Code's
// shell-detection chunk) statically imports both variants and only *calls*
// the win32 one under `process.platform === 'win32'` guards, which are false
// on Kandelo (platform is `linux`). The subpath must still resolve for the
// static import. `path.win32` is a POSIX approximation with `sep: '\\'` (see
// its definition above); real win32 path semantics are tracked future work
// (docs/posix-status.md, node-compat approximate implementations).
_builtinModules['path/win32'] = path.win32;

const _dnsPromises = { lookup: util.promisify(_builtinModules['dns'].lookup) };
_builtinModules['dns'].promises = _dnsPromises;
_builtinModules['dns/promises'] = _dnsPromises;

// `ws` — the WebSocket npm package. Bun ships a native ws-compatible module,
// so Bun-bundled apps (Claude Code) mark `ws` external and expect the runtime
// to provide it; it is not in the bundle or the package. node-compat is that
// runtime layer, so it provides `ws` here. This is a MINIMAL honest module:
// the module object IS the `WebSocket` class (real ws's `module.exports`), so
// `import WebSocket from "ws"` and `require("ws")` resolve and the class,
// static ready-state constants, `instanceof`, and subclassing all work at
// module scope; but *constructing a live WebSocket throws* -- real WebSocket
// I/O over TLS is tracked future work (docs/posix-status.md). Verified via a
// scope probe: `claude -p` imports `ws` but never opens a socket, so this
// unblocks it without faking WebSocket behavior. Graduating this to a full,
// real ws client/server is the deferred follow-up.
_builtinModules['ws'] = (() => {
    function WebSocket() {
        throw new Error('ws (WebSocket client) is not implemented on spidermonkey-node');
    }
    // Static ready-state constants (read at module scope by consumers).
    WebSocket.CONNECTING = 0;
    WebSocket.OPEN = 1;
    WebSocket.CLOSING = 2;
    WebSocket.CLOSED = 3;
    function WebSocketServer() {
        throw new Error('ws (WebSocketServer) is not implemented on spidermonkey-node');
    }
    function createWebSocketStream() {
        throw new Error('ws (createWebSocketStream) is not implemented on spidermonkey-node');
    }
    // real ws attaches these onto the exported WebSocket function.
    WebSocket.WebSocket = WebSocket;
    WebSocket.WebSocketServer = WebSocketServer;
    WebSocket.Server = WebSocketServer;
    WebSocket.createWebSocketStream = createWebSocketStream;
    return WebSocket;
})();

_builtinModules['perf_hooks'].monitorEventLoopDelay = function () {
    return {
        enable() {}, disable() {}, reset() {},
        percentile() { return 0; },
        get min() { return 0; },
        get max() { return 0; },
        get mean() { return 0; },
        get stddev() { return 0; },
        get exceeds() { return 0; },
    };
};

// zlib: async callback wrappers over the existing *Sync implementations,
// plus throwing stubs for the raw-inflate and zstd codecs (not wired
// through the wasm sysroot's libz binding).
_builtinModules['zlib'].deflate = function (buf, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    try {
        const out = _builtinModules['zlib'].deflateSync(buf, opts);
        queueMicrotask(() => cb(null, out));
    } catch (e) { queueMicrotask(() => cb(e)); }
};
_builtinModules['zlib'].inflate = function (buf, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    try {
        const out = _builtinModules['zlib'].inflateSync(buf);
        queueMicrotask(() => cb(null, out));
    } catch (e) { queueMicrotask(() => cb(e)); }
};
_builtinModules['zlib'].inflateRawSync = _notImpl('zlib', 'inflateRawSync');
_builtinModules['zlib'].createZstdDecompress = _notImpl('zlib', 'createZstdDecompress');

// Node exposes `node:module` as the CJS Module class itself: a
// constructor that doubles as the namespace for createRequire / _cache
// / _nodeModulePaths / etc., with a self-ref `Module.Module === Module`.
// jiti's CJS loader does `new Be.Module(filename)` and
// `Be.Module._nodeModulePaths(dir)`, so the shim must be a callable
// function with that static surface attached.
function Module(id, parent) {
    this.id = id || '';
    this.filename = id || '';
    this.loaded = false;
    this.exports = {};
    this.parent = parent || null;
    this.children = [];
    this.paths = id ? Module._nodeModulePaths(path.dirname(id)) : [];
    this.require = (request) => Module.prototype.require.call(this, request);
}
Module.Module = Module;
Module.builtinModules = Object.keys(_builtinModules);
Module.createRequire = function (filename) {
    if (filename && typeof filename === 'object' && filename.href) filename = filename.href;
    if (typeof filename === 'string' && filename.startsWith('file://')) {
        filename = url.fileURLToPath(filename);
    }
    return _makeRequire(filename);
};
Module._cache = {};
Module._extensions = {
    '.js': null,
    '.json': null,
    '.node': null,
};
Module._nodeModulePaths = function (from) {
    const paths = [];
    let dir = from;
    while (true) {
        if (path.basename(dir) !== 'node_modules') {
            paths.push(path.join(dir, 'node_modules'));
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return paths;
};
Module._resolveFilename = function (id, parent) {
    let name = id;
    if (name.startsWith('node:')) name = name.slice(5);
    if (_builtinModules[name] !== undefined) return name;
    const basedir = parent && parent.filename ? path.dirname(parent.filename) : process.cwd();
    const resolvedPath = _resolveFile(id, basedir);
    if (!resolvedPath) {
        const err = new Error(`Cannot find module '${id}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
    }
    return _moduleRealpath(resolvedPath);
};
Module.prototype.require = function (id) {
    const filename = this.filename || this.id || process.cwd() + '/repl';
    return _makeRequire(filename)(id);
};
_builtinModules['module'] = Module;

// `require('process')` and `import 'node:process'` both return the same
// global. Node ships this as a real builtin module; npm's chalk dependency
// (via its vendored supports-color) does `import process from 'node:process'`.
_builtinModules['process'] = process;

// Mode bits for stat(): S_IFDIR / S_IFREG match os.stat() return mode field.
function _isDir(p) {
    const [st, err] = os.stat(p);
    return err === 0 && (st.mode & 0o170000) === 0o40000;
}
function _isReg(p) {
    const [st, err] = os.stat(p);
    return err === 0 && (st.mode & 0o170000) === 0o100000;
}
function _moduleRealpath(p) {
    const [resolved, err] = os.realpath(p);
    return err === 0 ? resolved : p;
}

// Resolve a package directory's main entry: package.json#main → index.js.
// Returns the resolved file path, or null if neither exists.
function _resolvePackageMain(pkgDir) {
    const pkgJson = pkgDir + '/package.json';
    if (_isReg(pkgJson)) {
        try {
            const pkg = JSON.parse(std.loadFile(pkgJson));
            const main = pkg.main || 'index.js';
            const mainPath = path.resolve(pkgDir, main);
            if (_isReg(mainPath)) return mainPath;
            if (_isReg(mainPath + '.js')) return mainPath + '.js';
            if (_isReg(mainPath + '.json')) return mainPath + '.json';
            if (_isReg(mainPath + '/index.js')) return mainPath + '/index.js';
            if (_isReg(mainPath + '/index.json')) return mainPath + '/index.json';
        } catch {}
    }
    if (_isReg(pkgDir + '/index.js')) return pkgDir + '/index.js';
    if (_isReg(pkgDir + '/index.json')) return pkgDir + '/index.json';
    return null;
}

function _resolveFile(id, basedir) {
    // Relative or absolute id: resolve against basedir without node_modules walk.
    // Bare '.' / '..' are valid (sigstore tuf does `require(".")` for sibling index.js).
    const isRelOrAbs = id.startsWith('/') || id.startsWith('./') || id.startsWith('../') ||
        id === '.' || id === '..';
    if (isRelOrAbs) {
        const baseAbs = id.startsWith('/') ? id : basedir + '/' + id;
        const norm = path.normalize(baseAbs);
        // 1. exact file
        if (_isReg(norm)) return norm;
        // 2. file + .js / .json
        if (!id.endsWith('.js') && !id.endsWith('.json') && !id.endsWith('.mjs') && !id.endsWith('.cjs')) {
            if (_isReg(norm + '.js')) return norm + '.js';
            if (_isReg(norm + '.json')) return norm + '.json';
        }
        // 3. directory: package.json#main → index.js
        if (_isDir(norm)) {
            const main = _resolvePackageMain(norm);
            if (main) return main;
        }
        return null;
    }

    // Bare specifier: walk node_modules upward.
    let dir = basedir;
    while (true) {
        const nmDir = dir + '/node_modules/' + id;
        // 1. nmDir as a regular file (rare: node_modules/foo as a single file)
        if (_isReg(nmDir)) return nmDir;
        // 2. nmDir + .js / .json
        if (_isReg(nmDir + '.js')) return nmDir + '.js';
        if (_isReg(nmDir + '.json')) return nmDir + '.json';
        // 3. nmDir is a directory: package.json#main → index.js
        if (_isDir(nmDir)) {
            const main = _resolvePackageMain(nmDir);
            if (main) return main;
        }
        if (dir === '/' || dir === '') break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

// Shared across every _makeRequire — Node's module cache is process-global,
// keyed by absolute resolved path. Without this, circular requires loop
// forever (each module gets its own cache and re-evaluates the cycle).
const _moduleCache = {};

function _stripShebang(source) {
    if (source && source.charCodeAt(0) === 35 && source.charCodeAt(1) === 33) {
        const end = source.indexOf('\n');
        if (end < 0) return '';
        return '//' + source.slice(2);
    }
    return source;
}

function _makeRequire(filename) {
    const basedir = path.dirname(_moduleRealpath(filename || process.cwd() + '/repl'));

    function require(id) {
        // Built-in modules (with or without 'node:' prefix)
        let name = id;
        if (name.startsWith('node:')) name = name.slice(5);
        if (_builtinModules[name] !== undefined) {
            return _builtinModules[name];
        }

        // Resolve file path
        const resolvedPath = _resolveFile(id, basedir);
        if (!resolvedPath) {
            const err = new Error(`Cannot find module '${id}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        const resolved = _moduleRealpath(resolvedPath);

        // Check cache
        if (_moduleCache[resolved]) return _moduleCache[resolved].exports;

        // Load and execute
        let source = std.loadFile(resolved);
        if (source === null) {
            const err = new Error(`Cannot find module '${id}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        source = _stripShebang(source);

        if (resolved.endsWith('.json')) {
            const exports = JSON.parse(source);
            _moduleCache[resolved] = { exports };
            return exports;
        }

        // ESM target: an ES module cannot be CJS-wrapped (its top-level
        // import/export declarations are only valid in module goal, so the
        // wrapper below throws "import declarations may only appear at top
        // level of a module"). Route it through the native module loader so it
        // is CompileModule'd and shares one instance (dedup-safe via the
        // per-path registry) with import and dynamic import(), then return its
        // namespace -- Node require(esm) semantics (named exports as props,
        // default as .default). A ".cjs" file is always CommonJS regardless of
        // the nearest package "type", so it keeps the CJS wrapper below.
        if ((resolved.endsWith('.mjs') || _nearestPackageType(resolved) === 'module') && !resolved.endsWith('.cjs')) {
            // Pass the pre-realpath `resolvedPath`, not the realpath'd
            // `resolved`, to the native seam. The shell ModuleLoader keys its
            // per-path registry by a purely *lexical* normalizePath (no symlink
            // resolution), and `import`/dynamic `import()` reach it with the
            // same pre-realpath specifier path. Realpath'ing here would key the
            // registry differently from import under a symlinked module dir and
            // double-instantiate the module, defeating the shared-instance
            // dedup. The JS-side `_moduleCache` stays realpath-keyed (its own
            // cache, consistent with the check above).
            const ns = _nodeNative.__kandeloRequireModule(resolvedPath);
            _moduleCache[resolved] = { exports: ns };
            return ns;
        }

        // Create module object
        const dirname = path.dirname(resolved);
        const mod = {
            id: resolved,
            filename: resolved,
            loaded: false,
            exports: {},
            children: [],
            paths: Module._nodeModulePaths(dirname),
            require: null,
        };
        _moduleCache[resolved] = mod;

        // Wrap and execute. Compile via evalScriptAsFunction (not `new Function`)
        // so the wrapped script's [[ScriptOrModule]] carries `resolved` — that's
        // what JS_GetScriptOrModuleName returns to the C-side module normalizer
        // when this body calls dynamic `import()`. Without it, bare specifiers
        // (`import('chalk')`) can't tell which node_modules tree to walk.
        const wrappedFn = _nodeNative.evalScriptAsFunction(
            '(function (exports, require, module, __filename, __dirname) {\n' +
                source +
                '\n})',
            resolved
        );

        const childRequire = _makeRequire(resolved);
        mod.require = childRequire;
        try {
            wrappedFn(mod.exports, childRequire, mod, resolved, dirname);
        } catch (e) {
            delete _moduleCache[resolved];
            throw e;
        }
        mod.loaded = true;
        return mod.exports;
    }

    require.resolve = function(id) {
        let name = id;
        if (name.startsWith('node:')) name = name.slice(5);
        if (_builtinModules[name] !== undefined) return name;
        const resolvedPath = _resolveFile(id, basedir);
        if (!resolvedPath) {
            const err = new Error(`Cannot find module '${id}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        return _moduleRealpath(resolvedPath);
    };

    require.cache = _moduleCache;
    require.main = null;

    return require;
}

function _nearestPackageType(filename) {
    let dir = path.dirname(filename);
    while (dir && dir !== '/') {
        const pkgJson = dir + '/package.json';
        if (_isReg(pkgJson)) {
            try {
                const pkg = JSON.parse(std.loadFile(pkgJson));
                if (pkg && typeof pkg.type === 'string') return pkg.type;
            } catch {}
            return '';
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return '';
}

function _looksLikeEsmMain(filename, source) {
    if (filename.endsWith('.mjs')) return true;
    if (filename.endsWith('.cjs')) return false;
    if (_nearestPackageType(filename) === 'module') return true;
    const withoutShebang = _stripShebang(source);
    return /(^|\n)\s*(import\s+(?:[^('"`]|[\r\n])+?\s+from\s*['"]|export\s+)/.test(withoutShebang);
}

function _namedImportBindings(bindings) {
    return bindings
        .replace(/^\s*\{|\}\s*$/g, '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/\s+as\s+/g, ': '))
        .join(', ');
}

let _esmImportTempId = 0;
function _defaultImportBinding(name, moduleRef) {
    return `const ${name} = (${moduleRef} && Object.prototype.hasOwnProperty.call(${moduleRef}, 'default')) ? ${moduleRef}.default : ${moduleRef};`;
}

const _esmRequireBinding = '__kandelo_require';

function _rewriteStaticEsmImports(source) {
    source = source.replace(
        /(^|\n)\s*import\s+([\s\S]*?)\s+from\s*(['"][^'"]+['"])[ \t]*;?/g,
        (match, prefix, clause, specLiteral) => {
            clause = clause.trim();
            if (clause.startsWith('{')) {
                return `${prefix}const { ${_namedImportBindings(clause)} } = ${_esmRequireBinding}(${specLiteral});`;
            }
            if (clause.startsWith('*')) {
                const ns = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
                if (!ns) return match;
                return `${prefix}const ${ns[1]} = ${_esmRequireBinding}(${specLiteral});`;
            }
            const comma = clause.indexOf(',');
            if (comma >= 0) {
                const defaultName = clause.slice(0, comma).trim();
                const named = clause.slice(comma + 1).trim();
                const tmp = `__kandelo_esm_${_esmImportTempId++}`;
                let out = `${prefix}const ${tmp} = ${_esmRequireBinding}(${specLiteral});\n${_defaultImportBinding(defaultName, tmp)}`;
                if (named.startsWith('{')) {
                    out += `\nconst { ${_namedImportBindings(named)} } = ${tmp};`;
                }
                return out;
            }
            return `${prefix}const __kandelo_esm_${_esmImportTempId} = ${_esmRequireBinding}(${specLiteral});\n` +
                _defaultImportBinding(clause, `__kandelo_esm_${_esmImportTempId++}`);
        },
    );
    return source.replace(
        /(^|\n)\s*import\s+(['"][^'"]+['"])[ \t]*;?/g,
        (_match, prefix, specLiteral) => `${prefix}${_esmRequireBinding}(${specLiteral});`,
    );
}

function _runCommonJsMain(filename) {
    const mainRequire = _makeRequire(filename);
    mainRequire(filename);
    if (typeof drainJobQueue === 'function') drainJobQueue();
    process.exit(process.exitCode || 0);
}

function _formatThrownFailure(failure) {
    if (!failure) return String(failure);
    const text = String(failure);
    const name = failure.name ? String(failure.name) : 'Error';
    const message = failure.message ? String(failure.message) : '';
    const headline = message ? `${name}: ${message}` : text;
    const stack = failure.stack ? String(failure.stack) : '';
    if (!stack) return headline;
    if (stack.indexOf(headline) >= 0 || (message && stack.indexOf(message) >= 0)) {
        return stack;
    }
    return headline + '\n' + stack;
}

function _runEsmMain(filename, source) {
    const module = { id: filename, filename, loaded: false, exports: {}, children: [], paths: Module._nodeModulePaths(path.dirname(filename)) };
    const require = _makeRequire(filename);
    module.require = require;
    const dirname = path.dirname(filename);
    const fileUrl = url.pathToFileURL(filename).href;
    const transformed = _rewriteStaticEsmImports(_stripShebang(source))
        .replace(/\bimport\.meta\.url\b/g, JSON.stringify(fileUrl));
    const wrappedFn = _nodeNative.evalScriptAsFunction(
        '(async function () {\n' +
            `const ${_esmRequireBinding} = arguments[0];\n` +
            transformed +
            '\n})',
        filename,
    );
    let settled = false;
    let failure = null;
    Promise.resolve(wrappedFn(require)).then(
        () => { settled = true; },
        (err) => { failure = err; settled = true; },
    );
    let spins = 0;
    while (!settled && typeof drainJobQueue === 'function') {
        drainJobQueue();
        if (++spins > 100000) {
            failure = new Error('ES module main did not settle after draining the SpiderMonkey job queue');
            settled = true;
        }
    }
    if (failure) {
        console.error(_formatThrownFailure(failure));
        process.exitCode = process.exitCode || 1;
    }
    process.exit(process.exitCode || 0);
}

function _runMainScriptIfPresent() {
    if (!_mainScriptPath) return;
    const source = std.loadFile(_mainScriptPath);
    if (source === null) {
        const err = new Error(`Cannot find module '${_mainScriptPath}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
    }
    if (_looksLikeEsmMain(_mainScriptPath, source)) {
        _runEsmMain(_mainScriptPath, source);
    } else {
        _runCommonJsMain(_mainScriptPath);
    }
}

// ============================================================
// Set up globals
// ============================================================

// process.argv is set by the C entry point via execArgv global
if (typeof execArgv !== 'undefined') {
    process.argv = Array.from(execArgv);
    process.argv0 = typeof argv0 !== 'undefined' ? argv0 : (process.argv[0] || 'node');
}

// Global require. For `node script.js`, basedir is the script's directory
// so its top-level relative requires resolve against itself, matching Node's
// per-file require semantics. For -e/-p/REPL (no script in argv), basedir
// falls back to cwd.
globalThis.require = _makeRequire(
    (process.argv && process.argv.length > 1 && process.argv[1] && process.argv[1][0] === '/')
        ? process.argv[1]
        : process.cwd() + '/repl'
);

// --- Native ESM bare-specifier bridge ---------------------------------------
// The SpiderMonkey shell module loader resolves every import specifier as a
// file path. A bare specifier such as `import ... from "fs"` therefore becomes
// `//fs` and fails with "can't open //fs". Node treats a bare specifier (one
// that does not start with "./", "../", or "/") as a builtin or a node_modules
// package. We route those through the existing node-compat resolver so that a
// natively-loaded ES module receives the same object `require()` would return.
//
// The C shell loader (js/src/shell/ModuleLoader.cpp, patched via
// patches/0015-kandelo-esm-bare-specifier.patch) calls __kandeloResolveBare for
// any bare specifier. We return a synthetic module *path* (a stable token) and
// stash the generated ES-module source in __kandeloBareSources under that same
// token; the loader's fetchSource() serves it instead of reading a file. The
// synthetic source reads the real module object back out of __kandeloBareModules
// so the namespace's `default` and named exports are live references to the
// object require() produced. All namespace generation stays here in JS.
globalThis.__kandeloBareModules = Object.create(null);
globalThis.__kandeloBareSources = Object.create(null);

// Identifiers that cannot appear after `export const` (reserved words). Own
// enumerable keys that collide with these are exposed only via the default
// export, matching the safe subset Node's ESM interop provides for CJS.
const _esmReservedNames = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
    'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
    'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
    'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
    'implements', 'interface', 'package', 'private', 'protected', 'public',
    'await',
]);

function _makeBareEsmSource(token, obj) {
    const keyJson = JSON.stringify(token);
    let src = 'const __m = globalThis.__kandeloBareModules[' + keyJson + '];\n' +
        'export default __m;\n';
    if (obj !== null && (typeof obj === 'object' || typeof obj === 'function')) {
        const seen = Object.create(null);
        let keys;
        try {
            keys = Object.keys(obj);
        } catch (_e) {
            keys = [];
        }
        for (const key of keys) {
            if (key === 'default') continue;
            if (seen[key]) continue;
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) continue;
            if (_esmReservedNames.has(key)) continue;
            seen[key] = true;
            src += 'export const ' + key + ' = __m[' + JSON.stringify(key) + '];\n';
        }
    }
    return src;
}

globalThis.__kandeloResolveBare = function (specifier, referrerPath) {
    if (typeof specifier !== 'string' || specifier.length === 0) return null;
    // Only bare specifiers reach here, but guard against relative/absolute in
    // case a caller passes them: those are not our responsibility.
    if (specifier.startsWith('./') || specifier.startsWith('../') ||
        specifier.startsWith('/')) {
        return null;
    }

    let bareName = specifier;
    if (bareName.startsWith('node:')) bareName = bareName.slice(5);

    let token;
    let obj;
    if (_builtinModules[bareName] !== undefined) {
        // Node builtin (with or without the `node:` prefix). Dedup `fs` and
        // `node:fs` onto a single synthetic module.
        token = '/__kandelo_bare__/builtin/' + bareName;
        obj = _builtinModules[bareName];
    } else {
        // node_modules package. Resolve the concrete file so the token (and the
        // native loader's module registry) dedups by real path, then load the
        // object through the ordinary node-compat require so CJS interop and the
        // process-global module cache apply.
        const base = (typeof referrerPath === 'string' && referrerPath.length > 0)
            ? referrerPath
            : (process.cwd() + '/repl');
        const basedir = path.dirname(base);
        let resolvedPath = null;
        try {
            resolvedPath = _resolveFile(specifier, basedir);
        } catch (_e) {
            resolvedPath = null;
        }
        if (!resolvedPath) return null;

        // ESM target: hand the real path back to the native loader so it
        // CompileModules the file (dedup-safe via the native per-path module
        // registry) instead of CJS-wrapping it as a classic script. A CJS
        // wrapper (`_makeRequire`) evaluates the file body as a plain
        // function, so a top-level `import` declaration inside it throws
        // "import declarations may only appear at top level of a module".
        // Returning an absolute path here is handled natively by
        // ModuleLoader.cpp (confirmed: absolute paths bypass the bare-token
        // synthesis below and are read + compiled as a module directly).
        if ((resolvedPath.endsWith('.mjs') || _nearestPackageType(resolvedPath) === 'module') && !resolvedPath.endsWith('.cjs')) {
            return resolvedPath;
        }

        token = '/__kandelo_bare__/pkg' + resolvedPath;
        try {
            obj = _makeRequire(base)(specifier);
        } catch (_e) {
            return null;
        }
    }

    if (globalThis.__kandeloBareSources[token] === undefined) {
        globalThis.__kandeloBareModules[token] = obj;
        globalThis.__kandeloBareSources[token] = _makeBareEsmSource(token, obj);
    }
    return token;
};

// The native ES-module metadata hook (SpiderMonkey shell ModuleLoader.cpp,
// patches/0016-kandelo-import-meta.patch) calls __kandeloModuleMeta with the
// resolved module path and copies the returned url/dirname/require onto
// import.meta. This is the NATIVE import() module system's import.meta — it is
// distinct from _runEsmMain's regex-based import.meta.url string replacement.
// Extracted Bun apps read import.meta.require and import.meta.dirname, so
// populating them here lets those apps run without any source rewriting.
// Returning null lets the C hook keep its default (url = raw path) behavior so
// an unresolvable path stays a visible boundary rather than a silent success.
globalThis.__kandeloModuleMeta = function (resolvedPath) {
    if (typeof resolvedPath !== 'string' || resolvedPath.length === 0) {
        return null;
    }
    let href;
    try {
        href = url.pathToFileURL(resolvedPath).href;
    } catch (_e) {
        return null;
    }
    return {
        url: href,
        dirname: path.dirname(resolvedPath),
        require: _makeRequire(resolvedPath),
    };
};

// Node.js globals
globalThis.process = process;
globalThis.Buffer = Buffer;
globalThis.global = globalThis;
globalThis.GLOBAL = globalThis; // deprecated alias

// Timer globals — overwrite the js_std_add_helpers stubs that return a
// raw int64 with the wrapped-id objects from `timers` above.
globalThis.setTimeout = timers.setTimeout;
globalThis.clearTimeout = timers.clearTimeout;
globalThis.setInterval = timers.setInterval;
globalThis.clearInterval = timers.clearInterval;
globalThis.setImmediate = timers.setImmediate;
globalThis.clearImmediate = timers.clearImmediate;

// npm and hosted-git-info instantiate URL/URLSearchParams directly without
// `require('url')`. Expose the bootstrap shims when the engine does not ship them.
globalThis.URL = url.URL;
globalThis.URLSearchParams = url.URLSearchParams;

// Web platform globals that modern Node exposes by default. undici/whatwg-
// fetch reach for these at module init (e.g. `webidl.is.ReadableStream =
// MakeTypeAssertion(ReadableStream)` in undici/lib/web/webidl/index.js).
// We don't implement real semantics — just need the symbols to exist so
// instanceof checks don't ReferenceError. The agent's --version path
// doesn't actually exercise fetch; once it does, swap these for real impls.
const _streamWeb = _builtinModules['stream/web'];
if (typeof globalThis.ReadableStream === 'undefined')
    globalThis.ReadableStream = _streamWeb.ReadableStream;
if (typeof globalThis.WritableStream === 'undefined')
    globalThis.WritableStream = _streamWeb.WritableStream;
if (typeof globalThis.TransformStream === 'undefined')
    globalThis.TransformStream = _streamWeb.TransformStream;
if (typeof globalThis.ByteLengthQueuingStrategy === 'undefined')
    globalThis.ByteLengthQueuingStrategy = _streamWeb.ByteLengthQueuingStrategy;
if (typeof globalThis.CountQueuingStrategy === 'undefined')
    globalThis.CountQueuingStrategy = _streamWeb.CountQueuingStrategy;
if (typeof globalThis.Blob === 'undefined') globalThis.Blob = class Blob {};
if (typeof globalThis.File === 'undefined') globalThis.File = class File {};
if (typeof globalThis.FormData === 'undefined') globalThis.FormData = class FormData {};
if (typeof globalThis.Headers === 'undefined') globalThis.Headers = class Headers {};
if (typeof globalThis.Request === 'undefined') globalThis.Request = class Request {};
if (typeof globalThis.Response === 'undefined') globalThis.Response = class Response {};
if (typeof globalThis.MessagePort === 'undefined') globalThis.MessagePort = class MessagePort {};
if (typeof globalThis.MessageChannel === 'undefined')
    globalThis.MessageChannel = class MessageChannel {
        constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); }
    };
if (typeof globalThis.BroadcastChannel === 'undefined')
    globalThis.BroadcastChannel = class BroadcastChannel {
        constructor(name) { this.name = name; }
        postMessage() {} close() {}
        addEventListener() {} removeEventListener() {}
    };

// Web Crypto global. Modern Node (19+) exposes `globalThis.crypto` separately
// from `require('crypto')`. uuid/dist-node/rng.js and many other packages
// reach for the bare `crypto.getRandomValues()` here without importing
// anything — undefined crypto → silent rejection during session init.
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = {
        getRandomValues: crypto.getRandomValues,
        randomUUID: crypto.randomUUID,
        // Subtle is left unimplemented; consumers that actually need it
        // will fail loudly, which is preferable to a silent stub.
    };
}

// structuredClone — Node 17+ global. Settings managers and other helpers
// use it to deep-copy plain config objects. Falls back to JSON for the
// JSON-safe values these consumers actually pass; will visibly fail on
// non-JSON types (Date, Map, etc.) which we'd rather not silently mangle.
if (typeof globalThis.structuredClone === 'undefined') {
    globalThis.structuredClone = function structuredClone(value) {
        return JSON.parse(JSON.stringify(value));
    };
}

// AbortController/AbortSignal — used pervasively (undici, anthropic-sdk,
// timers/promises). The bootstrap timers module already references
// AbortSignal in its options bag for setTimeout. A minimal event-emitter-
// style implementation is enough: signal.aborted toggles, listeners fire
// once on abort. Real Node tracks reasons and AbortSignal.timeout() —
// we add timeout() because @anthropic-ai/sdk uses it for request timeouts.
// DOM Event/EventTarget — modern Node exposes these as globals. undici's
// websocket layer subclasses Event and uses EventTarget. We don't dispatch
// events through them in real flows here; just need the symbols so class
// extension works at module init.
if (typeof globalThis.Event === 'undefined') {
    globalThis.Event = class Event {
        constructor(type, init) {
            this.type = type;
            this.bubbles = !!(init && init.bubbles);
            this.cancelable = !!(init && init.cancelable);
            this.composed = !!(init && init.composed);
            this.defaultPrevented = false;
            this.target = null;
            this.currentTarget = null;
            this.timeStamp = Date.now();
        }
        preventDefault() { this.defaultPrevented = true; }
        stopPropagation() {}
        stopImmediatePropagation() {}
    };
}
if (typeof globalThis.EventTarget === 'undefined') {
    globalThis.EventTarget = class EventTarget {
        constructor() { this._lst = new Map(); }
        addEventListener(type, listener) {
            if (!this._lst.has(type)) this._lst.set(type, new Set());
            this._lst.get(type).add(listener);
        }
        removeEventListener(type, listener) {
            const s = this._lst.get(type);
            if (s) s.delete(listener);
        }
        dispatchEvent(ev) {
            const s = this._lst.get(ev.type);
            if (s) for (const l of s) {
                try { typeof l === 'function' ? l.call(this, ev) : l.handleEvent(ev); } catch {}
            }
            return !ev.defaultPrevented;
        }
    };
}
if (typeof globalThis.MessageEvent === 'undefined')
    globalThis.MessageEvent = class MessageEvent extends globalThis.Event {
        constructor(type, init) { super(type, init); this.data = init && init.data; }
    };
if (typeof globalThis.CloseEvent === 'undefined')
    globalThis.CloseEvent = class CloseEvent extends globalThis.Event {
        constructor(type, init) {
            super(type, init);
            this.code = (init && init.code) || 0;
            this.reason = (init && init.reason) || '';
            this.wasClean = !!(init && init.wasClean);
        }
    };
if (typeof globalThis.ErrorEvent === 'undefined')
    globalThis.ErrorEvent = class ErrorEvent extends globalThis.Event {
        constructor(type, init) { super(type, init); this.error = init && init.error; this.message = (init && init.message) || ''; }
    };
if (typeof globalThis.CustomEvent === 'undefined')
    globalThis.CustomEvent = class CustomEvent extends globalThis.Event {
        constructor(type, init) { super(type, init); this.detail = init && init.detail; }
    };
if (typeof globalThis.DOMException === 'undefined') {
    globalThis.DOMException = class DOMException extends Error {
        constructor(message, name) {
            super(message);
            this.name = name || 'Error';
            this.code = 0;
        }
    };
}

if (typeof globalThis.AbortSignal === 'undefined') {
    class AbortSignal {
        constructor() {
            this.aborted = false;
            this.reason = undefined;
            this._listeners = new Set();
        }
        addEventListener(type, listener) {
            if (type === 'abort') this._listeners.add(listener);
        }
        removeEventListener(type, listener) {
            if (type === 'abort') this._listeners.delete(listener);
        }
        dispatchEvent(ev) {
            if (ev && ev.type === 'abort')
                for (const l of this._listeners) l.call(this, ev);
            return true;
        }
        throwIfAborted() { if (this.aborted) throw this.reason; }
        static abort(reason) {
            const s = new AbortSignal();
            s.aborted = true;
            s.reason = reason;
            return s;
        }
        static timeout(ms) {
            const s = new AbortSignal();
            timers.setTimeout(() => {
                s.aborted = true;
                s.reason = new Error('The operation was aborted due to timeout');
                s.reason.name = 'TimeoutError';
                for (const l of s._listeners) {
                    try { l.call(s, { type: 'abort', target: s }); } catch {}
                }
            }, ms);
            return s;
        }
        static any(signals) {
            const s = new AbortSignal();
            for (const sig of signals) {
                if (sig.aborted) { s.aborted = true; s.reason = sig.reason; return s; }
                sig.addEventListener('abort', () => {
                    if (s.aborted) return;
                    s.aborted = true;
                    s.reason = sig.reason;
                    for (const l of s._listeners) {
                        try { l.call(s, { type: 'abort', target: s }); } catch {}
                    }
                });
            }
            return s;
        }
    }
    globalThis.AbortSignal = AbortSignal;
}
if (typeof globalThis.AbortController === 'undefined') {
    globalThis.AbortController = class AbortController {
        constructor() { this.signal = new globalThis.AbortSignal(); }
        abort(reason) {
            const s = this.signal;
            if (s.aborted) return;
            s.aborted = true;
            s.reason = reason !== undefined ? reason : new Error('aborted');
            for (const l of s._listeners) {
                try { l.call(s, { type: 'abort', target: s }); } catch {}
            }
        }
    };
}

// Some engines ship without ECMA-402 (Intl). TUIs use Intl.Segmenter for
// grapheme-based terminal-width math; a per-code-point fallback is good
// enough for ASCII / BMP — non-trivial graphemes (emoji ZWJ sequences,
// combining marks) collapse to multiple segments, which most UIs tolerate.
if (typeof globalThis.Intl === 'undefined') {
    globalThis.Intl = {
        Segmenter: class Segmenter {
            constructor(_locale, _options) {}
            segment(input) {
                const s = String(input);
                return {
                    [Symbol.iterator]: function* () {
                        let i = 0;
                        for (const ch of s) {
                            yield { segment: ch, index: i, input: s };
                            i += ch.length;
                        }
                    },
                };
            }
        },
        Collator: class Collator {
            constructor(_l, _o) {}
            compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
        },
        DateTimeFormat: class DateTimeFormat {
            constructor(_l, _o) {}
            format(date) { return new Date(date).toISOString(); }
        },
        NumberFormat: class NumberFormat {
            constructor(_l, _o) {}
            format(n) { return String(n); }
        },
    };
}

// __dirname and __filename for the main module (set when running a file)
const _mainScriptArg =
    process.argv && process.argv.length > 1 && process.argv[1] && process.argv[1][0] === '/'
        ? process.argv[1]
        : '';
const _mainScriptPath = _mainScriptArg ? _moduleRealpath(_mainScriptArg) : '';
globalThis.__filename = _mainScriptPath;
globalThis.__dirname = _mainScriptPath ? path.dirname(_mainScriptPath) : '';

// Module reference
globalThis.module = { exports: {} };
globalThis.exports = globalThis.module.exports;

// console may already exist, but ensure it has all methods.
// Some engine helpers ship only console.log; npm and most Node
// code expect .error/.warn to land on stderr.
if (!console.error) {
    console.error = (...args) => {
        process.stderr.write(args.map((a) => typeof a === 'string' ? a : util.inspect(a)).join(' ') + '\n');
    };
}
if (!console.warn) console.warn = console.error;
if (!console.debug) console.debug = console.log;
if (!console.info) console.info = console.log;
if (!console.dir) console.dir = (obj) => console.log(util.inspect(obj));
if (!console.time) {
    const _timers = {};
    console.time = (label) => { _timers[label || 'default'] = Date.now(); };
    console.timeEnd = (label) => {
        label = label || 'default';
        const ms = Date.now() - (_timers[label] || Date.now());
        delete _timers[label];
        console.log(`${label}: ${ms}ms`);
    };
    console.timeLog = (label) => {
        label = label || 'default';
        const ms = Date.now() - (_timers[label] || Date.now());
        console.log(`${label}: ${ms}ms`);
    };
}
if (!console.assert) {
    console.assert = (cond, ...args) => { if (!cond) console.error('Assertion failed:', ...args); };
}
if (!console.count) {
    const _counts = {};
    console.count = (label) => { label = label || 'default'; _counts[label] = (_counts[label] || 0) + 1; console.log(`${label}: ${_counts[label]}`); };
    console.countReset = (label) => { _counts[label || 'default'] = 0; };
}
if (!console.table) {
    console.table = (data) => console.log(data);
}
if (!console.group) {
    let _depth = 0;
    console.group = (...args) => { if (args.length) console.log(...args); _depth++; };
    console.groupEnd = () => { if (_depth > 0) _depth--; };
}

// ============================================================
// WHATWG fetch + Headers/Response/Request/ReadableStream
// ============================================================
//
// Bootstrap reserves stub globals for these (Response/Headers/Request) and a
// stub `class ReadableStream {}` from the stream/web pseudo-module. None of
// them actually do anything. Modern HTTP SDKs (undici, @anthropic-ai/sdk,
// the AWS SDK, etc.) call `fetch(url, { method:'POST', body, headers })`
// and read the response via `await res.json()` or `res.body.getReader()`
// (for streaming SSE). Without a real impl, fetch() ReferenceErrors. The
// implementation is built on top of the existing http/https modules above.
//
(() => {
    class FetchHeaders {
        constructor(init) {
            this._map = new Map();
            if (init instanceof FetchHeaders) {
                for (const [k, v] of init._map) this._map.set(k, v);
            } else if (Array.isArray(init)) {
                for (const [k, v] of init) this.append(k, v);
            } else if (init && typeof init === 'object') {
                for (const k of Object.keys(init)) this.append(k, init[k]);
            }
        }
        _k(name) { return String(name).toLowerCase(); }
        get(name) { const v = this._map.get(this._k(name)); return v === undefined ? null : v; }
        set(name, value) { this._map.set(this._k(name), String(value)); }
        has(name) { return this._map.has(this._k(name)); }
        delete(name) { return this._map.delete(this._k(name)); }
        append(name, value) {
            const k = this._k(name);
            const cur = this._map.get(k);
            this._map.set(k, cur === undefined ? String(value) : cur + ', ' + value);
        }
        forEach(cb, thisArg) {
            for (const [k, v] of this._map) cb.call(thisArg, v, k, this);
        }
        keys() { return this._map.keys(); }
        values() { return this._map.values(); }
        entries() { return this._map.entries(); }
        [Symbol.iterator]() { return this._map.entries(); }
    }

    // Minimal ReadableStream impl. Supports getReader().read(), async
    // iteration, cancel, and the start({enqueue, close, error}) underlying
    // source pattern used below. Not spec-perfect (no backpressure, no
    // tee()) but enough for SSE consumption.
    class MinReadableStream {
        constructor(source) {
            this._source = source || {};
            this._queue = [];
            this._closed = false;
            this._err = null;
            this._waiters = [];
            this._locked = false;
            const ctrl = {
                enqueue: (chunk) => {
                    if (this._closed) return;
                    if (this._waiters.length > 0) {
                        this._waiters.shift().resolve({ value: chunk, done: false });
                    } else {
                        this._queue.push(chunk);
                    }
                },
                close: () => {
                    this._closed = true;
                    while (this._waiters.length > 0) {
                        this._waiters.shift().resolve({ value: undefined, done: true });
                    }
                },
                error: (e) => {
                    this._err = e;
                    this._closed = true;
                    while (this._waiters.length > 0) this._waiters.shift().reject(e);
                },
                get desiredSize() { return 1; },
            };
            if (this._source.start) {
                try {
                    const r = this._source.start(ctrl);
                    if (r && typeof r.then === 'function') r.catch(e => ctrl.error(e));
                } catch (e) { ctrl.error(e); }
            }
        }
        get locked() { return this._locked; }
        getReader() {
            if (this._locked) throw new TypeError('Stream is locked');
            this._locked = true;
            const stream = this;
            return {
                read: () => {
                    if (stream._err) return Promise.reject(stream._err);
                    if (stream._queue.length > 0) {
                        return Promise.resolve({ value: stream._queue.shift(), done: false });
                    }
                    if (stream._closed) return Promise.resolve({ value: undefined, done: true });
                    return new Promise((resolve, reject) => {
                        stream._waiters.push({ resolve, reject });
                    });
                },
                releaseLock: () => { stream._locked = false; },
                cancel: (reason) => {
                    stream._closed = true;
                    try { stream._source.cancel && stream._source.cancel(reason); } catch {}
                    return Promise.resolve();
                },
            };
        }
        [Symbol.asyncIterator]() {
            const reader = this.getReader();
            return {
                next: () => reader.read(),
                return: () => { reader.releaseLock(); return Promise.resolve({ value: undefined, done: true }); },
                [Symbol.asyncIterator]() { return this; },
            };
        }
        cancel(reason) {
            this._closed = true;
            try { this._source.cancel && this._source.cancel(reason); } catch {}
            return Promise.resolve();
        }
    }

    class FetchResponse {
        constructor(body, init = {}) {
            this.status = init.status !== undefined ? init.status : 200;
            this.statusText = init.statusText || '';
            this.ok = this.status >= 200 && this.status < 300;
            this.headers = init.headers instanceof FetchHeaders
                ? init.headers : new FetchHeaders(init.headers);
            this.url = init.url || '';
            this.redirected = !!init.redirected;
            this.type = init.type || 'basic';
            this._bodyUsed = false;
            this._buffered = null;     // Uint8Array, if body was given as bytes/string
            this._stream = null;       // MinReadableStream, if body was given as a stream
            if (body == null) {
                /* empty */
            } else if (body instanceof MinReadableStream) {
                this._stream = body;
            } else if (body instanceof Uint8Array) {
                this._buffered = body;
            } else if (body instanceof ArrayBuffer) {
                this._buffered = new Uint8Array(body);
            } else if (typeof body === 'string') {
                this._buffered = new TextEncoder().encode(body);
            } else {
                this._buffered = new TextEncoder().encode(String(body));
            }
        }
        get bodyUsed() { return this._bodyUsed; }
        get body() {
            if (this._stream) return this._stream;
            if (this._buffered) {
                const bytes = this._buffered;
                this._stream = new MinReadableStream({
                    start(c) { c.enqueue(bytes); c.close(); },
                });
                this._buffered = null;
                return this._stream;
            }
            return null;
        }
        async arrayBuffer() {
            if (this._bodyUsed) throw new TypeError('Body already used');
            this._bodyUsed = true;
            if (this._buffered) {
                const b = this._buffered;
                return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
            }
            if (this._stream) {
                const reader = this._stream.getReader();
                const parts = [];
                let total = 0;
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
                    parts.push(u8);
                    total += u8.byteLength;
                }
                const out = new Uint8Array(total);
                let off = 0;
                for (const p of parts) { out.set(p, off); off += p.byteLength; }
                return out.buffer;
            }
            return new ArrayBuffer(0);
        }
        async text() {
            const ab = await this.arrayBuffer();
            return new TextDecoder('utf-8').decode(ab);
        }
        async json() {
            const t = await this.text();
            return JSON.parse(t);
        }
        async bytes() { return new Uint8Array(await this.arrayBuffer()); }
        async blob() {
            const ab = await this.arrayBuffer();
            return { size: ab.byteLength, type: this.headers.get('content-type') || '',
                     arrayBuffer: async () => ab, text: async () => new TextDecoder().decode(ab) };
        }
        clone() {
            // Only safe when body is still buffered. After a stream has been
            // consumed there's nothing left to clone — anthropic-sdk clones
            // before reading the body, so this is OK in practice.
            if (this._stream) throw new TypeError('Cannot clone Response whose body is a stream');
            const init = {
                status: this.status, statusText: this.statusText, url: this.url,
                headers: new FetchHeaders(this.headers),
            };
            return new FetchResponse(this._buffered ? this._buffered.slice() : null, init);
        }
    }

    class FetchRequest {
        constructor(input, init = {}) {
            if (input instanceof FetchRequest) {
                this.url = input.url;
                this.method = (init.method || input.method || 'GET').toUpperCase();
                this.headers = new FetchHeaders(init.headers || input.headers);
                this.body = init.body !== undefined ? init.body : input.body;
                this.signal = init.signal || input.signal || null;
            } else {
                this.url = typeof input === 'string' ? input : (input && input.url);
                this.method = (init.method || 'GET').toUpperCase();
                this.headers = new FetchHeaders(init.headers || {});
                this.body = init.body !== undefined ? init.body : null;
                this.signal = init.signal || null;
            }
        }
    }

    async function fetch(input, init) {
        init = init || {};
        let urlStr;
        let mergedHeaders;
        let bodyIn;
        let signal;
        let method;
        if (input instanceof FetchRequest) {
            urlStr = input.url;
            mergedHeaders = new FetchHeaders(input.headers);
            if (init.headers) for (const [k, v] of new FetchHeaders(init.headers)._map) mergedHeaders.set(k, v);
            bodyIn = init.body !== undefined ? init.body : input.body;
            signal = init.signal || input.signal;
            method = (init.method || input.method || 'GET').toUpperCase();
        } else {
            urlStr = typeof input === 'string' ? input : (input && input.url);
            mergedHeaders = new FetchHeaders(init.headers);
            bodyIn = init.body;
            signal = init.signal;
            method = (init.method || 'GET').toUpperCase();
        }
        if (!urlStr) throw new TypeError('fetch: invalid input');

        const parsed = new URL(urlStr);
        const client = parsed.protocol === 'https:' ? https : http;
        const port = parsed.port ? parseInt(parsed.port, 10)
            : (parsed.protocol === 'https:' ? 443 : 80);

        // Reduce headers to plain object for http.request
        const headerObj = {};
        for (const [k, v] of mergedHeaders._map) headerObj[k] = v;

        let bodyBuf = null;
        if (bodyIn != null) {
            if (typeof bodyIn === 'string') bodyBuf = Buffer.from(bodyIn, 'utf8');
            else if (bodyIn instanceof Uint8Array) bodyBuf = Buffer.from(bodyIn.buffer, bodyIn.byteOffset, bodyIn.byteLength);
            else if (bodyIn instanceof ArrayBuffer) bodyBuf = Buffer.from(bodyIn);
            else if (Buffer.isBuffer && Buffer.isBuffer(bodyIn)) bodyBuf = bodyIn;
            else bodyBuf = Buffer.from(String(bodyIn), 'utf8');
            if (bodyBuf && !headerObj['content-length'] && !headerObj['transfer-encoding']) {
                headerObj['content-length'] = String(bodyBuf.length);
            }
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let resStream = null;
            let resCtrl = null;

            const req = client.request({
                protocol: parsed.protocol,
                host: parsed.hostname,
                hostname: parsed.hostname,
                port,
                path: parsed.pathname + parsed.search,
                method,
                headers: headerObj,
            }, (res) => {
                if (settled) return;
                settled = true;

                resStream = new MinReadableStream({
                    start(c) {
                        resCtrl = c;
                        res.on('data', (chunk) => {
                            try {
                                const u8 = chunk instanceof Uint8Array ? chunk
                                    : (chunk && chunk.buffer ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                                       : new TextEncoder().encode(String(chunk)));
                                c.enqueue(u8);
                            } catch (e) { c.error(e); }
                        });
                        res.on('end', () => { try { c.close(); } catch {} });
                        res.on('error', (e) => { try { c.error(e); } catch {} });
                    },
                    cancel() { try { res.destroy(); } catch {} },
                });

                const respHeaders = new FetchHeaders();
                for (const k of Object.keys(res.headers || {})) {
                    const v = res.headers[k];
                    if (Array.isArray(v)) for (const x of v) respHeaders.append(k, x);
                    else if (v !== undefined) respHeaders.set(k, v);
                }
                resolve(new FetchResponse(resStream, {
                    status: res.statusCode || 0,
                    statusText: res.statusMessage || '',
                    headers: respHeaders,
                    url: urlStr,
                }));
            });

            req.on('error', (e) => {
                if (settled) {
                    if (resCtrl) try { resCtrl.error(e); } catch {}
                    return;
                }
                settled = true;
                reject(e);
            });

            if (signal && typeof signal.addEventListener === 'function') {
                const onAbort = () => {
                    try { req.destroy(new Error('Aborted')); } catch {}
                    if (settled) {
                        if (resCtrl) try { resCtrl.error(new DOMException('Aborted', 'AbortError')); } catch {}
                    } else {
                        settled = true;
                        reject(new DOMException('Aborted', 'AbortError'));
                    }
                };
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, { once: true });
            }

            if (bodyBuf) req.write(bodyBuf);
            req.end();
        });
    }

    globalThis.fetch = fetch;
    globalThis.Headers = FetchHeaders;
    globalThis.Response = FetchResponse;
    globalThis.Request = FetchRequest;
    globalThis.ReadableStream = MinReadableStream;
    // The `node:stream/web` pseudo-module also surfaces ReadableStream;
    // some libraries import from there instead of the global. Replace the
    // stub class with the real one.
    if (_builtinModules['stream/web']) {
        _builtinModules['stream/web'].ReadableStream = MinReadableStream;
    }
})();

// Export for the C entry point to detect successful bootstrap
globalThis.__nodeBootstrapReady = true;

_runMainScriptIfPresent();
