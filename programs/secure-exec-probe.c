#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <langinfo.h>
#include <locale.h>
#include <nl_types.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static int constructor_issetugid = -1;
static int constructor_untrusted_visible = -1;
static const char secure_stdout_sentinel[] = "secure-stdout-sentinel\n";
static const char secure_stderr_sentinel[] = "secure-stderr-sentinel\n";

__attribute__((constructor))
static void observe_secure_startup(void)
{
    constructor_issetugid = issetugid();
    constructor_untrusted_visible =
        secure_getenv("KANDELO_UNTRUSTED") != NULL;
}

/*
 * Fixture bytes for the sensitive-lookup probes below, embedded here (rather
 * than staged into /tmp by the test harness's own VirtualPlatformIO mount)
 * because the in-kernel tmpfs is the unconditional authority over `/tmp`
 * (VFS: make in-kernel tmpfs scratch mounts unconditional; delete
 * WASM_POSIX_TMPFS kill-switch). A host-side `/tmp` mount is never consulted
 * for a guest open under a kernel-owned scratch prefix, so the only way to
 * make these files visible to this program is to write them itself, through
 * the same guest syscalls a real setuid target would use.
 */
static const unsigned char kSecureLocaleMo[] = {
    0xde, 0x12, 0x04, 0x95, 0, 0, 0, 0,
    1, 0, 0, 0, 28, 0, 0, 0, 36, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    3, 0, 0, 0, 44, 0, 0, 0,
    3, 0, 0, 0, 48, 0, 0, 0,
    0x53, 0x75, 0x6e, 0, 0x4c, 0x6f, 0x6b, 0,
};
static const unsigned char kSecureEmptyCatalog[] = {
    0xff, 0x88, 0xff, 0x89,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
};
static const unsigned char kSecureTestZone[] = {
    0x54, 0x5a, 0x69, 0x66, 0x31,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 1, 0, 0, 0, 4,
    0, 0, 0x0e, 0x10, 0, 0,
    0x54, 0x53, 0x54, 0,
};

static int write_scratch_fixture(const char *path, const unsigned char *data,
                                 size_t len)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return -1;
    ssize_t written = write(fd, data, len);
    int closed = close(fd);
    return (written == (ssize_t)len && closed == 0) ? 0 : -1;
}

/* Populate the /tmp fixtures every run: the in-kernel tmpfs starts empty for
 * every fresh kernel instance, and a set-ID exec's own writes are exactly the
 * untrusted-in-/tmp content the secure-exec checks below must ignore. */
static int seed_scratch_fixtures(void)
{
    if (write_scratch_fixture("/tmp/zz_TEST", kSecureLocaleMo,
                              sizeof kSecureLocaleMo)) return 30;
    if (write_scratch_fixture("/tmp/secure.cat", kSecureEmptyCatalog,
                              sizeof kSecureEmptyCatalog)) return 30;
    if (write_scratch_fixture("/tmp/secure-zone", kSecureTestZone,
                              sizeof kSecureTestZone)) return 30;
    return 0;
}

static int check_sensitive_lookups(int secure)
{
    int seed_rc = seed_scratch_fixtures();
    if (seed_rc) return seed_rc;
    if (setenv("LC_TIME", "zz_TEST", 1)) return 31;
    if (setenv("MUSL_LOCPATH", "/tmp", 1)) return 32;
    if (!setlocale(LC_TIME, "")) return 33;
    if (strcmp(nl_langinfo(ABDAY_1), secure ? "Sun" : "Lok")) return 34;

    if (setenv("TZ", ":/tmp/secure-zone", 1)) return 35;
    tzset();
    if (strcmp(tzname[0], secure ? "UTC" : "TST")) return 36;

    if (setenv("NLSPATH", "/tmp/%N", 1)) return 37;
    nl_catd cat = catopen("secure.cat", NL_CAT_LOCALE);
    if (secure ? cat != (nl_catd)-1 : cat == (nl_catd)-1) return 38;
    if (cat != (nl_catd)-1) catclose(cat);
    return 0;
}

static int check_secure_state(int secure, int check_constructor)
{
    if (!!issetugid() != secure) return 10;
    if ((secure_getenv("KANDELO_UNTRUSTED") != NULL) != !secure) return 11;
    if (check_constructor && constructor_issetugid != secure) return 12;
    if (check_constructor && constructor_untrusted_visible != !secure) return 13;
    return 0;
}

static int check_standard_fds(unsigned mask)
{
    for (int fd = 0; fd < 3; fd++) {
        if (fcntl(fd, F_GETFD) < 0) return 40 + fd;
    }
    if (mask & 1) {
        unsigned char byte;
        if (read(0, &byte, 1) != 0) return 43;
    }
    if (write(1, secure_stdout_sentinel,
              sizeof(secure_stdout_sentinel) - 1) !=
        (ssize_t)(sizeof(secure_stdout_sentinel) - 1)) return 44;
    if (write(2, secure_stderr_sentinel,
              sizeof(secure_stderr_sentinel) - 1) !=
        (ssize_t)(sizeof(secure_stderr_sentinel) - 1)) return 45;
    return 0;
}

