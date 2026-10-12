package expo.modules.noisefilter

import android.content.Context
import android.os.Build
import android.os.PowerManager

/**
 * DPDFNet'in bu telefonda yetişemediğinin süreli kaydı: REMEMBER_TTL_MS (12 saat) boyunca sonraki katılışlarda
 * ve uygulama açılışlarında model hiç yüklenmeden doğrudan WebRTC'nin standart gürültü engellemesine geçilir
 * (her seferinde yeniden denenmez); süre dolunca bir kez daha denenir. Kayıt telefon modeline ve yüklü APK'ya
 * bağlıdır (sürüm kodu + kurulum anı): yeni APK kurulunca (model ya da ayarlar değişmiş olabilir) hemen
 * yeniden denenir.
 *
 * Ne zaman kaydedilir:
 * - Canlıda yetişemedi (oturumda hemen kapatılır): 24 saat içinde art arda ikinci kez olursa. Arada sağlıklı
 *   geçen bir oturum sayacı sıfırlar (clearStrikes).
 * - Isınma ortalaması canlı bütçeyi bile aştı: hemen (DpdfnetBudget.rememberWarmUp).
 * Telefon pil tasarrufundaysa, biraz bile ısınmışsa ya da yayın izleniyor/paylaşılıyorsa (işlemci başka işle
 * meşgul ya da kısılmış) yavaşlık geçici sayılır, hiçbir şey yazılmaz.
 */
internal class SlowMemory(private val app: Context) {
  private val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** Bu telefon + bu APK (+ model ve kural sürümü) */
  private val identity: String by lazy {
    "${Build.MANUFACTURER} ${Build.MODEL}|${apkVersion()}|$RULES"
  }

  /**
   * Kayıtlı neden (bu telefonda ve bu APK'da yetişemedi) ve kaydın bitmesine kalan süre (ms); kayıt yoksa ya da
   * süresi dolduysa null. Saat geri alınmışsa (kayıt gelecekte) kayıt geçersiz sayılır.
   */
  fun recall(now: Long = System.currentTimeMillis()): Pair<String, Long>? =
    try {
      if (prefs.getString(KEY_ID, null) != identity) {
        null
      } else {
        val reason = prefs.getString(KEY_REASON, null)
        val left = REMEMBER_TTL_MS - (now - prefs.getLong(KEY_AT, 0L))
        if (reason == null || left <= 0 || left > REMEMBER_TTL_MS) null else reason to left
      }
    } catch (_: Throwable) {
      null
    }

  /** Hemen kayıt (ısınma canlı bütçeyi aştı; REMEMBER_TTL_MS boyunca). Kaydedildiyse true. */
  fun remember(reason: String, videoActive: Boolean, now: Long = System.currentTimeMillis()): Boolean =
    try {
      if (transient(videoActive)) {
        false
      } else {
        prefs.edit().putString(KEY_ID, identity).putString(KEY_REASON, reason).putLong(KEY_AT, now).apply()
        true
      }
    } catch (_: Throwable) {
      false
    }

  /** Canlıda yetişemedi: STRIKE_TTL_MS içinde ikinci kezse kayıt (REMEMBER_TTL_MS boyunca; true döner) */
  fun strike(reason: String, videoActive: Boolean, now: Long = System.currentTimeMillis()): Boolean =
    try {
      if (transient(videoActive)) {
        false
      } else {
        val same = prefs.getString(KEY_ID, null) == identity
        val last = if (same) prefs.getLong(KEY_STRIKE_AT, 0L) else 0L
        val fresh = same && now - last in 0..STRIKE_TTL_MS
        val strikes = (if (fresh) prefs.getInt(KEY_STRIKES, 0) else 0) + 1
        val remember = strikes >= 2
        val edit = prefs.edit().putString(KEY_ID, identity).putInt(KEY_STRIKES, strikes).putLong(KEY_STRIKE_AT, now)
        if (remember) edit.putString(KEY_REASON, reason).putLong(KEY_AT, now) else if (!same) edit.remove(KEY_REASON)
        edit.apply()
        remember
      }
    } catch (_: Throwable) {
      false
    }

  /** Sağlıklı geçen oturum: önceki yetişemedi sayılmaz (art arda değil) */
  fun clearStrikes() {
    try {
      if (prefs.getString(KEY_ID, null) == identity && prefs.contains(KEY_STRIKES)) {
        prefs.edit().remove(KEY_STRIKES).remove(KEY_STRIKE_AT).apply()
      }
    } catch (_: Throwable) {
    }
  }

  /** Yayın, pil tasarrufu ya da ısınma: ölçüm telefonun gerçek hızını göstermez */
  private fun transient(videoActive: Boolean): Boolean {
    if (videoActive) return true
    val power = app.getSystemService(Context.POWER_SERVICE) as? PowerManager
    if (power?.isPowerSaveMode == true) return true
    return Thermal.status(app) >= Thermal.LIGHT
  }

  @Suppress("DEPRECATION")
  private fun apkVersion(): String =
    try {
      val info = app.packageManager.getPackageInfo(app.packageName, 0)
      val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
      "${info.versionName} ($code) ${info.lastUpdateTime}"
    } catch (_: Throwable) {
      ""
    }

  companion object {
    private const val PREFS = "diskort_dpdfnet"
    private const val KEY_ID = "slowId"
    private const val KEY_REASON = "slowReason"
    private const val KEY_STRIKES = "slowStrikes"
    private const val KEY_STRIKE_AT = "slowStrikeAt"
    private const val KEY_AT = "slowAt"

    /** Yetişemedi sayacı bu kadar süre sonra unutulur (eskiden 7 gün) */
    private const val STRIKE_TTL_MS = 24L * 3600 * 1000

    /** Kayıt bu kadar süre geçerli (eskiden yeni APK'ya kadar): sonra telefon yeniden denenir */
    const val REMEMBER_TTL_MS = 12L * 3600 * 1000

    /**
     * Karar kuralları değişince eski kayıtlar geçersiz olsun (sürüm kodu değişmese de). 3: model ayrı iş
     * parçacığında, 30 ms tampon, gevşek eşikler; eski "yavaş" kayıtları bu kurallarla bir kez daha denenir.
     */
    private const val RULES = "dpdfnet2_48khz_hr_int8/3"
  }
}
