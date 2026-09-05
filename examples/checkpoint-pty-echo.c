/*
 * checkpoint-pty-echo.c — echoes terminal input around a checkpoint.
 *
 * Test fixture for restored PTY routing
 * (host/test/migration/restore.test.ts). A restored kernel memory carries
 * the whole PTY table, but the host's pid → PTY routing dies with the
 * captured machine; input written to the restored terminal then vanishes
 * without an error. This program tags every byte it reads from its
 * terminal, so a "GOT:" line proves the byte crossed the restored master,
 * the line discipline, and the slave.
 *
 * The terminal is nonblocking and the loop naps between reads, so the
 * process keeps crossing syscall boundaries and a freeze never waits for
 * input that will not come. It never exits on its own. Its test destroys
 * the machine.
 */
#include <fcntl.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

int main(void) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	fcntl(0, F_SETFL, fcntl(0, F_GETFL, 0) | O_NONBLOCK);
	printf("READY\n");
	for (;;) {
		char buf[64];
		ssize_t got = read(0, buf, sizeof buf);
		for (ssize_t i = 0; i < got; i++) {
			if (buf[i] == '\n') continue;
			printf("GOT:%c\n", buf[i]);
		}
		struct timespec nap = { .tv_sec = 0, .tv_nsec = 1000000 };
		nanosleep(&nap, NULL);
	}
	return 0;
}
