#pragma once

#include <atomic>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <type_traits>
#include <utility>

#include "pc_sdk_next/generated/resource_manifest.generated.h"
#include "pc_sdk_next/resource_manifest.h"
#include "pc_sdk_next/resource_state.h"

namespace pc_sdk_next::containment {

template <ResourceSiteId Site, typename Value>
[[nodiscard]] constexpr decltype(auto) MarkResourceAcquired(Value&& value) noexcept {
  static_assert(ResourceSiteTraits<Site>::ownership == ResourceOwnershipClass::owned);
  return std::forward<Value>(value);
}

template <ResourceSiteId Site, typename Value>
[[nodiscard]] constexpr decltype(auto) MarkResourceBorrowed(Value&& value) noexcept {
  static_assert(ResourceSiteTraits<Site>::ownership == ResourceOwnershipClass::borrowed);
  return std::forward<Value>(value);
}

template <ResourceSiteId Site, typename Value>
[[nodiscard]] constexpr decltype(auto) MarkResourceNoRelease(Value&& value) noexcept {
  static_assert(ResourceSiteTraits<Site>::ownership == ResourceOwnershipClass::no_release);
  return std::forward<Value>(value);
}

template <ResourceSiteId Site, typename Result>
[[nodiscard]] constexpr decltype(auto) MarkResourceReleased(Result&& result) noexcept {
  static_assert(ResourceSiteTraits<Site>::ownership == ResourceOwnershipClass::owned);
  return std::forward<Result>(result);
}

#define PCSDK_RESOURCE_ACQUIRE(site, expression) \
  (::pc_sdk_next::containment::MarkResourceAcquired<site>((expression)))
#define PCSDK_RESOURCE_BORROW(site, expression) \
  (::pc_sdk_next::containment::MarkResourceBorrowed<site>((expression)))
#define PCSDK_RESOURCE_NO_RELEASE(site, expression) \
  (::pc_sdk_next::containment::MarkResourceNoRelease<site>((expression)))
#define PCSDK_RESOURCE_RELEASE(site, expression) \
  (::pc_sdk_next::containment::MarkResourceReleased<site>((expression)))

#if defined(PCSDK_QUALIFICATION)
enum class QualificationReleaseFault : std::uint8_t {
  none = 0,
  before_call = 1,
  release_returns_negative = 2,
  succeeded_report_uncertain = 3,
};

class QualificationReleaseFaultPort {
 public:
  virtual ~QualificationReleaseFaultPort() = default;
  [[nodiscard]] virtual QualificationReleaseFault FaultFor(ResourceSiteId site) noexcept = 0;
  [[nodiscard]] virtual bool InvokeNegativeRelease(ResourceSiteId site) noexcept = 0;
};
#endif

class ReleaseQuarantineSink {
 public:
  virtual ~ReleaseQuarantineSink() = default;
  virtual void OnReleaseQuarantined(
      ResourceSiteId site, const ReleaseTransition& transition) noexcept = 0;
};

class OwnerLivenessState final {
 public:
  OwnerLivenessState() noexcept = default;
  OwnerLivenessState(const OwnerLivenessState&) = delete;
  OwnerLivenessState& operator=(const OwnerLivenessState&) = delete;

  [[nodiscard]] bool TryBeginUse() noexcept {
    std::uint64_t observed = packed_state_.load(std::memory_order_acquire);
    for (;;) {
      if ((observed & kRetiredBit) != 0 ||
          (observed & kActiveCountMask) == kActiveCountMask) {
        return false;
      }
      if (packed_state_.compare_exchange_weak(
              observed, observed + 1, std::memory_order_acq_rel,
              std::memory_order_acquire)) {
        return true;
      }
    }
  }

  void EndUse() noexcept {
    const std::uint64_t previous = packed_state_.fetch_sub(1, std::memory_order_acq_rel);
    if ((previous & kActiveCountMask) == 0) std::terminate();
  }

  // Stops all future borrows. False means an already-scoped use was still active, so
  // the caller must quarantine without invoking the release API.
  [[nodiscard]] bool RetireForRelease() noexcept {
    const std::uint64_t previous =
        packed_state_.fetch_or(kRetiredBit, std::memory_order_acq_rel);
    return (previous & kActiveCountMask) == 0;
  }

