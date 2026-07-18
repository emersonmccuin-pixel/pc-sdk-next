#include <cstddef>
#include <cstdlib>

int main(const int argument_count, char** const arguments) {
  constexpr std::size_t allocation_size = 8U;
  auto* const memory = static_cast<unsigned char*>(std::malloc(allocation_size));
  if (memory == nullptr) {
    return 2;
  }
  for (std::size_t index = 0; index < allocation_size; ++index) {
    memory[index] = static_cast<unsigned char>(index);
  }
  const bool trip = argument_count == 2 && arguments[1] != nullptr && arguments[1][0] == 't';
  if (trip) {
    memory[allocation_size] = 0xffU;
  }
  const int result = memory[0] == 0U ? 0 : 3;
  std::free(memory);
  return result;
}
