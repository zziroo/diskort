package expo.modules.noisefilter

import android.content.Context
import android.os.Build
import android.os.PerformanceHintManager

/**
 * Android'in başarım ipucu (ADPF, PerformanceHintManager; Android 12+) ile bir iş parçacığının kare başına
 * hedef süresini sisteme bildirir. Varsayılan zamanlayıcı (EAS + schedutil) 10 ms'de bir gelen işi, kareyi
 * dönemin ~%80'inde bitirecek kadar düşük frekansta ya da küçük çekirdekte çalıştırmaya çalışır; model
 * süresi böylece gereksizce uzar ve bütçeyi aşabilir. İpucuyla sistem, gerçekleşen süreleri görüp
 * hedefi tutturacak kadar frekansı yükseltir / işi büyük çekirdeğe taşır. Desteklenmiyorsa hiçbir şey yapmaz.
 *
 * İş parçacığı güvenli değildir: tek bir iş parçacığından (ölçülen iş parçacığı) kullanılmalı.
 */
class PerfHint private constructor(private val session: Any?) : AutoCloseable {
  val active: Boolean get() = session != null

  /** Bir karenin gerçekleşen süresi (ns) */
  fun report(ns: Long) {
    if (session == null || ns <= 0 || Build.VERSION.SDK_INT < 31) return
    try {
      (session as PerformanceHintManager.Session).reportActualWorkDuration(ns)
    } catch (_: Throwable) {
      // ipucu yalnızca yardımcı: hata sesi etkilemesin
    }
  }

  override fun close() {
    if (session == null || Build.VERSION.SDK_INT < 31) return
    try {
      (session as PerformanceHintManager.Session).close()
    } catch (_: Throwable) {
    }
  }

  companion object {
    /**
     * Kare başına hedef süre: canlı bütçenin (DpdfnetBudget.LIVE_BUDGET_MS, 7,5 ms) epey altında pay bırakır.
     * Sistem ancak süre hedefi aşınca hızlandırır; hedef bütçeye eşit olsaydı kareler sınırda kalırdı ve
     * tampon payı (30 ms) ani sıçramalar yerine sürekli gecikmeye harcanırdı.
     */
    const val TARGET_NS = 4_000_000L

    @Volatile
    var context: Context? = null

    val NONE = PerfHint(null)

    /** Çağıran iş parçacığı için oturum açar (bir Binder çağrısı); desteklenmiyorsa NONE */
    fun forCurrentThread(): PerfHint {
      if (Build.VERSION.SDK_INT < 31) return NONE
      return try {
        val manager = context?.getSystemService(PerformanceHintManager::class.java) ?: return NONE
        val session = manager.createHintSession(intArrayOf(android.os.Process.myTid()), TARGET_NS) ?: return NONE
        PerfHint(session)
      } catch (_: Throwable) {
        NONE
      }
    }
  }
}
