cmake_minimum_required(VERSION 3.22.1)
project(audionotes LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ONNX Runtime (used by Silero VAD): we DO NOT link it at build time and we DO NOT use find_package.
# The onnxruntime-android AAR ships libonnxruntime.so (packaged into the APK) but no prefab CMake
# config, so instead we vendor just the API headers here and load the .so at runtime via dlopen
# (see cpp/vad/silero_vad.cpp, ORT_API_MANUAL_INIT). This configures cleanly with no extra setup.
set(ORT_INCLUDE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/onnxruntime/include)

add_library(audionotes SHARED
  util/utf8.cpp
  util/ort_init.cpp
  vad/silero_vad.cpp
  vad/vad_span_builder.cpp
  asr/whisper_asr.cpp
  asr/asr_chunker.cpp
  asr/live_chunker.cpp
  asr/asr_postprocess.cpp
  asr/asr_factory.cpp
  asr/asr_languages.cpp
  asr/qwen3_asr.cpp
  asr/sherpa_asr.cpp
  diar/diarizer.cpp
  diar/span_map.cpp
  diar/speaker_match.cpp
  llm/llama_engine.cpp
  llm/embed_engine.cpp
  # Rule-based minutes, shared with the CLI and minutes.ts (see jni nativeMinutes). The rest of
  # the core's upper layers (pipeline/, capi/) are NOT built here: Android drives the stages from
  # Kotlin because ProcessingEngine owns DB-backed resume-by-stage, which the capture-agnostic
  # an_process facade has no notion of. Add them when that changes.
  minutes/minutes_extractor.cpp
  # The same rules again, with the provenance the extractor used to discard (Task 3 of the
  # evidence spine). Shares minutes_extractor's rules:: helpers rather than restating them.
  minutes/evidence.cpp
  # Phase B: the typed record — the classifier's prompt (fenced), grammar, parser and validator.
  minutes/evidence_record.cpp
  minutes/ask.cpp
  # The LLM minutes plumbing: chunking, the fold plan and every prompt. Android drives the loop
  # from Kotlin (Narrator) so it can checkpoint each chunk and honour cancellation, but it must not
  # own a word of the prompts — those live here, where the CLI and the eval harness exercise them.
  minutes/llm_prompts.cpp
  # Sub-project 6a: the seven meeting-type ids and the sections each narrows narrativePrompt to.
  minutes/templates.cpp
  # Phase 5: spoken punctuation for dictation mode.
  minutes/dictation.cpp
  # Transcript text may not enter a prompt except through here. Without this line the file
  # is never compiled into libaudionotes.so, the prompt builders fail to link, and the app
  # does not build — which is the good failure. The bad one would be a fence that exists in
  # the tree, passes every desktop test, and is not in the binary the phone runs.
  minutes/fence.cpp
  jni/audionotes_jni.cpp)

# ---------------------------------------------------------------------------
# Optimisation for the vendored inference engines.
#
# A debug build gets -O0 from the NDK toolchain, and ggml at -O0 is 20-50x slower than at -O3:
# transcribing 11 s of speech took over ten minutes on a Pixel 7 Pro, which reads as "whisper is
# hung" rather than "whisper is unoptimised". These are third-party dependencies we never step
# through, so they are always built optimised regardless of the app's build type.
#
# The arch flags matter just as much: baseline armv8-a has no dot-product instructions, and the
# quantised (q5_1/Q4_K) kernels lean on them heavily. armv8.2-a+fp16+dotprod is the right floor
# for every 64-bit Android device we target. i8mm/SVE are deliberately NOT enabled — they are
# armv8.6+ and absent on the Cortex-X1/A78/A55 cores in this class of phone.
# ---------------------------------------------------------------------------
function(audionotes_optimize_engine target)
  if(TARGET ${target})
    target_compile_options(${target} PRIVATE -O3 -fno-finite-math-only)
    if(ANDROID_ABI STREQUAL "arm64-v8a")
      target_compile_options(${target} PRIVATE -march=armv8.2-a+fp16+dotprod)
    endif()
  endif()
endfunction()

target_include_directories(audionotes PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${ORT_INCLUDE})

# ---------------------------------------------------------------------------
# ggml ownership — read this before reordering anything below.
#
# whisper.cpp and llama.cpp each vendor their own copy of ggml, and both add it with the SAME
# CMake target names (ggml, ggml-base, ggml-cpu). Only one may build it. Both upstreams guard
# with `if (NOT TARGET ggml)`, so whichever is added FIRST owns ggml and the other reuses it.
#
# llama.cpp is added first deliberately: ggml lives in the llama.cpp repo and whisper.cpp syncs
# from it, so llama's copy is always the newer superset. With whisper first, llama failed to
# compile against whisper v1.9.1's older ggml (`use of undeclared identifier GGML_TYPE_Q2_0`).
# The reverse direction works because whisper only uses long-stable ggml APIs.
#
# If you bump either submodule and hit missing GGML_* symbols, it is this version skew — bump
# the other one to a contemporaneous release rather than trying to patch the engine sources.
# ---------------------------------------------------------------------------

# --- llama.cpp (LLM) — vendored as a git submodule; built + linked when present ---
#   git submodule add https://github.com/ggml-org/llama.cpp cpp/third_party/llama.cpp
set(LLAMA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp)
if(EXISTS ${LLAMA_DIR}/CMakeLists.txt)
  set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
  set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
  set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  # ggml's llamafile sgemm kernels use fp16 NEON intrinsics (vld1q_f16) that 32-bit ARM lacks;
  # armeabi-v7a is a bench-only ABI here (the 2019 Galaxy Tab A), never shipped — so the
  # accelerator is simply off there and ggml falls back to its portable kernels.
  if(ANDROID_ABI STREQUAL "armeabi-v7a")
    set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
  endif()
  add_subdirectory(${LLAMA_DIR} ${CMAKE_BINARY_DIR}/llama_build)
  target_compile_definitions(audionotes PRIVATE HAVE_LLAMA=1)
  target_link_libraries(audionotes llama)
  foreach(t llama ggml ggml-base ggml-cpu)
    audionotes_optimize_engine(${t})
  endforeach()
endif()

# --- whisper.cpp (ASR) — vendored as a git submodule; built + linked when present ---
#   git submodule add https://github.com/ggerganov/whisper.cpp cpp/third_party/whisper.cpp
set(WHISPER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/whisper.cpp)
if(EXISTS ${WHISPER_DIR}/CMakeLists.txt)
  set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  # The NDK has no usable libgomp; ggml's OpenMP path fails to link on Android.
  # whisper is already threaded via wparams.n_threads, so this costs nothing.
  set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
  # Link whisper+ggml statically INTO libaudionotes.so so there is exactly one
  # .so to package and SoLoader has nothing extra to find at runtime.
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  add_subdirectory(${WHISPER_DIR} ${CMAKE_BINARY_DIR}/whisper_build)
  target_compile_definitions(audionotes PRIVATE HAVE_WHISPER=1)
  target_link_libraries(audionotes whisper)
  foreach(t whisper ggml ggml-base ggml-cpu)
    audionotes_optimize_engine(${t})
  endforeach()
endif()

# --- sherpa-onnx (diarization) — vendored as a git submodule; built + linked when present ---
#   git submodule add https://github.com/k2-fsa/sherpa-onnx cpp/third_party/sherpa-onnx
set(SHERPA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/sherpa-onnx)
if(EXISTS ${SHERPA_DIR}/CMakeLists.txt)
  # -------------------------------------------------------------------------
  # ONNX Runtime for sherpa-onnx.
  #
  # sherpa's own download_onnxruntime() FATAL_ERRORs on Android ("Only support Linux, macOS and
  # Windows"), so its pre-installed path is the only way in. It reads two ENVIRONMENT variables
  # at configure time, hence set(ENV{...}) rather than plain cache variables.
  #
  # We point it at the SAME runtime the app already ships — the libonnxruntime.so inside the
  # com.microsoft.onnxruntime:onnxruntime-android AAR that Gradle packages into the APK. Letting
  # sherpa fetch its own would put two different ORT builds in one process: duplicate symbols,
  # two sets of globals, and a large wasted download. The headers are the ones already vendored
  # under third_party/onnxruntime/include for the Silero VAD path.
  # -------------------------------------------------------------------------
  set(ORT_AAR_SO "" CACHE FILEPATH "libonnxruntime.so extracted from the onnxruntime-android AAR")
  if(NOT ORT_AAR_SO OR NOT EXISTS "${ORT_AAR_SO}")
    message(WARNING
      "sherpa-onnx is vendored but ORT_AAR_SO was not provided, so diarization is being SKIPPED. "
      "app/build.gradle extracts it from the AAR and passes -DORT_AAR_SO=<path>.")
  else()
    get_filename_component(ORT_LIB_DIR "${ORT_AAR_SO}" DIRECTORY)
    set(ENV{SHERPA_ONNXRUNTIME_INCLUDE_DIR} "${ORT_INCLUDE}")
    set(ENV{SHERPA_ONNXRUNTIME_LIB_DIR} "${ORT_LIB_DIR}")
    set(SHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE ON CACHE BOOL "" FORCE)

    set(SHERPA_ONNX_ENABLE_C_API ON CACHE BOOL "" FORCE)
    set(SHERPA_ONNX_ENABLE_PYTHON OFF CACHE BOOL "" FORCE)
    set(SHERPA_ONNX_ENABLE_TESTS OFF CACHE BOOL "" FORCE)
    set(SHERPA_ONNX_ENABLE_PORTAUDIO OFF CACHE BOOL "" FORCE)
    set(SHERPA_ONNX_ENABLE_BINARY OFF CACHE BOOL "" FORCE)
    set(SHERPA_ONNX_ENABLE_WEBSOCKET OFF CACHE BOOL "" FORCE)
    set(SHERPA_ONNX_ENABLE_JNI OFF CACHE BOOL "" FORCE)
    # We only use offline speaker diarization; leaving TTS on drags in espeak-ng and friends
    # for no benefit and a large binary cost.
    set(SHERPA_ONNX_ENABLE_TTS OFF CACHE BOOL "" FORCE)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    add_subdirectory(${SHERPA_DIR} ${CMAKE_BINARY_DIR}/sherpa_build)
    target_compile_definitions(audionotes PRIVATE HAVE_SHERPA=1)
    target_include_directories(audionotes PRIVATE ${SHERPA_DIR})
    target_link_libraries(audionotes sherpa-onnx-c-api)
    audionotes_optimize_engine(sherpa-onnx-core)
  endif()
endif()

find_library(log-lib log)

# dl for dlopen(libonnxruntime.so); log for Android logging.
target_link_libraries(audionotes
  ${log-lib}
  ${CMAKE_DL_LIBS})
