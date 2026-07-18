#include <node_api.h>

static const char kBlockedReport[] =
    "{\"schemaVersion\":1,\"probeVersion\":\"phase-4a-native-fs-v1\","
    "\"state\":\"blocked\",\"reason\":\"native-backend-unimplemented\"}";

static napi_value Probe(napi_env env, napi_callback_info info) {
  napi_value report;
  (void)info;

  if (napi_create_string_utf8(env, kBlockedReport, NAPI_AUTO_LENGTH, &report) !=
      napi_ok) {
    return NULL;
  }

  return report;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value probe;

  if (napi_create_function(env, "probe", NAPI_AUTO_LENGTH, Probe, NULL, &probe) !=
      napi_ok) {
    return NULL;
  }
  if (napi_set_named_property(env, exports, "probe", probe) != napi_ok) {
    return NULL;
  }

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
