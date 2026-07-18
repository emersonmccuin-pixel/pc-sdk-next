#include <cstdint>
#include <node_api.h>

#include "msvc-static-crt-contract.h"

extern "C" std::uint32_t pcsdk_probe_core();

NAPI_MODULE_INIT() {
  napi_value value = nullptr;
  if (napi_create_uint32(env, pcsdk_probe_core(), &value) != napi_ok) {
    return nullptr;
  }
  if (napi_set_named_property(env, exports, "probeValue", value) != napi_ok) {
    return nullptr;
  }
  return exports;
}
