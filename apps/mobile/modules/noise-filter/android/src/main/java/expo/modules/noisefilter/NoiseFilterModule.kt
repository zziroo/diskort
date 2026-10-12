package expo.modules.noisefilter

import android.content.Context
import android.os.Build
import android.util.Log
import com.livekit.reactnative.LiveKitReactNative
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

/**
 * DPDFNet gürültü engelleme (JS: modules/noise-filter). Model APK'nın içindedir (assets); ONNX Runtime
 * ile telefonda çalışır. Model sesli sohbete katılırken yüklenir, ayrılırken bellekten atılır.
 *
 * Telefon yetişemezse bu açılışta bir süre beklenir (2, 4, 8, en fazla 15 dk; DpdfnetBudget.retryDelayMs), JS bu
 * sürenin sonunda sesli sohbetteyken de yeniden dener (retryInMs). Canlıda 24 saat içinde iki kez yetişemediyse ya
 * da ısınma canlı bütçeyi bile aştıysa bu telefon ve bu APK için 12 saat kaydedilir (SlowMemory): o süre
 * boyunca model hiç yüklenmez. Telefonun ısı durumu da buradan okunur (getThermal); sesli sohbetteyken
 * "ciddi" ya da üstüne çıkarsa DPDFNet o oturum için kapatılır.
 */
