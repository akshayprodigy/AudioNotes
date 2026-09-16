package com.innocorelabs.verbale

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Verbale native modules (TurboModules) — the seam to the C++ inference core.
          add(com.innocorelabs.verbale.pipeline.AudioPipelinePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }

  /**
   * The embedding model is the one native handle kept resident between uses (EmbedRuntime); it
   * is the first thing to give back when the system asks. The writer is never resident outside
   * a narration or an open Ask screen, so there is nothing else to drop here.
   */
  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    if (level >= TRIM_MEMORY_RUNNING_LOW) com.innocorelabs.verbale.pipeline.EmbedRuntime.release()
  }
}