static int target_main(int argc, char **argv)
{
    if (argc < 4) return 2;
    int secure = atoi(argv[2]) != 0;
    unsigned mask = (unsigned)strtoul(argv[3], NULL, 0);

    int rc = check_secure_state(secure, 1);
    if (rc) return rc;
    rc = check_standard_fds(mask);
    if (rc) return rc;
    rc = check_sensitive_lookups(secure);
    if (rc) return rc;

    if (secure) {
        if (setuid(getuid())) return 50;
        rc = check_secure_state(1, 1);
        if (rc) return 51;
    }

    printf(
        "secure=%d ctor_secure=%d untrusted_visible=%d ctor_visible=%d "
        "locale=%s timezone=%s catalog=%s fds=ok\n",
        !!issetugid(), constructor_issetugid,
        secure_getenv("KANDELO_UNTRUSTED") != NULL,
        constructor_untrusted_visible,
        nl_langinfo(ABDAY_1), tzname[0], secure ? "blocked" : "loaded");
    return 0;
}

static int stdio_target_main(int argc, char **argv)
{
    if (argc < 4) return 2;
    return check_standard_fds((unsigned)strtoul(argv[3], NULL, 0));
}

static int startup_target_main(int argc, char **argv)
{
    if (argc < 4) return 2;
    int secure = atoi(argv[2]) != 0;
    int rc = check_secure_state(secure, 1);
    if (rc) return rc;
    printf(
        "secure=%d ctor_secure=%d untrusted_visible=%d ctor_visible=%d\n",
        !!issetugid(), constructor_issetugid,
        secure_getenv("KANDELO_UNTRUSTED") != NULL,
        constructor_untrusted_visible);
    return 0;
}

static int exec_target(const char *path, const char *mode, const char *secure,
                       const char *mask, const char *child_path,
                       const char *child_mode)
{
    char *const target_argv[] = {
        (char *)path, (char *)mode, (char *)secure, (char *)mask,
        (char *)child_path, (char *)child_mode, NULL,
    };
    char *const target_env[] = {
        "KANDELO_UNTRUSTED=visible-only-outside-secure-startup",
        "LC_TIME=zz_TEST",
        "MUSL_LOCPATH=/tmp",
        "TZ=:/tmp/secure-zone",
        "NLSPATH=/tmp/%N",
        NULL,
    };
    execve(path, target_argv, target_env);
    return errno == ENOENT ? 60 : 61;
}

static int launch_main(int argc, char **argv, int exhaust_fds)
{
    if (argc < 6) return 2;
    if (exhaust_fds) {
        struct rlimit limit;
        if (getrlimit(RLIMIT_NOFILE, &limit)) return 63;
        limit.rlim_cur = 0;
        if (setrlimit(RLIMIT_NOFILE, &limit)) return 64;
    }
    unsigned mask = (unsigned)strtoul(argv[5], NULL, 0);
    for (int fd = 0; fd < 3; fd++) {
        if ((mask & (1u << fd)) && close(fd) && errno != EBADF) return 62;
    }
    return exec_target(argv[2], argv[3], argv[4], argv[5],
                       argc > 6 ? argv[6] : NULL,
                       argc > 7 ? argv[7] : NULL);
}

static int spawn_parent_main(int argc, char **argv)
{
    if (argc < 4) return 2;
    int resetids = atoi(argv[3]) != 0;
    int rc = check_secure_state(1, 1);
    if (rc) return rc;

    posix_spawnattr_t attr;
    if (posix_spawnattr_init(&attr)) return 70;
    if (resetids && posix_spawnattr_setflags(&attr, POSIX_SPAWN_RESETIDS)) {
        return 71;
    }
    char expected[] = { resetids ? '0' : '1', 0 };
    char *child_argv[] = {
        argc > 4 ? argv[4] : "/bin/secure-child",
        argc > 5 ? argv[5] : "target", expected, "0", NULL,
    };
    pid_t child = -1;
    rc = posix_spawn(&child, child_argv[0], NULL, &attr, child_argv, environ);
    posix_spawnattr_destroy(&attr);
    if (rc) return 72;
    int status = 0;
    if (waitpid(child, &status, 0) != child) return 73;
    if (!WIFEXITED(status)) return 74;
    return WEXITSTATUS(status);
}

int main(int argc, char **argv)
{
    if (argc < 2) return 2;
    if (!strcmp(argv[1], "launch")) return launch_main(argc, argv, 0);
    if (!strcmp(argv[1], "launch-nofile")) return launch_main(argc, argv, 1);
    if (!strcmp(argv[1], "target")) return target_main(argc, argv);
    if (!strcmp(argv[1], "startup-target")) return startup_target_main(argc, argv);
    if (!strcmp(argv[1], "stdio-target")) return stdio_target_main(argc, argv);
    if (!strcmp(argv[1], "spawn-parent")) return spawn_parent_main(argc, argv);
    return 3;
}
