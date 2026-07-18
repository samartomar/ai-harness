#define _GNU_SOURCE

#include "backend.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <linux/stat.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH 0x1000
#endif

#ifndef AT_STATX_SYNC_AS_STAT
#define AT_STATX_SYNC_AS_STAT 0x0000
#endif

#ifndef P_tmpdir
#define P_tmpdir "/tmp"
#endif

#define AIH_CAPABILITY_PREFIX "aih-methodology-native-fs-"
#define AIH_MKDTEMP_SUFFIX_LENGTH 6

static const char *const kUnsupportedReasons[AIH_NATIVE_FS_OBSERVATION_COUNT] = {
    "identity-bound-file-publication-unavailable",
    "no-replace-directory-publication-unavailable",
    "identity-bound-file-detachment-unavailable",
    "identity-bound-directory-detachment-unavailable",
    "parent-directory-durability-unavailable",
    "link-and-volume-containment-unavailable",
    "substitution-resistance-unavailable"};

static void SetObservation(struct aih_native_fs_report *report,
                           enum aih_native_fs_primitive primitive,
                           enum aih_native_fs_disposition disposition,
                           const char *reason) {
  report->observations[primitive].primitive = primitive;
  report->observations[primitive].disposition = disposition;
  report->observations[primitive].reason = reason;
}

static void InitializeReport(struct aih_native_fs_report *report) {
  int index;
  for (index = 0; index < AIH_NATIVE_FS_OBSERVATION_COUNT; index += 1) {
    SetObservation(report, (enum aih_native_fs_primitive)index,
                   AIH_UNSUPPORTED, kUnsupportedReasons[index]);
  }
}

