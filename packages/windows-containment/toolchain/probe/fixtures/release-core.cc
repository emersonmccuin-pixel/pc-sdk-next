#include <cstddef>
#include <cstdint>

#include "msvc-static-crt-contract.h"

namespace {

using ProbeFunction = std::uint32_t(__cdecl*)(std::uint32_t) noexcept;

__declspec(noinline) std::uint32_t probe_target(const std::uint32_t value) noexcept {
  return value + 2U;
}

ProbeFunction volatile probe_dispatch = &probe_target;

__declspec(noinline) std::uint32_t probe_stack(const std::uint32_t seed) noexcept {
  volatile std::uint8_t bytes[64]{};
  for (std::size_t index = 0; index < 64U; ++index) {
    bytes[index] = static_cast<std::uint8_t>(seed + static_cast<std::uint32_t>(index));
  }
  return static_cast<std::uint32_t>(bytes[0]) + static_cast<std::uint32_t>(bytes[63]);
}

__declspec(noinline) std::uint32_t probe_exception(const std::uint32_t value) {
  try {
    if (value == 7U) {
      throw 9U;
    }
  } catch (const std::uint32_t caught) {
    return caught;
  }
  return value;
}

}  // namespace

extern "C" std::uint32_t pcsdk_probe_core() {
  const ProbeFunction selected = probe_dispatch;
  return selected(40U) + probe_stack(1U) + probe_exception(7U);
}
