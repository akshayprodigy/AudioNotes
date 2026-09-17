package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.random.Random

/** decode is the inverse of encode: same little-endian, scale-first layout dot already reads. */
class VecCodecTest {
  private fun plainDot(a: FloatArray, b: FloatArray): Float {
    var s = 0f
    val n = minOf(a.size, b.size)
    for (i in 0 until n) s += a[i] * b[i]
    return s
  }

  private fun scaleOf(v: FloatArray): Float {
    var max = 0f
    for (x in v) if (abs(x) > max) max = abs(x)
    return if (max > 0f) max / 127f else 1f
  }

  @Test fun decodeOfEncodeIsWithinScaleElementwise() {
    val rnd = Random(42)
    val v = FloatArray(384) { rnd.nextFloat() * 2f - 1f }
    val scale = scaleOf(v)
    val decoded = VecCodec.decode(VecCodec.encode(v))
    assertEquals(v.size, decoded.size)
    for (i in v.indices) assertTrue(abs(decoded[i] - v[i]) <= scale + 1e-6f)
  }

  @Test fun dotOfEncodedEqualsPlainDotOfDecodedWithin1en3() {
    val rnd = Random(7)
    val v = FloatArray(384) { rnd.nextFloat() * 2f - 1f }
    val q = FloatArray(384) { rnd.nextFloat() * 2f - 1f }
    val blob = VecCodec.encode(v)
    val viaBlob = VecCodec.dot(q, blob)
    val viaDecode = plainDot(q, VecCodec.decode(blob))
    assertTrue(abs(viaBlob - viaDecode) < 1e-3f)
  }
}
