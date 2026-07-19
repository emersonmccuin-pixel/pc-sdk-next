#include "pc_sdk_next/resource_state.h"

#include <cstring>

#include "pc_sdk_next/resource_manifest.h"

namespace pc_sdk_next::containment {
namespace {

class ResourceManifestJsonReader final {
 public:
  explicit ResourceManifestJsonReader(
      std::span<const std::uint8_t> bytes) noexcept
      : bytes_(bytes) {}

  [[nodiscard]] bool Parse() noexcept {
    SkipWhitespace();
    if (!ParseValue(0)) return false;
    SkipWhitespace();
    return position_ == bytes_.size() && !saw_whitespace_;
  }

 private:
  static constexpr std::size_t kMaximumDepth = 64;
  static constexpr std::size_t kMaximumMembers = 4096;

  [[nodiscard]] bool ParseValue(std::size_t depth) noexcept {
    if (depth > kMaximumDepth || position_ >= bytes_.size()) return false;
    switch (bytes_[position_]) {
      case '{':
        return ParseObject(depth + 1);
      case '[':
        return ParseArray(depth + 1);
      case '"':
        return ParseString();
      case 't':
        return ConsumeLiteral("true");
      case 'f':
        return ConsumeLiteral("false");
      case 'n':
        return ConsumeLiteral("null");
      default:
        return ParseNumber();
    }
  }

  [[nodiscard]] bool ParseObject(std::size_t depth) noexcept {
    ++position_;
    SkipWhitespace();
    if (Consume('}')) return true;
    for (;;) {
      if (++members_ > kMaximumMembers || !ParseString()) return false;
      SkipWhitespace();
      if (!Consume(':')) return false;
      SkipWhitespace();
      if (!ParseValue(depth)) return false;
      SkipWhitespace();
      if (Consume('}')) return true;
      if (!Consume(',')) return false;
      SkipWhitespace();
    }
  }

  [[nodiscard]] bool ParseArray(std::size_t depth) noexcept {
    ++position_;
    SkipWhitespace();
    if (Consume(']')) return true;
    for (;;) {
      if (++members_ > kMaximumMembers || !ParseValue(depth)) return false;
      SkipWhitespace();
      if (Consume(']')) return true;
      if (!Consume(',')) return false;
      SkipWhitespace();
    }
  }

  [[nodiscard]] bool ParseString() noexcept {
    if (!Consume('"')) return false;
    while (position_ < bytes_.size()) {
      const std::uint8_t byte = bytes_[position_++];
      if (byte == '"') return true;
      if (byte < 0x20U) return false;
      if (byte != '\\') continue;
      if (position_ >= bytes_.size()) return false;
      const std::uint8_t escape = bytes_[position_++];
      if (escape == '"' || escape == '\\' || escape == '/' || escape == 'b' ||
          escape == 'f' || escape == 'n' || escape == 'r' || escape == 't') {
        continue;
      }
      if (escape != 'u') return false;
      std::uint16_t scalar = 0;
      if (!ReadHex4(&scalar)) return false;
      if (scalar >= 0xdc00U && scalar <= 0xdfffU) return false;
      if (scalar >= 0xd800U && scalar <= 0xdbffU) {
        if (position_ + 2 > bytes_.size() || bytes_[position_] != '\\' ||
            bytes_[position_ + 1] != 'u') {
          return false;
        }
        position_ += 2;
        std::uint16_t low = 0;
        if (!ReadHex4(&low) || low < 0xdc00U || low > 0xdfffU) return false;
      }
    }
    return false;
  }

  [[nodiscard]] bool ParseNumber() noexcept {
    const std::size_t start = position_;
    static_cast<void>(Consume('-'));
    if (position_ >= bytes_.size()) return false;
    if (bytes_[position_] == '0') {
      ++position_;
      if (position_ < bytes_.size() && bytes_[position_] >= '0' &&
          bytes_[position_] <= '9') {
        return false;
      }
    } else {
      if (bytes_[position_] < '1' || bytes_[position_] > '9') return false;
      while (position_ < bytes_.size() && bytes_[position_] >= '0' &&
             bytes_[position_] <= '9') {
        ++position_;
      }
    }
    if (Consume('.')) {
      const std::size_t fraction = position_;
      while (position_ < bytes_.size() && bytes_[position_] >= '0' &&
             bytes_[position_] <= '9') {
        ++position_;
      }
      if (fraction == position_) return false;
    }
    if (position_ < bytes_.size() &&
        (bytes_[position_] == 'e' || bytes_[position_] == 'E')) {
      ++position_;
      if (position_ < bytes_.size() &&
          (bytes_[position_] == '+' || bytes_[position_] == '-')) {
        ++position_;
      }
      const std::size_t exponent = position_;
      while (position_ < bytes_.size() && bytes_[position_] >= '0' &&
             bytes_[position_] <= '9') {
        ++position_;
      }
      if (exponent == position_) return false;
    }
    return position_ > start;
  }

