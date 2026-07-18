#include <stddef.h>
#include <stdint.h>

#include "msvc-static-crt-contract.h"

typedef uint32_t(__cdecl* probe_function)(uint32_t);

static __declspec(noinline) uint32_t probe_target(const uint32_t value) {
  return value ^ UINT32_C(0x5a5a5a5a);
}

static probe_function volatile probe_dispatch = probe_target;

uint32_t pcsdk_sqlite_c_flag_probe(const uint32_t seed) {
  volatile uint8_t bytes[64] = {0};
  size_t index = 0;
  for (index = 0; index < sizeof(bytes); ++index) {
    bytes[index] = (uint8_t)(seed + (uint32_t)index);
  }
  return probe_dispatch(seed) + (uint32_t)bytes[63];
}
