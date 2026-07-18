#include <node_api.h>

#include <stddef.h>
#include <string.h>

#include "backend.h"

#define AIH_MAX_ROOT_BYTES 4096
#define AIH_MAX_ROOT_UTF16_UNITS 4096
#define AIH_MAX_REPORT_BYTES 8192

static const char *const kPrimitiveNames[AIH_NATIVE_FS_OBSERVATION_COUNT] = {
    "identity-bound-file-publication",
    "no-replace-directory-publication",
    "identity-bound-file-detachment",
    "identity-bound-directory-detachment",
    "parent-directory-durability",
    "link-and-volume-containment",
    "substitution-resistance"};

static const char *const kDispositionNames[] = {"supported", "unsupported",
                                                "blocked"};

static const char *const kUnsupportedReasons[AIH_NATIVE_FS_OBSERVATION_COUNT] = {
    "identity-bound-file-publication-unavailable",
    "no-replace-directory-publication-unavailable",
    "identity-bound-file-detachment-unavailable",
    "identity-bound-directory-detachment-unavailable",
    "parent-directory-durability-unavailable",
    "link-and-volume-containment-unavailable",
    "substitution-resistance-unavailable"};

static const char *const kBlockedReasons[] = {
    "native-backend-unimplemented",
    "native-addon-unavailable",
    "native-addon-load-failed",
    "native-addon-abi-mismatch",
    "native-addon-ancestor-invalid",
    "native-addon-oversized",
    "native-loader-not-identity-bound",
    "native-report-invalid",
    "native-report-oversized",
    "native-operation-failed",
    "unexpected-error-code",
    "root-identity-unavailable",
    "root-identity-drift",
    "root-not-private",
    "root-linked",
    "root-outside-temporary-directory",
    "filesystem-identity-unavailable",
    "filesystem-identity-drift",
    "containment-unproven",
    "substitution-resistance-unproven",
    "source-identity-drift",
    "destination-canary-changed",
    "cross-volume-operation",
    "symlink-detected",
    "hard-link-detected",
    "reparse-point-detected"};

static napi_value ThrowTypeError(napi_env env, const char *message) {
  (void)napi_throw_type_error(env, NULL, message);
  return NULL;
}

static napi_value ThrowRangeError(napi_env env, const char *message) {
  (void)napi_throw_range_error(env, NULL, message);
  return NULL;
}

static int AppendLiteral(char *output, size_t capacity, size_t *length,
                         const char *literal) {
  size_t literal_length = strlen(literal);
  if (*length > capacity || literal_length > capacity - *length) {
    return -1;
  }
  memcpy(output + *length, literal, literal_length);
  *length += literal_length;
  return 0;
}

static int Utf16RootIsValid(const char16_t *root, size_t length) {
  size_t index;
  for (index = 0; index < length; index += 1) {
    const char16_t unit = root[index];
    if (unit == 0) {
      return 0;
    }
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      if (index + 1 >= length || root[index + 1] < 0xDC00 ||
          root[index + 1] > 0xDFFF) {
        return 0;
      }
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return 0;
    }
  }
  return 1;
}

static const char *CanonicalBlockedReason(const char *reason) {
  size_t index;
  if (reason == NULL) {
    return NULL;
  }
  for (index = 0; index < sizeof(kBlockedReasons) / sizeof(kBlockedReasons[0]);
       index += 1) {
    if (strcmp(reason, kBlockedReasons[index]) == 0) {
      return kBlockedReasons[index];
    }
  }
  return NULL;
}

static const char *CanonicalReason(
    size_t index, const struct aih_native_fs_observation *observation) {
  if (observation->reason == NULL) {
    return NULL;
  }
  if (observation->disposition == AIH_SUPPORTED) {
    return strcmp(observation->reason, "primitive-qualified") == 0
               ? "primitive-qualified"
               : NULL;
  }
  if (observation->disposition == AIH_UNSUPPORTED) {
    return strcmp(observation->reason, kUnsupportedReasons[index]) == 0
               ? kUnsupportedReasons[index]
               : NULL;
  }
  if (observation->disposition == AIH_BLOCKED) {
    return CanonicalBlockedReason(observation->reason);
  }
  return NULL;
}

static int ReportIsCanonical(const struct aih_native_fs_report *report) {
  size_t index;
  for (index = 0; index < AIH_NATIVE_FS_OBSERVATION_COUNT; index += 1) {
    const struct aih_native_fs_observation *observation =
        &report->observations[index];
    if (observation->primitive != (enum aih_native_fs_primitive)index ||
        observation->disposition < AIH_SUPPORTED ||
        observation->disposition > AIH_BLOCKED ||
        CanonicalReason(index, observation) == NULL) {
      return 0;
    }
  }
  return 1;
}

