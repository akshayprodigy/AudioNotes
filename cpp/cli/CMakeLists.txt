# Desktop host build for the AudioNotes core CLI (Phase 1a bring-up).
# Separate from the Android build (../CMakeLists.txt, which builds libaudionotes.so + JNI).
# This target excludes the JNI layer and links the vendored engines for the host toolchain.
#
# Milestone order (layered to de-risk): ASR (whisper, no ORT) -> +VAD -> +diarize -> +LLM -> orchestrator.
# Current milestone: ASR + VAD.
cmake_minimum_required(VERSION 3.22)
project(audionotes_cli CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

get_filename_component(CORE ${CMAKE_CURRENT_SOURCE_DIR}/.. ABSOLUTE)
set(TP ${CORE}/third_party)

# --- ONNX Runtime (Silero VAD now; sherpa-onnx diarization next) ---
# Pinned to the SAME version the Android app ships (app/build.gradle ext.ortVersion), so every
# platform runs one ORT. The vendored headers under third_party/onnxruntime/include (API 19)
# predate 1.20 and remain compatible. Nothing links ORT at build time for VAD — the core dlopens
# it at runtime (util/ort_init.cpp); we fetch the official release dylib once into cli/ort/ and
# bake its path into the binary as the AUDIONOTES_ORT_LIB default (env var still wins).
set(ORT_VERSION 1.20.0)
if(APPLE AND CMAKE_HOST_SYSTEM_PROCESSOR STREQUAL "arm64")
  set(ORT_PKG onnxruntime-osx-arm64-${ORT_VERSION})
  set(ORT_SHA256 2bcfaafa9ff0a3a94f78e3af2f135ffde5bb2d79b08e83a50dbc450b0d20ddae)
  set(ORT_DYLIB_NAME libonnxruntime.${ORT_VERSION}.dylib)
endif()
if(ORT_PKG)
  set(ORT_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/ort/${ORT_PKG})
  if(NOT EXISTS ${ORT_ROOT}/lib/${ORT_DYLIB_NAME})
    set(ORT_TGZ ${CMAKE_CURRENT_SOURCE_DIR}/ort/${ORT_PKG}.tgz)
    file(DOWNLOAD
      https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/${ORT_PKG}.tgz
      ${ORT_TGZ} EXPECTED_HASH SHA256=${ORT_SHA256} SHOW_PROGRESS)
    file(ARCHIVE_EXTRACT INPUT ${ORT_TGZ} DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/ort)
  endif()
  set(ORT_LIB ${ORT_ROOT}/lib/${ORT_DYLIB_NAME})
else()
  message(WARNING
    "No pinned ONNX Runtime artifact for this host; VAD/diarization need AUDIONOTES_ORT_LIB "
    "pointing at a libonnxruntime shared library at runtime.")
endif()

# --- whisper.cpp (ASR) : builds ggml + whisper static libs for the host ---
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
add_subdirectory(${TP}/whisper.cpp ${CMAKE_BINARY_DIR}/whisper EXCLUDE_FROM_ALL)

add_executable(audionotes_cli
  main.cpp
  ${CORE}/asr/whisper_asr.cpp
  ${CORE}/util/ort_init.cpp
  ${CORE}/vad/silero_vad.cpp)

target_include_directories(audionotes_cli PRIVATE
  ${CORE}
  ${TP}/onnxruntime/include
  ${TP}/whisper.cpp/include
  ${TP}/whisper.cpp/ggml/include)

target_compile_definitions(audionotes_cli PRIVATE HAVE_WHISPER)
if(ORT_LIB)
  target_compile_definitions(audionotes_cli PRIVATE AUDIONOTES_ORT_LIB_DEFAULT="${ORT_LIB}")
endif()
target_link_libraries(audionotes_cli PRIVATE whisper ${CMAKE_DL_LIBS})