  [[nodiscard]] bool is_live() const noexcept {
    return (packed_state_.load(std::memory_order_acquire) & kRetiredBit) == 0;
  }

 private:
  static constexpr std::uint64_t kRetiredBit = std::uint64_t{1} << 63U;
  static constexpr std::uint64_t kActiveCountMask =
      std::numeric_limits<std::uint32_t>::max();
  std::atomic<std::uint64_t> packed_state_{0};
};

class OwnerUseLease final {
 public:
  OwnerUseLease() noexcept = default;
  OwnerUseLease(const OwnerUseLease&) = delete;
  OwnerUseLease& operator=(const OwnerUseLease&) = delete;
  OwnerUseLease(OwnerUseLease&& other) noexcept
      : state_(std::move(other.state_)), acquired_(std::exchange(other.acquired_, false)) {}
  OwnerUseLease& operator=(OwnerUseLease&&) = delete;
  ~OwnerUseLease() noexcept {
    if (acquired_) state_->EndUse();
  }

  [[nodiscard]] bool acquired() const noexcept { return acquired_; }

 private:
  friend class OwnerLivenessToken;
  explicit OwnerUseLease(std::shared_ptr<OwnerLivenessState> state) noexcept
      : state_(std::move(state)), acquired_(true) {}

  std::shared_ptr<OwnerLivenessState> state_;
  bool acquired_ = false;
};

class OwnerLivenessToken final {
 public:
  OwnerLivenessToken() noexcept = default;

  [[nodiscard]] std::optional<OwnerUseLease> TryAcquire() const noexcept {
    const std::shared_ptr<OwnerLivenessState> state = state_.lock();
    if (state == nullptr || !state->TryBeginUse()) return std::nullopt;
    return OwnerUseLease{state};
  }

  [[nodiscard]] bool is_live() const noexcept {
    const std::shared_ptr<OwnerLivenessState> state = state_.lock();
    return state != nullptr && state->is_live();
  }

 private:
  template <typename, ResourceSiteId, typename>
  friend class OwnedResource;
  friend struct ResourceFactoryAccess;
  explicit OwnerLivenessToken(const std::shared_ptr<OwnerLivenessState>& state) noexcept
      : state_(state) {}

  std::weak_ptr<OwnerLivenessState> state_;
};

template <typename Policy, typename Native>
concept OwnedResourcePolicy = requires(Native& value, const Native& const_value) {
  { Policy::domain } -> std::convertible_to<ResourceDomain>;
  { Policy::IsValid(const_value) } noexcept -> std::same_as<bool>;
  { Policy::Release(value) } noexcept -> std::same_as<bool>;
};

template <typename Policy, typename Native>
concept ObservedResourcePolicy = requires(const Native& left, const Native& right) {
  { Policy::domain } -> std::convertible_to<ResourceDomain>;
  { Policy::IsValid(left) } noexcept -> std::same_as<bool>;
  { Policy::SameStableIdentity(left, right) } noexcept -> std::same_as<bool>;
};

struct ResourceFactoryAccess;

template <typename Native, ResourceSiteId Site, typename Policy>
class OwnedResource final {
 public:
  static_assert(OwnedResourcePolicy<Policy, Native>);
  static_assert(ResourceSiteTraits<Site>::ownership == ResourceOwnershipClass::owned);
  static_assert(ResourceSiteTraits<Site>::domain == Policy::domain);

  OwnedResource(const OwnedResource&) = delete;
  OwnedResource& operator=(const OwnedResource&) = delete;
  OwnedResource& operator=(OwnedResource&&) = delete;

  OwnedResource(OwnedResource&& other) noexcept(std::is_nothrow_move_constructible_v<Native>)
      : value_(std::move(other.value_)),
        lifecycle_(std::move(other.lifecycle_)),
        liveness_(std::move(other.liveness_)),
        sink_(other.sink_),
#if defined(PCSDK_QUALIFICATION)
        fault_port_(other.fault_port_),
#endif
        release_claimed_(other.release_claimed_.load(std::memory_order_acquire)),
        engaged_(std::exchange(other.engaged_, false)) {
    other.sink_ = nullptr;
#if defined(PCSDK_QUALIFICATION)
    other.fault_port_ = nullptr;
#endif
  }

