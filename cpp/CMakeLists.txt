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
  vad/silero_vad.cpp
  asr/whisper_asr.cpp
  diar/diarizer.cpp
  llm/llama_engine.cpp
  jni/audionotes_jni.cpp)

target_include_directories(audionotes PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${ORT_INCLUDE})

# --- whisper.cpp (ASR) — vendored as a git submodule; built + linked when present ---
#   git submodule add https://github.com/ggerganov/whisper.cpp cpp/third_party/whisper.cpp
set(WHISPER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/whisper.cpp)
if(EXISTS ${WHISPER_DIR}/CMakeLists.txt)
  set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  add_subdirectory(${WHISPER_DIR} ${CMAKE_BINARY_DIR}/whisper_build)
  target_compile_definitions(audionotes PRIVATE HAVE_WHISPER=1)
  target_link_libraries(audionotes whisper)
endif()

# --- sherpa-onnx (diarization) — vendored as a git submodule; built + linked when present ---
#   git submodule add https://github.com/k2-fsa/sherpa-onnx cpp/third_party/sherpa-onnx
set(SHERPA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/sherpa-onnx)
if(EXISTS ${SHERPA_DIR}/CMakeLists.txt)
  set(SHERPA_ONNX_ENABLE_C_API ON CACHE BOOL "" FORCE)
  set(SHERPA_ONNX_ENABLE_PYTHON OFF CACHE BOOL "" FORCE)
  set(SHERPA_ONNX_ENABLE_TESTS OFF CACHE BOOL "" FORCE)
  set(SHERPA_ONNX_ENABLE_PORTAUDIO OFF CACHE BOOL "" FORCE)
  set(SHERPA_ONNX_ENABLE_BINARY OFF CACHE BOOL "" FORCE)
  set(SHERPA_ONNX_ENABLE_WEBSOCKET OFF CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  add_subdirectory(${SHERPA_DIR} ${CMAKE_BINARY_DIR}/sherpa_build)
  target_compile_definitions(audionotes PRIVATE HAVE_SHERPA=1)
  target_include_directories(audionotes PRIVATE ${SHERPA_DIR})
  target_link_libraries(audionotes sherpa-onnx-c-api)
endif()

# --- llama.cpp (LLM) — vendored as a git submodule; built + linked when present ---
#   git submodule add https://github.com/ggerganov/llama.cpp cpp/third_party/llama.cpp
set(LLAMA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp)
if(EXISTS ${LLAMA_DIR}/CMakeLists.txt)
  set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
  add_subdirectory(${LLAMA_DIR} ${CMAKE_BINARY_DIR}/llama_build)
  target_compile_definitions(audionotes PRIVATE HAVE_LLAMA=1)
  target_link_libraries(audionotes llama)
endif()

find_library(log-lib log)

# dl for dlopen(libonnxruntime.so); log for Android logging.
target_link_libraries(audionotes
  ${log-lib}
  ${CMAKE_DL_LIBS})
