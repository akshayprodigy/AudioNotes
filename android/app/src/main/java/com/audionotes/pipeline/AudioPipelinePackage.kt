package com.audionotes.pipeline

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the AudioNotes native modules. ModelManager / FileExport follow the same pattern
 * and get added here as they are built (milestones 2 and 6).
 */
class AudioPipelinePackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(
      AudioPipelineModule(ctx),
      StorageModule(ctx),
      ModelManagerModule(ctx),
      LlmModule(ctx),
      FileExportModule(ctx),
      OverlayModule(ctx),
    )

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
