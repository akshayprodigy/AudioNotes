package com.innocorelabs.verbale.pipeline

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A unit vector as 384 signed bytes and one float scale: `x ≈ q * scale`.
 *
 * Four times smaller than floats, and the whole library's vectors scan in Kotlin in tens of
 * milliseconds; the ranking loses nothing a person could see (a vector's cosine with its own
 * quantised self is above 0.98). Little-endian, scale first, so the blob is self-describing to
 * anything that reads the table.
 */
object VecCodec {
  fun encode(v: FloatArray): ByteArray {
    var max = 0f
    for (x in v) if (Math.abs(x) > max) max = Math.abs(x)
    val scale = if (max > 0f) max / 127f else 1f
    val buf = ByteBuffer.allocate(4 + v.size).order(ByteOrder.LITTLE_ENDIAN)
    buf.putFloat(scale)
    for (x in v) buf.put(Math.round(x / scale).coerceIn(-127, 127).toByte())
    return buf.array()
  }

  /** `q · blob` — a cosine when both are unit vectors. */
  fun dot(q: FloatArray, blob: ByteArray): Float {
    if (blob.size < 4) return 0f
    val buf = ByteBuffer.wrap(blob).order(ByteOrder.LITTLE_ENDIAN)
    val scale = buf.getFloat(0)
    var s = 0f
    val n = minOf(q.size, blob.size - 4)
    for (i in 0 until n) s += q[i] * blob[4 + i]
    return s * scale
  }

  /**
   * The inverse of [encode]: the same little-endian, scale-first layout [dot] already reads,
   * turned back into floats so two stored vectors can be compared (Phase 3, thread memory).
   */
  fun decode(blob: ByteArray): FloatArray {
    if (blob.size < 4) return FloatArray(0)
    val buf = ByteBuffer.wrap(blob).order(ByteOrder.LITTLE_ENDIAN)
    val scale = buf.getFloat(0)
    val n = blob.size - 4
    return FloatArray(n) { i -> blob[4 + i] * scale }
  }
}
