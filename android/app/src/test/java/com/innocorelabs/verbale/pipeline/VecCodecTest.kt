package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Vectors as bytes. The defects it guards: a scale that is dropped (every score a tiny
 * fraction), a sign lost (cosines folded), and a reader that starts at the wrong offset.
 */
class VecCodecTest {
  private fun unit(seed: Long): FloatArray {
    val rnd = java.util.Random(seed)
    val v = FloatArray(384) { rnd.nextGaussian().toFloat() }
    val n = Math.sqrt(v.sumOf { (it * it).toDouble() }).toFloat()
    for (i in v.indices) v[i] /= n
    return v
  }

  @Test fun roundTripsAUnitVectorToWithinTwoHundredths() {
    val v = unit(7)
    val blob = VecCodec.encode(v)
    assertEquals(384 + 4, blob.size)
    val cos = VecCodec.dot(v, blob)
    assertTrue("cosine with itself was $cos", cos > 0.98f && cos <= 1.001f)
  }

  @Test fun orthogonalVectorsScoreNearZeroAndOppositeOnesNearMinusOne() {
    val a = FloatArray(384).also { it[0] = 1f }
    val b = FloatArray(384).also { it[1] = 1f }
    assertEquals(0f, VecCodec.dot(a, VecCodec.encode(b)), 1e-3f)
    val neg = FloatArray(384).also { it[0] = -1f }
    assertEquals(-1f, VecCodec.dot(a, VecCodec.encode(neg)), 1e-2f)
  }

  @Test fun theOrderOfTwoDifferentVectorsIsPreserved() {
    val q = unit(1); val near = unit(1); val far = unit(2)
    // near is q itself; far is independent — after quantisation the order must hold
    assertTrue(VecCodec.dot(q, VecCodec.encode(near)) > VecCodec.dot(q, VecCodec.encode(far)) + 0.5f)
  }

  @Test fun aZeroVectorEncodesAndScoresZero() {
    val z = FloatArray(384)
    assertEquals(0f, VecCodec.dot(unit(3), VecCodec.encode(z)), 0f)
  }
}
