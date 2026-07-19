#pragma once

#include <atomic>
#include <cstdint>
#include <string_view>

namespace pc_sdk_next::containment {

enum class ResourceLifecycleState : std::uint8_t {
  known_live = 0,
  positively_released = 1,
  release_outcome_quarantined = 2,
};

enum class ReleaseObservation : std::uint8_t {
  positive = 0,
  negative = 1,
  before_call = 2,
  succeeded_report_uncertain = 3,
};

struct QuarantineSignals final {
  bool poison_process_creation;
  bool nonrestart_shutdown_required;
};

struct ReleaseTransition final {
  ResourceLifecycleState previous_state;
  ResourceLifecycleState state;
  ReleaseObservation observation;
  bool accepted;
  bool release_call_invoked;
  bool poison_process_creation;
  bool nonrestart_shutdown_required;
};

[[nodiscard]] constexpr bool IsKnownResourceLifecycleState(
    ResourceLifecycleState state) noexcept {
  switch (state) {
    case ResourceLifecycleState::known_live:
    case ResourceLifecycleState::positively_released:
    case ResourceLifecycleState::release_outcome_quarantined:
      return true;
  }
  return false;
}

[[nodiscard]] constexpr bool IsKnownReleaseObservation(
    ReleaseObservation observation) noexcept {
  switch (observation) {
    case ReleaseObservation::positive:
    case ReleaseObservation::negative:
    case ReleaseObservation::before_call:
    case ReleaseObservation::succeeded_report_uncertain:
      return true;
  }
  return false;
}

[[nodiscard]] std::string_view ResourceLifecycleStateName(
    ResourceLifecycleState state) noexcept;
[[nodiscard]] std::string_view ReleaseObservationName(
    ReleaseObservation observation) noexcept;
[[nodiscard]] bool ParseResourceLifecycleState(
    std::string_view value, ResourceLifecycleState* state) noexcept;
[[nodiscard]] bool ParseReleaseObservation(
    std::string_view value, ReleaseObservation* observation) noexcept;

class ResourceStateMachine final {
 private:
  static constexpr std::uint8_t kStateMask = 0x03U;
  static constexpr std::uint8_t kPoisonBit = 0x04U;
  static constexpr std::uint8_t kNonrestartBit = 0x08U;
  static constexpr std::uint8_t kMovedFromPackedState =
      static_cast<std::uint8_t>(ResourceLifecycleState::release_outcome_quarantined) |
      kPoisonBit | kNonrestartBit;

 public:
  ResourceStateMachine() noexcept = default;

  ResourceStateMachine(const ResourceStateMachine&) = delete;
  ResourceStateMachine& operator=(const ResourceStateMachine&) = delete;
  ResourceStateMachine(ResourceStateMachine&& other) noexcept
      : packed_state_(other.packed_state_.exchange(
            kMovedFromPackedState, std::memory_order_acq_rel)) {}
  ResourceStateMachine& operator=(ResourceStateMachine&&) = delete;

  [[nodiscard]] ResourceLifecycleState state() const noexcept;

  [[nodiscard]] bool release_may_be_observed() const noexcept;

  [[nodiscard]] bool poison_process_creation() const noexcept;

  [[nodiscard]] bool nonrestart_shutdown_required() const noexcept;

  // Exactly one terminal observation is accepted. Every non-positive observation is
  // terminal quarantine: callers must never query, reuse, or reclose that native value.
  [[nodiscard]] ReleaseTransition ObserveRelease(
      ReleaseObservation observation, QuarantineSignals signals) noexcept;

 private:
  std::atomic<std::uint8_t> packed_state_{
      static_cast<std::uint8_t>(ResourceLifecycleState::known_live)};
};

}  // namespace pc_sdk_next::containment
