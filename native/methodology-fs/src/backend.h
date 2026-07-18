#ifndef AIH_METHODOLOGY_FS_BACKEND_H
#define AIH_METHODOLOGY_FS_BACKEND_H

#define AIH_NATIVE_FS_OBSERVATION_COUNT 7

#if (defined(AIH_NATIVE_FS_BACKEND_LINUX) +                              \
     defined(AIH_NATIVE_FS_BACKEND_WINDOWS) +                            \
     defined(AIH_NATIVE_FS_BACKEND_DARWIN)) > 1
#error "exactly one native filesystem backend may be selected"
#endif

enum aih_native_fs_disposition {
  AIH_BLOCKED = 0
};

enum aih_native_fs_primitive {
  AIH_FILE_PUBLISH = 0,
  AIH_DIR_PUBLISH = 1,
  AIH_FILE_DETACH = 2,
  AIH_DIR_DETACH = 3,
  AIH_PARENT_DURABILITY = 4,
  AIH_CONTAINMENT = 5,
  AIH_SUBSTITUTION = 6
};

struct aih_native_fs_observation {
  enum aih_native_fs_primitive primitive;
  enum aih_native_fs_disposition disposition;
  const char *reason;
};

struct aih_native_fs_report {
  struct aih_native_fs_observation observations[AIH_NATIVE_FS_OBSERVATION_COUNT];
};

int aih_probe_native_fs(const char *root, struct aih_native_fs_report *report);
int aih_backend_probe_native_fs(const char *root,
                                struct aih_native_fs_report *report);

#endif
