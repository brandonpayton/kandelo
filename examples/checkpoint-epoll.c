/*
 * checkpoint-epoll.c — epoll_wait forever, proving the interest list
 * survives a checkpoint.
 *
 * Test fixture for host/test/migration/restore.test.ts. The host serves
 * epoll_pwait from a mirror of the interest list it builds by watching
 * epoll_ctl, so the mirror must travel with the checkpoint. This program
 * registers one pipe in an epoll set and ticks it forever; a restore that
 * dropped the mirror answers EBADF and the tick turns into EPOLL_ERR.
 *
 * It never exits on its own. Its test destroys the machine.
 */
#include <errno.h>
#include <stdio.h>
#include <sys/epoll.h>
#include <time.h>
#include <unistd.h>

int main(void) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	int fds[2];
	if (pipe(fds) != 0) {
		printf("PIPE_ERR %d\n", errno);
		return 1;
	}
	int epfd = epoll_create1(0);
	if (epfd < 0) {
		printf("EPOLL_CREATE_ERR %d\n", errno);
		return 1;
	}
	struct epoll_event interest = { .events = EPOLLIN, .data = { .fd = fds[0] } };
	if (epoll_ctl(epfd, EPOLL_CTL_ADD, fds[0], &interest) != 0) {
		printf("EPOLL_CTL_ERR %d\n", errno);
		return 1;
	}
	printf("READY\n");
	for (;;) {
		if (write(fds[1], "x", 1) != 1) {
			printf("WRITE_ERR %d\n", errno);
			return 1;
		}
		struct epoll_event event;
		int n = epoll_wait(epfd, &event, 1, 1000);
		if (n != 1 || event.data.fd != fds[0]) {
			printf("EPOLL_ERR n=%d errno=%d\n", n, errno);
			return 1;
		}
		char byte;
		if (read(fds[0], &byte, 1) != 1) {
			printf("READ_ERR %d\n", errno);
			return 1;
		}
		printf("TICK\n");
		struct timespec nap = { .tv_sec = 0, .tv_nsec = 1000000 };
		nanosleep(&nap, NULL);
	}
	return 0;
}
