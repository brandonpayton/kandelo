/*
 * exec-storm.c — replaces itself with execv forever.
 *
 * Test fixture for host/test/migration/checkpoint-exec.test.ts. Every
 * generation is a fresh program image, so the pid spends much of its life
 * between the execve syscall and the next image's first syscall — the window
 * in which a machine freeze meets a process that has no parked channel yet.
 * Each generation prints its number, naps briefly, and execs the next.
 */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	int generation = argc > 1 ? atoi(argv[1]) : 0;
	if (generation == 0) printf("READY\n");
	printf("GEN %d\n", generation);
	struct timespec nap = { .tv_sec = 0, .tv_nsec = 2000000 };
	nanosleep(&nap, NULL);
	char next[16];
	snprintf(next, sizeof next, "%d", generation + 1);
	char *args[] = { argv[0], next, NULL };
	execv(argv[0], args);
	perror("execv");
	return 1;
}
