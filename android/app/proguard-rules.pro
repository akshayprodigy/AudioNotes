# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# cpp/jni/audionotes_jni.cpp looks up this callback by literal name —
# env->GetMethodID(cls, "onProgress", "(II)Z") — to report native-pipeline progress back into
# Kotlin. R8 renaming the method (on the interface or on the lambda class NativeBridge.kt's
# StageProgress { ... } compiles to) would make that lookup fail silently at runtime, since the
# native side has no way to know the new name. Keeping the interface member is enough: R8 keeps
# every class's override of a kept interface method too, to preserve virtual dispatch.
-keepclassmembers interface com.innocorelabs.verbale.pipeline.NativeBridge$StageProgress {
    boolean onProgress(int, int);
}
