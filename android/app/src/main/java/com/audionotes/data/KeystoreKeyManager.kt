package com.audionotes.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.ByteBuffer
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Owns the SQLCipher passphrase. A random 256-bit passphrase is generated once, wrapped by
 * a non-exportable AES key held in the Android Keystore (hardware-backed where available),
 * and the wrapped blob is stored in private prefs. The raw passphrase never leaves the process
 * and is never persisted in the clear.
 */
object KeystoreKeyManager {
  private const val ANDROID_KEYSTORE = "AndroidKeyStore"
  private const val KEY_ALIAS = "audionotes_db_master"
  private const val PREFS = "audionotes_secure"
  private const val PREF_PASS = "db_pass_v1"
  private const val GCM_TAG_BITS = 128

  /** Returns the DB passphrase, generating + wrapping it on first call. */
  fun getOrCreatePassphrase(context: Context): ByteArray {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    prefs.getString(PREF_PASS, null)?.let {
      return decrypt(Base64.decode(it, Base64.NO_WRAP))
    }
    val pass = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val wrapped = encrypt(pass)
    prefs.edit().putString(PREF_PASS, Base64.encodeToString(wrapped, Base64.NO_WRAP)).apply()
    return pass
  }

  private fun secretKey(): SecretKey {
    val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  // Layout: [ivLen: 1 byte][iv][ciphertext+tag]
  private fun encrypt(plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val iv = cipher.iv
    val ct = cipher.doFinal(plain)
    return ByteBuffer.allocate(1 + iv.size + ct.size)
      .put(iv.size.toByte())
      .put(iv)
      .put(ct)
      .array()
  }

  private fun decrypt(blob: ByteArray): ByteArray {
    val bb = ByteBuffer.wrap(blob)
    val ivLen = bb.get().toInt()
    val iv = ByteArray(ivLen).also { bb.get(it) }
    val ct = ByteArray(bb.remaining()).also { bb.get(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
    return cipher.doFinal(ct)
  }
}
