#include <cstdio>
#include <cstring>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

#include "pc_sdk_next/resource.h"

namespace pc_sdk_next::containment {
[[nodiscard]] bool RunResourceProperties(
    std::uint64_t* assertion_count,
    QualificationCanaryResult* canary_result) noexcept;
}  // namespace pc_sdk_next::containment

int main(int argc, char** argv) {
  if (argc != 3 || argv == nullptr || argv[1] == nullptr || argv[2] == nullptr ||
      std::strcmp(argv[1], "--mode") != 0 ||
      std::strcmp(argv[2], "resource-ownership") != 0) {
    return 2;
  }
#if defined(_WIN32)
  const int stdout_descriptor = _fileno(stdout);
  if (stdout_descriptor < 0 || _setmode(stdout_descriptor, _O_BINARY) == -1) return 1;
#endif

  std::uint64_t assertions = 0;
  pc_sdk_next::containment::QualificationCanaryResult canary{
      pc_sdk_next::containment::QualificationCanaryStatus::failed, "unrun", "", 0};
  const bool passed =
      pc_sdk_next::containment::RunResourceProperties(&assertions, &canary);
  if (!passed || assertions == 0 || assertions > 9'007'199'254'740'991ULL) return 1;

  if (canary.status == pc_sdk_next::containment::QualificationCanaryStatus::inconclusive) {
    const int written = std::printf(
        "{\"schemaVersion\":1,\"mode\":\"resource-ownership\","
        "\"status\":\"inconclusive\",\"reason\":\"%.*s\","
        "\"siteId\":\"%.*s\",\"attempts\":%llu}\n",
        static_cast<int>(canary.reason.size()), canary.reason.data(),
        static_cast<int>(canary.site_id.size()), canary.site_id.data(),
        static_cast<unsigned long long>(canary.attempts));
    return written > 0 && written <= 512 ? 3 : 4;
  }
  if (canary.status != pc_sdk_next::containment::QualificationCanaryStatus::passed) return 1;
  bool canary_site_is_generated = false;
  for (const std::string_view site_id :
       pc_sdk_next::containment::kResourceSiteIdStrings) {
    canary_site_is_generated = canary_site_is_generated || site_id == canary.site_id;
  }
  if (canary.attempts == 0 || !canary_site_is_generated ||
      pc_sdk_next::containment::kResourceSiteIdStrings.empty()) {
    return 1;
  }

  char output[2'048]{};
  std::size_t used = 0;
  const auto append = [&output, &used](const char* format, auto... values) noexcept {
    if (used >= sizeof(output)) return false;
    const int written = std::snprintf(
        output + used, sizeof(output) - used, format, values...);
    if (written < 0 || static_cast<std::size_t>(written) >= sizeof(output) - used) {
      return false;
    }
    used += static_cast<std::size_t>(written);
    return true;
  };
  if (!append(
      "{\"schemaVersion\":1,\"mode\":\"resource-ownership\","
      "\"artifact\":\"%.*s\",\"status\":\"passed\","
      "\"assertions\":%llu,\"abaSiteId\":\"%.*s\","
      "\"abaAttempts\":%llu,\"siteIds\":[",
      static_cast<int>(pc_sdk_next::containment::kResourceOwnershipManifestArtifactId.size()),
      pc_sdk_next::containment::kResourceOwnershipManifestArtifactId.data(),
      static_cast<unsigned long long>(assertions),
      static_cast<int>(canary.site_id.size()), canary.site_id.data(),
      static_cast<unsigned long long>(canary.attempts))) {
    return 4;
  }
  bool first_site = true;
  for (const std::string_view site_id :
       pc_sdk_next::containment::kResourceSiteIdStrings) {
    if (!append(first_site ? "\"%.*s\"" : ",\"%.*s\"",
                static_cast<int>(site_id.size()), site_id.data())) {
      return 4;
    }
    first_site = false;
  }
  if (!append("]}\n") || used == 0 || used > 2'047) return 4;
  if (std::fwrite(output, 1, used, stdout) != used) return 4;
  return 0;
}
