#include "util/ort_init.h"

#include <dlfcn.h>

#include <mutex>
#include <stdexcept>
#include <string>

// Manual init: don't reference OrtGetApiBase from the header, so we don't have to link
// libonnxruntime.so at build time via a prefab CMake config. We resolve it at runtime instead;
// the .so itself ships in the onnxruntime-android AAR and is packaged in the APK.
#define ORT_API_MANUAL_INIT
#include "onnxruntime_cxx_api.h"

namespace audionotes {

void ensureOrtApi() {
  static std::once_flag once;
  static std::string error;
  std::call_once(once, [] {
    // RTLD_GLOBAL so the statically-linked sherpa-onnx code in this library resolves its
    // onnxruntime symbols against the same loaded instance rather than a second copy.
    void* h = dlopen("libonnxruntime.so", RTLD_NOW | RTLD_GLOBAL);
    if (!h) {
      error = std::string("dlopen libonnxruntime.so failed: ") + dlerror();
      return;
    }
    using GetApiBaseFn = const OrtApiBase* (*)();
    auto get_base = reinterpret_cast<GetApiBaseFn>(dlsym(h, "OrtGetApiBase"));
    if (!get_base) {
      error = "OrtGetApiBase not found in libonnxruntime.so";
      return;
    }
    const OrtApi* api = get_base()->GetApi(ORT_API_VERSION);
    if (!api) {
      error = "OrtGetApiBase()->GetApi returned null";
      return;
    }
    Ort::InitApi(api);
  });
  // Throw on every call, not just the first: a caller that runs after a failed init would
  // otherwise proceed with a null OrtApi and segfault instead of seeing the reason.
  if (!error.empty()) throw std::runtime_error(error);
}

}  // namespace audionotes