  ~OwnedResource() noexcept {
    if (engaged_ && !release_claimed_.load(std::memory_order_acquire)) std::terminate();
  }

  [[nodiscard]] bool engaged() const noexcept { return engaged_; }
  [[nodiscard]] ResourceLifecycleState state() const noexcept { return lifecycle_.state(); }
  [[nodiscard]] bool poison_process_creation() const noexcept {
    return lifecycle_.poison_process_creation();
  }
  [[nodiscard]] bool nonrestart_shutdown_required() const noexcept {
    return lifecycle_.nonrestart_shutdown_required();
  }

  template <typename Callback>
    requires std::is_invocable_v<Callback, const Native&>
  [[nodiscard]] bool WithLiveValue(Callback&& callback) const
      noexcept(std::is_nothrow_invocable_v<Callback, const Native&>) {
    if (!engaged_) return false;
    std::optional<OwnerUseLease> lease = OwnerLivenessToken{liveness_}.TryAcquire();
    if (!lease.has_value()) return false;
    std::invoke(std::forward<Callback>(callback), std::as_const(value_));
    return true;
  }

  [[nodiscard]] OwnerLivenessToken owner_liveness() const noexcept {
    return engaged_ ? OwnerLivenessToken{liveness_} : OwnerLivenessToken{};
  }

  [[nodiscard]] std::optional<ReleaseTransition> Release() noexcept {
    if (!engaged_) return std::nullopt;
    bool expected = false;
    if (!release_claimed_.compare_exchange_strong(
            expected, true, std::memory_order_acq_rel, std::memory_order_acquire)) {
      return std::nullopt;
    }

    ReleaseObservation observation = ReleaseObservation::before_call;
    const bool no_active_use = liveness_->RetireForRelease();
#if defined(PCSDK_QUALIFICATION)
    QualificationReleaseFault fault = QualificationReleaseFault::none;
    if (fault_port_ != nullptr) fault = fault_port_->FaultFor(Site);
    const bool admitted_before_fault = fault == QualificationReleaseFault::before_call &&
        ResourceSiteTraits<Site>::fault_inject_before_call;
    const bool admitted_negative_fault =
        fault == QualificationReleaseFault::release_returns_negative &&
        ResourceSiteTraits<Site>::fault_inject_nonpositive_result;
    const bool admitted_uncertain_fault =
        fault == QualificationReleaseFault::succeeded_report_uncertain &&
        ResourceSiteTraits<Site>::fault_inject_report_uncertain_after_success;
    const bool fault_before_call = admitted_before_fault ||
        (fault != QualificationReleaseFault::none && !admitted_negative_fault &&
         !admitted_uncertain_fault);
#else
    const bool fault_before_call = false;
#endif
    if (no_active_use && !fault_before_call) {
      bool release_result = false;
#if defined(PCSDK_QUALIFICATION)
      if (admitted_negative_fault) {
        release_result = fault_port_->InvokeNegativeRelease(Site);
      } else
#endif
      {
        release_result = Policy::Release(value_);
      }
      if (!release_result) {
        observation = ReleaseObservation::negative;
#if defined(PCSDK_QUALIFICATION)
      } else if (admitted_uncertain_fault) {
        observation = ReleaseObservation::succeeded_report_uncertain;
      } else if (admitted_negative_fault) {
        observation = ReleaseObservation::succeeded_report_uncertain;
#endif
      } else {
        observation = ReleaseObservation::positive;
      }
    }

    const ReleaseTransition transition = lifecycle_.ObserveRelease(
        observation,
        QuarantineSignals{
            ResourceSiteTraits<Site>::quarantine_poison_process_creation,
            ResourceSiteTraits<Site>::quarantine_nonrestart_shutdown_required,
        });
    if (transition.state == ResourceLifecycleState::release_outcome_quarantined &&
        sink_ != nullptr) {
      sink_->OnReleaseQuarantined(Site, transition);
    }
    return transition;
  }

