#include "backend.h"

#if !defined(AIH_NATIVE_FS_BACKEND_LINUX) &&     \
    !defined(AIH_NATIVE_FS_BACKEND_WINDOWS) &&   \
    !defined(AIH_NATIVE_FS_BACKEND_DARWIN)
int aih_backend_probe_native_fs(const char *root,
                                struct aih_native_fs_report *report) {
  int index;

  if (root == 0 || root[0] == '\0' || report == 0) {
    return -1;
  }

  for (index = 0; index < AIH_NATIVE_FS_OBSERVATION_COUNT; index += 1) {
    report->observations[index].primitive = (enum aih_native_fs_primitive)index;
    report->observations[index].disposition = AIH_BLOCKED;
    report->observations[index].reason = "native-backend-unimplemented";
  }

  return 0;
}
#endif

int aih_probe_native_fs(const char *root, struct aih_native_fs_report *report) {
  if (root == 0 || root[0] == '\0' || report == 0) {
    return -1;
  }
  return aih_backend_probe_native_fs(root, report);
}
