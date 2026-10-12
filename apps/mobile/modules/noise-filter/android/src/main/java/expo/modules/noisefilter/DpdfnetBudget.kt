package expo.modules.noisefilter

/**
 * DPDFNet'in zaman bütçesi: telefon modeli gerçek zamanda, sesi bozmadan çalıştırabilir mi (saf; Android'e
 * bağlı değil, JVM testi: DpdfnetBudgetTest).
 *
 * Model kendi iş parçacığında, ses yakalama iş parçacığının BUFFER_HOPS kare (30 ms) gerisinden çalışır
 * (DpdfnetProcessor): tek tük uzun kareler bu payda erir, sesi kesmez. Esnetilemeyen tek sınır gerçek zaman:
 * ortalama kare süresi 10 ms'yi aşarsa iş sürekli birikir, hiçbir tampon kurtarmaz. Bu yüzden ortalama sınırı
 * 10 ms'nin altında pay bırakır (LIVE_BUDGET_MS); tampon yalnızca sıçramaları yutar. Payı da aşan kare
 * (LATE) o 10 ms'de gürültü engellemesiz (kuru) geçer; ses kesilmez ama gürültü bir an duyulur.
 *
 * Saha verisi (eski düzen, model doğrudan ses yakalama iş parçacığındaydı, tampon yoktu): HONOR SM7550'de ısınma
 * 4,00 ms, canlıda ortalama 6,0–6,3 ms ve en uzun kare 13,3 ms ile iki yönde cızırtı; telefonların çoğu ısınmada
 * ~5 ms ile ya da canlıda 5,1 ms ile (sınır 5 ms) standarda düşüyordu, bazıları 200 karenin ~9'u 10 ms'yi aştığı
 * için. Yeni düzende ses iş parçacığı modeli beklemez; sınırlar buna göre gevşetildi.
 */
object DpdfnetBudget {
  /** Kare (hop) süresi: 48 kHz'de 480 örnek */
  const val HOP_MS = 10.0

  /**
   * Modelin ses yakalamanın kaç kare gerisinden çalıştığı (ek gecikme: 3 × 10 = 30 ms). Bir kare bu kadar
   * süre içinde bitmezse geç kalmış sayılır (kuru geçer).
   */
  const val BUFFER_HOPS = 3

  /**
   * Canlıda 2 saniyelik pencerenin ortalama kare süresi sınırı (10 ms'nin %75'i). Model artık kendi iş
   * parçacığında: WebRTC'nin kendi işleriyle aynı 10 ms'yi paylaşmıyor; kalan %25 ve 30 ms'lik tampon
   * dalgalanmayı yutar. Bu sınırın üstü 10 ms'ye o kadar yakındır ki geç kalan kareler sıklaşır.
   */
  const val LIVE_BUDGET_MS = 7.5

  /**
   * Canlı / ısınma kare süresi için iyimser tahmin. SM7550'de oran 1,5–1,6 idi (ısınmada kareler arka arkaya
   * işlenir, işlemci hızlı ve önbellek sıcak; canlıda 10 ms'de bir kısa iş). Isınma artık yalnızca umutsuz
   * telefonları eler: canlıda denemenin bedeli küçük (geç kare kuru geçer, ilk karar 4 sn'de verilir), asıl
   * kararı canlı pencere verir. Bu yüzden saha oranından düşük tutulur.
   */
  const val LIVE_FACTOR = 1.35

  /** Isınmanın (ikinci yarı) ortalama sınırı: iyimser tahminle canlı bütçeye sığmalı (7,5 / 1,35 ≈ 5,6 ms) */
  const val WARMUP_BUDGET_MS = LIVE_BUDGET_MS / LIVE_FACTOR

  /**
   * Isınmanın ikinci yarısındaki ikinci en uzun kare: 10 ms'yi aşıyorsa ani takılmalar tamponu da zorlar.
   * En uzun kare değil: tek bir kez iş parçacığı başka işe bırakıldıysa hızlı telefon elenmesin.
   */
  const val WARMUP_SPIKE_MS = 10.0

  /**
   * Isınmanın ilk yarısı (ilk kare hariç; işlemci henüz hızlanmamış, kod ısınıyor): ortalaması bile 10 ms'yi
   * aşıyorsa telefon soğukken gerçek zamana yetişemiyor.
   */
  const val WARMUP_FIRST_MS = 10.0

