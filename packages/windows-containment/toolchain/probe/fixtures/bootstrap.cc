#include <cstdint>
#include <windows.h>

#include "msvc-static-crt-contract.h"

extern "C" std::uint32_t pcsdk_probe_core();

int WINAPI wWinMain(
    const HINSTANCE instance,
    const HINSTANCE previous_instance,
    const PWSTR command_line,
    const int show_command) {
  (void)instance;
  (void)previous_instance;
  (void)command_line;
  (void)show_command;
  return pcsdk_probe_core() == 116U ? 0 : 1;
}