 private:
  friend struct ResourceFactoryAccess;
  OwnedResource(Native value, std::shared_ptr<OwnerLivenessState> liveness,
                ReleaseQuarantineSink* sink
#if defined(PCSDK_QUALIFICATION)
                , QualificationReleaseFaultPort* fault_port
#endif
                ) noexcept(std::is_nothrow_move_constructible_v<Native>)
      : value_(std::move(value)),
        liveness_(std::move(liveness)),
        sink_(sink)
#if defined(PCSDK_QUALIFICATION)
        , fault_port_(fault_port)
#endif
        {}

  Native value_;
  ResourceStateMachine lifecycle_;
  std::shared_ptr<OwnerLivenessState> liveness_;
  ReleaseQuarantineSink* sink_ = nullptr;
#if defined(PCSDK_QUALIFICATION)
  QualificationReleaseFaultPort* fault_port_ = nullptr;
#endif
  std::atomic<bool> release_claimed_{false};
  bool engaged_ = true;
};

template <typename Native, ResourceSiteId Site, typename Policy>
  requires ObservedResourcePolicy<Policy, Native>
class BorrowedResource final {
 public:
  static_assert(ResourceSiteTraits<Site>::ownership == ResourceOwnershipClass::borrowed);
  static_assert(ResourceSiteTraits<Site>::domain == Policy::domain);

  BorrowedResource(const BorrowedResource&) = delete;
  BorrowedResource& operator=(const BorrowedResource&) = delete;
  BorrowedResource& operator=(BorrowedResource&&) = delete;
  BorrowedResource(BorrowedResource&& other) noexcept(
      std::is_nothrow_move_constructible_v<Native>)
      : value_(std::move(other.value_)),
        owner_(std::move(other.owner_)),
        engaged_(std::exchange(other.engaged_, false)) {}
  ~BorrowedResource() = default;

  template <typename Callback>
    requires std::is_invocable_v<Callback, const Native&>
  [[nodiscard]] bool WithOwnerLiveValue(Callback&& callback) const
      noexcept(std::is_nothrow_invocable_v<Callback, const Native&>) {
    if (!engaged_) return false;
    std::optional<OwnerUseLease> lease = owner_.TryAcquire();
    if (!lease.has_value()) return false;
    std::invoke(std::forward<Callback>(callback), std::as_const(value_));
    return true;
  }

 private:
  friend struct ResourceFactoryAccess;
  BorrowedResource(Native value, OwnerLivenessToken owner) noexcept(
      std::is_nothrow_move_constructible_v<Native>)
      : value_(std::move(value)), owner_(std::move(owner)) {}

  Native value_;
  OwnerLivenessToken owner_;
  bool engaged_ = true;
};

template <typename Native, ResourceSiteId Site, typename Policy>
  requires ObservedResourcePolicy<Policy, Native>
class NoReleaseResource final {
 public:
  static_assert(ResourceSiteTraits<Site>::ownership == ResourceOwnershipClass::no_release);
  static_assert(ResourceSiteTraits<Site>::domain == Policy::domain);

  NoReleaseResource(const NoReleaseResource&) = delete;
  NoReleaseResource& operator=(const NoReleaseResource&) = delete;
  NoReleaseResource& operator=(NoReleaseResource&&) = delete;
  NoReleaseResource(NoReleaseResource&& other) noexcept(
      std::is_nothrow_move_constructible_v<Native>)
      : value_(std::move(other.value_)), engaged_(std::exchange(other.engaged_, false)) {}
  ~NoReleaseResource() = default;

  template <typename Callback>
    requires std::is_invocable_v<Callback, const Native&>
  void WithStableIdentity(Callback&& callback) const
      noexcept(std::is_nothrow_invocable_v<Callback, const Native&>) {
    if (engaged_) std::invoke(std::forward<Callback>(callback), std::as_const(value_));
  }

  [[nodiscard]] bool MatchesStableIdentity(const Native& candidate) const noexcept {
    return engaged_ && Policy::IsValid(candidate) &&
        Policy::SameStableIdentity(value_, candidate);
  }

