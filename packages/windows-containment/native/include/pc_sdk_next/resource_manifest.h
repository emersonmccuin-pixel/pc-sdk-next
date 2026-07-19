#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>

namespace pc_sdk_next::containment {

inline constexpr std::size_t kResourceManifestHeaderBytes = 64;
inline constexpr std::size_t kResourceManifestFooterBytes = 16;
inline constexpr std::size_t kMaximumResourceManifestPayloadBytes = 128U * 1024U;
inline constexpr std::size_t kMaximumResourceManifestFrameBytes =
    kResourceManifestHeaderBytes + kMaximumResourceManifestPayloadBytes +
    kResourceManifestFooterBytes;
inline constexpr std::size_t kMaximumResourceManifestSites = 64;

enum class ResourceManifestValidation : std::uint8_t {
  valid = 0,
  empty = 1,
  too_large = 2,
  invalid_frame = 3,
  digest_mismatch = 4,
  invalid_json = 5,
  binding_mismatch = 6,
  missing_site = 7,
  duplicate_site = 8,
};

// Artifact-neutral lexical validation shared by production frame validation and
// the sealed manifest fuzz target. This only establishes a bounded, compact,
// UTF-8 JSON object; it does not establish schema, key uniqueness/order, or an
// artifact binding. The frame validator separately requires byte equality with
// the generated artifact payload.
[[nodiscard]] bool ValidateResourceManifestCompactJsonSyntax(
    std::span<const std::uint8_t> payload) noexcept;

[[nodiscard]] ResourceManifestValidation ValidateResourceOwnershipManifestFrame(
    std::span<const std::uint8_t> frame,
    std::span<const std::string_view> expected_site_ids) noexcept;

[[nodiscard]] bool ResourceManifestContainsExactString(
    std::span<const std::uint8_t> frame, std::string_view value) noexcept;

[[nodiscard]] std::span<const std::uint8_t> EmbeddedResourceOwnershipManifest() noexcept;
[[nodiscard]] std::span<const std::uint8_t> EmbeddedResourceOwnershipManifestSha256() noexcept;
[[nodiscard]] ResourceManifestValidation ValidateEmbeddedResourceOwnershipManifest() noexcept;

#if defined(PCSDK_QUALIFICATION)
// Qualification-only hostile-frame helper. It cannot change length/header/footer and
// never appears in a production artifact.
[[nodiscard]] bool QualificationRecomputeResourceManifestFrameDigest(
    std::span<std::uint8_t> frame) noexcept;
#endif

}  // namespace pc_sdk_next::containment
