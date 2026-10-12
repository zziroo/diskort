package expo.modules.noisefilter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** DPDFNet'in zaman bütçesi kararları (saha verisiyle; model ayrı iş parçacığında, 30 ms tampon). */
class DpdfnetBudgetTest {
  @Test
  fun warmUpOnlyRejectsHopelessPhones() {
    // Sahada standarda düşen telefonların çoğu: ısınma ~5 ms (eski sınır 3,1) → artık canlıda denenir
    assertNull(DpdfnetBudget.judgeWarmUp(avgMs = 5.0, spikeMs = 6.5, firstMs = 7.0))
    // SM7550: ısınma 4,00 ms → denenir
    assertNull(DpdfnetBudget.judgeWarmUp(avgMs = 4.0, spikeMs = 4.6, firstMs = 5.0))
    // Güçlü telefon: rahat geçer
    assertNull(DpdfnetBudget.judgeWarmUp(avgMs = 2.0, spikeMs = 2.8, firstMs = 3.5))
    // Sınır: ısınma × iyimser oran canlı bütçeye sığmalı (7,5 / 1,35 ≈ 5,56)
    assertNull(DpdfnetBudget.judgeWarmUp(avgMs = 5.5, spikeMs = 6.0, firstMs = 6.0))
    val slow = DpdfnetBudget.judgeWarmUp(avgMs = 5.6, spikeMs = 6.0, firstMs = 6.0)
    assertNotNull(slow)
    assertTrue(slow!!.systematic)
    assertTrue(DpdfnetBudget.WARMUP_BUDGET_MS * DpdfnetBudget.LIVE_FACTOR <= DpdfnetBudget.LIVE_BUDGET_MS + 1e-9)
    // Kayıt yalnızca ısınma canlı bütçeyi bile aşınca
    assertFalse(DpdfnetBudget.rememberWarmUp(5.6))
    assertFalse(DpdfnetBudget.rememberWarmUp(7.5))
    assertTrue(DpdfnetBudget.rememberWarmUp(7.6))
  }

  @Test
  fun warmUpSpikesAreNotSystematic() {
    // Ortalama iyi ama ikinci en uzun kare 10 ms'yi aşıyor ya da soğukken ilk yarı yetişmiyor: ani takılma
    assertNull(DpdfnetBudget.judgeWarmUp(avgMs = 2.0, spikeMs = 9.5, firstMs = 9.5))
    val spike = DpdfnetBudget.judgeWarmUp(avgMs = 2.0, spikeMs = 10.5, firstMs = 3.0)
    assertNotNull(spike)
    assertFalse(spike!!.systematic)
    val cold = DpdfnetBudget.judgeWarmUp(avgMs = 2.0, spikeMs = 3.0, firstMs = 10.5)
    assertNotNull(cold)
    assertFalse(cold!!.systematic)
  }

  @Test
  fun liveWindowBypassesOnAverageOrLateHops() {
    // Eski sınırda (5 ms) düşenler: 5,1 ve SM7550'nin 6,28 ms'si artık yetişiyor
    assertNull(DpdfnetBudget.judgeWindow(avgMs = 5.1, late = 0, frames = 200))
    assertNull(DpdfnetBudget.judgeWindow(avgMs = 6.28, late = 0, frames = 200))
    assertNull(DpdfnetBudget.judgeWindow(avgMs = 7.5, late = 0, frames = 200))
    // Ortalama 10 ms'ye çok yakın: genel yavaşlık
    val slow = DpdfnetBudget.judgeWindow(avgMs = 7.6, late = 0, frames = 200)
    assertNotNull(slow)
    assertTrue(slow!!.systematic)
    assertTrue(slow.reason.startsWith("yavaş: kare başına "))
    // 200 karede 4 geç kare (%2): tolere edilir; 5 kare: yetişemedi (ani takılma)
    assertNull(DpdfnetBudget.judgeWindow(avgMs = 3.0, late = 4, frames = 200))
    val misses = DpdfnetBudget.judgeWindow(avgMs = 3.0, late = 5, frames = 200)
    assertNotNull(misses)
    assertFalse(misses!!.systematic)
    assertTrue(misses.reason.startsWith("yetişemedi: "))
    // Boş pencere
    assertNull(DpdfnetBudget.judgeWindow(avgMs = 0.0, late = 0, frames = 0))
    assertEquals(7.5, DpdfnetBudget.LIVE_BUDGET_MS, 0.0)
    assertEquals(3, DpdfnetBudget.BUFFER_HOPS)
  }

  @Test
  fun retryBacksOffAndForgets() {
    val min = 60_000L
    assertEquals(2 * min, DpdfnetBudget.retryDelayMs(1))
    assertEquals(4 * min, DpdfnetBudget.retryDelayMs(2))
    assertEquals(8 * min, DpdfnetBudget.retryDelayMs(3))
    assertEquals(15 * min, DpdfnetBudget.retryDelayMs(4))
    assertEquals(15 * min, DpdfnetBudget.retryDelayMs(40))
    // Art arda: sayaç artar; uzun aradan sonra (1 saat) ya da ilk kez: baştan
    val t = 10_000_000L
    assertEquals(1, DpdfnetBudget.nextRetryCount(prevCount = 0, prevAt = 0L, now = t))
    assertEquals(3, DpdfnetBudget.nextRetryCount(prevCount = 2, prevAt = t - 10 * min, now = t))
    assertEquals(1, DpdfnetBudget.nextRetryCount(prevCount = 2, prevAt = t - 61 * min, now = t))
  }
}
