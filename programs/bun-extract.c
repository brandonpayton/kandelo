/*
 * bun-extract: extract the plaintext JS module graph from a Bun standalone
 * executable (e.g. the `claude` native binary) so it can be run on
 * spidermonkey-node.
 *
 * A Bun standalone stores its bundled modules as a serialized "module graph".
 * This program locates the graph without container-specific parsing: it anchors
 * on the Bun trailer near end of file, reads the Offsets struct, and finds the
 * blob base by validating that module-name pointers resolve to "/$bunfs/root/…"
 * strings. That single code path works for Mach-O, ELF and PE binaries.
 *
 * Format: oven-sh/bun src/standalone_graph/StandaloneModuleGraph.rs
 *   Offsets (32 bytes, at [T-32, T) where T = trailer file offset):
 *     u64 byte_count; StringPointer modules_ptr; u32 entry_point_id;
 *     StringPointer compile_exec_argv_ptr; u32 flags;
 *   StringPointer { u32 offset; u32 length; }  (offset relative to blob base)
 *   CompiledModuleGraphFile (52 bytes):
 *     StringPointer name, contents, sourcemap, bytecode, module_info,
 *                   bytecode_origin_path;
 *     u8 encoding (0=Binary,1=Latin1,2=Utf16LE), loader, module_format, side;
 *
 * Reads are positioned (pread) so peak memory is one module, not the whole
 * ~200 MB binary — important inside a wasm guest.
 *
 * usage: bun-extract <bun-executable> <out-dir>
 *        bun-extract --prepare <bun-executable> <cache-root>
 *
 * `--prepare` mode is cache-aware: it hashes the module-graph blob
 * (FNV-1a-64, folded with its length) and extracts under
 * <cache-root>/<hash>/ only on a miss, rewriting each JS module's
 * "/$bunfs/root/" specifiers to the cache dir absolute path so the
 * extracted graph is self-contained and importable from disk. It also
 * writes a `manifest.json` (entry + module format) and a `package.json`
 * (`{"type":"module"}`) so the entry, which is emitted with a `.mjs`
 * extension, loads as ESM under spidermonkey-node. It prints `CACHE=`
 * and `ENTRY=` lines consumed by the bun-run bootstrap.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <sys/stat.h>
#include <sys/types.h>

static const char TRAILER[] = "\n---- Bun! ----\n";
#define TRAILER_LEN 15
#define REC 52          /* sizeof(CompiledModuleGraphFile) */
#define OFFSETS 32      /* sizeof(Offsets) */
#define TAIL_SCAN (8 * 1024 * 1024)

static const char *PREFIXES[] = { "/$bunfs/root/", "B:/~BUN/root/", "/$bunfs/", "B:/~BUN/", NULL };

/* FNV-1a-64 content hash. Content-addressing, not security. */
static uint64_t fnv1a64(const unsigned char *p, size_t n, uint64_t h) {
    for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 1099511628211ULL; }
    return h;
}

static int ends_with(const char *s, const char *suf) {
    size_t ls = strlen(s), lsuf = strlen(suf);
    return ls >= lsuf && strcmp(s + ls - lsuf, suf) == 0;
}

/* Reject a stripped module-relative path that could escape the extraction
 * root via ".." path segments. Untrusted input (a crafted/corrupt Bun
 * executable) must not be able to write outside outdir/cachedir. */
static int has_dotdot_segment(const char *rel) {
    size_t n = strlen(rel);
    if (n == 2 && rel[0] == '.' && rel[1] == '.') return 1;
    if (n >= 3 && rel[0] == '.' && rel[1] == '.' && rel[2] == '/') return 1;
    if (n >= 3 && rel[n - 1] == '.' && rel[n - 2] == '.' && rel[n - 3] == '/') return 1;
    if (strstr(rel, "/../")) return 1;
    return 0;
}

/* Reject bytes that would produce invalid/unsafe JSON when embedded
 * unescaped in a "..."-quoted manifest string. */
static int has_json_unsafe_byte(const char *s) {
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (*p == '"' || *p == '\\' || *p < 0x20) return 1;
    }
    return 0;
}

