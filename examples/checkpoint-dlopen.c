/*
 * checkpoint-dlopen.c — a checkpoint with one thread's replica behind.
 *
 * Test fixture for the machine checkpoint
 * (host/test/migration/machine-checkpoint.test.ts). One thread loads the side
 * module after the other thread already exists, so the other thread's copy of
 * the dynamic-loader archive is one generation old when the freeze arrives. It
 * has to adopt the newer generation before it can capture, and adopting needs
 * the archive writer, which no thread can take while a peer parked in the same
 * freeze holds a reader.
 *
 * The naps are the ordering. The loader wakes every millisecond and reaches
 * the freeze first, so it is the peer holding the reader. The other thread
 * wakes every fifty, so it asks for the writer with the loader already parked.
 *
 * The first argument is the path of the side module. The second selects the
 * loader: absent or "main" makes the main thread load, so the pthread is the
 * thread that refuses; "thread" makes the pthread load, so the refusal runs on
 * the main thread instead. The fixture never exits on its own. Its test
 * destroys the machine.
 */
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static const char *library_path;

static void nap(long nanoseconds) {
	struct timespec interval = { .tv_sec = 0, .tv_nsec = nanoseconds };
	nanosleep(&interval, NULL);
}

static void tick(void) {
	for (;;) nap(50000000);
}

static int load(void) {
	// The load must follow the other thread's first nap, or that thread
	// adopts the new generation at startup and nothing is ever behind.
	nap(100000000);
	void *library = dlopen(library_path, RTLD_NOW);
	if (!library) {
		printf("DLOPEN_FAILED %s\n", dlerror());
		return -1;
	}
	printf("READY\n");
	for (;;) nap(1000000);
	return 0;
}

static void *thread_loads(void *unused) {
	(void)unused;
	load();
	return NULL;
}

static void *thread_ticks(void *unused) {
	(void)unused;
	tick();
	return NULL;
}

int main(int argc, char *argv[]) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	if (argc < 2) {
		printf("USAGE\n");
		return 1;
	}
	library_path = argv[1];
	int loader_is_thread = argc > 2 && strcmp(argv[2], "thread") == 0;
	// The instrumenter grants the dylink-main fork role only to a module that
	// imports kernel.kernel_fork, and a fork-instrumented main without that
	// role refuses dlopen. One real fork keeps the fixture an ordinary
	// fork-capable dlopen user.
	if (fork() == 0) return 0;
	wait(NULL);
	pthread_t thread;
	void *(*routine)(void *) = loader_is_thread ? thread_loads : thread_ticks;
	if (pthread_create(&thread, NULL, routine, NULL) != 0) {
		printf("THREAD_FAILED\n");
		return 1;
	}
	if (loader_is_thread) tick();
	return load() == 0 ? 0 : 1;
}