class NoiseFilterModule : Module() {
  /** Devre dışı kalma sonrası işler (motoru kapatma, kayıt) ve ısı bildirimleri: ses iş parçacığı dışında */
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "DiskortNoiseFilter") }
  private var stopThermal: (() -> Unit)? = null
  private var memory: SlowMemory? = null

  /** Yayın izleniyor ya da paylaşılıyor (JS bildirir): o sırada yavaşlık kalıcı kaydedilmez */
  @Volatile
  private var videoActive = false

  override fun definition() = ModuleDefinition {
    Name("DiskortNoiseFilter")

    /** İşlemci kendini devre dışı bıraktı: { reason, retryInMs } (retryInMs null: yeniden denenmez) */
    Events("onBypass")

    OnCreate {
      val context = appContext.reactContext?.applicationContext
      PerfHint.context = context
      // İş parçacığı şimdi açılır: ilk bildirim ses iş parçacığında iş parçacığı oluşturmasın
      worker.execute {}
      DpdfnetProcessor.onBypass = { b ->
        // Ses iş parçacığında olabilir: iş sıraya alınır
        worker.execute { handleBypass(b) }
      }
      if (context != null) {
        stopThermal = Thermal.listen(context, worker) { status ->
          if (status >= Thermal.SEVERE) DpdfnetProcessor.bypassThermal(thermalReason(status))
        }
      }
    }

    OnDestroy {
      DpdfnetProcessor.onBypass = null
      stopThermal?.invoke()
      stopThermal = null
      worker.shutdown()
    }

    /** Bu telefonda denenebilir mi (32/64 bit ARM; emülatörde ONNX Runtime kütüphanesi paketlenmiyor) */
    Function("isSupported") {
      Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "armeabi-v7a" }
    }

    /**
     * Açar ya da kapatır. Açarken model yüklenir, hızı ölçülür ve WebRTC'ye takılır. Sonuç: durum
     * (getStats ile aynı alanlar); active false ise reason neden çalışmadığını söyler.
     */
    AsyncFunction("configure") { enabled: Boolean, attenLimitDb: Double ->
      if (!enabled) {
        // Oturum yetişerek geçtiyse (en az 2 dakika) önceki yetişemedi art arda sayılmaz
        if (DpdfnetProcessor.hasEngine() && DpdfnetProcessor.bypassReason == null &&
          DpdfnetProcessor.healthyWindows >= HEALTHY_WINDOWS
        ) {
          appContext.reactContext?.let { memoryOf(it).clearStrikes() }
          DpdfnetProcessor.clearSlowCount()
        }
        DpdfnetProcessor.setEnabled(false)
        DpdfnetProcessor.install(null)
        return@AsyncFunction status(null)
      }
      // Önceki oturumdan devre dışı kalmış motor kalmışsa atılır: aşağıdaki denetimlerden yeniden geçer
      if (DpdfnetProcessor.bypassReason != null) {
        DpdfnetProcessor.setEnabled(false)
        DpdfnetProcessor.install(null)
      }
      val context = appContext.reactContext ?: return@AsyncFunction status("uygulama bağlamı yok")
      val thermal = Thermal.status(context)
      if (thermal >= Thermal.SEVERE) {
        DpdfnetProcessor.setEnabled(false)
        DpdfnetProcessor.install(null)
        return@AsyncFunction status(thermalReason(thermal), THERMAL_RETRY_MS)
      }
      // Bu telefonda ve bu APK'da kısa süre önce yetişemedi (süreli kayıt) ya da bu açılışta yetişemedi (bekleme)
      memoryOf(context).recall()?.let { (reason, left) ->
        return@AsyncFunction status("$reason (önceki ölçüm)", left)
      }
      val slow = DpdfnetProcessor.slowReason
      DpdfnetProcessor.slowRemainingMs()?.let { left ->
        return@AsyncFunction status(slow ?: "yavaş", left)
      }
      try {
        if (!DpdfnetProcessor.hasEngine()) {
          val bytes = context.assets.open(MODEL_ASSET).use { it.readBytes() }
          var engine: DpdfnetEngine? = load(bytes, attenLimitDb, xnnpack = false)
          var warm = warmUp(engine!!)
          if (warm.judge() != null) {
            // Son şans: XNNPACK (Conv düğümleri başka çekirdeklerle). ARM64 büyük çekirdekte (Neoverse N2)
            // CPU'dan hızlı değildi, o yüzden varsayılan değil; yalnızca CPU yetişemeyen telefonda denenir.
            engine.close()
            engine = try {
              load(bytes, attenLimitDb, xnnpack = true)
            } catch (t: Throwable) {
              Log.w(TAG, "XNNPACK açılamadı", t)
              null
            }
            if (engine != null) {
              val alt = warmUp(engine)
              if (alt.judge() == null || alt.avgMs < warm.avgMs) warm = alt
              if (alt.judge() != null) {
                engine.close()
                engine = null
              }
            }
          }
          DpdfnetProcessor.warmup = warm
          if (engine == null) {
            val miss = warm.judge() ?: DpdfnetBudget.Miss("yavaş", systematic = false)
            // Genel yavaşlık bu açılışta bir süre beklemeye alınır. Ani takılma beklemeye alınmaz (sonraki katılışta
            // hemen denenir) ama sesli sohbetteyken yeniden deneme art arda oldukça seyrekleşir (noteWarmSpike);
            // canlı bütçeyi bile aşan ısınma kaydedilir
            var retry = if (miss.systematic) DpdfnetProcessor.noteSlow(miss.reason) else DpdfnetProcessor.noteWarmSpike()
            val remembered = miss.systematic && DpdfnetBudget.rememberWarmUp(warm.avgMs) &&
              memoryOf(context).remember(miss.reason, videoActive)
            if (remembered) retry = SlowMemory.REMEMBER_TTL_MS
            Log.w(TAG, "DPDFNet ısınmada yetişemedi: ${miss.reason}${if (remembered) " (kaydedildi)" else ""}")
            return@AsyncFunction status(miss.reason, retry)
          }
          DpdfnetProcessor.install(engine)
        } else {
          DpdfnetProcessor.setAttenLimit(attenLimitDb)
        }
        val controller = try {
          LiveKitReactNative.audioProcessingController
        } catch (_: IllegalStateException) {
          null
        } ?: return@AsyncFunction status("WebRTC ses işleme hazır değil")
        if (controller.capturePostProcessor !== DpdfnetProcessor) {
          controller.capturePostProcessor = DpdfnetProcessor
        }
        DpdfnetProcessor.setEnabled(true)
        status(null)
      } catch (t: Throwable) {
        Log.e(TAG, "DPDFNet yüklenemedi", t)
        DpdfnetProcessor.setEnabled(false)
        DpdfnetProcessor.install(null)
        status("yüklenemedi: ${t.message ?: t.javaClass.simpleName}")
      }
    }

    /** Bastırma sınırı (dB); 100 = sınırsız. Anında uygulanır. */
    Function("setAttenLimit") { db: Double ->
      DpdfnetProcessor.setAttenLimit(db)
    }

    /** Anlık durum ve son 2 saniyenin ölçümleri */
    Function("getStats") {
      status(null)
    }

    /** Yayın izleniyor ya da paylaşılıyor mu: o sırada yetişemeyen telefon kalıcı kaydedilmez (görüntü de işlemciyi yorar) */
    Function("setVideoActive") { active: Boolean ->
      videoActive = active
    }

    /**
     * Telefonun ısı durumu: status (PowerManager.THERMAL_STATUS_*: 0 yok … 6 kapanıyor; Android 10 öncesinde
     * -1) ve headroom (ısınma payı, 1,0 = "ciddi" eşiği; Android 11+, ölçülemezse null).
     */
    Function("getThermal") {
      val context = appContext.reactContext
      mapOf(
        "status" to (context?.let { Thermal.status(it) } ?: Thermal.UNKNOWN),
        "headroom" to context?.let { Thermal.headroom(it) },
      )
    }
  }

  @Synchronized
  private fun memoryOf(context: Context): SlowMemory =
    memory ?: SlowMemory(context.applicationContext).also { memory = it }

  /**
   * Isınma ölçümü; ortalama yetişiyor ama ani takılma varsa (ör. iş parçacığı bir kez başka işe bırakıldı)
   * karar vermeden önce bir kez daha ölçülür.
   */
  private fun warmUp(engine: DpdfnetEngine): DpdfnetProcessor.WarmUp {
    var warm = DpdfnetProcessor.warmUp(engine)
    log(warm)
    val miss = warm.judge()
    if (miss != null && !miss.systematic) {
      warm = DpdfnetProcessor.warmUp(engine)
      log(warm)
    }
    return warm
  }

  /**
   * Devre dışı kalma sonrası (iş parçacığı: worker): motor kapatılır, canlıda yetişemediyse sayılır
   * (SlowMemory), JS'e bildirilir. Bu arada ayrılıp yeniden katılındıysa (motor değişti) JS'e bildirilmez:
   * yeni oturumun motoru çalışıyor.
   */
  private fun handleBypass(b: DpdfnetProcessor.Bypass) {
    Log.w(TAG, "DPDFNet devre dışı: ${b.reason}")
    val closed = try {
      b.engine?.let { DpdfnetProcessor.unload(it) } ?: false
    } catch (t: Throwable) {
      Log.w(TAG, "DPDFNet motoru kapatılamadı", t)
      false
    }
    // Yeniden deneme: yetişemediyse bekleme süresi (işlemci noteSlow ile başlattı), ısındıysa birkaç dakika,
    // hatada hiç (null)
    var retry: Long? = when (b.kind) {
      DpdfnetProcessor.Kind.SLOW, DpdfnetProcessor.Kind.SPIKE -> DpdfnetProcessor.slowRemainingMs() ?: 0L
      DpdfnetProcessor.Kind.THERMAL -> THERMAL_RETRY_MS
      DpdfnetProcessor.Kind.ERROR -> null
    }
    if (b.kind == DpdfnetProcessor.Kind.SLOW || b.kind == DpdfnetProcessor.Kind.SPIKE) {
      try {
        val context = appContext.reactContext
        if (context != null && memoryOf(context).strike(b.reason, videoActive)) {
          retry = SlowMemory.REMEMBER_TTL_MS
          Log.w(TAG, "DPDFNet bu telefonda 12 saat kapalı kalacak (yeni APK kurulursa hemen denenir)")
        }
      } catch (t: Throwable) {
        Log.w(TAG, "DPDFNet yavaşlığı kaydedilemedi", t)
      }
    }
    if (!closed) {
      Log.i(TAG, "DPDFNet bildirimi eski oturumdan: JS'e gönderilmedi")
      return
    }
    try {
      sendEvent("onBypass", mapOf("reason" to b.reason, "retryInMs" to retry?.toDouble()))
    } catch (t: Throwable) {
      Log.w(TAG, "onBypass gönderilemedi", t)
    }
  }

  private fun thermalReason(status: Int): String =
    "telefon çok ısındı (ısı durumu ${if (status >= 4) "kritik" else "ciddi"})"

  private fun load(bytes: ByteArray, attenLimitDb: Double, xnnpack: Boolean): DpdfnetEngine {
    val start = System.nanoTime()
    val engine = DpdfnetEngine.create(bytes, attenLimitDb, xnnpack)
    Log.i(TAG, String.format("DPDFNet yüklendi (%s): %.0f ms", engine.provider, (System.nanoTime() - start) / 1e6))
    return engine
  }

  private fun log(w: DpdfnetProcessor.WarmUp) {
    Log.i(
      TAG,
      String.format(
        "DPDFNet ısınma (%s): kare başına %.2f ms (model %.2f, en uzun %.2f / %.2f, ilk yarı %.2f; çekirdek %s; ipucu %b)",
        w.provider, w.avgMs, w.modelMs, w.maxMs, w.spikeMs, w.firstMs, w.core, w.hint,
      ),
    )
  }

  /** Durum; retryInMs: çalışmıyorsa yeniden denemeye kalan süre (null: bilinmiyor ya da denenmeyecek) */
  private fun status(reason: String?, retryInMs: Long? = null): Map<String, Any?> {
    val s = DpdfnetProcessor.stats
    val w = DpdfnetProcessor.warmup
    val tid = DpdfnetProcessor.audioTid
    return mapOf(
      "active" to (reason == null && DpdfnetProcessor.isActive()),
      "processing" to (DpdfnetProcessor.isActive() && DpdfnetProcessor.isProcessing()),
      "reason" to (reason ?: DpdfnetProcessor.bypassReason ?: DpdfnetProcessor.slowReason),
      "sampleRate" to DpdfnetProcessor.sampleRate,
      "warmupMs" to (w?.avgMs ?: 0.0),
      "warmupModelMs" to w?.modelMs,
      "warmupFirstMs" to w?.firstMs,
      "warmupMaxMs" to w?.maxMs,
      "warmupCore" to w?.core,
      "provider" to (DpdfnetProcessor.provider ?: w?.provider),
      // Başarım ipucu (ADPF): ses iş parçacığında (canlı) ya da ısınmada açıldı mı
      "hint" to (if (DpdfnetProcessor.audioTid != 0) DpdfnetProcessor.hintActive else w?.hint),
      "avgMs" to s?.avgMs,
      "modelMs" to s?.modelMs,
      "maxMs" to s?.maxMs,
      "load" to s?.load,
      "frames" to (s?.frames ?: 0L).toDouble(),
      "overHop" to (s?.overHop ?: 0),
      "late" to (s?.late ?: 0),
      "retryInMs" to retryInMs?.toDouble(),
      "audioCore" to (if (tid != 0) CpuInfo.describe(tid) else null),
      "cpu" to CpuInfo.clusters,
      "soc" to (if (Build.VERSION.SDK_INT >= 31) "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}" else Build.HARDWARE),
    )
  }

  private companion object {
    const val TAG = "DiskortNoiseFilter"
    const val MODEL_ASSET = "dpdfnet2_48khz_hr_int8.onnx"

    /** Sağlıklı oturum: en az bu kadar 2 sn'lik pencere yetişti (2 dakika) */
    const val HEALTHY_WINDOWS = 60

    /** Telefon çok ısınınca yeniden denemeden önce beklenen süre */
    const val THERMAL_RETRY_MS = 5L * 60_000
  }
}
