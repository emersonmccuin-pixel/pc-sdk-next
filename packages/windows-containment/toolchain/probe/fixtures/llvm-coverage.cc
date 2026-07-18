#include <cstdlib>

namespace {

__declspec(noinline) int classify(const int value) noexcept {
  if (value > 0) {
    return 1;
  }
  if (value < 0) {
    return -1;
  }
  return 0;
}

}  // namespace

int main(const int argument_count, char**) {
  // argc 1/2/3 drives -1/0/+1 so every classify branch is exercised by the
  // three sealed probe invocations without adding another branch in main.
  volatile int observed = classify(argument_count - 2);
  (void)observed;
  return EXIT_SUCCESS;
}
