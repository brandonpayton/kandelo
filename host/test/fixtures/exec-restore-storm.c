/*
 * exec-restore-storm.c — replaces itself with execv forever, carrying env.
 *
 * Diagnostic fixture for the restore side of the exec/capture race. Like
 * exec-storm.c, every generation is a fresh image, so a capture often lands
 * while the pid is inside _start's argv/environ marshalling. The environment
 * entries give that marshalling real work: a restored continuation that
 * resumes _start with wrong state trips crt1.c's startup contract and traps.
 */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	setenv("STORM_SHORT", "x", 1);
	setenv("STORM_MEDIUM", "0123456789abcdef", 1);
	setenv("STORM_LONG",
	       "the-quick-brown-fox-jumps-over-the-lazy-dog-0123456789", 1);
	setenv("STORM_PATH", "/usr/local/bin:/usr/bin:/bin", 1);
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
