# App-level JNI build for AudioNotes (React Native New Architecture).
#
# This is the app's single externalNativeBuild entry point. It MUST build
# `libappmodules.so` — the RN New-Arch registration library that wires up all
# TurboModules (incl. PlatformConstants), Fabric components and the autolinked
# libraries, and installs the JSI runtime globals. Without it the JS runtime
# comes up with no native bindings ("Global was not installed" / PlatformConstants
# not found) and the app renders a blank screen.
#
# We also build our own shared C++ inference core (`libaudionotes.so`) here, so a
# single app CMake target produces both libraries. (AGP only allows one
# externalNativeBuild.cmake.path per module, so both must hang off this file.)
cmake_minimum_required(VERSION 3.22.1)
project(appmodules)

# libappmodules.so — provided by React Native. REACT_ANDROID_DIR is passed in by
# the React Native Gradle plugin. This pulls in default-app-setup/OnLoad.cpp, the
# generated autolinking.cpp, and links jsi/fabric/reactnative/fbjni + autolinked libs.
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# libaudionotes.so — the platform-agnostic inference core (Silero VAD via dlopen'd
# onnxruntime now; whisper/sherpa/llama when vendored). Loaded lazily by NativeBridge.
# PROJECT_ROOT_DIR is <project>/android, so ../cpp is the shared core.
add_subdirectory(${PROJECT_ROOT_DIR}/../cpp ${CMAKE_BINARY_DIR}/audionotes)
