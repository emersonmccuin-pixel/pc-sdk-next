#include "pc_sdk_next/resource_manifest.h"

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iterator>
#include <span>
#include <vector>

namespace {

[[noreturn]] void Trap() noexcept {
  std::abort();
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
  using namespace pc_sdk_next::containment;
  if (data == nullptr && size != 0) Trap();

  constexpr std::uint8_t kCanonicalObject[]{'{', '"', 'x', '"', ':', '0', '}'};
  constexpr std::uint8_t kNoncanonicalWhitespace[]{'{', '"', 'x', '"', ':', ' ', '0', '}'};
  if (!ValidateResourceManifestCompactJsonSyntax(kCanonicalObject) ||
      ValidateResourceManifestCompactJsonSyntax(kNoncanonicalWhitespace)) {
    Trap();
  }

  const std::span<const std::uint8_t> input = data == nullptr
      ? std::span<const std::uint8_t>{}
      : std::span<const std::uint8_t>(data, size);
  std::span<const std::uint8_t> payload = input;
  std::vector<std::uint8_t> wrapped;
  if (!input.empty() &&
      input.size() - 1 <= kMaximumResourceManifestPayloadBytes - 12) {
    const std::uint8_t mode = input.front() % 3U;
    const std::span<const std::uint8_t> body = input.subspan(1);
    if (mode == 1U) {
      constexpr std::uint8_t kPrefix[]{'{', '"', 'x', '"', ':'};
      wrapped.insert(wrapped.end(), std::begin(kPrefix), std::end(kPrefix));
      wrapped.insert(wrapped.end(), body.begin(), body.end());
      wrapped.push_back('}');
      payload = wrapped;
    } else if (mode == 2U) {
      constexpr std::uint8_t kPrefix[]{'{', '"', 'x', '"', ':', '"'};
      wrapped.insert(wrapped.end(), std::begin(kPrefix), std::end(kPrefix));
      wrapped.insert(wrapped.end(), body.begin(), body.end());
      wrapped.push_back('"');
      wrapped.push_back('}');
      payload = wrapped;
    }
  }

  const bool first = ValidateResourceManifestCompactJsonSyntax(payload);
  const bool replay = ValidateResourceManifestCompactJsonSyntax(payload);
  if (first != replay) Trap();
  if (first &&
      (payload.empty() || payload.front() != '{' || payload.back() != '}')) {
    Trap();
  }
  return 0;
}
