#define _GNU_SOURCE

#include "backend.h"

#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef P_tmpdir
#define P_tmpdir "/tmp"
#endif

#define AIH_CAPABILITY_PREFIX "aih-methodology-native-fs-"
#define AIH_MKDTEMP_SUFFIX_LENGTH 6

static void BlockReport(struct aih_native_fs_report *report,
                        const char *reason) {
  int index;
  for (index = 0; index < AIH_NATIVE_FS_OBSERVATION_COUNT; index += 1) {
    report->observations[index].primitive =
        (enum aih_native_fs_primitive)index;
    report->observations[index].disposition = AIH_BLOCKED;
    report->observations[index].reason = reason;
  }
}

static int IsAsciiAlphaNumeric(char value) {
  return (value >= 'a' && value <= 'z') ||
         (value >= 'A' && value <= 'Z') ||
         (value >= '0' && value <= '9');
}

static const char *CapabilityChild(const char *root) {
  const size_t temp_length = strlen(P_tmpdir);
  const size_t prefix_length = strlen(AIH_CAPABILITY_PREFIX);
  const char *child;
  size_t child_length;
  size_t index;

  if (strncmp(root, P_tmpdir, temp_length) != 0 || root[temp_length] != '/') {
    return NULL;
  }
  child = root + temp_length + 1;
  child_length = strlen(child);
  if (child_length != prefix_length + AIH_MKDTEMP_SUFFIX_LENGTH ||
      strncmp(child, AIH_CAPABILITY_PREFIX, prefix_length) != 0) {
    return NULL;
  }
  for (index = prefix_length; index < child_length; index += 1) {
    if (!IsAsciiAlphaNumeric(child[index])) {
      return NULL;
    }
  }
  return child;
}

int aih_backend_probe_native_fs(const char *root,
                                struct aih_native_fs_report *report) {
  const char *child;
  int temp_fd;
  struct stat named_identity;

  if (root == NULL || root[0] == '\0' || report == NULL) {
    return -1;
  }
  child = CapabilityChild(root);
  if (child == NULL) {
    BlockReport(report, "root-outside-temporary-directory");
    return 0;
  }

  temp_fd = open(P_tmpdir, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (temp_fd < 0) {
    BlockReport(report, "root-identity-unavailable");
    return 0;
  }
  if (fstatat(temp_fd, child, &named_identity, AT_SYMLINK_NOFOLLOW) != 0) {
    BlockReport(report, "root-identity-unavailable");
  } else if (S_ISLNK(named_identity.st_mode)) {
    BlockReport(report, "root-linked");
  } else if (!S_ISDIR(named_identity.st_mode)) {
    BlockReport(report, "root-identity-unavailable");
  } else {
    /* A path string cannot authenticate the module-private TS capability. */
    BlockReport(report, "root-capability-unproven");
  }
  (void)close(temp_fd);
  return 0;
}
