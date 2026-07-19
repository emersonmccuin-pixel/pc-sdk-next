#include "pc_sdk_next/resource.h"

#include <array>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

namespace pc_sdk_next::containment {
namespace {

class Checks final {
 public:
  void Require(bool condition) noexcept {
    ++assertions_;
    passed_ = passed_ && condition;
  }

  [[nodiscard]] bool passed() const noexcept { return passed_; }
  [[nodiscard]] std::uint64_t assertions() const noexcept { return assertions_; }

 private:
  std::uint64_t assertions_ = 0;
  bool passed_ = true;
};

class RecordingSink final : public ReleaseQuarantineSink {
 public:
  void OnReleaseQuarantined(
      ResourceSiteId site, const ReleaseTransition& transition) noexcept override {
    ++calls;
    last_site = site;
    last_transition = transition;
  }

  std::uint64_t calls = 0;
  ResourceSiteId last_site = ResourceSiteId::qualification_owned_event;
  ReleaseTransition last_transition{
      ResourceLifecycleState::known_live,
      ResourceLifecycleState::known_live,
      ReleaseObservation::before_call,
      false,
      false,
      false,
      false,
  };
};

#if defined(PCSDK_QUALIFICATION)
class OneShotFault final : public QualificationReleaseFaultPort {
 public:
  explicit OneShotFault(QualificationReleaseFault fault) noexcept : fault_(fault) {}

  QualificationReleaseFault FaultFor(ResourceSiteId) noexcept override {
    const QualificationReleaseFault result = fault_;
    fault_ = QualificationReleaseFault::none;
    return result;
  }

  bool InvokeNegativeRelease(ResourceSiteId) noexcept override {
    ++negative_release_calls_;
    return false;
  }

  [[nodiscard]] std::uint64_t negative_release_calls() const noexcept {
    return negative_release_calls_;
  }

