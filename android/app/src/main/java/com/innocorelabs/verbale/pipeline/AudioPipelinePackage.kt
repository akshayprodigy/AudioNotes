package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.billing.BillingModule
import com.innocorelabs.verbale.billing.LicenceModule
import com.innocorelabs.verbale.data.BackupModule
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the Verbale native modules. ModelManager / FileExport follow the same pattern
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
      PlayerModule(ctx),
      ImportModule(ctx),
      PipModule(ctx),
      LicenceModule(ctx),
      BillingModule(ctx),
      BackupModule(ctx),
    )

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