static void BlockReport(struct aih_native_fs_report *report,
                        const char *reason) {
  size_t index;
  for (index = 0; index < AIH_NATIVE_FS_OBSERVATION_COUNT; index += 1) {
    report->observations[index].primitive =
        (enum aih_native_fs_primitive)index;
    report->observations[index].disposition = AIH_BLOCKED;
    report->observations[index].reason = reason;
  }
}

static int SerializeReport(const struct aih_native_fs_report *report,
                           char *output, size_t capacity, size_t *length) {
  size_t index;
  *length = 0;
  if (AppendLiteral(output, capacity, length,
                    "{\"schemaVersion\":1,\"nativeProtocolVersion\":\""
                    "phase-4a-native-observations-v1\",\"observations\":[") !=
      0) {
    return -1;
  }
  for (index = 0; index < AIH_NATIVE_FS_OBSERVATION_COUNT; index += 1) {
    const struct aih_native_fs_observation *observation =
        &report->observations[index];
    const char *reason = CanonicalReason(index, observation);
    if (reason == NULL ||
        (index != 0 && AppendLiteral(output, capacity, length, ",") != 0) ||
        AppendLiteral(output, capacity, length, "{\"primitive\":\"") != 0 ||
        AppendLiteral(output, capacity, length, kPrimitiveNames[index]) != 0 ||
        AppendLiteral(output, capacity, length,
                      "\",\"disposition\":\"") != 0 ||
        AppendLiteral(output, capacity, length,
                      kDispositionNames[observation->disposition]) != 0 ||
        AppendLiteral(output, capacity, length, "\",\"reason\":\"") != 0 ||
        AppendLiteral(output, capacity, length, reason) != 0 ||
        AppendLiteral(output, capacity, length, "\"}") != 0) {
      return -1;
    }
  }
  return AppendLiteral(output, capacity, length, "]}");
}

static napi_value Probe(napi_env env, napi_callback_info info) {
  size_t argument_count = 2;
  napi_value arguments[2];
  napi_valuetype argument_type;
  size_t root_utf16_length = 0;
  size_t copied_utf16_length = 0;
  size_t root_length = 0;
  size_t copied_length = 0;
  char16_t root_utf16[AIH_MAX_ROOT_UTF16_UNITS + 1];
  char root[AIH_MAX_ROOT_BYTES + 1];
  struct aih_native_fs_report report;
  char output[AIH_MAX_REPORT_BYTES];
  size_t output_length = 0;
  napi_value result;

  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) !=
      napi_ok) {
    return ThrowTypeError(env, "native filesystem probe arguments are invalid");
  }
  if (argument_count != 1) {
    return ThrowTypeError(env,
                          "native filesystem probe requires exactly one root");
  }
  if (napi_typeof(env, arguments[0], &argument_type) != napi_ok ||
      argument_type != napi_string) {
    return ThrowTypeError(env, "native filesystem probe root must be a string");
  }
  if (napi_get_value_string_utf16(env, arguments[0], NULL, 0,
                                  &root_utf16_length) != napi_ok) {
    return ThrowTypeError(env, "native filesystem probe root is invalid");
  }
  if (root_utf16_length == 0) {
    return ThrowTypeError(env, "native filesystem probe root must not be empty");
  }
  if (root_utf16_length > AIH_MAX_ROOT_UTF16_UNITS) {
    return ThrowRangeError(env, "native filesystem probe root is oversized");
  }
  if (napi_get_value_string_utf16(env, arguments[0], root_utf16,
                                  AIH_MAX_ROOT_UTF16_UNITS + 1,
                                  &copied_utf16_length) != napi_ok ||
      copied_utf16_length != root_utf16_length ||
      !Utf16RootIsValid(root_utf16, copied_utf16_length)) {
    return ThrowTypeError(env, "native filesystem probe root is invalid");
  }
  if (napi_get_value_string_utf8(env, arguments[0], NULL, 0, &root_length) !=
      napi_ok) {
    return ThrowTypeError(env, "native filesystem probe root is invalid");
  }
  if (root_length > AIH_MAX_ROOT_BYTES) {
    return ThrowRangeError(env, "native filesystem probe root is oversized");
  }
  if (napi_get_value_string_utf8(env, arguments[0], root, sizeof(root),
                                 &copied_length) != napi_ok ||
      copied_length != root_length || strlen(root) != copied_length) {
    return ThrowTypeError(env, "native filesystem probe root is invalid");
  }

  if (aih_probe_native_fs(root, &report) != 0 || !ReportIsCanonical(&report)) {
    BlockReport(&report, "native-operation-failed");
  }
  if (SerializeReport(&report, output, sizeof(output), &output_length) != 0 ||
      napi_create_string_utf8(env, output, output_length, &result) != napi_ok) {
    return ThrowRangeError(env, "native filesystem probe report is invalid");
  }
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor descriptor = {
      "probe", NULL, Probe, NULL, NULL, NULL, napi_enumerable, NULL};

  if (napi_define_properties(env, exports, 1, &descriptor) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
