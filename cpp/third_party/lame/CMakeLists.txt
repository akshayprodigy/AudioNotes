# LAME 3.100 (https://lame.sourceforge.io), LGPL-2.0-or-later — see COPYING.
#
# Built as a SEPARATE SHARED LIBRARY, libmp3lame.so, on purpose and never as a static archive: the
# LGPL lets a person replace the library with their own build, and a shared object in the APK is
# the way that stays true. The app's own code reaches it only through libverbale_mp3.so (a thin JNI
# shim, see android/app/src/main/mp3/mp3_jni.cpp) linked against it dynamically.
#
# Vendored unmodified from lame-3.100.tar.gz (sha256 ddfe36ca…da1e). The decoder (mpglib), the
# frontend and the x86 assembler are not copied: the app only encodes.
cmake_minimum_required(VERSION 3.22.1)
project(lame C)

file(GLOB LAME_SRC ${CMAKE_CURRENT_LIST_DIR}/libmp3lame/*.c)

add_library(mp3lame SHARED ${LAME_SRC})
target_include_directories(mp3lame
  PUBLIC ${CMAKE_CURRENT_LIST_DIR}/include
  PRIVATE ${CMAKE_CURRENT_LIST_DIR}/libmp3lame)
# What ./configure would have put in config.h, for a modern libc. Encoder only: no HAVE_MPGLIB, no
# analyser, no SSE intrinsics. ieee754_float32_t is the one type configure defines for it.
target_compile_definitions(mp3lame PRIVATE STDC_HEADERS=1 HAVE_STDINT_H=1 HAVE_LIMITS_H=1 ieee754_float32_t=float)
target_compile_options(mp3lame PRIVATE -w -O2)
# Hide everything but the lame_* API, so a replacement build only has to honour lame.h.
set_target_properties(mp3lame PROPERTIES C_VISIBILITY_PRESET default)
