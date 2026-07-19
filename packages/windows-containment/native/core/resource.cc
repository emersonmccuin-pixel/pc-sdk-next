#include "pc_sdk_next/resource.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cstring>
#include <limits>
#include <new>

#if defined(_WIN32)
#include <Windows.h>
#endif

namespace pc_sdk_next::containment {

#if defined(_MSC_VER)
#pragma section(".rdata$PCSDKRM", read)
__declspec(allocate(".rdata$PCSDKRM"))
constinit const auto kEmbeddedResourceOwnershipManifest =
    ResourceOwnershipManifestSourceFrame();
#else
[[gnu::section(".rdata$PCSDKRM"), gnu::used]]
constinit const auto kEmbeddedResourceOwnershipManifest =
    ResourceOwnershipManifestSourceFrame();
#endif
constinit const auto kEmbeddedResourceOwnershipManifestSha256 =
    ResourceOwnershipManifestSourceSha256();

struct ResourceFactoryAccess final {
  template <typename Native, ResourceSiteId Site, typename Policy>
  [[nodiscard]] static std::optional<OwnedResource<Native, Site, Policy>> Own(
      Native value, std::shared_ptr<OwnerLivenessState> liveness,
      ReleaseQuarantineSink* sink
#if defined(PCSDK_QUALIFICATION)
      , QualificationReleaseFaultPort* fault_port
#endif
      ) noexcept {
    return std::optional<OwnedResource<Native, Site, Policy>>{
        OwnedResource<Native, Site, Policy>(
            std::move(value), std::move(liveness), sink
#if defined(PCSDK_QUALIFICATION)
            , fault_port
#endif
            )};
  }

  template <typename Native, ResourceSiteId Site, typename Policy>
  [[nodiscard]] static std::optional<BorrowedResource<Native, Site, Policy>> Borrow(
      Native value, OwnerLivenessToken owner) noexcept {
    if (!Policy::IsValid(value) || !owner.is_live()) return std::nullopt;
    return std::optional<BorrowedResource<Native, Site, Policy>>{
        BorrowedResource<Native, Site, Policy>(std::move(value), std::move(owner))};
  }