  /**
   * Canlıda bir pencerede geç kalan (tampon payını da aşıp kuru geçen) karelerin en fazla oranı (%).
   * 2 saniyede ~200 kare: 5 ve üstü kare yetişemedi. Eski kural %1'di ve 10 ms'yi aşan her kareyi sayıyordu;
   * tamponla 10 ms'yi aşan kare artık sesi bozmaz, yalnızca payı aşan sayılır.
   */
  const val LATE_PERCENT = 2

  /** Yetişemeyince (canlıda ya da ısınmada genel yavaşlık) ilk yeniden deneme: 2 dk sonra */
  const val RETRY_BASE_MS = 2L * 60_000

  /** Art arda yetişemedikçe bekleme ikiye katlanır (2, 4, 8, en fazla 15 dk) */
  const val RETRY_MAX_MS = 15L * 60_000

  /** Son yetişemedinin üzerinden bu kadar geçtiyse bekleme baştan (2 dk) başlar */
  const val RETRY_MEMORY_MS = 60L * 60_000

  /**
   * Yetişemedi kararı. systematic: telefon genel olarak yavaş (ortalama bütçeyi aşıyor); değilse ani
   * takılmalardır (ör. anlık başka yük). Isınmada ani takılma kararı ancak ikinci ölçümde de görülürse
   * verilir ve beklemeye alınmaz. Kalıcı kayıt: SlowMemory.
   */
  data class Miss(val reason: String, val systematic: Boolean)

  /**
   * Isınma ölçümünün kararı (ms/kare): avgMs ikinci yarının ortalaması, spikeMs ikinci yarının ikinci en uzun
   * karesi, firstMs ilk yarının ortalaması. null: yetişiyor.
   */
  fun judgeWarmUp(avgMs: Double, spikeMs: Double, firstMs: Double): Miss? {
    if (avgMs > WARMUP_BUDGET_MS) return Miss(String.format("yavaş: ısınmada kare başına %.1f ms", avgMs), true)
    if (spikeMs > WARMUP_SPIKE_MS) return Miss(String.format("yavaş: ısınmada uzun kareler (%.1f ms)", spikeMs), false)
    if (firstMs > WARMUP_FIRST_MS) {
      return Miss(String.format("yavaş: ısınmanın ilk yarısında kare başına %.1f ms", firstMs), false)
    }
    return null
  }

  /**
   * Isınma ortalaması canlı bütçeyi bile aşıyor: canlıda hiç yetişemez, bu telefonda ve bu APK'da hemen
   * kaydedilir (SlowMemory, süreli). Aradaki ısınmalar (5,6–7,5 ms) yalnızca bu açılışta beklemeye alınır.
   */
  fun rememberWarmUp(avgMs: Double): Boolean = avgMs > LIVE_BUDGET_MS

  /**
   * Canlıda bir ölçüm penceresinin kararı: ortalama bütçeyi aşıyor ya da karelerin %2'sinden fazlası geç kaldı
   * (tampon payını da aştı, kuru geçti). null: yetişiyor. Tek pencere bu oturumda kapatmaya yeter; kayıt için
   * kısa süre içinde ikinci kez olmalı (SlowMemory.strike).
   */
  fun judgeWindow(avgMs: Double, late: Int, frames: Int): Miss? {
    if (frames <= 0) return null
    if (avgMs > LIVE_BUDGET_MS) return Miss(String.format("yavaş: kare başına %.1f ms", avgMs), true)
    if (late * 100 > frames * LATE_PERCENT) {
      return Miss("yetişemedi: $frames karenin $late tanesi zamanında işlenemedi", false)
    }
    return null
  }

  /** count'uncu art arda yetişemediden sonra yeniden denemeye kadar bekleme (count ≥ 1) */
  fun retryDelayMs(count: Int): Long {
    val shift = (count - 1).coerceIn(0, 10)
    return minOf(RETRY_BASE_MS shl shift, RETRY_MAX_MS)
  }

  /** Yeni yetişemedinin sırası: öncekinin üzerinden uzun süre geçtiyse baştan */
  fun nextRetryCount(prevCount: Int, prevAt: Long, now: Long): Int =
    if (prevCount > 0 && now - prevAt in 0 until RETRY_MEMORY_MS) prevCount + 1 else 1
}
