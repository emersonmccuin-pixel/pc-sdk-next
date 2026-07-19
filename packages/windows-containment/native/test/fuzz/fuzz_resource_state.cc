#include "pc_sdk_next/resource_state.h"

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <string_view>

namespace {

[[noreturn]] void Trap() noexcept {
  std::abort();
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
  using namespace pc_sdk_next::containment;
  if (data == nullptr && size != 0) Trap();

  ResourceStateMachine machine;
  bool observed = false;
  ResourceLifecycleState terminal = ResourceLifecycleState::known_live;
  bool persisted_poison = false;
  bool persisted_nonrestart = false;
  for (std::size_t index = 0; index < size; ++index) {
    const ReleaseObservation observation = static_cast<ReleaseObservation>(data[index]);
    const QuarantineSignals signals{
        (data[index] & 0x40U) != 0,
        (data[index] & 0x80U) != 0,
    };
    const ReleaseTransition transition = machine.ObserveRelease(observation, signals);
    if (!observed) {
      if (!transition.accepted || transition.previous_state != ResourceLifecycleState::known_live ||
          transition.state == ResourceLifecycleState::known_live) {
        Trap();
      }
      observed = true;
      terminal = transition.state;
      persisted_poison = transition.poison_process_creation;
      persisted_nonrestart = transition.nonrestart_shutdown_required;
    } else if (transition.accepted || transition.state != terminal ||
               transition.poison_process_creation != persisted_poison ||
               transition.nonrestart_shutdown_required != persisted_nonrestart) {
      Trap();
    }
  }

  if (observed && (machine.state() != terminal ||
                   machine.poison_process_creation() != persisted_poison ||
                   machine.nonrestart_shutdown_required() != persisted_nonrestart)) {
    Trap();
  }

  if (size <= 64) {
    const std::string_view text = data == nullptr
        ? std::string_view{}
        : std::string_view(reinterpret_cast<const char*>(data), size);
    ResourceLifecycleState state = ResourceLifecycleState::known_live;
    if (ParseResourceLifecycleState(text, &state) &&
        ResourceLifecycleStateName(state) != text) {
      Trap();
    }
    ReleaseObservation observation = ReleaseObservation::positive;
    if (ParseReleaseObservation(text, &observation) &&
        ReleaseObservationName(observation) != text) {
      Trap();
    }
  }
  return 0;
}