  [[nodiscard]] bool ConsumeLiteral(std::string_view literal) noexcept {
    if (literal.size() > bytes_.size() - position_) return false;
    if (std::memcmp(bytes_.data() + position_, literal.data(), literal.size()) != 0) {
      return false;
    }
    position_ += literal.size();
    return true;
  }

  [[nodiscard]] bool ReadHex4(std::uint16_t* value) noexcept {
    if (value == nullptr || position_ + 4 > bytes_.size()) return false;
    std::uint16_t result = 0;
    for (std::size_t index = 0; index < 4; ++index) {
      const std::uint8_t digit = bytes_[position_++];
      std::uint8_t nibble = 0;
      if (digit >= '0' && digit <= '9') {
        nibble = static_cast<std::uint8_t>(digit - '0');
      } else if (digit >= 'a' && digit <= 'f') {
        nibble = static_cast<std::uint8_t>(digit - 'a' + 10U);
      } else if (digit >= 'A' && digit <= 'F') {
        nibble = static_cast<std::uint8_t>(digit - 'A' + 10U);
      } else {
        return false;
      }
      result = static_cast<std::uint16_t>((result << 4U) | nibble);
    }
    *value = result;
    return true;
  }

  [[nodiscard]] bool Consume(std::uint8_t expected) noexcept {
    if (position_ >= bytes_.size() || bytes_[position_] != expected) return false;
    ++position_;
    return true;
  }

  void SkipWhitespace() noexcept {
    while (position_ < bytes_.size()) {
      const std::uint8_t byte = bytes_[position_];
      if (byte != ' ' && byte != '\t' && byte != '\r' && byte != '\n') return;
      saw_whitespace_ = true;
      ++position_;
    }
  }