static void BlockReport(struct aih_native_fs_report *report,
                        const char *reason) {
  int index;
  for (index = 0; index < AIH_NATIVE_FS_OBSERVATION_COUNT; index += 1) {
    SetObservation(report, (enum aih_native_fs_primitive)index, AIH_BLOCKED,
                   reason);
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

static int SameObject(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_uid == right->st_uid;
}

static int SameFilesystem(const struct statfs *left,
                          const struct statfs *right) {
  return left->f_type == right->f_type &&
         memcmp(&left->f_fsid, &right->f_fsid, sizeof(left->f_fsid)) == 0;
}

static int DirectoryIsEmpty(int directory_fd) {
  char buffer[4096];
  int bytes;

#if !defined(SYS_getdents64)
  (void)directory_fd;
  errno = ENOSYS;
  return -1;
#else
  if (lseek(directory_fd, 0, SEEK_SET) < 0) {
    return -1;
  }
  for (;;) {
    int offset = 0;
    bytes = (int)syscall(SYS_getdents64, directory_fd, buffer,
                         sizeof(buffer));
    if (bytes < 0) {
      return -1;
    }
    if (bytes == 0) {
      return 1;
    }
    while (offset < bytes) {
      const struct dirent *entry =
          (const struct dirent *)(const void *)(buffer + offset);
      if (entry->d_reclen == 0 || offset + entry->d_reclen > bytes) {
        errno = EIO;
        return -1;
      }
      if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
        return 0;
      }
      offset += entry->d_reclen;
    }
  }
#endif
}

static int StatMount(int descriptor, struct statx *identity) {
#if !defined(SYS_statx) || !defined(STATX_MNT_ID)
  (void)descriptor;
  (void)identity;
  errno = ENOSYS;
  return -1;
#else
  memset(identity, 0, sizeof(*identity));
  return (int)syscall(SYS_statx, descriptor, "", AT_EMPTY_PATH |
                      AT_STATX_SYNC_AS_STAT, STATX_BASIC_STATS | STATX_MNT_ID,
                      identity);
#endif
}

static int UnsupportedErrno(int error) {
  return error == ENOSYS || error == EOPNOTSUPP || error == ENOTSUP ||
         error == EINVAL;
}

static int RootIdentityIsStable(int temp_fd, int root_fd,
                                const char *child,
                                const struct stat *expected_root,
                                const struct statfs *expected_filesystem,
                                uint64_t expected_mount_id) {
  struct stat named_root;
  struct stat opened_root;
  struct statfs filesystem;
  struct statx mount;

  if (fstatat(temp_fd, child, &named_root, AT_SYMLINK_NOFOLLOW) != 0 ||
      fstat(root_fd, &opened_root) != 0 ||
      !SameObject(expected_root, &named_root) ||
      !SameObject(expected_root, &opened_root) ||
      fstatfs(root_fd, &filesystem) != 0 ||
      !SameFilesystem(expected_filesystem, &filesystem) ||
      StatMount(root_fd, &mount) != 0 ||
      (mount.stx_mask & STATX_MNT_ID) == 0 ||
      (uint64_t)mount.stx_mnt_id != expected_mount_id) {
    return 0;
  }
  return 1;
}

static int RemoveOwnedFile(int root_fd, const char *name,
                           const struct stat *expected) {
  struct stat named;
  if (fstatat(root_fd, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(named.st_mode) || !SameObject(expected, &named)) {
    return -1;
  }
  return unlinkat(root_fd, name, 0);
}

static int RemoveOwnedDirectory(int root_fd, const char *name,
                                const struct stat *expected) {
  struct stat named;
  if (fstatat(root_fd, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(named.st_mode) || !SameObject(expected, &named)) {
    return -1;
  }
  return unlinkat(root_fd, name, AT_REMOVEDIR);
}

static int WriteAll(int descriptor, const char *bytes, size_t length) {
  size_t written = 0;
  while (written < length) {
    const ssize_t result = write(descriptor, bytes + written, length - written);
    if (result <= 0) {
      return -1;
    }
    written += (size_t)result;
  }
  return 0;
}

static int CanaryIsUnchanged(int root_fd, int canary_fd,
                             const char *name,
                             const struct stat *expected,
                             const char *bytes, size_t length) {
  struct stat named;
  struct stat opened;
  char content[32];
  ssize_t read_bytes;

  if (length > sizeof(content) || fstat(canary_fd, &opened) != 0 ||
      fstatat(root_fd, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameObject(expected, &opened) || !SameObject(expected, &named) ||
      opened.st_nlink != 1 || lseek(canary_fd, 0, SEEK_SET) < 0) {
    return 0;
  }
  read_bytes = read(canary_fd, content, sizeof(content));
  return read_bytes == (ssize_t)length && memcmp(content, bytes, length) == 0;
}

static void ProbeFilePublication(int root_fd,
                                 struct aih_native_fs_report *report) {
  static const char kCanaryName[] = "aih-file-canary";
  static const char kPublishedName[] = "aih-file-published";
  static const char kLinkedName[] = "aih-linked-source";
  static const char kLinkedAlias[] = "aih-linked-alias";
  static const char kCanaryBytes[] = "canary-v1";
  static const char kSourceBytes[] = "source-v1";
  int source_fd = -1;
  int canary_fd = -1;
  int linked_fd = -1;
  int result;
  int saved_error = 0;
  struct stat source;
  struct stat published;
  struct stat canary;
  struct stat linked;
  struct stat linked_alias;
  int source_linked = 0;
  int canary_created = 0;
  int published_created = 0;
  int linked_created = 0;
  int alias_created = 0;
  int cleanup_ok = 1;

  source_fd = openat(root_fd, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0600);
  if (source_fd < 0) {
    SetObservation(report, AIH_FILE_PUBLISH,
                   UnsupportedErrno(errno) ? AIH_UNSUPPORTED : AIH_BLOCKED,
                   UnsupportedErrno(errno)
                       ? kUnsupportedReasons[AIH_FILE_PUBLISH]
                       : "unexpected-error-code");
    return;
  }
  if (WriteAll(source_fd, kSourceBytes, sizeof(kSourceBytes) - 1) != 0 ||
      fsync(source_fd) != 0 || fstat(source_fd, &source) != 0 ||
      !S_ISREG(source.st_mode) || source.st_nlink != 0 ||
      source.st_dev == 0) {
    SetObservation(report, AIH_FILE_PUBLISH, AIH_BLOCKED,
                   "source-identity-drift");
    goto cleanup;
  }

  canary_fd = openat(root_fd, kCanaryName,
                     O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW,
                     0600);
  if (canary_fd < 0 || fstat(canary_fd, &canary) != 0) {
    SetObservation(report, AIH_FILE_PUBLISH, AIH_BLOCKED,
                   "unexpected-error-code");
    goto cleanup;
  }
  canary_created = 1;
  if (WriteAll(canary_fd, kCanaryBytes, sizeof(kCanaryBytes) - 1) != 0 ||
      fsync(canary_fd) != 0) {
    SetObservation(report, AIH_FILE_PUBLISH, AIH_BLOCKED,
                   "unexpected-error-code");
    goto cleanup;
  }

  errno = 0;
  result = linkat(source_fd, "", root_fd, kCanaryName, AT_EMPTY_PATH);
  saved_error = errno;
  if (result == 0 || saved_error != EEXIST ||
      !CanaryIsUnchanged(root_fd, canary_fd, kCanaryName, &canary,
                         kCanaryBytes, sizeof(kCanaryBytes) - 1)) {
    SetObservation(report, AIH_FILE_PUBLISH, AIH_BLOCKED,
                   "destination-canary-changed");
    goto cleanup;
  }

  result = linkat(source_fd, "", root_fd, kPublishedName, AT_EMPTY_PATH);
  if (result != 0) {
    saved_error = errno;
    SetObservation(report, AIH_FILE_PUBLISH,
                   UnsupportedErrno(saved_error) || saved_error == EPERM
                       ? AIH_UNSUPPORTED
                       : AIH_BLOCKED,
                   UnsupportedErrno(saved_error) || saved_error == EPERM
                       ? kUnsupportedReasons[AIH_FILE_PUBLISH]
                       : "unexpected-error-code");
    goto cleanup;
  }
  published_created = 1;
  if (fstat(source_fd, &source) != 0 ||
      fstatat(root_fd, kPublishedName, &published, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameObject(&source, &published) || source.st_nlink != 1) {
    SetObservation(report, AIH_FILE_PUBLISH, AIH_BLOCKED,
                   "source-identity-drift");
    goto cleanup;
  }

  linked_fd = openat(root_fd, kLinkedName,
                     O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW,
                     0600);
  if (linked_fd < 0 || fstat(linked_fd, &linked) != 0) {
    SetObservation(report, AIH_FILE_PUBLISH, AIH_BLOCKED,
                   "unexpected-error-code");
    goto cleanup;
  }
  linked_created = 1;
  if (linkat(root_fd, kLinkedName, root_fd, kLinkedAlias, 0) != 0) {
    SetObservation(report, AIH_FILE_PUBLISH,
                   UnsupportedErrno(errno) ? AIH_UNSUPPORTED : AIH_BLOCKED,
                   UnsupportedErrno(errno)
                       ? kUnsupportedReasons[AIH_FILE_PUBLISH]
                       : "unexpected-error-code");
    goto cleanup;
  }
  alias_created = 1;
  if (fstat(linked_fd, &linked) != 0 || linked.st_nlink != 2 ||
      fstatat(root_fd, kLinkedAlias, &linked_alias, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameObject(&linked, &linked_alias)) {
    SetObservation(report, AIH_FILE_PUBLISH, AIH_BLOCKED,
                   "hard-link-detected");
    goto cleanup;
  }
  source_linked = 1;
  SetObservation(report, AIH_FILE_PUBLISH, AIH_SUPPORTED,
                 "primitive-qualified");

cleanup:
  if (alias_created && RemoveOwnedFile(root_fd, kLinkedAlias, &linked) != 0) {
    cleanup_ok = 0;
  }
  if (linked_created) {
    if (fstat(linked_fd, &linked) != 0 ||
        (source_linked && linked.st_nlink != 1) ||
        RemoveOwnedFile(root_fd, kLinkedName, &linked) != 0) {
      cleanup_ok = 0;
    }
  }
  if (published_created &&
      RemoveOwnedFile(root_fd, kPublishedName, &source) != 0) {
    cleanup_ok = 0;
  }
  if (canary_created &&
      RemoveOwnedFile(root_fd, kCanaryName, &canary) != 0) {
    cleanup_ok = 0;
  }
  if (linked_fd >= 0) {
    (void)close(linked_fd);
  }
  if (canary_fd >= 0) {
    (void)close(canary_fd);
  }
  (void)close(source_fd);
  if (!cleanup_ok) {
    SetObservation(report, AIH_FILE_PUBLISH, AIH_BLOCKED,
                   "unexpected-error-code");
  }
}

static void ProbeDirectoryPublication(int root_fd,
                                      struct aih_native_fs_report *report) {
  static const char kSourceName[] = "aih-dir-source";
  static const char kCanaryName[] = "aih-dir-canary";
  static const char kCanaryFile[] = "aih-dir-canary-file";
  static const char kPublishedName[] = "aih-dir-published";
  int source_fd = -1;
  int canary_fd = -1;
  int canary_file_fd = -1;
  int source_created = 0;
  int source_identity_ready = 0;
  int canary_created = 0;
  int canary_identity_ready = 0;
  int canary_file_created = 0;
  int published_created = 0;
  int cleanup_ok = 1;
  int result;
  int saved_error;
  struct stat source;
  struct stat canary;
  struct stat canary_file;
  struct stat named;

  if (mkdirat(root_fd, kSourceName, 0700) != 0) {
    SetObservation(report, AIH_DIR_PUBLISH, AIH_BLOCKED,
                   "unexpected-error-code");
    goto cleanup;
  }
  source_created = 1;
  source_fd = openat(root_fd, kSourceName,
                     O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (source_fd < 0 || fstat(source_fd, &source) != 0) {
    SetObservation(report, AIH_DIR_PUBLISH, AIH_BLOCKED,
                   "source-identity-drift");
    goto cleanup;
  }
  source_identity_ready = 1;
  if (mkdirat(root_fd, kCanaryName, 0700) != 0) {
    SetObservation(report, AIH_DIR_PUBLISH, AIH_BLOCKED,
                   "unexpected-error-code");
    goto cleanup;
  }
  canary_created = 1;
  canary_fd = openat(root_fd, kCanaryName,
                     O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (canary_fd < 0 || fstat(canary_fd, &canary) != 0) {
    SetObservation(report, AIH_DIR_PUBLISH, AIH_BLOCKED,
                   "destination-canary-changed");
    goto cleanup;
  }
  canary_identity_ready = 1;
  canary_file_fd = openat(canary_fd, kCanaryFile,
                          O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW,
                          0600);
  if (canary_file_fd < 0 || fstat(canary_file_fd, &canary_file) != 0) {
    SetObservation(report, AIH_DIR_PUBLISH, AIH_BLOCKED,
                   "destination-canary-changed");
    goto cleanup;
  }
  canary_file_created = 1;

  errno = 0;
#if !defined(SYS_renameat2)
  result = -1;
  errno = ENOSYS;
#else
  result = (int)syscall(SYS_renameat2, root_fd, kSourceName, root_fd,
                        kCanaryName, RENAME_NOREPLACE);
#endif
  saved_error = errno;
  if (result == 0 || saved_error != EEXIST ||
      fstatat(root_fd, kSourceName, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameObject(&source, &named) ||
      fstatat(root_fd, kCanaryName, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameObject(&canary, &named) ||
      fstatat(canary_fd, kCanaryFile, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameObject(&canary_file, &named)) {
    SetObservation(report, AIH_DIR_PUBLISH,
                   saved_error == ENOSYS ? AIH_UNSUPPORTED : AIH_BLOCKED,
                   saved_error == ENOSYS
                       ? kUnsupportedReasons[AIH_DIR_PUBLISH]
                       : "destination-canary-changed");
    goto cleanup;
  }

#if !defined(SYS_renameat2)
  result = -1;
  errno = ENOSYS;
#else
  result = (int)syscall(SYS_renameat2, root_fd, kSourceName, root_fd,
                        kPublishedName, RENAME_NOREPLACE);
#endif
  if (result != 0) {
    saved_error = errno;
    SetObservation(report, AIH_DIR_PUBLISH,
                   UnsupportedErrno(saved_error) ? AIH_UNSUPPORTED
                                                 : AIH_BLOCKED,
                   UnsupportedErrno(saved_error)
                       ? kUnsupportedReasons[AIH_DIR_PUBLISH]
                       : "unexpected-error-code");
    goto cleanup;
  }
  source_created = 0;
  published_created = 1;
  if (fstat(source_fd, &source) != 0 ||
      fstatat(root_fd, kPublishedName, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameObject(&source, &named)) {
    SetObservation(report, AIH_DIR_PUBLISH, AIH_BLOCKED,
                   "source-identity-drift");
    goto cleanup;
  }
  SetObservation(report, AIH_DIR_PUBLISH, AIH_SUPPORTED,
                 "primitive-qualified");

cleanup:
  if (canary_file_created &&
      RemoveOwnedFile(canary_fd, kCanaryFile, &canary_file) != 0) {
    cleanup_ok = 0;
  }
  if (canary_file_fd >= 0) {
    (void)close(canary_file_fd);
  }
  if (published_created &&
      RemoveOwnedDirectory(root_fd, kPublishedName, &source) != 0) {
    cleanup_ok = 0;
  }
  if (source_created) {
    if (!source_identity_ready ||
        RemoveOwnedDirectory(root_fd, kSourceName, &source) != 0) {
      cleanup_ok = 0;
    }
  }
  if (canary_created) {
    if (!canary_identity_ready ||
        RemoveOwnedDirectory(root_fd, kCanaryName, &canary) != 0) {
      cleanup_ok = 0;
    }
  }
  if (source_fd >= 0) {
    (void)close(source_fd);
  }
  if (canary_fd >= 0) {
    (void)close(canary_fd);
  }
  if (!cleanup_ok) {
    SetObservation(report, AIH_DIR_PUBLISH, AIH_BLOCKED,
                   "unexpected-error-code");
  }
}

static void ProbeContainment(int root_fd,
                             struct aih_native_fs_report *report) {
  static const char kSymlinkName[] = "aih-containment-link";
  struct open_how how;
  struct stat root;
  struct stat opened;
  int opened_fd = -1;
  int result;
  int saved_error;
  int symlink_created = 0;
  int cleanup_ok = 1;

  memset(&how, 0, sizeof(how));
  how.flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                RESOLVE_NO_MAGICLINKS;
#if !defined(SYS_openat2)
  errno = ENOSYS;
  result = -1;
#else
  result = (int)syscall(SYS_openat2, root_fd, ".", &how, sizeof(how));
#endif
  if (result < 0) {
    saved_error = errno;
    SetObservation(report, AIH_CONTAINMENT,
                   UnsupportedErrno(saved_error) ? AIH_UNSUPPORTED
                                                 : AIH_BLOCKED,
                   UnsupportedErrno(saved_error)
                       ? kUnsupportedReasons[AIH_CONTAINMENT]
                       : "containment-unproven");
    return;
  }
  opened_fd = result;
  if (fstat(root_fd, &root) != 0 || fstat(opened_fd, &opened) != 0 ||
      !SameObject(&root, &opened)) {
    SetObservation(report, AIH_CONTAINMENT, AIH_BLOCKED,
                   "containment-unproven");
    goto cleanup;
  }
  (void)close(opened_fd);
  opened_fd = -1;

  errno = 0;
#if !defined(SYS_openat2)
  result = -1;
  errno = ENOSYS;
#else
  result = (int)syscall(SYS_openat2, root_fd, "../", &how, sizeof(how));
#endif
  saved_error = errno;
  if (result >= 0) {
    (void)close(result);
    SetObservation(report, AIH_CONTAINMENT, AIH_BLOCKED,
                   "containment-unproven");
    goto cleanup;
  }
  if (saved_error != EXDEV && saved_error != ELOOP) {
    SetObservation(report, AIH_CONTAINMENT, AIH_BLOCKED,
                   "unexpected-error-code");
    goto cleanup;
  }

  if (symlinkat(".", root_fd, kSymlinkName) != 0) {
    SetObservation(report, AIH_CONTAINMENT, AIH_BLOCKED,
                   "unexpected-error-code");
    goto cleanup;
  }
  symlink_created = 1;
  errno = 0;
#if !defined(SYS_openat2)
  result = -1;
  errno = ENOSYS;
#else
  result = (int)syscall(SYS_openat2, root_fd, kSymlinkName, &how,
                        sizeof(how));
#endif
  saved_error = errno;
  if (result >= 0) {
    (void)close(result);
    SetObservation(report, AIH_CONTAINMENT, AIH_BLOCKED,
                   "symlink-detected");
    goto cleanup;
  }
  if (saved_error != ELOOP) {
    SetObservation(report, AIH_CONTAINMENT, AIH_BLOCKED,
                   "unexpected-error-code");
    goto cleanup;
  }
  SetObservation(report, AIH_CONTAINMENT, AIH_SUPPORTED,
                 "primitive-qualified");

cleanup:
  if (opened_fd >= 0) {
    (void)close(opened_fd);
  }
  if (symlink_created && unlinkat(root_fd, kSymlinkName, 0) != 0) {
    cleanup_ok = 0;
  }
  if (!cleanup_ok) {
    SetObservation(report, AIH_CONTAINMENT, AIH_BLOCKED,
                   "unexpected-error-code");
  }
}

int aih_backend_probe_native_fs(const char *root,
                                struct aih_native_fs_report *report) {
  const char *child;
  int temp_fd = -1;
  int root_fd = -1;
  struct stat temp_identity;
  struct stat named_identity;
  struct stat root_identity;
  struct statfs temp_filesystem;
  struct statfs root_filesystem;
  struct statx temp_mount;
  struct statx root_mount;
  int empty;

  if (root == NULL || root[0] == '\0' || report == NULL) {
    return -1;
  }
  InitializeReport(report);
  child = CapabilityChild(root);
  if (child == NULL) {
    BlockReport(report, "root-outside-temporary-directory");
    return 0;
  }

  temp_fd = open(P_tmpdir, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (temp_fd < 0 || fstat(temp_fd, &temp_identity) != 0 ||
      !S_ISDIR(temp_identity.st_mode)) {
    BlockReport(report, "root-identity-unavailable");
    goto done;
  }
  if (fstatat(temp_fd, child, &named_identity, AT_SYMLINK_NOFOLLOW) != 0) {
    BlockReport(report, "root-identity-unavailable");
    goto done;
  }
  if (S_ISLNK(named_identity.st_mode)) {
    BlockReport(report, "root-linked");
    goto done;
  }
  if (!S_ISDIR(named_identity.st_mode)) {
    BlockReport(report, "root-identity-unavailable");
    goto done;
  }
  root_fd = openat(temp_fd, child,
                   O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (root_fd < 0 || fstat(root_fd, &root_identity) != 0 ||
      !SameObject(&named_identity, &root_identity)) {
    BlockReport(report, "root-identity-drift");
    goto done;
  }
  if (root_identity.st_uid != geteuid() ||
      (root_identity.st_mode & 07777) != 0700 || root_identity.st_nlink != 2) {
    BlockReport(report, "root-not-private");
    goto done;
  }
  empty = DirectoryIsEmpty(root_fd);
  if (empty <= 0) {
    BlockReport(report, empty == 0 ? "root-not-private"
                                  : "root-identity-unavailable");
    goto done;
  }
  if (root_identity.st_dev != temp_identity.st_dev) {
    BlockReport(report, "cross-volume-operation");
    goto done;
  }
  if (fstatfs(temp_fd, &temp_filesystem) != 0 ||
      fstatfs(root_fd, &root_filesystem) != 0) {
    BlockReport(report, "filesystem-identity-unavailable");
    goto done;
  }
  if (!SameFilesystem(&temp_filesystem, &root_filesystem)) {
    BlockReport(report, "filesystem-identity-drift");
    goto done;
  }
  if (StatMount(temp_fd, &temp_mount) != 0 ||
      StatMount(root_fd, &root_mount) != 0) {
    BlockReport(report, "containment-unproven");
    goto done;
  }
  if ((temp_mount.stx_mask & STATX_MNT_ID) == 0 ||
      (root_mount.stx_mask & STATX_MNT_ID) == 0 ||
      temp_mount.stx_mnt_id != root_mount.stx_mnt_id) {
    BlockReport(report, "containment-unproven");
    goto done;
  }

  ProbeContainment(root_fd, report);
  ProbeFilePublication(root_fd, report);
  ProbeDirectoryPublication(root_fd, report);
  if (fsync(root_fd) == 0) {
    SetObservation(report, AIH_PARENT_DURABILITY, AIH_SUPPORTED,
                   "primitive-qualified");
  } else if (UnsupportedErrno(errno)) {
    SetObservation(report, AIH_PARENT_DURABILITY, AIH_UNSUPPORTED,
                   kUnsupportedReasons[AIH_PARENT_DURABILITY]);
  } else {
    SetObservation(report, AIH_PARENT_DURABILITY, AIH_BLOCKED,
                   "unexpected-error-code");
  }

  if (!RootIdentityIsStable(temp_fd, root_fd, child, &root_identity,
                            &root_filesystem,
                            (uint64_t)root_mount.stx_mnt_id)) {
    BlockReport(report, "root-identity-drift");
    goto done;
  }
  empty = DirectoryIsEmpty(root_fd);
  if (empty != 1) {
    BlockReport(report, "unexpected-error-code");
  }

done:
  if (root_fd >= 0) {
    (void)close(root_fd);
  }
  if (temp_fd >= 0) {
    (void)close(temp_fd);
  }
  return 0;
}