/* Map a Bun standalone-graph loader byte (observed on Claude Code 2.1.x) to a
 * stable class string the runtime honors. Unknown bytes return "" and are
 * treated as js (executed) by the consumer -- a safe, logged fallback. */
static const char *loader_class(unsigned char b) {
  switch (b) {
    case 1:  return "js";
    case 13: return "text";
    case 5:  return "file";
    case 6:  return "json";
    case 10: return "napi";
    default: return "";
  }
}

/* Replace all occurrences of `from` with `to` in text; returns malloc'd result, sets *outlen.
 * Returns NULL (with *outlen = 0) on allocation failure; callers must treat that as fatal,
 * not fall back to writing the unremapped text. */
static char *replace_all(const char *text, size_t tlen, const char *from, const char *to, size_t *outlen) {
    size_t flen = strlen(from), tolen = strlen(to);
    size_t count = 0; const char *s = text;
    while ((s = memmem(s, (size_t)(text + tlen - s), from, flen))) { count++; s += flen; }
    size_t cap = tlen + count * (tolen > flen ? tolen - flen : 0) + 1;
    char *out = malloc(cap);
    if (!out) { *outlen = 0; return NULL; }
    size_t o = 0; s = text; const char *end = text + tlen;
    while (s < end) {
        const char *m = memmem(s, (size_t)(end - s), from, flen);
        if (!m) { memcpy(out + o, s, (size_t)(end - s)); o += (size_t)(end - s); break; }
        memcpy(out + o, s, (size_t)(m - s)); o += (size_t)(m - s);
        memcpy(out + o, to, tolen); o += tolen; s = m + flen;
    }
    *outlen = o; return out;
}

static uint32_t rd_u32(const unsigned char *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint64_t rd_u64(const unsigned char *p) {
    return (uint64_t)rd_u32(p) | ((uint64_t)rd_u32(p + 4) << 32);
}

/* pread exactly len bytes into buf; return 0 on success. */
static int pread_all(int fd, void *buf, size_t len, off_t off) {
    unsigned char *b = buf;
    while (len) {
        ssize_t n = pread(fd, b, len, off);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        if (n == 0) return -1;
        b += n; off += n; len -= (size_t)n;
    }
    return 0;
}

static int has_bunfs_prefix(const char *name, uint32_t len) {
    for (const char **pre = PREFIXES; *pre; pre++) {
        size_t pl = strlen(*pre);
        if (len >= pl && memcmp(name, *pre, pl) == 0) return 1;
    }
    return 0;
}

static const char *strip_prefix(const char *name) {
    for (const char **pre = PREFIXES; *pre; pre++) {
        size_t pl = strlen(*pre);
        if (strncmp(name, *pre, pl) == 0) return name + pl;
    }
    while (*name == '/') name++;
    return name;
}

/* mkdir -p for the directory portion of a file path under root. */
static void mkparents(const char *path) {
    char tmp[4096];
    size_t n = strlen(path);
    if (n >= sizeof(tmp)) return;
    memcpy(tmp, path, n + 1);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') { *p = '\0'; mkdir(tmp, 0755); *p = '/'; }
    }
}