 private:
  friend struct ResourceFactoryAccess;
  explicit NoReleaseResource(Native value) noexcept(
      std::is_nothrow_move_constructible_v<Native>)
      : value_(std::move(value)) {}

  Native value_;
  bool engaged_ = true;
};

#if defined(PCSDK_QUALIFICATION)
using QualificationNativeValue = std::uintptr_t;

struct QualificationOwnedEventPolicy final {
  static constexpr ResourceDomain domain = ResourceDomain::recyclable_numeric;
  [[nodiscard]] static bool IsValid(const QualificationNativeValue& value) noexcept;
  [[nodiscard]] static bool Release(QualificationNativeValue& value) noexcept;
};

struct QualificationBorrowedEventPolicy final {
  static constexpr ResourceDomain domain = ResourceDomain::recyclable_numeric;
  [[nodiscard]] static bool IsValid(const QualificationNativeValue& value) noexcept;
  [[nodiscard]] static bool SameStableIdentity(
      const QualificationNativeValue& left, const QualificationNativeValue& right) noexcept;
};

struct QualificationPseudoProcessPolicy final {
  static constexpr ResourceDomain domain = ResourceDomain::pseudo;
  [[nodiscard]] static bool IsValid(const QualificationNativeValue& value) noexcept;
  [[nodiscard]] static bool SameStableIdentity(
      const QualificationNativeValue& left, const QualificationNativeValue& right) noexcept;
};

struct QualificationOwnedLocalAllocPolicy final {
  static constexpr ResourceDomain domain = ResourceDomain::opaque;
  [[nodiscard]] static bool IsValid(const QualificationNativeValue& value) noexcept;
  [[nodiscard]] static bool Release(QualificationNativeValue& value) noexcept;
};

using QualificationOwnedEvent = OwnedResource<
    QualificationNativeValue, ResourceSiteId::qualification_owned_event,
    QualificationOwnedEventPolicy>;
using QualificationBorrowedEvent = BorrowedResource<
    QualificationNativeValue, ResourceSiteId::qualification_borrowed_event,
    QualificationBorrowedEventPolicy>;
using QualificationPseudoProcess = NoReleaseResource<
    QualificationNativeValue, ResourceSiteId::qualification_pseudo_process,
    QualificationPseudoProcessPolicy>;
using QualificationOwnedLocalAlloc = OwnedResource<
    QualificationNativeValue, ResourceSiteId::qualification_owned_local_alloc,
    QualificationOwnedLocalAllocPolicy>;

struct QualificationResourceCounters final {
  std::uint64_t owned_event_acquisitions;
  std::uint64_t owned_event_release_calls;
  std::uint64_t borrowed_event_observations;
  std::uint64_t pseudo_process_observations;
  std::uint64_t local_alloc_acquisitions;
  std::uint64_t local_alloc_release_calls;
};

enum class QualificationCanaryStatus : std::uint8_t {
  passed = 0,
  inconclusive = 1,
  failed = 2,
};

struct QualificationCanaryResult final {
  QualificationCanaryStatus status;
  std::string_view reason;
  std::string_view site_id;
  std::uint64_t attempts;
};

void ResetQualificationResourceCounters() noexcept;
[[nodiscard]] QualificationResourceCounters ReadQualificationResourceCounters() noexcept;
[[nodiscard]] QualificationCanaryResult RunQualificationResourceCanaries() noexcept;

[[nodiscard]] std::optional<QualificationOwnedEvent> AcquireQualificationOwnedEvent(
    ReleaseQuarantineSink* sink = nullptr,
    QualificationReleaseFaultPort* fault_port = nullptr) noexcept;
[[nodiscard]] std::optional<QualificationBorrowedEvent> BorrowQualificationEvent(
    const QualificationOwnedEvent& owner) noexcept;
[[nodiscard]] std::optional<QualificationPseudoProcess>
AcquireQualificationPseudoProcess() noexcept;
[[nodiscard]] std::optional<QualificationOwnedLocalAlloc>
AcquireQualificationOwnedLocalAlloc(
    std::size_t bytes, ReleaseQuarantineSink* sink = nullptr,
    QualificationReleaseFaultPort* fault_port = nullptr) noexcept;
#endif

}  // namespace pc_sdk_next::containment