 private:
  QualificationReleaseFault fault_;
  std::uint64_t negative_release_calls_ = 0;
};
#endif

[[nodiscard]] std::uint64_t NextRandom(std::uint64_t* state) noexcept {
  std::uint64_t value = *state;
  value ^= value << 13U;
  value ^= value >> 7U;
  value ^= value << 17U;
  *state = value;
  return value;
}

void CheckStateVocabulary(Checks* checks) noexcept {
  constexpr std::array states{
      ResourceLifecycleState::known_live,
      ResourceLifecycleState::positively_released,
      ResourceLifecycleState::release_outcome_quarantined,
  };
  for (const ResourceLifecycleState state : states) {
    ResourceLifecycleState parsed = ResourceLifecycleState::known_live;
    const std::string_view name = ResourceLifecycleStateName(state);
    checks->Require(!name.empty());
    checks->Require(ParseResourceLifecycleState(name, &parsed));
    checks->Require(parsed == state);
  }
  ResourceLifecycleState state = ResourceLifecycleState::known_live;
  checks->Require(!ParseResourceLifecycleState("known_live", &state));
  checks->Require(!ParseResourceLifecycleState(" known-live", &state));
  checks->Require(!ParseResourceLifecycleState("known-live", nullptr));

  constexpr std::array observations{
      ReleaseObservation::positive,
      ReleaseObservation::negative,
      ReleaseObservation::before_call,
      ReleaseObservation::succeeded_report_uncertain,
  };
  for (const ReleaseObservation observation : observations) {
    ReleaseObservation parsed = ReleaseObservation::positive;
    const std::string_view name = ReleaseObservationName(observation);
    checks->Require(!name.empty());
    checks->Require(ParseReleaseObservation(name, &parsed));
    checks->Require(parsed == observation);
  }
  ReleaseObservation observation = ReleaseObservation::positive;
  checks->Require(!ParseReleaseObservation("succeeded", &observation));
  checks->Require(!ParseReleaseObservation("positive", nullptr));
  checks->Require(ResourceLifecycleStateName(
      static_cast<ResourceLifecycleState>(0xffU)).empty());
  checks->Require(ReleaseObservationName(static_cast<ReleaseObservation>(0xffU)).empty());
}

void CheckStateTransitions(Checks* checks) noexcept {
  static_assert(std::is_move_constructible_v<ResourceStateMachine>);
  static_assert(!std::is_move_assignable_v<ResourceStateMachine>);
  constexpr std::array observations{
      ReleaseObservation::positive,
      ReleaseObservation::negative,
      ReleaseObservation::before_call,
      ReleaseObservation::succeeded_report_uncertain,
  };
  for (const ReleaseObservation observation : observations) {
    ResourceStateMachine machine;
    const ReleaseTransition first = machine.ObserveRelease(observation, {true, false});
    checks->Require(first.accepted);
    checks->Require(first.previous_state == ResourceLifecycleState::known_live);
    checks->Require(first.release_call_invoked ==
                    (observation != ReleaseObservation::before_call));
    const bool positive = observation == ReleaseObservation::positive;
    checks->Require(first.state == (positive
        ? ResourceLifecycleState::positively_released
        : ResourceLifecycleState::release_outcome_quarantined));
    checks->Require(first.poison_process_creation == !positive);
    checks->Require(!first.nonrestart_shutdown_required);

    const ReleaseTransition replay = machine.ObserveRelease(
        ReleaseObservation::positive, {false, true});
    checks->Require(!replay.accepted);
    checks->Require(!replay.release_call_invoked);
    checks->Require(replay.state == first.state);
    checks->Require(replay.poison_process_creation == !positive);
    checks->Require(!replay.nonrestart_shutdown_required);
  }

  ResourceStateMachine invalid;
  const ReleaseTransition rejected = invalid.ObserveRelease(
      static_cast<ReleaseObservation>(0xffU), {true, true});
  checks->Require(rejected.accepted);
  checks->Require(!rejected.release_call_invoked);
  checks->Require(rejected.state ==
                  ResourceLifecycleState::release_outcome_quarantined);
  checks->Require(rejected.poison_process_creation);
  checks->Require(rejected.nonrestart_shutdown_required);
  const ReleaseTransition after_unknown = invalid.ObserveRelease(
      ReleaseObservation::positive, {false, false});
  checks->Require(!after_unknown.accepted);
  checks->Require(after_unknown.poison_process_creation);
  checks->Require(after_unknown.nonrestart_shutdown_required);

  ResourceStateMachine move_source;
  ResourceStateMachine move_destination{std::move(move_source)};
  checks->Require(!move_source.release_may_be_observed());
  checks->Require(move_source.state() ==
                  ResourceLifecycleState::release_outcome_quarantined);
  checks->Require(move_source.poison_process_creation());
  checks->Require(move_source.nonrestart_shutdown_required());
  checks->Require(move_destination.release_may_be_observed());
  const ReleaseTransition moved_source_replay = move_source.ObserveRelease(
      ReleaseObservation::positive, {false, false});
  checks->Require(!moved_source_replay.accepted);
  const ReleaseTransition moved_destination_release = move_destination.ObserveRelease(
      ReleaseObservation::positive, {false, false});
  checks->Require(moved_destination_release.accepted);
  checks->Require(moved_destination_release.state ==
                  ResourceLifecycleState::positively_released);
}

void CheckDeterministicStateProperties(Checks* checks) noexcept {
  constexpr std::array<std::uint64_t, 10> seeds{
      0x36b7e6a8c0249f11ULL, 0x7f4a7c159e3779b9ULL,
      0x94d049bb133111ebULL, 0xd6e8feb86659fd93ULL,
      0xa5a3564e27f8862fULL, 0x8cb92baa3f3d8dd7ULL,
      0xdb4f0b9175ae2165ULL, 0xbb67ae8584caa73bULL,
      0x3c6ef372fe94f82bULL, 0x510e527fade682d1ULL,
  };
  for (std::uint64_t seed : seeds) {
    std::uint64_t random = seed;
    for (std::size_t index = 0; index < 100'000; ++index) {
      const std::uint64_t sample = NextRandom(&random);
      const ReleaseObservation observation =
          static_cast<ReleaseObservation>(sample & 3U);
      const QuarantineSignals signals{
          (sample & 4U) != 0,
          (sample & 8U) != 0,
      };
      ResourceStateMachine machine;
      const ReleaseTransition transition = machine.ObserveRelease(observation, signals);
      const bool positive = observation == ReleaseObservation::positive;
      checks->Require(transition.accepted);
      checks->Require(machine.state() == (positive
          ? ResourceLifecycleState::positively_released
          : ResourceLifecycleState::release_outcome_quarantined));
      checks->Require(machine.poison_process_creation() ==
                      (!positive && signals.poison_process_creation));
      checks->Require(machine.nonrestart_shutdown_required() ==
                      (!positive && signals.nonrestart_shutdown_required));
      const ReleaseTransition replay = machine.ObserveRelease(
          static_cast<ReleaseObservation>((sample >> 8U) & 3U),
          {!signals.poison_process_creation, !signals.nonrestart_shutdown_required});
      checks->Require(!replay.accepted);
      checks->Require(replay.poison_process_creation ==
                      machine.poison_process_creation());
      checks->Require(replay.nonrestart_shutdown_required ==
                      machine.nonrestart_shutdown_required());
    }
  }
}

void CheckManifest(Checks* checks) {
  const auto json_bytes = [](std::string_view value) noexcept {
    return std::span<const std::uint8_t>(
        reinterpret_cast<const std::uint8_t*>(value.data()), value.size());
  };
  checks->Require(ValidateResourceManifestCompactJsonSyntax(
      json_bytes("{\"x\":0}")));
  checks->Require(ValidateResourceManifestCompactJsonSyntax(
      json_bytes("{\"x\":0,\"x\":1}")));
  checks->Require(!ValidateResourceManifestCompactJsonSyntax(
      json_bytes("{\"x\": 0}")));
  checks->Require(!ValidateResourceManifestCompactJsonSyntax(json_bytes("[]")));

  const std::span<const std::uint8_t> frame = EmbeddedResourceOwnershipManifest();
  const std::span<const std::uint8_t> digest = EmbeddedResourceOwnershipManifestSha256();
  checks->Require(!frame.empty());
  checks->Require(frame.size() <= kMaximumResourceManifestFrameBytes);
  checks->Require(digest.size() == 32);
  checks->Require(ValidateEmbeddedResourceOwnershipManifest() ==
                  ResourceManifestValidation::valid);
  for (const std::string_view site_id : kResourceSiteIdStrings) {
    checks->Require(ResourceManifestContainsExactString(frame, site_id));
  }
  constexpr std::array<std::string_view, 1> hostile_expected{
      "qualification_owned_event\""};
  checks->Require(ValidateResourceOwnershipManifestFrame(
                      frame, hostile_expected) ==
                  ResourceManifestValidation::binding_mismatch);
  checks->Require(!ResourceManifestContainsExactString(
      frame, "qualification_owned_event\\\""));

  checks->Require(ValidateResourceOwnershipManifestFrame({}, {}) ==
                  ResourceManifestValidation::empty);
  constexpr std::array<std::uint8_t, 1> malformed{'{'};
  checks->Require(ValidateResourceOwnershipManifestFrame(malformed, {}) ==
                  ResourceManifestValidation::invalid_frame);
  std::vector<std::uint8_t> oversized(kMaximumResourceManifestFrameBytes + 1, 0);
  checks->Require(ValidateResourceOwnershipManifestFrame(oversized, {}) ==
                  ResourceManifestValidation::too_large);

#if defined(PCSDK_QUALIFICATION)
  std::vector<std::uint8_t> digest_mismatch(frame.begin(), frame.end());
  digest_mismatch[kResourceManifestHeaderBytes] ^= 1U;
  checks->Require(ValidateResourceOwnershipManifestFrame(
                      digest_mismatch, kResourceSiteIdStrings) ==
                  ResourceManifestValidation::digest_mismatch);

  std::vector<std::uint8_t> binding_mismatch(frame.begin(), frame.end());
  binding_mismatch[20] = 1;
  checks->Require(ValidateResourceOwnershipManifestFrame(
                      binding_mismatch, kResourceSiteIdStrings) ==
                  ResourceManifestValidation::binding_mismatch);

  const auto mutate_payload = [&frame](std::string_view needle,
                                       std::string_view replacement) {
    std::vector<std::uint8_t> mutated(frame.begin(), frame.end());
    const auto found = std::search(
        mutated.begin() + static_cast<std::ptrdiff_t>(kResourceManifestHeaderBytes),
        mutated.end(), needle.begin(), needle.end());
    if (found == mutated.end() || needle.size() != replacement.size()) return std::vector<std::uint8_t>{};
    std::copy(replacement.begin(), replacement.end(), found);
    if (!QualificationRecomputeResourceManifestFrameDigest(mutated)) {
      return std::vector<std::uint8_t>{};
    }
    return mutated;
  };

  const std::vector<std::uint8_t> invalid_json = mutate_payload(
      "\"artifactId\":", "\"artifactId\";");
  checks->Require(!invalid_json.empty());
  checks->Require(!invalid_json.empty() &&
                  ValidateResourceOwnershipManifestFrame(
                      invalid_json, kResourceSiteIdStrings) ==
                      ResourceManifestValidation::invalid_json);

  const std::vector<std::uint8_t> lone_high_surrogate = mutate_payload(
      "qualif", "\\uD800");
  checks->Require(!lone_high_surrogate.empty());
  checks->Require(!lone_high_surrogate.empty() &&
                  ValidateResourceOwnershipManifestFrame(
                      lone_high_surrogate, kResourceSiteIdStrings) ==
                      ResourceManifestValidation::invalid_json);
  const std::vector<std::uint8_t> lone_low_surrogate = mutate_payload(
      "qualif", "\\uDC00");
  checks->Require(!lone_low_surrogate.empty());
  checks->Require(!lone_low_surrogate.empty() &&
                  ValidateResourceOwnershipManifestFrame(
                      lone_low_surrogate, kResourceSiteIdStrings) ==
                      ResourceManifestValidation::invalid_json);

  const std::vector<std::uint8_t> schema_value_mismatch = mutate_payload(
      "\"ownership\":\"borrowed\"", "\"ownership\":\"borrowex\"");
  checks->Require(!schema_value_mismatch.empty());
  checks->Require(!schema_value_mismatch.empty() &&
                  ValidateResourceOwnershipManifestFrame(
                      schema_value_mismatch, kResourceSiteIdStrings) ==
                      ResourceManifestValidation::binding_mismatch);
  const std::vector<std::uint8_t> noncanonical_number = mutate_payload(
      "\"maxMonotonicMilliseconds\":5000",
      "\"maxMonotonicMilliseconds\":5e03");
  checks->Require(!noncanonical_number.empty());
  checks->Require(!noncanonical_number.empty() &&
                  ValidateResourceOwnershipManifestFrame(
                      noncanonical_number, kResourceSiteIdStrings) ==
                      ResourceManifestValidation::binding_mismatch);

  constexpr std::string_view first_site_pattern =
      "\"siteId\":\"qualification_borrowed_event\"";
  std::string replacement(first_site_pattern);
  replacement[replacement.size() - 2] = 'x';
  const std::vector<std::uint8_t> missing_site = mutate_payload(
      first_site_pattern, replacement);
  checks->Require(!missing_site.empty());
  checks->Require(!missing_site.empty() &&
                  ValidateResourceOwnershipManifestFrame(
                      missing_site, kResourceSiteIdStrings) ==
                      ResourceManifestValidation::missing_site);

  constexpr std::array<std::string_view, 4> duplicate_expected{
      "qualification_borrowed_event",
      "qualification_borrowed_event",
      "qualification_owned_local_alloc",
      "qualification_pseudo_process",
  };
  checks->Require(ValidateResourceOwnershipManifestFrame(
                      frame, duplicate_expected) ==
                  ResourceManifestValidation::duplicate_site);
#endif
}

#if defined(PCSDK_QUALIFICATION)
void CheckOwnedBorrowedAndMove(Checks* checks) noexcept {
  ResetQualificationResourceCounters();
  RecordingSink sink;
  auto owner = AcquireQualificationOwnedEvent(&sink);
  checks->Require(owner.has_value());
  if (!owner.has_value()) return;
  auto borrowed = BorrowQualificationEvent(*owner);
  checks->Require(borrowed.has_value());
  if (!borrowed.has_value()) {
    checks->Require(owner->Release().has_value());
    return;
  }

  QualificationNativeValue owner_value = 0;
  QualificationNativeValue borrowed_value = 0;
  checks->Require(owner->WithLiveValue(
      [&owner_value](const QualificationNativeValue& value) noexcept { owner_value = value; }));
  checks->Require(borrowed->WithOwnerLiveValue(
      [&borrowed_value](const QualificationNativeValue& value) noexcept {
        borrowed_value = value;
      }));
  checks->Require(owner_value != 0 && owner_value == borrowed_value);

  QualificationOwnedEvent moved_owner{std::move(*owner)};
  QualificationBorrowedEvent moved_borrowed{std::move(*borrowed)};
  checks->Require(!owner->engaged());
  checks->Require(!owner->WithLiveValue([](const QualificationNativeValue&) noexcept {}));
  checks->Require(!borrowed->WithOwnerLiveValue(
      [](const QualificationNativeValue&) noexcept {}));
  checks->Require(moved_borrowed.WithOwnerLiveValue(
      [](const QualificationNativeValue&) noexcept {}));

  const std::optional<ReleaseTransition> released = moved_owner.Release();
  checks->Require(released.has_value());
  checks->Require(released.has_value() &&
                  released->state == ResourceLifecycleState::positively_released);
  checks->Require(!moved_owner.Release().has_value());
  checks->Require(!moved_owner.WithLiveValue(
      [](const QualificationNativeValue&) noexcept {}));
  checks->Require(!moved_borrowed.WithOwnerLiveValue(
      [](const QualificationNativeValue&) noexcept {}));
  checks->Require(sink.calls == 0);

  const QualificationResourceCounters counters = ReadQualificationResourceCounters();
  checks->Require(counters.owned_event_acquisitions == 1);
  checks->Require(counters.owned_event_release_calls == 1);
  checks->Require(counters.borrowed_event_observations == 1);
}

void CheckScopedBorrowReleaseRace(Checks* checks) noexcept {
  OwnerLivenessState contested_liveness;
  constexpr std::size_t kContenderCount = 8;
  std::atomic<std::size_t> entered{0};
  std::atomic<bool> leave{false};
  std::atomic<bool> contention_failed{false};
  std::array<std::thread, kContenderCount> contenders;
  try {
    for (std::thread& contender : contenders) {
      contender = std::thread([&contested_liveness, &entered, &leave,
                               &contention_failed]() noexcept {
        if (!contested_liveness.TryBeginUse()) {
          contention_failed.store(true, std::memory_order_release);
          return;
        }
        entered.fetch_add(1, std::memory_order_acq_rel);
        while (!leave.load(std::memory_order_acquire)) std::this_thread::yield();
        contested_liveness.EndUse();
      });
    }
  } catch (...) {
    contention_failed.store(true, std::memory_order_release);
  }
  const auto contention_deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (entered.load(std::memory_order_acquire) != kContenderCount &&
         !contention_failed.load(std::memory_order_acquire)) {
    if (std::chrono::steady_clock::now() >= contention_deadline) {
      contention_failed.store(true, std::memory_order_release);
      break;
    }
    std::this_thread::yield();
  }
  if (contention_failed.load(std::memory_order_acquire)) {
    leave.store(true, std::memory_order_release);
    for (std::thread& contender : contenders) {
      if (contender.joinable()) contender.join();
    }
    checks->Require(false);
    return;
  }
  checks->Require(!contested_liveness.RetireForRelease());
  leave.store(true, std::memory_order_release);
  for (std::thread& contender : contenders) {
    if (contender.joinable()) contender.join();
  }
  checks->Require(!contested_liveness.is_live());
  checks->Require(!contested_liveness.TryBeginUse());

  ResetQualificationResourceCounters();
  RecordingSink sink;
  auto owner = AcquireQualificationOwnedEvent(&sink);
  checks->Require(owner.has_value());
  if (!owner.has_value()) return;
  std::optional<ReleaseTransition> during_use;
  checks->Require(owner->WithLiveValue(
      [&owner, &during_use](const QualificationNativeValue&) noexcept {
        during_use = owner->Release();
      }));
  checks->Require(during_use.has_value());
  checks->Require(during_use.has_value() &&
                  during_use->observation == ReleaseObservation::before_call);
  checks->Require(during_use.has_value() && !during_use->release_call_invoked);
  checks->Require(owner->poison_process_creation());
  checks->Require(owner->nonrestart_shutdown_required());
  checks->Require(!owner->Release().has_value());
  checks->Require(sink.calls == 1);
  checks->Require(ReadQualificationResourceCounters().owned_event_release_calls == 0);
}

void CheckReleaseFaults(Checks* checks) noexcept {
  struct Case final {
    QualificationReleaseFault fault;
    ReleaseObservation observation;
    bool injected_release_called;
    bool release_api_called;
  };
  constexpr std::array cases{
      Case{QualificationReleaseFault::before_call,
           ReleaseObservation::before_call, false, false},
      Case{QualificationReleaseFault::release_returns_negative,
           ReleaseObservation::negative, true, false},
      Case{QualificationReleaseFault::succeeded_report_uncertain,
           ReleaseObservation::succeeded_report_uncertain, false, true},
  };
  for (const Case& test_case : cases) {
    ResetQualificationResourceCounters();
    RecordingSink sink;
    OneShotFault fault(test_case.fault);
    auto owner = AcquireQualificationOwnedEvent(&sink, &fault);
    checks->Require(owner.has_value());
    if (!owner.has_value()) continue;
    const std::optional<ReleaseTransition> transition = owner->Release();
    checks->Require(transition.has_value());
    checks->Require(transition.has_value() && transition->accepted);
    checks->Require(transition.has_value() &&
                    transition->observation == test_case.observation);
    checks->Require(transition.has_value() &&
                    transition->state ==
                        ResourceLifecycleState::release_outcome_quarantined);
    checks->Require(transition.has_value() &&
                    transition->release_call_invoked ==
                        (test_case.observation != ReleaseObservation::before_call));
    checks->Require(owner->poison_process_creation());
    checks->Require(owner->nonrestart_shutdown_required());
    checks->Require(!owner->Release().has_value());
    checks->Require(sink.calls == 1);
    checks->Require(fault.negative_release_calls() ==
                    (test_case.injected_release_called ? 1U : 0U));
    checks->Require(ReadQualificationResourceCounters().owned_event_release_calls ==
                    (test_case.release_api_called ? 1U : 0U));
  }

  for (const Case& test_case : cases) {
    ResetQualificationResourceCounters();
    RecordingSink sink;
    OneShotFault fault(test_case.fault);
    auto allocation = AcquireQualificationOwnedLocalAlloc(32, &sink, &fault);
    checks->Require(allocation.has_value());
    if (!allocation.has_value()) continue;
    const std::optional<ReleaseTransition> transition = allocation->Release();
    checks->Require(transition.has_value());
    checks->Require(transition.has_value() &&
                    transition->observation == test_case.observation);
    checks->Require(transition.has_value() &&
                    transition->state ==
                        ResourceLifecycleState::release_outcome_quarantined);
    checks->Require(allocation->poison_process_creation());
    checks->Require(allocation->nonrestart_shutdown_required());
    checks->Require(!allocation->Release().has_value());
    checks->Require(sink.calls == 1);
    checks->Require(fault.negative_release_calls() ==
                    (test_case.injected_release_called ? 1U : 0U));
    checks->Require(ReadQualificationResourceCounters().local_alloc_release_calls ==
                    (test_case.release_api_called ? 1U : 0U));
  }
}

void CheckOpaqueAndNoRelease(Checks* checks) noexcept {
  ResetQualificationResourceCounters();
  RecordingSink sink;
  auto allocation = AcquireQualificationOwnedLocalAlloc(64, &sink);
  checks->Require(allocation.has_value());
  if (allocation.has_value()) {
    checks->Require(allocation->WithLiveValue(
        [](const QualificationNativeValue& value) noexcept {
          static_cast<void>(value);
        }));
    const std::optional<ReleaseTransition> released = allocation->Release();
    checks->Require(released.has_value());
    checks->Require(released.has_value() &&
                    released->state == ResourceLifecycleState::positively_released);
    checks->Require(!allocation->Release().has_value());
  }
  checks->Require(sink.calls == 0);
  checks->Require(ReadQualificationResourceCounters().local_alloc_acquisitions == 1);
  checks->Require(ReadQualificationResourceCounters().local_alloc_release_calls == 1);

  auto pseudo_a = AcquireQualificationPseudoProcess();
  auto pseudo_b = AcquireQualificationPseudoProcess();
  checks->Require(pseudo_a.has_value() && pseudo_b.has_value());
  if (!pseudo_a.has_value() || !pseudo_b.has_value()) return;
  QualificationNativeValue identity = 0;
  pseudo_b->WithStableIdentity(
      [&identity](const QualificationNativeValue& value) noexcept { identity = value; });
  checks->Require(identity != 0);
  checks->Require(pseudo_a->MatchesStableIdentity(identity));
  QualificationPseudoProcess moved{std::move(*pseudo_a)};
  bool moved_source_called = false;
  pseudo_a->WithStableIdentity(
      [&moved_source_called](const QualificationNativeValue&) noexcept {
        moved_source_called = true;
      });
  checks->Require(!moved_source_called);
  checks->Require(moved.MatchesStableIdentity(identity));
  checks->Require(ReadQualificationResourceCounters().pseudo_process_observations == 2);
}
#endif

}  // namespace

bool RunResourceProperties(
    std::uint64_t* assertion_count,
    QualificationCanaryResult* canary_result) noexcept {
  static_assert(!std::is_copy_constructible_v<QualificationOwnedEvent>);
  static_assert(!std::is_copy_assignable_v<QualificationOwnedEvent>);
  static_assert(std::is_move_constructible_v<QualificationOwnedEvent>);
  static_assert(!std::is_move_assignable_v<QualificationOwnedEvent>);
  static_assert(!std::is_copy_constructible_v<QualificationBorrowedEvent>);
  static_assert(std::is_move_constructible_v<QualificationBorrowedEvent>);
  static_assert(!std::is_move_assignable_v<QualificationBorrowedEvent>);
  static_assert(!std::is_copy_constructible_v<QualificationPseudoProcess>);
  static_assert(std::is_move_constructible_v<QualificationPseudoProcess>);
  static_assert(!std::is_move_assignable_v<QualificationPseudoProcess>);

  Checks checks;
  CheckStateVocabulary(&checks);
  CheckStateTransitions(&checks);
  CheckDeterministicStateProperties(&checks);
  try {
    CheckManifest(&checks);
  } catch (...) {
    if (assertion_count != nullptr) *assertion_count = checks.assertions();
    return false;
  }
#if defined(PCSDK_QUALIFICATION)
  CheckOwnedBorrowedAndMove(&checks);
  CheckScopedBorrowReleaseRace(&checks);
  CheckReleaseFaults(&checks);
  CheckOpaqueAndNoRelease(&checks);
#endif
  if (assertion_count != nullptr) *assertion_count = checks.assertions();
  if (!checks.passed()) return false;
#if defined(PCSDK_QUALIFICATION)
  const QualificationCanaryResult canary = RunQualificationResourceCanaries();
  if (canary_result != nullptr) *canary_result = canary;
  return canary.status != QualificationCanaryStatus::failed;
#else
  if (canary_result != nullptr) {
    *canary_result = QualificationCanaryResult{
        QualificationCanaryStatus::failed, "qualification-disabled", "", 0};
  }
  return false;
#endif
}

}  // namespace pc_sdk_next::containment