/* Minimal UTF-16LE -> UTF-8 (BMP + surrogate pairs). Returns malloc'd buf, sets *outlen. */
static char *utf16le_to_utf8(const unsigned char *in, size_t inlen, size_t *outlen) {
    /* inlen is attacker-controlled (cont_len from the untrusted module-graph
     * blob). "inlen * 3 + 4" can wrap size_t (32-bit on this target) for a
     * large-enough inlen, yielding a small cap that malloc happily satisfies
     * while the loop below still writes up to 4 bytes per UTF-16 code unit
     * — a heap buffer overflow. Reject before computing cap if the true
     * (non-wrapping) result would exceed SIZE_MAX. */
    if (inlen > (SIZE_MAX - 4) / 3) { *outlen = 0; return NULL; }
    size_t cap = inlen * 3 + 4, o = 0;
    char *out = malloc(cap);
    if (!out) return NULL;
    for (size_t i = 0; i + 1 < inlen; i += 2) {
        uint32_t c = (uint32_t)in[i] | ((uint32_t)in[i + 1] << 8);
        if (c >= 0xD800 && c <= 0xDBFF && i + 3 < inlen) {
            uint32_t lo = (uint32_t)in[i + 2] | ((uint32_t)in[i + 3] << 8);
            if (lo >= 0xDC00 && lo <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00); i += 2; }
        }
        if (c < 0x80) out[o++] = (char)c;
        else if (c < 0x800) { out[o++] = (char)(0xC0 | (c >> 6)); out[o++] = (char)(0x80 | (c & 0x3F)); }
        else if (c < 0x10000) { out[o++] = (char)(0xE0 | (c >> 12)); out[o++] = (char)(0x80 | ((c >> 6) & 0x3F)); out[o++] = (char)(0x80 | (c & 0x3F)); }
        else { out[o++] = (char)(0xF0 | (c >> 18)); out[o++] = (char)(0x80 | ((c >> 12) & 0x3F)); out[o++] = (char)(0x80 | ((c >> 6) & 0x3F)); out[o++] = (char)(0x80 | (c & 0x3F)); }
    }
    *outlen = o;
    return out;
}

