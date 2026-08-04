// Thread-count selection for the inference engines.
#pragma once

#include <algorithm>
#include <cstdio>
#include <thread>
#include <vector>

namespace audionotes {

/**
 * Number of threads to hand a ggml/ONNX graph on this device.
 *
 * Returns the size of the FASTEST CPU cluster, not the core count. Both runtimes synchronise all
 * worker threads at every graph node, so a pass advances at the speed of its slowest thread —
 * adding a slow core does not add throughput, it adds a stall that every other thread waits on.
 *
 * Measured on a Pixel 7 Pro (Tensor G2: 4x A55 @1.80GHz, 2x A78 @2.35GHz, 2x X1 @2.85GHz),
 * transcribing 154s of speech with whisper base:
 *
 *     2 threads    ~104 s     <- fastest cluster only (both X1)
 *     4 threads     112 s
 *     6 threads     115 s
 *     8 threads     622 s     <- 5.5x SLOWER; every barrier waits on an A55
 *
 * The naive `hardware_concurrency() - 2` would pick 6 here, and "use every core" would pick the
 * catastrophic 8. Hence: group cores by max frequency and use only the top group.
 *
 * Falls back to a conservative half-of-cores if sysfs is unreadable (some devices restrict it).
 */
inline int inferenceThreadCount() {
  const int hw = std::max(1, static_cast<int>(std::thread::hardware_concurrency()));
  if (hw <= 2) return hw;

  std::vector<long> freqs;
  freqs.reserve(hw);
  for (int i = 0; i < hw; ++i) {
    char path[128];
    std::snprintf(path, sizeof(path),
                  "/sys/devices/system/cpu/cpu%d/cpufreq/cpuinfo_max_freq", i);
    if (FILE* f = std::fopen(path, "r")) {
      long khz = 0;
      if (std::fscanf(f, "%ld", &khz) == 1 && khz > 0) freqs.push_back(khz);
      std::fclose(f);
    }
  }
  if (freqs.empty()) return std::max(1, hw / 2);

  const long top = *std::max_element(freqs.begin(), freqs.end());
  // 5% tolerance: cores in one cluster occasionally report slightly different ceilings.
  const long cutoff = top - top / 20;
  int fast = 0;
  for (long f : freqs) {
    if (f >= cutoff) ++fast;
  }

  // A homogeneous CPU reports every core as "fastest"; leave one for the UI and the foreground
  // service rather than saturating the device. Cap at 6 — beyond that ggml's barrier overhead
  // outweighs the extra arithmetic even when the cores are identical.
  if (fast == hw) fast = std::max(1, hw - 1);
  return std::clamp(fast, 1, 6);
}

}  // namespace audionotes
