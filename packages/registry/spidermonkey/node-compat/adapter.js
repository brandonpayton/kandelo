// SpiderMonkey adapter for the shared Node compatibility bootstrap.
//
// The shared compatibility layer is intentionally the source of truth for
// the JavaScript-level Node module shims. This prefix supplies the qjs-shaped
// std, os, and native surfaces that bootstrap expects, backed by the
// SpiderMonkey shell and Kandelo POSIX helpers.
(function () {
    if (typeof globalThis.queueMicrotask !== 'function') {
        globalThis.queueMicrotask = function queueMicrotask(callback) {
            Promise.resolve().then(() => callback());
        };
    }

    const shellOs = globalThis.os || {};
    const shellFile = shellOs.file || {};
    const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
    const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
    const nativeJsonParse = JSON.parse.bind(JSON);
    let nextTimerId = 1;
    const pendingTimers = new Map();

    function encodeUtf8(value) {
        value = String(value);
        if (encoder) return encoder.encode(value);
        const out = [];
        for (let i = 0; i < value.length; i++) {
            let code = value.charCodeAt(i);
            if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
                const low = value.charCodeAt(i + 1);
                if (low >= 0xdc00 && low <= 0xdfff) {
                    code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
                    i++;
                }
            }
            if (code < 0x80) out.push(code);
            else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
            else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
        return new Uint8Array(out);
    }

    function decodeUtf8(value) {
        if (value == null) return '';
        const bytes = value instanceof Uint8Array ? value :
            value instanceof ArrayBuffer ? new Uint8Array(value) :
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (decoder) return decoder.decode(bytes);
        let out = '';
        for (const b of bytes) out += String.fromCharCode(b);
        try { return decodeURIComponent(escape(out)); } catch (_) { return out; }
    }

    function errnoFromError(error, fallback) {
        const message = String(error && (error.message || error));
        const match = message.match(/errno\s+(-?\d+)/i);
        return match ? Math.abs(Number(match[1])) : fallback;
    }

    function pathToString(path) {
        if (typeof path === 'string') return path;
        if (path && typeof path.pathname === 'string') return path.pathname;
        if (path instanceof Uint8Array) return decodeUtf8(path);
        return String(path);
    }

    function readFileBytes(path) {
        const data = shellFile.readFile(pathToString(path), 'binary');
        if (typeof data === 'string') return encodeUtf8(data);
        return data instanceof Uint8Array ? data : new Uint8Array(data);
    }

    function readFileText(path) {
        const data = shellFile.readFile(pathToString(path));
        return typeof data === 'string' ? data : decodeUtf8(data);
    }

    function makeMemoryFile(path) {
        const bytes = readFileBytes(path);
        let offset = 0;
        return {
            tell() { return offset; },
            seek(pos, whence) {
                whence = whence === undefined ? std.SEEK_SET : whence;
                if (whence === std.SEEK_SET) offset = pos;
                else if (whence === std.SEEK_CUR) offset += pos;
                else if (whence === std.SEEK_END) offset = bytes.byteLength + pos;
                if (offset < 0) offset = 0;
                if (offset > bytes.byteLength) offset = bytes.byteLength;
            },
            read(buffer, byteOffset, length) {
                const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
                byteOffset = byteOffset || 0;
                length = length === undefined ? view.byteLength - byteOffset : length;
                const n = Math.max(0, Math.min(length, bytes.byteLength - offset));
                view.set(bytes.subarray(offset, offset + n), byteOffset);
                offset += n;
                return n;
            },
            getline() {
                if (offset >= bytes.byteLength) return null;
                let end = offset;
                while (end < bytes.byteLength && bytes[end] !== 10) end++;
                const line = decodeUtf8(bytes.subarray(offset, end));
                offset = end < bytes.byteLength ? end + 1 : end;
                return line;
            },
            close() { offset = bytes.byteLength; return 0; },
        };
    }

    function writeFd(fd, data) {
        const bytes = typeof data === 'string' ? encodeUtf8(data) :
            data instanceof Uint8Array ? data :
            data instanceof ArrayBuffer ? new Uint8Array(data) :
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (typeof shellOs.write === 'function') {
            return shellOs.write(fd, bytes.buffer, bytes.byteOffset, bytes.byteLength);
        }
        if (fd === 2 && typeof printErr === 'function') printErr(decodeUtf8(bytes).replace(/\n$/, ''));
        else if (typeof putstr === 'function') putstr(decodeUtf8(bytes));
        else if (typeof print === 'function') print(decodeUtf8(bytes).replace(/\n$/, ''));
        return bytes.byteLength;
    }

    function tupleFromFileCall(fn, fallbackErrno) {
        try { return [fn(), 0]; } catch (error) { return [null, errnoFromError(error, fallbackErrno)]; }
    }

    const std = {
        SEEK_SET: 0,
        SEEK_CUR: 1,
        SEEK_END: 2,
        getenv(key) {
            if (typeof shellOs.getenv !== 'function') return null;
            const value = shellOs.getenv(String(key));
            return value === undefined ? null : value;
        },
        setenv(key, value) {
            // Keep process.env mutations in the shared JS bootstrap's env
            // object. SpiderMonkey's wasm shell inherits Mozilla setenv
            // interposition machinery that aborts when user JS calls through
            // to libc setenv(), and npm mutates process.env during startup.
            void key;
            void value;
        },
        unsetenv(key) {
            void key;
        },
        exit(code) {
            if (typeof quit === 'function') quit(code | 0);
            throw new Error('exit ' + (code | 0));
        },
        loadFile(path) {
            try { return readFileText(path); } catch (_) { return null; }
        },
        open(path, mode) {
            mode = mode || 'r';
            if (!/^r|rb$/.test(mode)) return null;
            try { return makeMemoryFile(path); } catch (_) { return null; }
        },
        popen(command) {
            const result = typeof shellOs.popenRead === 'function'
                ? shellOs.popenRead(String(command))
                : { output: '', status: typeof shellOs.system === 'function' ? shellOs.system(String(command)) : 127 };
            const lines = String(result.output || '').split('\n');
            let index = 0;
            return {
                getline() {
                    if (index >= lines.length) return null;
                    const line = lines[index++];
                    if (index === lines.length && line === '') return null;
                    return line;
                },
                close() { return result.status || 0; },
            };
        },
        out: { puts(data) { writeFd(1, data); }, flush() {} },
        err: { puts(data) { writeFd(2, data); }, flush() {} },
    };

    const os = {
        O_RDONLY: 0,
        O_WRONLY: 1,
        O_RDWR: 2,
        O_CREAT: 0o100,
        O_EXCL: 0o200,
        O_TRUNC: 0o1000,
        O_APPEND: 0o2000,
        getcwd() {
            try { return [typeof shellOs.getcwd === 'function' ? shellOs.getcwd() : '/', 0]; }
            catch (error) { return [null, errnoFromError(error, 2)]; }
        },
        chdir(path) { return typeof shellOs.chdir === 'function' ? shellOs.chdir(pathToString(path)) : -2; },
        getpid() { return typeof shellOs.getpid === 'function' ? shellOs.getpid() : 1; },
        kill(pid, signal) { if (typeof shellOs.kill === 'function') return shellOs.kill(pid, signal); return 0; },
        stat(path) { return tupleFromFileCall(() => shellFile.stat(pathToString(path)), 2); },
        lstat(path) { return tupleFromFileCall(() => shellFile.lstat(pathToString(path)), 2); },
        readdir(path) { return tupleFromFileCall(() => shellFile.listDir(pathToString(path)), 2); },
        mkdir(path, mode) { return typeof shellFile.mkdir === 'function' ? shellFile.mkdir(pathToString(path), mode || 0o777) : -38; },
        remove(path) { return typeof shellFile.remove === 'function' ? shellFile.remove(pathToString(path)) : -38; },
        rename(oldPath, newPath) { return typeof shellFile.rename === 'function' ? shellFile.rename(pathToString(oldPath), pathToString(newPath)) : -38; },
        symlink(target, linkpath) { return typeof shellFile.symlink === 'function' ? shellFile.symlink(pathToString(target), pathToString(linkpath)) : -38; },
        readlink(path) { return tupleFromFileCall(() => shellFile.readlink(pathToString(path)), 22); },
        realpath(path) { return tupleFromFileCall(() => shellFile.realpath(pathToString(path)), 2); },
        utimes(path, atime, mtime) { return typeof shellFile.utimes === 'function' ? shellFile.utimes(pathToString(path), atime, mtime) : 0; },
        open(path, flags, mode) { return typeof shellOs.open === 'function' ? shellOs.open(pathToString(path), flags, mode || 0o666) : -38; },
        close(fd) { return typeof shellOs.close === 'function' ? shellOs.close(fd) : 0; },
        read(fd, buffer, byteOffset, length) { return typeof shellOs.read === 'function' ? shellOs.read(fd, buffer, byteOffset || 0, length) : -38; },
        write(fd, buffer, byteOffset, length) { return writeFd(fd, new Uint8Array(buffer, byteOffset || 0, length)); },
        seek(fd, offset, whence) { return typeof shellOs.seek === 'function' ? shellOs.seek(fd, offset, whence) : -38; },
        fstat(fd) { return typeof shellOs.fstat === 'function' ? shellOs.fstat(fd) : [null, 38]; },
        isatty(fd) { return typeof shellOs.isatty === 'function' ? shellOs.isatty(fd) : false; },
        ttyGetWinSize(fd) { return typeof shellOs.ttyGetWinSize === 'function' ? shellOs.ttyGetWinSize(fd) : null; },
        signal() {},
        setReadHandler() {},
        setTimeout(fn, delay) {
            const id = nextTimerId++;
            const ms = Math.max(0, Number(delay) || 0);
            pendingTimers.set(id, { fn, due: Date.now() + ms });
            if (ms === 0) {
                queueMicrotask(() => runTimer(id));
            }
            return id;
        },
        clearTimeout(id) { pendingTimers.delete(id); },
    };

    function runTimer(id) {
        const timer = pendingTimers.get(id);
        if (!timer) return false;
        pendingTimers.delete(id);
        timer.fn();
        return true;
    }

    function runDueTimers() {
        let ran = 0;
        while (true) {
            const now = Date.now();
            const dueIds = [];
            for (const [id, timer] of pendingTimers) {
                if (timer.due <= now) dueIds.push(id);
            }
            if (dueIds.length === 0) break;
            for (const id of dueIds) {
                if (runTimer(id)) ran++;
            }
        }
        return ran;
    }

    function nextTimerDelay() {
        let next = Infinity;
        const now = Date.now();
        for (const timer of pendingTimers.values()) {
            if (timer.due < next) next = timer.due;
        }
        return next === Infinity ? null : Math.max(0, next - now);
    }

    globalThis.__kandeloRunDueTimers = runDueTimers;
    globalThis.__kandeloNextTimerDelay = nextTimerDelay;

    globalThis.__kandeloCreateWorkerThreads = function(EventEmitter) {
        class MessagePort extends EventEmitter {
            postMessage() {}
            start() {}
            close() { this.emit('close'); }
            ref() { return this; }
            unref() { return this; }
        }
        class MessageChannel {
            constructor() {
                this.port1 = new MessagePort();
                this.port2 = new MessagePort();
            }
        }
        function clearSharedWorkerData() {
            if (typeof setSharedObject === 'function') {
                try { setSharedObject(null); } catch {}
            }
        }
        function joinShellWorkers() {
            if (typeof joinWorkerThreads === 'function') {
                try { joinWorkerThreads(); } catch {}
            }
        }
        class Worker extends EventEmitter {
            constructor(filenameOrSource, options) {
                super();
                options = options || {};
                let source = String(filenameOrSource);
                if (!options.eval) {
                    const loaded = std.loadFile(source);
                    if (loaded == null) throw new Error('Cannot find module ' + source);
                    source = loaded;
                }

                let workerDataExpression = 'undefined';
                if (Object.prototype.hasOwnProperty.call(options, 'workerData')) {
                    const data = options.workerData;
                    if (data instanceof SharedArrayBuffer ||
                        (typeof WebAssembly === 'object' && WebAssembly.Memory && data instanceof WebAssembly.Memory)) {
                        if (typeof setSharedObject !== 'function') {
                            throw new Error('SpiderMonkey shared worker mailbox is unavailable');
                        }
                        setSharedObject(data);
                        workerDataExpression = 'getSharedObject()';
                    } else {
                        workerDataExpression = JSON.stringify(data);
                    }
                } else if (typeof setSharedObject === 'function') {
                    setSharedObject(null);
                }

                const prelude = [
                    'var workerData = ' + workerDataExpression + ';',
                    'var parentPort = null;',
                    'var require = function(name) {',
                    '  if (name === "worker_threads" || name === "node:worker_threads") {',
                    '    return { isMainThread: false, parentPort: parentPort, workerData: workerData };',
                    '  }',
                    '  throw new Error("Cannot find module " + name);',
                    '};',
                    'var module = { exports: {} };',
                    'var exports = module.exports;',
                ].join('\n');

                if (typeof evalInWorker !== 'function') {
                    throw new Error('SpiderMonkey evalInWorker is unavailable');
                }
                evalInWorker(prelude + '\n' + source + '\n');
                const defer = typeof queueMicrotask === 'function'
                    ? queueMicrotask
                    : (fn) => Promise.resolve().then(fn);
                defer(() => this.emit('online'));
            }
            postMessage() {
                throw new Error('Worker.postMessage is not implemented in the SpiderMonkey shell adapter');
            }
            terminate() {
                clearSharedWorkerData();
                joinShellWorkers();
                this.emit('exit', 0);
                return Promise.resolve(0);
            }
            ref() { return this; }
            unref() { return this; }
        }
        return {
            isMainThread: true,
            parentPort: null,
            workerData: null,
            Worker,
            MessageChannel,
            MessagePort,
            SHARE_ENV: Symbol.for('kandelo.worker_threads.SHARE_ENV'),
        };
    };

    const native = globalThis.__kandeloNodeNative || {};
    const _nodeNative = {
        evalScriptAsFunction(source, filename) {
            if (typeof native.evalScriptAsFunction === 'function') {
                return native.evalScriptAsFunction(source, filename);
            }
            return (0, eval)(source + '\n//# sourceURL=' + filename);
        },
        decodeUtf8(bytes) { return decodeUtf8(bytes); },
        jsonParse(text) { return nativeJsonParse(text); },
        __kandeloRequireModule(path) {
            if (typeof native.__kandeloRequireModule !== 'function') {
                throw new Error('native __kandeloRequireModule is unavailable');
            }
            return native.__kandeloRequireModule(path);
        },
        __kandeloZstdDecompress(bytes) {
            if (typeof native.__kandeloZstdDecompress !== 'function') throw new Error('native __kandeloZstdDecompress is unavailable');
            return native.__kandeloZstdDecompress(bytes);
        },
        __kandeloVmMakeContext(sandbox, opts) {
            if (typeof native.__kandeloVmMakeContext !== 'function') throw new Error('native __kandeloVmMakeContext is unavailable');
            return native.__kandeloVmMakeContext(sandbox, opts);
        },
        __kandeloVmIsContext(obj) { return typeof native.__kandeloVmIsContext === 'function' && native.__kandeloVmIsContext(obj); },
        __kandeloVmRunInContext(codeOrScript, ctx, opts) {
            if (typeof native.__kandeloVmRunInContext !== 'function') throw new Error('native __kandeloVmRunInContext is unavailable');
            return native.__kandeloVmRunInContext(codeOrScript, ctx, opts);
        },
        __kandeloVmCompile(code, opts) {
            if (typeof native.__kandeloVmCompile !== 'function') throw new Error('native __kandeloVmCompile is unavailable');
            return native.__kandeloVmCompile(code, opts);
        },
        setRawMode(fd, raw) { if (typeof native.setRawMode === 'function') return native.setRawMode(fd, raw); },
        createHash(algorithm) { return native.createHash(algorithm); },
        createHmac(algorithm, key) { return native.createHmac(algorithm, key); },
        createDeflate(level) { return native.createDeflate(level); },
        createInflate() { return native.createInflate(); },
        createGzip(level) { return native.createGzip(level); },
        createGunzip() { return native.createGunzip(); },
        deflateSync(input, level) { return native.deflateSync(input, level); },
        inflateSync(input) { return native.inflateSync(input); },
        gzipSync(input, level) { return native.gzipSync(input, level); },
        gunzipSync(input) { return native.gunzipSync(input); },
        socketConnect(host, port) { return native.socketConnect(host, port); },
        socketRead(fd, length) { return native.socketRead(fd, length); },
        socketWrite(fd, bytes) { return native.socketWrite(fd, bytes); },
        socketClose(fd) { return native.socketClose(fd); },
        tlsConnect(fd, servername, options) { return native.tlsConnect(fd, servername, options); },
        tlsRead(handle, length) { return native.tlsRead(handle, length); },
        tlsWrite(handle, bytes) { return native.tlsWrite(handle, bytes); },
        tlsClose(handle) { return native.tlsClose(handle); },
    };

    const entryPath = typeof scriptPath === 'string' && scriptPath ? scriptPath : '';
    const args = typeof scriptArgs !== 'undefined' ? Array.from(scriptArgs) : [];
    globalThis.argv0 = 'node';
    globalThis.execArgv = entryPath ? ['node', entryPath, ...args] : ['node', ...args];
