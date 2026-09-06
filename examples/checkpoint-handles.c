/*
 * checkpoint-handles.c — holds live host handles across a checkpoint.
 *
 * Test fixture for the restored-machine host handle rebinding
 * (host/test/migration/restore.test.ts). Before READY it opens a file and
 * writes its first half, creates a directory large enough that iterating it
 * takes several getdents batches and reads a third of it, and arms alarm(5).
 * Then it naps until SIGALRM. The capture happens between READY and the
 * alarm, so the restored machine must continue a file mid-write, a directory
 * mid-iteration, and a pending alarm.
 *
 * After the alarm it writes the second half at the inherited offset, reads
 * the whole file back, finishes the directory, and verifies every entry was
 * seen exactly once. It runs on a writable root: scratch mounts do not
 * travel in a checkpoint.
 */
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>

static long long monotonic_ns(void)
{
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	return (long long)now.tv_sec * 1000000000LL + now.tv_nsec;
}

#define ENTRY_COUNT 300

static volatile sig_atomic_t alarm_fired = 0;

static void on_alarm(int signum) {
	(void)signum;
	alarm_fired = 1;
}

static unsigned char seen[ENTRY_COUNT];
static int seen_dot;
static int seen_dotdot;
static int seen_unknown;

static int note_entry(const struct dirent *entry) {
	if (strcmp(entry->d_name, ".") == 0) {
		seen_dot++;
		return 0;
	}
	if (strcmp(entry->d_name, "..") == 0) {
		seen_dotdot++;
		return 0;
	}
	unsigned index;
	if (sscanf(entry->d_name, "e%u", &index) != 1 || index >= ENTRY_COUNT) {
		seen_unknown++;
		return 0;
	}
	seen[index]++;
	return 1;
}

int main(void) {
	setvbuf(stdout, NULL, _IOLBF, 0);

	int fd = open("/handles.txt", O_CREAT | O_RDWR | O_TRUNC, 0644);
	if (fd < 0) {
		perror("open");
		return 1;
	}
	if (write(fd, "first-half:", 11) != 11) {
		perror("first write");
		return 1;
	}

	if (mkdir("/handles-dir", 0755) != 0) {
		perror("mkdir");
		return 1;
	}
	for (int i = 0; i < ENTRY_COUNT; i++) {
		char path[32];
		snprintf(path, sizeof path, "/handles-dir/e%03d", i);
		int entry_fd = open(path, O_CREAT | O_WRONLY, 0644);
		if (entry_fd < 0) {
			perror("entry open");
			return 1;
		}
		close(entry_fd);
	}
	DIR *dir = opendir("/handles-dir");
	if (!dir) {
		perror("opendir");
		return 1;
	}
	for (int read_entries = 0; read_entries < ENTRY_COUNT / 3;) {
		struct dirent *entry = readdir(dir);
		if (!entry) {
			fprintf(stderr, "directory ended early\n");
			return 1;
		}
		read_entries += note_entry(entry);
	}

	struct sigaction action;
	memset(&action, 0, sizeof action);
	action.sa_handler = on_alarm;
	if (sigaction(SIGALRM, &action, NULL) != 0) {
		perror("sigaction");
		return 1;
	}
	alarm(5);

	/* Every nap iteration re-reads CLOCK_MONOTONIC, so the restore boundary
	 * itself is checked: a receiver whose clock started behind the captured
	 * machine's would regress on the first iteration after the restore. */
	long long monotonic_last = monotonic_ns();
	printf("READY\n");
	while (!alarm_fired) {
		struct timespec nap = { .tv_sec = 0, .tv_nsec = 1000000 };
		nanosleep(&nap, NULL);
		long long now = monotonic_ns();
		if (now < monotonic_last) {
			fprintf(
				stderr,
				"monotonic clock regressed: %lld -> %lld\n",
				monotonic_last,
				now
			);
			return 1;
		}
		monotonic_last = now;
	}
	printf("MONO OK\n");

	if (write(fd, "second-half", 11) != 11) {
		perror("second write");
		return 1;
	}
	if (lseek(fd, 0, SEEK_SET) != 0) {
		perror("lseek");
		return 1;
	}
	char content[64] = { 0 };
	ssize_t got = read(fd, content, sizeof content - 1);
	if (got != 22 || strcmp(content, "first-half:second-half") != 0) {
		fprintf(stderr, "file content mismatch: %zd %s\n", got, content);
		return 1;
	}
	printf("FILE OK\n");

	struct dirent *entry;
	while ((entry = readdir(dir)) != NULL) {
		note_entry(entry);
	}
	int wrong = 0;
	for (int i = 0; i < ENTRY_COUNT; i++) {
		if (seen[i] != 1) wrong++;
	}
	if (wrong != 0 || seen_dot != 1 || seen_dotdot != 1 || seen_unknown != 0) {
		fprintf(
			stderr,
			"dir mismatch: wrong=%d dot=%d dotdot=%d unknown=%d\n",
			wrong,
			seen_dot,
			seen_dotdot,
			seen_unknown
		);
		return 1;
	}
	printf("DIR OK\n");
	printf("ALARM OK\n");
	return 0;
}
