/*
 * checkpoint-threads.c — checkpoint-loop.c with a second thread doing the same.
 *
 * Test fixture for the machine checkpoint
 * (host/test/migration/machine-checkpoint.test.ts). A process is fully
 * unwound only once every one of its threads has reported, so the freeze has
 * to wait for both of these and read the memory while both are parked. Both
 * threads nap for a millisecond forever, so each keeps reaching the syscall
 * completion its unwind request rides out on.
 *
 * It never exits on its own. Its test destroys the machine.
 */
#include <pthread.h>
#include <stdio.h>
#include <time.h>

static void nap(void) {
	struct timespec interval = { .tv_sec = 0, .tv_nsec = 1000000 };
	nanosleep(&interval, NULL);
}

static void *tick(void *unused) {
	(void)unused;
	for (;;) nap();
	return NULL;
}

int main(void) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	pthread_t thread;
	if (pthread_create(&thread, NULL, tick, NULL) != 0) {
		printf("THREAD_FAILED\n");
		return 1;
	}
	printf("READY\n");
	for (;;) nap();
	return 0;
}
