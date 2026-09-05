/*
 * checkpoint-blocking-read.c — parks in a blocking read across a checkpoint.
 *
 * Test fixture for the checkpoint restart bit
 * (host/test/migration/checkpoint-blocking-syscall.test.ts). A process
 * parked in a blocking syscall reaches no post-syscall boundary, so a freeze
 * can only reach it by completing the call with EINTR. Nothing was caught,
 * so the process is owed its read rather than an interruption, and
 * CHECKPOINT_REQUEST_RESTART is what tells the glue to resubmit it.
 *
 * The read is blocking and the loop never naps, so this process sits inside
 * the syscall until a byte arrives. Every failure is reported as its own
 * errno next to whether a signal was behind it, rather than assumed to be
 * EINTR: a checkpoint that leaked an interruption is `ERR:4:0`, a real
 * SIGUSR1 is `ERR:4:1`, and anything else names the errno it actually got.
 * SIGUSR1 is caught without SA_RESTART, so it still ends the read.
 *
 * It never exits on its own. Its test destroys the machine.
 */
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

static volatile sig_atomic_t caught_signal = 0;

static void on_usr1(int sig) {
	(void)sig;
	caught_signal = 1;
}

int main(void) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	struct sigaction usr1 = { .sa_handler = on_usr1, .sa_flags = 0 };
	sigemptyset(&usr1.sa_mask);
	sigaction(SIGUSR1, &usr1, NULL);
	printf("READY\n");
	for (;;) {
		char buf[64];
		ssize_t got = read(0, buf, sizeof buf);
		if (got < 0) {
			printf("ERR:%d:%d\n", errno, (int)caught_signal);
			caught_signal = 0;
			continue;
		}
		for (ssize_t i = 0; i < got; i++) {
			if (buf[i] == '\n') continue;
			printf("GOT:%c\n", buf[i]);
		}
	}
	return 0;
}
