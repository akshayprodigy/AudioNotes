# Desktop host build for the AudioNotes core CLI (Phase 1a bring-up).
# Separate from the Android build (../CMakeLists.txt, which builds libaudionotes.so + JNI).
# This target excludes the JNI layer and links the vendored engines for the host toolchain.
#
# Milestone order (layered to de-risk): ASR (whisper, no ORT) -> +VAD -> +diarize -> +LLM -> orchestrator.
# Current milestone: ASR only.
cmake_minimum_required(VERSION 3.22)
project(audionotes_cli CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

get_filename_component(CORE ${CMAKE_CURRENT_SOURCE_DIR}/.. ABSOLUTE)
set(TP ${CORE}/third_party)

# --- whisper.cpp (ASR) : builds ggml + whisper static libs for the host ---
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
add_subdirectory(${TP}/whisper.cpp ${CMAKE_BINARY_DIR}/whisper EXCLUDE_FROM_ALL)

add_executable(audionotes_cli
  main.cpp
  ${CORE}/asr/whisper_asr.cpp)

target_include_directories(audionotes_cli PRIVATE
  ${CORE}
  ${TP}/whisper.cpp/include
  ${TP}/whisper.cpp/ggml/include)

target_compile_definitions(audionotes_cli PRIVATE HAVE_WHISPER)
target_link_libraries(audionotes_cli PRIVATE whisper)