int main(int argc, char **argv) {
    int prepare = 0;
    const char *cache_root = NULL;
    const char *exe = NULL, *outdir = NULL;
    if (argc == 4 && strcmp(argv[1], "--prepare") == 0) {
        prepare = 1; exe = argv[2]; cache_root = argv[3];
    } else if (argc == 3) {
        exe = argv[1]; outdir = argv[2];
    } else {
        fprintf(stderr, "usage: bun-extract <bun-exe> <out-dir> | bun-extract --prepare <bun-exe> <cache-root>\n");
        return 2;
    }

    int fd = open(exe, O_RDONLY);
    if (fd < 0) { fprintf(stderr, "open %s: %s\n", exe, strerror(errno)); return 1; }
    struct stat st;
    if (fstat(fd, &st) < 0) { perror("fstat"); return 1; }
    off_t fsize = st.st_size;

    /* Read the tail and find the last trailer occurrence (the real graph
     * trailer sits at/near EOF; earlier copies are Bun-runtime strings). */
    size_t tail = fsize < TAIL_SCAN ? (size_t)fsize : TAIL_SCAN;
    off_t tail_off = fsize - (off_t)tail;
    unsigned char *tbuf = malloc(tail);
    if (!tbuf || pread_all(fd, tbuf, tail, tail_off) != 0) { fprintf(stderr, "read tail failed\n"); return 1; }
    long trailer_rel = -1;
    for (long i = (long)tail - TRAILER_LEN; i >= 0; i--) {
        if (memcmp(tbuf + i, TRAILER, TRAILER_LEN) == 0) { trailer_rel = i; break; }
    }
    if (trailer_rel < 0) { fprintf(stderr, "not a Bun standalone executable (no trailer)\n"); return 1; }
    off_t T = tail_off + trailer_rel;   /* file offset of trailer start */

    /* Offsets at [T-32, T). */
    unsigned char ob[OFFSETS];
    if (pread_all(fd, ob, OFFSETS, T - OFFSETS) != 0) { fprintf(stderr, "read offsets failed\n"); return 1; }
    uint64_t byte_count = rd_u64(ob);
    uint32_t modules_off = rd_u32(ob + 8);
    uint32_t modules_len = rd_u32(ob + 12);
    uint32_t entry_id = rd_u32(ob + 16);
    uint32_t flags = rd_u32(ob + 28);
    if (modules_len == 0 || modules_len % REC != 0) { fprintf(stderr, "implausible module table len %u\n", modules_len); return 1; }
    uint32_t count = modules_len / REC;

    /* Blob base: Offsets sits at base+byte_count, i.e. file offset T-32.
     * Container alignment shifts this by a few bytes, so validate a window. */
    off_t approx = (T - OFFSETS) - (off_t)byte_count;
    off_t base = -1;
    unsigned char rec[REC];
    for (off_t cand = approx - 64; cand <= approx + 64; cand++) {
        if (cand < 0 || cand + modules_off + modules_len > fsize) continue;
        int ok = 1;
        uint32_t sample = count < 8 ? count : 8;
        for (uint32_t i = 0; i < sample && ok; i++) {
            if (pread_all(fd, rec, REC, cand + modules_off + (off_t)i * REC) != 0) { ok = 0; break; }
            uint32_t no = rd_u32(rec), nl = rd_u32(rec + 4);
            if (nl == 0 || nl > 4096) { ok = 0; break; }
            char nm[4097];
            if (pread_all(fd, nm, nl, cand + no) != 0) { ok = 0; break; }
            nm[nl] = 0;
            if (!has_bunfs_prefix(nm, nl)) ok = 0;
        }
        if (ok) { base = cand; break; }
    }
    if (base < 0) { fprintf(stderr, "could not locate module-graph base\n"); return 1; }

    char cachedir[8192] = "";
    int is_hit = 0;
    if (prepare) {
        /* Hash the module-graph blob region [base, base+byte_count) streaming
         * in chunks so peak memory stays bounded regardless of exe size. */
        uint64_t h = 1469598103934665603ULL;      /* FNV offset basis */
        off_t at = base, end = base + (off_t)byte_count;
        size_t hb_cap = 1 << 20;
        unsigned char *hb = malloc(hb_cap);        /* heap, not stack: guest stacks are small */
        if (!hb) { fprintf(stderr, "oom\n"); return 1; }
        while (at < end) {
            size_t want = (size_t)((end - at) < (off_t)hb_cap ? (end - at) : (off_t)hb_cap);
            if (pread_all(fd, hb, want, at) != 0) { fprintf(stderr, "hash read failed\n"); free(hb); return 1; }
            h = fnv1a64(hb, want, h); at += (off_t)want;
        }
        free(hb);
        h ^= byte_count;                           /* fold in section length */
        snprintf(cachedir, sizeof(cachedir), "%s/%016llx", cache_root, (unsigned long long)h);
        mkparents(cachedir); mkdir(cache_root, 0755); mkdir(cachedir, 0755);

        char manifest_check[8300];
        snprintf(manifest_check, sizeof(manifest_check), "%s/manifest.json", cachedir);
        FILE *hf = fopen(manifest_check, "rb");
        if (hf) { is_hit = 1; fclose(hf); }

        outdir = cachedir;
    } else {
        mkdir(outdir, 0755);
    }
    fprintf(stderr, "modules=%u entry=%u flags=0x%x base=%lld byte_count=%llu%s\n",
            count, entry_id, flags, (long long)base, (unsigned long long)byte_count,
            prepare ? (is_hit ? " (cache hit)" : " (cache miss)") : "");

    char nm[4097];
    char dest[8192];
    size_t cbuf_cap = 0;
    unsigned char *cbuf = NULL;
    uint32_t esm = 0, written = 0;
    char entry_rel[4200] = "";
    int entry_fmt = 0;
    int entry_found = 0;
    char *loaders = NULL; size_t loaders_len = 0, loaders_cap = 0;
    uint32_t unknown_loaders = 0;

    for (uint32_t i = 0; i < count; i++) {
        if (pread_all(fd, rec, REC, base + modules_off + (off_t)i * REC) != 0) { fprintf(stderr, "read rec %u\n", i); return 1; }
        uint32_t name_off = rd_u32(rec),    name_len = rd_u32(rec + 4);
        uint32_t cont_off = rd_u32(rec + 8), cont_len = rd_u32(rec + 12);
        unsigned char enc = rec[48];
        unsigned char loader = rec[49];
        unsigned char fmt = rec[50];
        if (name_len > 4096) { fprintf(stderr, "name too long at %u\n", i); return 1; }
        if (pread_all(fd, nm, name_len, base + name_off) != 0) { fprintf(stderr, "read name %u\n", i); return 1; }
        nm[name_len] = 0;
        if (has_json_unsafe_byte(nm)) { fprintf(stderr, "bun-extract: unsafe module name at %u\n", i); return 1; }

        const char *rel = strip_prefix(nm);
        if (has_dotdot_segment(rel)) { fprintf(stderr, "bun-extract: unsafe module path: %s\n", nm); return 1; }
        int is_entry = (i == entry_id);
        /* spidermonkey-node only reliably loads ".mjs" as ESM. The entry is
         * not imported by any other module (only the bootstrap loads it
         * directly), so it alone is safe to rename; other chunks keep their
         * baked-in names since remapped import specifiers must still match
         * the files on disk. */
        char rel_out[4210];
        if (prepare && is_entry && !ends_with(rel, ".mjs")) {
            snprintf(rel_out, sizeof(rel_out), "%s.mjs", rel);
        } else {
            snprintf(rel_out, sizeof(rel_out), "%s", rel);
        }

        if (fmt == 1) esm++;
        if (is_entry) { snprintf(entry_rel, sizeof(entry_rel), "%s", rel_out); entry_fmt = fmt; entry_found = 1; }
        written++;

        if (prepare && is_hit) continue; /* cache already populated */

        int is_js = is_entry || (loader == 1);

        if (prepare && !is_entry && loader != 1) {
            const char *cls = loader_class(loader);
            if (cls[0] == 0) {
                unknown_loaders++;   /* unknown -> omitted; consumer runs as js */
            } else {
                char eb[4400];
                int m = snprintf(eb, sizeof eb, "%s\"%s\":\"%s\"",
                                 loaders_len ? "," : "", rel_out, cls);
                if (m < 0 || m >= (int)sizeof eb) {
                    fprintf(stderr, "bun-extract: loaders entry too long at %u\n", i);
                    free(loaders); return 1;
                }
                if (loaders_len + (size_t)m + 1 > loaders_cap) {
                    loaders_cap = (loaders_len + (size_t)m + 1) * 2;
                    loaders = realloc(loaders, loaders_cap);
                    if (!loaders) { fprintf(stderr, "oom\n"); return 1; }
                }
                memcpy(loaders + loaders_len, eb, (size_t)m);
                loaders_len += (size_t)m; loaders[loaders_len] = 0;
            }
        }

        /* Widen the comparison: cont_len is attacker-controlled and, at
         * UINT32_MAX, "cont_len + 1" wraps to 0 in 32-bit arithmetic, which
         * would satisfy "> cbuf_cap" as false and skip the realloc — leaving
         * cbuf undersized (or NULL) before the pread_all below. size_t is
         * also 32 bits on this target, so also reject a size that would
         * itself overflow size_t rather than silently truncating it. */
        uint64_t need = (uint64_t)cont_len + 1;
        if (need > (uint64_t)SIZE_MAX) { fprintf(stderr, "bun-extract: implausible content length at %u\n", i); return 1; }
        if (need > (uint64_t)cbuf_cap) {
            cbuf_cap = (size_t)need;
            cbuf = realloc(cbuf, cbuf_cap);
            if (!cbuf) { fprintf(stderr, "oom\n"); return 1; }
        }
        if (cont_len && pread_all(fd, cbuf, cont_len, base + cont_off) != 0) { fprintf(stderr, "read contents %u\n", i); return 1; }

        int dn = snprintf(dest, sizeof(dest), "%s/%s", outdir, rel_out);
        if (dn <= 0 || dn >= (int)sizeof(dest)) { fprintf(stderr, "path too long %u\n", i); return 1; }
        mkparents(dest);
        FILE *f = fopen(dest, "wb");
        if (!f) { fprintf(stderr, "open %s: %s\n", dest, strerror(errno)); return 1; }

        char *text = (char *)cbuf; size_t tlen = cont_len; char *utf8 = NULL;
        if (enc == 2) {
            size_t ol; utf8 = utf16le_to_utf8(cbuf, cont_len, &ol);
            if (utf8) { text = utf8; tlen = ol; } else { text = (char *)cbuf; tlen = 0; }
        }

        if (prepare && is_js) {
            char to[8200];
            snprintf(to, sizeof(to), "%s/", cachedir);
            size_t outlen;
            char *remapped = replace_all(text, tlen, "/$bunfs/root/", to, &outlen);
            if (!remapped) {
                /* Never fall back to writing the unremapped text: that would
                 * silently ship "/$bunfs/root/" specifiers the cache dir
                 * can't resolve, i.e. a fake success. */
                fclose(f); free(utf8);
                fprintf(stderr, "bun-extract: out of memory remapping %s\n", nm);
                return 1;
            }
            fwrite(remapped, 1, outlen, f); free(remapped);
        } else {
            fwrite(text, 1, tlen, f);
        }
        fclose(f);

        if (prepare && !is_js) {
            const char *cls = loader_class(loader);
            if (cls[0]) {
                int has = (tlen && memmem(text, tlen, "/$bunfs/root/", 13) != NULL);
                printf("ASSET_VERBATIM %s %s\n", rel_out, has ? "yes" : "no");
            }
        }
        free(utf8);
    }

    if (prepare) {
        if (!entry_found) {
            /* entry_id came from the (untrusted) binary's Offsets struct and
             * did not match any module in the table: never print a CACHE=/
             * ENTRY= pair pointing at a nonexistent entry file. */
            fprintf(stderr, "bun-extract: entry module id %u out of range (%u modules)\n", entry_id, count);
            return 1;
        }
        if (!is_hit) {
            snprintf(dest, sizeof(dest), "%s/manifest.json", cachedir);
            FILE *mf = fopen(dest, "wb");
            if (mf) { fprintf(mf, "{\"entry\":\"%s\",\"format\":%d,\"loaders\":{%s}}\n",
                              entry_rel, entry_fmt, loaders ? loaders : ""); fclose(mf); }

            snprintf(dest, sizeof(dest), "%s/package.json", cachedir);
            FILE *pf = fopen(dest, "wb");
            if (pf) { fprintf(pf, "{\"type\":\"module\"}\n"); fclose(pf); }

            printf("MANIFEST_LOADERS {%s}\n", loaders ? loaders : "");
            if (unknown_loaders) {
                fprintf(stderr, "bun-extract: %u modules with unrecognized loader byte (treated as js)\n",
                        unknown_loaders);
            }
        }

        fprintf(stderr, "prepared %u modules (%u ESM) at %s\nentry: %s\n", written, esm, cachedir, entry_rel);

        printf("CACHE=%s\n", cachedir);
        printf("ENTRY=%s/%s\n", cachedir, entry_rel);
        /* self-check: reopen the entry, confirm remap applied (no /$bunfs/root/ left) */
        {
            char ep[8192]; snprintf(ep, sizeof(ep), "%s/%s", cachedir, entry_rel);
            FILE *rf = fopen(ep, "rb");
            if (rf) {
                char buf[4096]; size_t n = fread(buf, 1, sizeof(buf) - 1, rf); buf[n] = 0; fclose(rf);
                printf("REMAP_OK %s\n", strstr(buf, "/$bunfs/root/") ? "FAIL" : cachedir);
            }
        }
        free(loaders); loaders = NULL;
    } else {
        /* Emit a tiny manifest so a loader knows the entry point. */
        snprintf(dest, sizeof(dest), "%s/_manifest.json", outdir);
        FILE *mf = fopen(dest, "wb");
        if (mf) { fprintf(mf, "{\"entry\":\"%s\",\"count\":%u,\"esm\":%u}\n", entry_rel, count, esm); fclose(mf); }

        fprintf(stderr, "extracted %u modules (%u ESM) to %s\nentry: %s\n", written, esm, outdir, entry_rel);

        /* Machine-readable result on stdout, plus a read-back self-check that proves
         * the write path worked end-to-end inside the guest VFS. */
        printf("EXTRACTED count=%u esm=%u entry=%s\n", written, esm, entry_rel);
        if (entry_rel[0]) {
            snprintf(dest, sizeof(dest), "%s/%s", outdir, entry_rel);
            FILE *rf = fopen(dest, "rb");
            if (rf) {
                char line[128];
                size_t n = fread(line, 1, sizeof(line) - 1, rf);
                fclose(rf);
                line[n] = 0;
                char *nl = strchr(line, '\n');
                if (nl) *nl = 0;
                printf("ENTRY_HEAD %s\n", line);
            }
        }
    }

    free(cbuf); free(tbuf);
    close(fd);
    return 0;
}