  std::span<const std::uint8_t> bytes_;
  std::size_t position_ = 0;
  std::size_t members_ = 0;
  bool saw_whitespace_ = false;
};

[[nodiscard]] bool HasValidManifestUtf8(
    std::span<const std::uint8_t> bytes) noexcept {
  std::size_t index = 0;
  while (index < bytes.size()) {
    const std::uint8_t first = bytes[index++];
    if (first <= 0x7fU) continue;
    std::uint32_t scalar = 0;
    std::size_t continuation = 0;
    if (first >= 0xc2U && first <= 0xdfU) {
      scalar = first & 0x1fU;
      continuation = 1;
    } else if (first >= 0xe0U && first <= 0xefU) {
      scalar = first & 0x0fU;
      continuation = 2;
    } else if (first >= 0xf0U && first <= 0xf4U) {
      scalar = first & 0x07U;
      continuation = 3;
    } else {
      return false;
    }
    if (continuation > bytes.size() - index) return false;
    for (std::size_t offset = 0; offset < continuation; ++offset) {
      const std::uint8_t next = bytes[index++];
      if ((next & 0xc0U) != 0x80U) return false;
      scalar = (scalar << 6U) | (next & 0x3fU);
    }
    if ((continuation == 1 && scalar < 0x80U) ||
        (continuation == 2 && scalar < 0x800U) ||
        (continuation == 3 && scalar < 0x10000U) || scalar > 0x10ffffU ||
        (scalar >= 0xd800U && scalar <= 0xdfffU)) {
      return false;
    }
  }
  return true;
}

}  // namespace

bool ValidateResourceManifestCompactJsonSyntax(
    std::span<const std::uint8_t> payload) noexcept {
  return !payload.empty() &&
      payload.size() <= kMaximumResourceManifestPayloadBytes &&
      payload.front() == '{' && HasValidManifestUtf8(payload) &&
      ResourceManifestJsonReader(payload).Parse();
}

std::string_view ResourceLifecycleStateName(ResourceLifecycleState state) noexcept {
  switch (state) {
    case ResourceLifecycleState::known_live:
      return "known-live";
    case ResourceLifecycleState::positively_released:
      return "positively-released";
    case ResourceLifecycleState::release_outcome_quarantined:
      return "release-outcome-quarantined";
  }
  return {};
}

std::string_view ReleaseObservationName(ReleaseObservation observation) noexcept {
  switch (observation) {
    case ReleaseObservation::positive:
      return "positive";
    case ReleaseObservation::negative:
      return "negative";
    case ReleaseObservation::before_call:
      return "before-call";
    case ReleaseObservation::succeeded_report_uncertain:
      return "succeeded-report-uncertain";
  }
  return {};
}

bool ParseResourceLifecycleState(
    std::string_view value, ResourceLifecycleState* state) noexcept {
  if (state == nullptr) return false;
  if (value == "known-live") {
    *state = ResourceLifecycleState::known_live;
    return true;
  }
  if (value == "positively-released") {
    *state = ResourceLifecycleState::positively_released;
    return true;
  }
  if (value == "release-outcome-quarantined") {
    *state = ResourceLifecycleState::release_outcome_quarantined;
    return true;
  }
  return false;
}

bool ParseReleaseObservation(
    std::string_view value, ReleaseObservation* observation) noexcept {
  if (observation == nullptr) return false;
  if (value == "positive") {
    *observation = ReleaseObservation::positive;
    return true;
  }
  if (value == "negative") {
    *observation = ReleaseObservation::negative;
    return true;
  }
  if (value == "before-call") {
    *observation = ReleaseObservation::before_call;
    return true;
  }
  if (value == "succeeded-report-uncertain") {
    *observation = ReleaseObservation::succeeded_report_uncertain;
    return true;
  }
  return false;
}

ResourceLifecycleState ResourceStateMachine::state() const noexcept {
  return static_cast<ResourceLifecycleState>(
      packed_state_.load(std::memory_order_acquire) & kStateMask);
}

bool ResourceStateMachine::release_may_be_observed() const noexcept {
  return state() == ResourceLifecycleState::known_live;
}

bool ResourceStateMachine::poison_process_creation() const noexcept {
  return (packed_state_.load(std::memory_order_acquire) & kPoisonBit) != 0;
}

bool ResourceStateMachine::nonrestart_shutdown_required() const noexcept {
  return (packed_state_.load(std::memory_order_acquire) & kNonrestartBit) != 0;
}

ReleaseTransition ResourceStateMachine::ObserveRelease(
    ReleaseObservation observation, QuarantineSignals signals) noexcept {
  const bool known_observation = IsKnownReleaseObservation(observation);
  const bool positive = known_observation && observation == ReleaseObservation::positive;
  const bool release_call_invoked = known_observation &&
      observation != ReleaseObservation::before_call;
  const ResourceLifecycleState next_state = positive
      ? ResourceLifecycleState::positively_released
      : ResourceLifecycleState::release_outcome_quarantined;
  std::uint8_t next = static_cast<std::uint8_t>(next_state);
  if (!positive && signals.poison_process_creation) next |= kPoisonBit;
  if (!positive && signals.nonrestart_shutdown_required) next |= kNonrestartBit;

  std::uint8_t expected = static_cast<std::uint8_t>(ResourceLifecycleState::known_live);
  if (packed_state_.compare_exchange_strong(
          expected, next, std::memory_order_acq_rel, std::memory_order_acquire)) {
    return ReleaseTransition{
        ResourceLifecycleState::known_live,
        next_state,
        observation,
        true,
        release_call_invoked,
        !positive && signals.poison_process_creation,
        !positive && signals.nonrestart_shutdown_required,
    };
  }

  const ResourceLifecycleState persisted_state =
      static_cast<ResourceLifecycleState>(expected & kStateMask);
  return ReleaseTransition{
      persisted_state,
      persisted_state,
      observation,
      false,
      false,
      (expected & kPoisonBit) != 0,
      (expected & kNonrestartBit) != 0,
  };
}

}  // namespace pc_sdk_next::containment
