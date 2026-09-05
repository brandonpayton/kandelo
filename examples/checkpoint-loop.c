/*
 * checkpoint-loop.c — runs forever, crossing a syscall boundary constantly.
 *
 * Test fixture for the machine checkpoint
 * (host/test/migration/machine-checkpoint.test.ts). An unwind request rides
 * out on the next syscall completion the guest observes, so a process that
 * can be checkpointed has to keep reaching one. This program naps for a
 * millisecond forever, so the freeze never waits long for it. Contrast
 * block-forever.c, which parks in one enormous sleep and is the process a
 * checkpoint must time out on rather than force.
 *
 * It never exits on its own. Its test destroys the machine.
 */
#include <stdio.h>
#include <time.h>

int main(void) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	printf("READY\n");
	for (;;) {
		struct timespec nap = { .tv_sec = 0, .tv_nsec = 1000000 };
		nanosleep(&nap, NULL);
	}
	return 0;
}
