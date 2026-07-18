#include <cstddef>
#include <cstdint>

namespace {

volatile std::uint8_t probe_sink = 0U;

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* const data, const std::size_t size) {
  if (size >= 4U && data[0] == 0x43U && data[1] == 0x58U && data[2] == 0x30U && data[3] == 0x34U) {
    probe_sink = data[3];
  } else if (size != 0U) {
    probe_sink = data[0];
  }
  return 0;
}
