/*
 * fork-exec-storm.c — a supervisor that forks children which exec.
 *
 * Test fixture for host/test/migration/checkpoint-exec.test.ts, shaped like
 * dinit launching a service: the parent parks in waitpid while its child sits
 * between execve and the next image's first syscall. A machine freeze must
 * interrupt the parked wait, wait out the child's exec window, and hand both
 * back running.
 */
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	if (argc > 1) {
		printf("CHILD %s\n", argv[1]);
		return 0;
	}
	printf("READY\n");
	for (int round = 0;; round++) {
		pid_t child = fork();
		if (child < 0) {
			perror("fork");
			return 1;
		}
		if (child == 0) {
			char arg[16];
			snprintf(arg, sizeof arg, "%d", round);
			char *args[] = { argv[0], arg, NULL };
			execv(argv[0], args);
			perror("execv");
			_exit(1);
		}
		int status = 0;
		waitpid(child, &status, 0);
		printf("ROUND %d\n", round);
		struct timespec nap = { .tv_sec = 0, .tv_nsec = 2000000 };
		nanosleep(&nap, NULL);
	}
}