  template <typename Native, ResourceSiteId Site, typename Policy>
  [[nodiscard]] static std::optional<NoReleaseResource<Native, Site, Policy>> NoRelease(
      Native value) noexcept {
    if (!Policy::IsValid(value)) return std::nullopt;
    return std::optional<NoReleaseResource<Native, Site, Policy>>{
        NoReleaseResource<Native, Site, Policy>(std::move(value))};
  }
};

namespace {

#if defined(PCSDK_QUALIFICATION)
std::atomic<std::uint64_t> g_owned_event_acquisitions{0};
std::atomic<std::uint64_t> g_owned_event_release_calls{0};
std::atomic<std::uint64_t> g_borrowed_event_observations{0};
std::atomic<std::uint64_t> g_pseudo_process_observations{0};
std::atomic<std::uint64_t> g_local_alloc_acquisitions{0};
std::atomic<std::uint64_t> g_local_alloc_release_calls{0};
#endif

constexpr std::array<std::uint8_t, 16> kFrameFooter{
    'P', 'C', 'S', 'D', 'K', '-', 'C', 'X', '0', '0', '4', '-', 'E', 'N', 'D', 0};

struct DecodedFrame final {
  std::span<const std::uint8_t> payload;
  std::span<const std::uint8_t> digest;
  std::uint8_t artifact_code;
  std::uint32_t site_count;
};

[[nodiscard]] std::uint16_t ReadLe16(
    std::span<const std::uint8_t> bytes, std::size_t offset) noexcept {
  return static_cast<std::uint16_t>(bytes[offset]) |
      static_cast<std::uint16_t>(bytes[offset + 1]) << 8U;
}

[[nodiscard]] std::uint32_t ReadLe32(
    std::span<const std::uint8_t> bytes, std::size_t offset) noexcept {
  return static_cast<std::uint32_t>(bytes[offset]) |
      static_cast<std::uint32_t>(bytes[offset + 1]) << 8U |
      static_cast<std::uint32_t>(bytes[offset + 2]) << 16U |
      static_cast<std::uint32_t>(bytes[offset + 3]) << 24U;
}

[[nodiscard]] bool DecodeFrame(
    std::span<const std::uint8_t> frame, DecodedFrame* decoded) noexcept {
  if (decoded == nullptr ||
      frame.size() < kResourceManifestHeaderBytes + kResourceManifestFooterBytes ||
      frame.size() > kMaximumResourceManifestFrameBytes ||
      !std::equal(frame.begin(), frame.begin() + 16,
                  kEmbeddedResourceOwnershipManifest.begin()) ||
      ReadLe16(frame, 16) != 1 || ReadLe16(frame, 18) != kResourceManifestHeaderBytes ||
      frame[20] < 1 || frame[20] > 3 || frame[21] != 0 || frame[22] != 0 ||
      frame[23] != 0) {
    return false;
  }
  const std::uint32_t payload_length = ReadLe32(frame, 24);
  const std::uint32_t site_count = ReadLe32(frame, 28);
  if (payload_length > kMaximumResourceManifestPayloadBytes ||
      site_count > kMaximumResourceManifestSites) {
    return false;
  }
  const std::size_t expected_size = kResourceManifestHeaderBytes +
      static_cast<std::size_t>(payload_length) + kResourceManifestFooterBytes;
  if (frame.size() != expected_size) return false;
  const std::size_t footer_offset = kResourceManifestHeaderBytes + payload_length;
  if (!std::equal(kFrameFooter.begin(), kFrameFooter.end(),
                  frame.begin() + static_cast<std::ptrdiff_t>(footer_offset))) {
    return false;
  }
  *decoded = DecodedFrame{
      frame.subspan(kResourceManifestHeaderBytes, payload_length),
      frame.subspan(32, 32),
      frame[20],
      site_count,
  };
  return true;
}

constexpr std::array<std::uint32_t, 64> kSha256RoundConstants{
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
    0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
    0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
    0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
    0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
    0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
    0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
};

[[nodiscard]] constexpr std::uint32_t RotateRight(
    std::uint32_t value, unsigned int count) noexcept {
  return (value >> count) | (value << (32U - count));
}

void Sha256Compress(
    const std::uint8_t* block, std::array<std::uint32_t, 8>* hash) noexcept {
  std::array<std::uint32_t, 64> words{};
  for (std::size_t index = 0; index < 16; ++index) {
    const std::size_t offset = index * 4;
    words[index] = static_cast<std::uint32_t>(block[offset]) << 24U |
        static_cast<std::uint32_t>(block[offset + 1]) << 16U |
        static_cast<std::uint32_t>(block[offset + 2]) << 8U |
        static_cast<std::uint32_t>(block[offset + 3]);
  }
  for (std::size_t index = 16; index < words.size(); ++index) {
    const std::uint32_t a = words[index - 15];
    const std::uint32_t b = words[index - 2];
    const std::uint32_t sigma0 = RotateRight(a, 7) ^ RotateRight(a, 18) ^ (a >> 3U);
    const std::uint32_t sigma1 = RotateRight(b, 17) ^ RotateRight(b, 19) ^ (b >> 10U);
    words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1;
  }
  std::uint32_t a = (*hash)[0];
  std::uint32_t b = (*hash)[1];
  std::uint32_t c = (*hash)[2];
  std::uint32_t d = (*hash)[3];
  std::uint32_t e = (*hash)[4];
  std::uint32_t f = (*hash)[5];
  std::uint32_t g = (*hash)[6];
  std::uint32_t h = (*hash)[7];
  for (std::size_t index = 0; index < 64; ++index) {
    const std::uint32_t upper = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
    const std::uint32_t choice = (e & f) ^ (~e & g);
    const std::uint32_t first = h + upper + choice + kSha256RoundConstants[index] + words[index];
    const std::uint32_t lower = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
    const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const std::uint32_t second = lower + majority;
    h = g;
    g = f;
    f = e;
    e = d + first;
    d = c;
    c = b;
    b = a;
    a = first + second;
  }
  (*hash)[0] += a;
  (*hash)[1] += b;
  (*hash)[2] += c;
  (*hash)[3] += d;
  (*hash)[4] += e;
  (*hash)[5] += f;
  (*hash)[6] += g;
  (*hash)[7] += h;
}

[[nodiscard]] std::array<std::uint8_t, 32> Sha256(
    std::span<const std::uint8_t> input) noexcept {
  std::array<std::uint32_t, 8> hash{
      0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
      0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U,
  };
  std::size_t offset = 0;
  while (input.size() - offset >= 64) {
    Sha256Compress(input.data() + offset, &hash);
    offset += 64;
  }
  std::array<std::uint8_t, 128> tail{};
  const std::size_t remaining = input.size() - offset;
  if (remaining != 0) std::memcpy(tail.data(), input.data() + offset, remaining);
  tail[remaining] = 0x80U;
  const std::size_t padded = remaining < 56 ? 64 : 128;
  const std::uint64_t bit_length = static_cast<std::uint64_t>(input.size()) * 8U;
  for (std::size_t index = 0; index < 8; ++index) {
    tail[padded - 1 - index] = static_cast<std::uint8_t>(bit_length >> (index * 8U));
  }
  Sha256Compress(tail.data(), &hash);
  if (padded == 128) Sha256Compress(tail.data() + 64, &hash);
  std::array<std::uint8_t, 32> digest{};
  for (std::size_t index = 0; index < hash.size(); ++index) {
    digest[index * 4] = static_cast<std::uint8_t>(hash[index] >> 24U);
    digest[index * 4 + 1] = static_cast<std::uint8_t>(hash[index] >> 16U);
    digest[index * 4 + 2] = static_cast<std::uint8_t>(hash[index] >> 8U);
    digest[index * 4 + 3] = static_cast<std::uint8_t>(hash[index]);
  }
  return digest;
}

[[nodiscard]] std::uint8_t ExpectedArtifactCode() noexcept {
  if (kResourceOwnershipManifestArtifactId == "bootstrap") return 1;
  if (kResourceOwnershipManifestArtifactId == "addon") return 2;
  if (kResourceOwnershipManifestArtifactId == "qualification") return 3;
  return 0;
}

[[nodiscard]] std::shared_ptr<OwnerLivenessState> AllocateOwnerLiveness() noexcept {
  try {
    return std::make_shared<OwnerLivenessState>();
  } catch (...) {
    return {};
  }
}

#if defined(PCSDK_QUALIFICATION) && !defined(_WIN32)
std::atomic<QualificationNativeValue> g_fake_native_identity{0x1000U};
std::atomic<QualificationNativeValue> g_fake_reissue_identity{0};
std::atomic<std::uint32_t> g_fake_reissue_countdown{0};

[[nodiscard]] QualificationNativeValue AcquireFakeNativeIdentity() noexcept {
  const QualificationNativeValue reissue =
      g_fake_reissue_identity.load(std::memory_order_relaxed);
  if (reissue != 0) {
    const std::uint32_t countdown =
        g_fake_reissue_countdown.load(std::memory_order_relaxed);
    if (countdown == 0 ||
        g_fake_reissue_countdown.fetch_sub(1, std::memory_order_relaxed) == 1) {
      return g_fake_reissue_identity.exchange(0, std::memory_order_relaxed);
    }
  }
  return g_fake_native_identity.fetch_add(0x10U, std::memory_order_relaxed);
}
#endif

#if defined(PCSDK_QUALIFICATION)
class MutableReleaseFault final : public QualificationReleaseFaultPort {
 public:
  QualificationReleaseFault FaultFor(ResourceSiteId) noexcept override {
    return fault_.exchange(QualificationReleaseFault::none, std::memory_order_acq_rel);
  }

