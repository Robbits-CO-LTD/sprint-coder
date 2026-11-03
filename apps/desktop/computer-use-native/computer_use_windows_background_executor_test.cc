#include "computer_use_windows_background_executor_test.h"

int main() {
  return windows_background_executor_test::CheckBackgroundExecutor() &&
      windows_background_executor_test::CheckBackgroundScroll() ? 0 : 1;
}