  bool InvokeNegativeRelease(ResourceSiteId) noexcept override {
    return false;
  }

  void Set(QualificationReleaseFault fault) noexcept {
    fault_.store(fault, std::memory_order_release);
  }

 private:
  std::atomic<QualificationReleaseFault> fault_{QualificationReleaseFault::none};
};
#endif

[[nodiscard]] std::size_t CountExactBytes(
    std::span<const std::uint8_t> frame, std::string_view value) noexcept {
  if (value.empty() || value.size() > frame.size()) return 0;
  std::size_t count = 0;
  for (std::size_t offset = 0; offset + value.size() <= frame.size(); ++offset) {
    if (std::memcmp(frame.data() + offset, value.data(), value.size()) == 0) ++count;
  }
  return count;
}

[[nodiscard]] bool IsCanonicalResourceSiteId(std::string_view value) noexcept {
  if (value.empty() || value.size() > 64 || value.front() < 'a' ||
      value.front() > 'z') {
    return false;
  }
  for (const char character : value.substr(1)) {
    if ((character < 'a' || character > 'z') &&
        (character < '0' || character > '9') && character != '_') {
      return false;
    }
  }
  return true;
}

}  // namespace

#if defined(PCSDK_QUALIFICATION)
bool QualificationOwnedEventPolicy::IsValid(
    const QualificationNativeValue& value) noexcept {
  return value != 0;
}

bool QualificationOwnedEventPolicy::Release(QualificationNativeValue& value) noexcept {
#if defined(PCSDK_QUALIFICATION)
  g_owned_event_release_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#if defined(_WIN32)
  return PCSDK_RESOURCE_RELEASE(
             ResourceSiteId::qualification_owned_event,
             ::CloseHandle(reinterpret_cast<HANDLE>(value))) != FALSE;
#else
  return PCSDK_RESOURCE_RELEASE(ResourceSiteId::qualification_owned_event, value != 0);
#endif
}

bool QualificationBorrowedEventPolicy::IsValid(
    const QualificationNativeValue& value) noexcept {
  return value != 0;
}

bool QualificationBorrowedEventPolicy::SameStableIdentity(
    const QualificationNativeValue& left, const QualificationNativeValue& right) noexcept {
  return left == right;
}

bool QualificationPseudoProcessPolicy::IsValid(
    const QualificationNativeValue& value) noexcept {
  return value != 0;
}

bool QualificationPseudoProcessPolicy::SameStableIdentity(
    const QualificationNativeValue& left, const QualificationNativeValue& right) noexcept {
  return left == right;
}

bool QualificationOwnedLocalAllocPolicy::IsValid(
    const QualificationNativeValue& value) noexcept {
  return value != 0;
}

bool QualificationOwnedLocalAllocPolicy::Release(QualificationNativeValue& value) noexcept {
#if defined(PCSDK_QUALIFICATION)
  g_local_alloc_release_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#if defined(_WIN32)
  return PCSDK_RESOURCE_RELEASE(
             ResourceSiteId::qualification_owned_local_alloc,
             ::LocalFree(reinterpret_cast<HLOCAL>(value))) == nullptr;
#else
  return PCSDK_RESOURCE_RELEASE(ResourceSiteId::qualification_owned_local_alloc, value != 0);
#endif
}

std::optional<QualificationOwnedEvent> AcquireQualificationOwnedEvent(
    ReleaseQuarantineSink* sink, QualificationReleaseFaultPort* fault_port) noexcept {
  std::shared_ptr<OwnerLivenessState> liveness = AllocateOwnerLiveness();
  if (liveness == nullptr) return std::nullopt;
#if defined(_WIN32)
  HANDLE raw = PCSDK_RESOURCE_ACQUIRE(
      ResourceSiteId::qualification_owned_event,
      ::CreateEventExW(nullptr, nullptr, CREATE_EVENT_MANUAL_RESET,
                       EVENT_MODIFY_STATE | SYNCHRONIZE));
  const QualificationNativeValue value = reinterpret_cast<QualificationNativeValue>(raw);
#else
  const QualificationNativeValue value = PCSDK_RESOURCE_ACQUIRE(
      ResourceSiteId::qualification_owned_event, AcquireFakeNativeIdentity());
#endif
  if (!QualificationOwnedEventPolicy::IsValid(value)) return std::nullopt;
  g_owned_event_acquisitions.fetch_add(1, std::memory_order_relaxed);
  return ResourceFactoryAccess::Own<
      QualificationNativeValue, ResourceSiteId::qualification_owned_event,
      QualificationOwnedEventPolicy>(value, std::move(liveness), sink, fault_port);
}

std::optional<QualificationBorrowedEvent> BorrowQualificationEvent(
    const QualificationOwnedEvent& owner) noexcept {
  QualificationNativeValue value = 0;
  bool positive_liveness = false;
  if (!owner.WithLiveValue([&value, &positive_liveness](
                               const QualificationNativeValue& live) noexcept {
#if defined(_WIN32)
        positive_liveness = ::WaitForSingleObject(
            reinterpret_cast<HANDLE>(live), 0) == WAIT_TIMEOUT;
#else
        positive_liveness = live != 0;
#endif
        if (!positive_liveness) return;
        value = PCSDK_RESOURCE_BORROW(
            ResourceSiteId::qualification_borrowed_event, live);
      }) || !positive_liveness) {
    return std::nullopt;
  }
  g_borrowed_event_observations.fetch_add(1, std::memory_order_relaxed);
  return ResourceFactoryAccess::Borrow<
      QualificationNativeValue, ResourceSiteId::qualification_borrowed_event,
      QualificationBorrowedEventPolicy>(value, owner.owner_liveness());
}

std::optional<QualificationPseudoProcess> AcquireQualificationPseudoProcess() noexcept {
#if defined(_WIN32)
  HANDLE raw = PCSDK_RESOURCE_NO_RELEASE(
      ResourceSiteId::qualification_pseudo_process, ::GetCurrentProcess());
  const QualificationNativeValue value = reinterpret_cast<QualificationNativeValue>(raw);
  if (raw == nullptr || ::GetProcessId(raw) != ::GetCurrentProcessId()) return std::nullopt;
#else
  const QualificationNativeValue value = PCSDK_RESOURCE_NO_RELEASE(
      ResourceSiteId::qualification_pseudo_process,
      static_cast<QualificationNativeValue>(~static_cast<QualificationNativeValue>(0)));
#endif
  g_pseudo_process_observations.fetch_add(1, std::memory_order_relaxed);
  return ResourceFactoryAccess::NoRelease<
      QualificationNativeValue, ResourceSiteId::qualification_pseudo_process,
      QualificationPseudoProcessPolicy>(value);
}

std::optional<QualificationOwnedLocalAlloc> AcquireQualificationOwnedLocalAlloc(
    std::size_t bytes, ReleaseQuarantineSink* sink,
    QualificationReleaseFaultPort* fault_port) noexcept {
  if (bytes == 0 || bytes > kMaximumResourceManifestFrameBytes) return std::nullopt;
  std::shared_ptr<OwnerLivenessState> liveness = AllocateOwnerLiveness();
  if (liveness == nullptr) return std::nullopt;
#if defined(_WIN32)
  HLOCAL raw = PCSDK_RESOURCE_ACQUIRE(
      ResourceSiteId::qualification_owned_local_alloc, ::LocalAlloc(LMEM_FIXED, bytes));
  const QualificationNativeValue value = reinterpret_cast<QualificationNativeValue>(raw);
#else
  const QualificationNativeValue value = PCSDK_RESOURCE_ACQUIRE(
      ResourceSiteId::qualification_owned_local_alloc, AcquireFakeNativeIdentity());
#endif
  if (!QualificationOwnedLocalAllocPolicy::IsValid(value)) return std::nullopt;
  g_local_alloc_acquisitions.fetch_add(1, std::memory_order_relaxed);
  return ResourceFactoryAccess::Own<
      QualificationNativeValue, ResourceSiteId::qualification_owned_local_alloc,
      QualificationOwnedLocalAllocPolicy>(value, std::move(liveness), sink, fault_port);
}

void ResetQualificationResourceCounters() noexcept {
  g_owned_event_acquisitions.store(0, std::memory_order_relaxed);
  g_owned_event_release_calls.store(0, std::memory_order_relaxed);
  g_borrowed_event_observations.store(0, std::memory_order_relaxed);
  g_pseudo_process_observations.store(0, std::memory_order_relaxed);
  g_local_alloc_acquisitions.store(0, std::memory_order_relaxed);
  g_local_alloc_release_calls.store(0, std::memory_order_relaxed);
}

QualificationResourceCounters ReadQualificationResourceCounters() noexcept {
  return QualificationResourceCounters{
      g_owned_event_acquisitions.load(std::memory_order_relaxed),
      g_owned_event_release_calls.load(std::memory_order_relaxed),
      g_borrowed_event_observations.load(std::memory_order_relaxed),
      g_pseudo_process_observations.load(std::memory_order_relaxed),
      g_local_alloc_acquisitions.load(std::memory_order_relaxed),
      g_local_alloc_release_calls.load(std::memory_order_relaxed),
  };
}

QualificationCanaryResult RunQualificationResourceCanaries() noexcept {
  constexpr QualificationCanaryResult failed{
      QualificationCanaryStatus::failed, "resource-canary-failed", "", 0};

  // Opaque liveness/release canary: the only raw HLOCAL use remains scoped here.
  constexpr std::uint32_t local_maximum_attempts =
      ResourceSiteTraits<ResourceSiteId::qualification_owned_local_alloc>::aba_max_attempts;
  constexpr std::uint32_t local_maximum_milliseconds =
      ResourceSiteTraits<ResourceSiteId::qualification_owned_local_alloc>::
          aba_max_monotonic_milliseconds;
  if constexpr (local_maximum_attempts != 1 || local_maximum_milliseconds == 0) {
    return QualificationCanaryResult{
        QualificationCanaryStatus::inconclusive,
        "site-unrun",
        ResourceSiteTraits<ResourceSiteId::qualification_owned_local_alloc>::site_id,
        0,
    };
  }
  const auto local_started = std::chrono::steady_clock::now();
  MutableReleaseFault local_fault;
  auto local = AcquireQualificationOwnedLocalAlloc(64, nullptr, &local_fault);
  if (!local.has_value()) return failed;
  bool local_probe = false;
  if (!local->WithLiveValue([&local_probe](const QualificationNativeValue& value) noexcept {
#if defined(_WIN32)
        auto* const bytes = reinterpret_cast<std::uint8_t*>(value);
        const SIZE_T size = ::LocalSize(reinterpret_cast<HLOCAL>(value));
        if (size < 64) return;
        for (std::size_t index = 0; index < 64; ++index) {
          bytes[index] = static_cast<std::uint8_t>(index ^ 0xa5U);
        }
        for (std::size_t index = 0; index < 64; ++index) {
          if (bytes[index] != static_cast<std::uint8_t>(index ^ 0xa5U)) return;
        }
        local_probe = true;
#else
        local_probe = value != 0;
#endif
      }) || !local_probe) {
    local_fault.Set(QualificationReleaseFault::before_call);
    static_cast<void>(local->Release());
    return failed;
  }
  const std::optional<ReleaseTransition> local_release = local->Release();
  if (!local_release.has_value() ||
      local_release->state != ResourceLifecycleState::positively_released) {
    return failed;
  }
  if (std::chrono::steady_clock::now() - local_started >=
      std::chrono::milliseconds(local_maximum_milliseconds)) {
    return QualificationCanaryResult{
        QualificationCanaryStatus::inconclusive,
        "aba-site-bound",
        ResourceSiteTraits<ResourceSiteId::qualification_owned_local_alloc>::site_id,
        1,
    };
  }

  // No-release pseudo canary: factory positively proves current-process query behavior.
  auto pseudo = AcquireQualificationPseudoProcess();
  if (!pseudo.has_value()) return failed;
  QualificationNativeValue pseudo_identity = 0;
  pseudo->WithStableIdentity(
      [&pseudo_identity](const QualificationNativeValue& value) noexcept {
        pseudo_identity = value;
      });
  if (!pseudo->MatchesStableIdentity(pseudo_identity)) return failed;

  MutableReleaseFault retired_fault;
  auto retired_owner = AcquireQualificationOwnedEvent(nullptr, &retired_fault);
  if (!retired_owner.has_value()) return failed;
  auto borrowed = BorrowQualificationEvent(*retired_owner);
  if (!borrowed.has_value()) {
    retired_fault.Set(QualificationReleaseFault::before_call);
    static_cast<void>(retired_owner->Release());
    return failed;
  }
  bool borrowed_proof = borrowed->WithOwnerLiveValue(
      [](const QualificationNativeValue& value) noexcept {
        static_cast<void>(value);
      });
  if (!borrowed_proof) {
    retired_fault.Set(QualificationReleaseFault::before_call);
    static_cast<void>(retired_owner->Release());
    return failed;
  }
  QualificationNativeValue retired_identity = 0;
  if (!retired_owner->WithLiveValue(
          [&retired_identity](const QualificationNativeValue& value) noexcept {
            retired_identity = value;
          }) || retired_identity == 0) {
    retired_fault.Set(QualificationReleaseFault::before_call);
    static_cast<void>(retired_owner->Release());
    return failed;
  }
  const std::optional<ReleaseTransition> retired_release = retired_owner->Release();
  if (!retired_release.has_value() ||
      retired_release->state != ResourceLifecycleState::positively_released ||
      borrowed->WithOwnerLiveValue([](const QualificationNativeValue&) noexcept {})) {
    return failed;
  }

#if !defined(_WIN32)
  g_fake_reissue_identity.store(retired_identity, std::memory_order_relaxed);
  g_fake_reissue_countdown.store(2, std::memory_order_relaxed);
#endif
  constexpr std::uint32_t maximum_attempts =
      ResourceSiteTraits<ResourceSiteId::qualification_owned_event>::aba_max_attempts;
  constexpr std::uint32_t maximum_milliseconds =
      ResourceSiteTraits<ResourceSiteId::qualification_owned_event>::
          aba_max_monotonic_milliseconds;
  const auto started = std::chrono::steady_clock::now();
  std::uint64_t attempts = 0;
  while (attempts < maximum_attempts &&
         std::chrono::steady_clock::now() - started <
             std::chrono::milliseconds(maximum_milliseconds)) {
    MutableReleaseFault candidate_fault;
    auto candidate = AcquireQualificationOwnedEvent(nullptr, &candidate_fault);
    if (!candidate.has_value()) return failed;
    ++attempts;
    QualificationNativeValue candidate_identity = 0;
    if (!candidate->WithLiveValue(
            [&candidate_identity](const QualificationNativeValue& value) noexcept {
              candidate_identity = value;
            }) || candidate_identity == 0) {
      candidate_fault.Set(QualificationReleaseFault::before_call);
      static_cast<void>(candidate->Release());
      return failed;
    }
    if (candidate_identity == retired_identity) {
      bool exact_match_probe = false;
      if (!candidate->WithLiveValue(
              [&exact_match_probe](const QualificationNativeValue& value) noexcept {
#if defined(_WIN32)
                DWORD flags = 0;
                exact_match_probe = ::GetHandleInformation(
                    reinterpret_cast<HANDLE>(value), &flags) != FALSE &&
                    (flags & HANDLE_FLAG_INHERIT) == 0 &&
                    ::WaitForSingleObject(reinterpret_cast<HANDLE>(value), 0) == WAIT_TIMEOUT;
#else
                exact_match_probe = value != 0;
#endif
              }) || !exact_match_probe) {
        candidate_fault.Set(QualificationReleaseFault::before_call);
        static_cast<void>(candidate->Release());
        return failed;
      }
      const std::optional<ReleaseTransition> exact_release = candidate->Release();
      if (!exact_release.has_value() ||
          exact_release->state != ResourceLifecycleState::positively_released) {
        return failed;
      }
      if (std::chrono::steady_clock::now() - started >=
          std::chrono::milliseconds(maximum_milliseconds)) {
        return QualificationCanaryResult{
            QualificationCanaryStatus::inconclusive,
            "aba-site-bound",
            ResourceSiteTraits<ResourceSiteId::qualification_owned_event>::site_id,
            attempts,
        };
      }
      return QualificationCanaryResult{
          QualificationCanaryStatus::passed,
          "all-sites-passed",
          ResourceSiteTraits<ResourceSiteId::qualification_owned_event>::site_id,
          attempts,
      };
    }
    const std::optional<ReleaseTransition> intermediate_release = candidate->Release();
    if (!intermediate_release.has_value() ||
        intermediate_release->state != ResourceLifecycleState::positively_released) {
      return failed;
    }
  }

  return QualificationCanaryResult{
      QualificationCanaryStatus::inconclusive,
      "aba-site-bound",
      ResourceSiteTraits<ResourceSiteId::qualification_owned_event>::site_id,
      attempts,
  };
}
#endif

ResourceManifestValidation ValidateResourceOwnershipManifestFrame(
    std::span<const std::uint8_t> frame,
    std::span<const std::string_view> expected_site_ids) noexcept {
  if (frame.empty()) return ResourceManifestValidation::empty;
  if (frame.size() > kMaximumResourceManifestFrameBytes) {
    return ResourceManifestValidation::too_large;
  }
  DecodedFrame decoded{};
  if (!DecodeFrame(frame, &decoded)) return ResourceManifestValidation::invalid_frame;
  const std::array<std::uint8_t, 32> computed_digest = Sha256(decoded.payload);
  if (!std::equal(computed_digest.begin(), computed_digest.end(), decoded.digest.begin())) {
    return ResourceManifestValidation::digest_mismatch;
  }
  if (!ValidateResourceManifestCompactJsonSyntax(decoded.payload)) {
    return ResourceManifestValidation::invalid_json;
  }
  if (expected_site_ids.size() > kMaximumResourceManifestSites) {
    return ResourceManifestValidation::binding_mismatch;
  }
  for (std::size_t left = 0; left < expected_site_ids.size(); ++left) {
    if (!IsCanonicalResourceSiteId(expected_site_ids[left])) {
      return ResourceManifestValidation::binding_mismatch;
    }
    for (std::size_t right = left + 1; right < expected_site_ids.size(); ++right) {
      if (expected_site_ids[left] == expected_site_ids[right]) {
        return ResourceManifestValidation::duplicate_site;
      }
    }
  }
  if (decoded.artifact_code != ExpectedArtifactCode() ||
      decoded.site_count != expected_site_ids.size()) {
    return ResourceManifestValidation::binding_mismatch;
  }

  std::array<char, 96> artifact_pattern{};
  constexpr std::string_view artifact_prefix = "\"artifactId\":\"";
  std::size_t artifact_length = 0;
  std::memcpy(artifact_pattern.data(), artifact_prefix.data(), artifact_prefix.size());
  artifact_length += artifact_prefix.size();
  std::memcpy(artifact_pattern.data() + artifact_length,
              kResourceOwnershipManifestArtifactId.data(),
              kResourceOwnershipManifestArtifactId.size());
  artifact_length += kResourceOwnershipManifestArtifactId.size();
  artifact_pattern[artifact_length++] = '"';
  if (decoded.payload.size() <= artifact_length + 1 || decoded.payload.front() != '{' ||
      std::memcmp(decoded.payload.data() + 1, artifact_pattern.data(), artifact_length) != 0 ||
      decoded.payload[artifact_length + 1] != ',') {
    return ResourceManifestValidation::binding_mismatch;
  }

  std::array<char, 48> site_count_pattern{};
  constexpr std::string_view site_count_prefix = "\"siteCount\":";
  std::memcpy(site_count_pattern.data(), site_count_prefix.data(), site_count_prefix.size());
  const auto [site_count_end, site_count_error] = std::to_chars(
      site_count_pattern.data() + site_count_prefix.size(), site_count_pattern.data() +
          site_count_pattern.size(), decoded.site_count);
  if (site_count_error != std::errc{} ||
      CountExactBytes(
          decoded.payload,
          std::string_view(site_count_pattern.data(),
                           static_cast<std::size_t>(site_count_end - site_count_pattern.data()))) != 1 ||
      CountExactBytes(decoded.payload, "\"siteId\":") != decoded.site_count) {
    return ResourceManifestValidation::binding_mismatch;
  }

  for (const std::string_view site_id : expected_site_ids) {
    std::array<char, 256> pattern{};
    constexpr std::string_view prefix = "\"siteId\":\"";
    if (prefix.size() + site_id.size() + 1 > pattern.size()) {
      return ResourceManifestValidation::missing_site;
    }
    std::size_t length = 0;
    std::memcpy(pattern.data() + length, prefix.data(), prefix.size());
    length += prefix.size();
    std::memcpy(pattern.data() + length, site_id.data(), site_id.size());
    length += site_id.size();
    pattern[length++] = '"';
    const std::size_t count = CountExactBytes(
        decoded.payload, std::string_view(pattern.data(), length));
    if (count == 0) return ResourceManifestValidation::missing_site;
    if (count != 1) return ResourceManifestValidation::duplicate_site;
  }
  DecodedFrame generated{};
  if (!DecodeFrame(kEmbeddedResourceOwnershipManifest, &generated)) {
    return ResourceManifestValidation::invalid_frame;
  }
  if (decoded.payload.size() != generated.payload.size() ||
      !std::equal(decoded.payload.begin(), decoded.payload.end(),
                  generated.payload.begin())) {
    return ResourceManifestValidation::binding_mismatch;
  }
  return ResourceManifestValidation::valid;
}

bool ResourceManifestContainsExactString(
    std::span<const std::uint8_t> frame, std::string_view value) noexcept {
  DecodedFrame decoded{};
  if (!IsCanonicalResourceSiteId(value) || !DecodeFrame(frame, &decoded)) return false;
  const std::array<std::uint8_t, 32> digest = Sha256(decoded.payload);
  if (!std::equal(digest.begin(), digest.end(), decoded.digest.begin()) ||
      !ValidateResourceManifestCompactJsonSyntax(decoded.payload) ||
      value.size() + 2 > decoded.payload.size()) {
    return false;
  }
  std::array<char, 512> quoted{};
  if (value.size() + 2 > quoted.size()) return false;
  quoted[0] = '"';
  std::memcpy(quoted.data() + 1, value.data(), value.size());
  quoted[value.size() + 1] = '"';
  return CountExactBytes(
      decoded.payload, std::string_view(quoted.data(), value.size() + 2)) != 0;
}

std::span<const std::uint8_t> EmbeddedResourceOwnershipManifest() noexcept {
  return kEmbeddedResourceOwnershipManifest;
}

std::span<const std::uint8_t> EmbeddedResourceOwnershipManifestSha256() noexcept {
  return kEmbeddedResourceOwnershipManifestSha256;
}

ResourceManifestValidation ValidateEmbeddedResourceOwnershipManifest() noexcept {
  const std::span<const std::uint8_t> frame = EmbeddedResourceOwnershipManifest();
  const ResourceManifestValidation validation =
      ValidateResourceOwnershipManifestFrame(frame, kResourceSiteIdStrings);
  if (validation != ResourceManifestValidation::valid) return validation;
  DecodedFrame decoded{};
  if (!DecodeFrame(frame, &decoded) ||
      !std::equal(decoded.digest.begin(), decoded.digest.end(),
                  EmbeddedResourceOwnershipManifestSha256().begin())) {
    return ResourceManifestValidation::digest_mismatch;
  }
  return ResourceManifestValidation::valid;
}

#if defined(PCSDK_QUALIFICATION)
bool QualificationRecomputeResourceManifestFrameDigest(
    std::span<std::uint8_t> frame) noexcept {
  DecodedFrame decoded{};
  const std::span<const std::uint8_t> read_only(frame.data(), frame.size());
  if (!DecodeFrame(read_only, &decoded)) return false;
  const std::array<std::uint8_t, 32> digest = Sha256(decoded.payload);
  std::copy(digest.begin(), digest.end(), frame.begin() + 32);
  return true;
}
#endif

}  // namespace pc_sdk_next::containment
