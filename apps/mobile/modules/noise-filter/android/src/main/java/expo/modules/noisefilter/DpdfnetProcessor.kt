package expo.modules.noisefilter

import android.os.SystemClock
import com.livekit.reactnative.audio.processing.AudioProcessorInterface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.LockSupport
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * WebRTC'nin ses işleme modülüne (APM) "yakalama sonrası işlemci" olarak takılan DPDFNet.
 *
 * LiveKit'in Android SDK'sındaki ExternalAudioProcessingFactory, mikrofon sesini APM'nin sonunda
 * (yankı engelleme ve bantların birleştirilmesinden sonra) 10 ms'lik tam bant bloklar hâlinde verir:
 * 48 kHz'de 480 örnek, float, [-32768, 32767] ölçeğinde, yerinde değiştirilir. processAudio WebRTC'nin
 * ses yakalama iş parçacığında çağrılır.
 *
 * Model ses iş parçacığında ÇALIŞMAZ: processAudio kareyi bir halkaya yazar, modelin kendi iş parçacığını
 * ("DiskortDpdfnet", ses önceliğinde) uyandırır ve BUFFER_HOPS (3) kare önceki karenin temiz sonucunu verir.
 * Böylece ek gecikme 30 ms olur ama tek tük uzun kareler (ör. 13 ms) sesi kesmez: model bir kare için 30 ms
 * pay bulur. Sonuç yine de hazır değilse ve model o anda tam o kareyi işliyorsa ses iş parçacığı en fazla WAIT_NS
 * bekler (pencere başına toplam WAIT_BUDGET_NS); model o kareye henüz başlamadıysa (geride kaldı) beklenmez. Sonuç
 * gelmezse o kare gürültü engellemesiz (kuru) geçer ve "geç" sayılır. Kuru kare modelin algoritmik gecikmesi kadar
 * (5 kare) geriden alınır: zaman sıçraması olmaz. Kuru↔temiz geçişlerinde FADE örneklik doğrusal geçiş yapılır.
 *
 * Android 12+'da modelin iş parçacığı için başarım ipucu (PerfHint, ADPF) açılır: sistem kare sürelerini görüp
 * frekansı hedefe göre ayarlar.
 *
 * Güvenlik (eşikler: DpdfnetBudget): 2 saniyelik bir ölçüm penceresinde ortalama kare süresi bütçeyi aşarsa
 * ya da kareler sık sık geç kalırsa, hata olursa ya da telefon çok ısınırsa işlemci kendini devre dışı bırakır
 * (ses olduğu gibi geçer) ve bildirir; modül motoru kapatır, JS de WebRTC'nin kendi gürültü engellemesini
 * açar ve bekleme süresi dolunca yeniden dener. Açılıştaki ilk pencere karar vermez (iş parçacığı ve ipucu yeni
 * başlıyor). 48 kHz dışındaki hızlarda ses işlenmeden geçer.
 */
object DpdfnetProcessor : AudioProcessorInterface {
  private const val WINDOW_MS = 2000L
  private const val SCALE = 32768f

  /** Bu kadar kare gelmezse (mikrofon kapalıydı) ölçüm ve halka baştan başlar */
  private const val PAUSE_MS = 1000L

  /** Modelin ses yakalamanın kaç kare gerisinden çalıştığı (ek gecikme 30 ms) */
  private const val DELAY = DpdfnetBudget.BUFFER_HOPS

  /** Kuru (işlenmemiş) kare bu kadar kare geriden alınır: modelin algoritmik gecikmesi (pencere + 4 kare) */
  private const val DRY_LAG = Dpdfnet.MODEL_LAG_FRAMES + 1

  /** Halka: kuru kare için DELAY + DRY_LAG kare geriye bakılır, kalanı modelin gecikme payı */
  private const val RING = 16

  /** Model bundan çok geride kaldıysa (80 ms) bekleyen eski kareler atlanır, en yeniden devam edilir */
  private const val SKIP_HOPS = 8

  /** Sonuç hazır değilse ses iş parçacığının en fazla bekleyeceği süre (sonra kuru geçer) */
  private const val WAIT_NS = 8_000_000L

  /**
   * Bir ölçüm penceresinde (2 s) beklemelerin toplam üst sınırı: model sık sık son anda yetişiyorsa yakalama iş
   * parçacığı zamanının çoğunu beklemekle geçirmesin (AudioRecord taşmasın); sınır dolunca kare hemen kuru geçer
   */
  private const val WAIT_BUDGET_NS = 200_000_000L

  /** Kuru↔temiz geçişinin uzunluğu: 3 ms (48 kHz'de 144 örnek) */
  private const val FADE = 144

  private const val PAUSE_NS = PAUSE_MS * 1_000_000L

  /** Motor (değiştirme, işleme, ayar): modelin iş parçacığı ve modül kullanır; ses iş parçacığı kullanmaz */
  private val lock = ReentrantLock()
  private val bypassLock = Any()

  /** Halka kilidi: yalnızca kısa kopyalamalar (480 örnek) için tutulur */
  private val ringLock = Any()

  @Volatile
  private var engine: DpdfnetEngine? = null

  @Volatile
  private var enabled = false

  @Volatile
  private var needsReset = false

  /** Devre dışı kalma nedeni (null: çalışıyor); yalnızca yeni yüklemede ya da kapatınca silinir */
  @Volatile
  var bypassReason: String? = null
    private set

  /** Telefon yetişemedi (ısınmada ya da canlıda): slowUntil'e kadar yeniden denenmez (bkz. noteSlow) */
  @Volatile
  var slowReason: String? = null
    private set

  /** slowReason'ın geçerli olduğu son an (elapsedRealtime) */
  @Volatile
  private var slowUntil = 0L
  private var slowCount = 0
  private var slowAt = 0L

  /** Isınmada ani takılma (systematic değil) sayacı: yeniden deneme beklemesi bununla büyür (bkz. noteWarmSpike) */
  private var spikeCount = 0
  private var spikeAt = 0L

  @Volatile
  var sampleRate = 0
    private set

  /** Son ısınmanın ölçümü (null: henüz yok) */
  @Volatile
  var warmup: WarmUp? = null

  /** Takılı motorun yürütücüsü ("CPU" / "XNNPACK"); motor yoksa son kullanılan */
  @Volatile
  var provider: String? = null
    private set

  /** Modeli çalıştıran iş parçacığının kimliği (tid): hangi çekirdekte çalıştığını tanılama için okuruz */
  @Volatile
  var audioTid = 0
    private set

  /** Modelin iş parçacığının başarım ipucu oturumu (yalnızca o iş parçacığı kullanır) */
  private var hint: PerfHint = PerfHint.NONE
  private var hintTid = 0

  /** Modelin iş parçacığı için başarım ipucu (ADPF) açık mı */
  @Volatile
  var hintActive = false
    private set

  enum class Kind {
    /** Telefon genel olarak yavaş (ortalama bütçeyi aşıyor) */
    SLOW,

    /** Ani takılmalar: kareler tampon payını da aşıp geç kaldı */
    SPIKE,

    /** Model hata verdi */
    ERROR,

    /** Telefon çok ısındı (yalnızca bu oturum) */
    THERMAL,
  }

  /** Devre dışı kalma: neden, türü ve o anki motor (modül ses iş parçacığı dışında kapatır) */
  class Bypass(val reason: String, val kind: Kind, val engine: DpdfnetEngine?)

  /** Devre dışı kalınca çağrılır; ses ya da model iş parçacığında olabilir: uzun iş yapmamalı */
  @Volatile
  var onBypass: ((Bypass) -> Unit)? = null

  // ---------- Halka (ringLock ile) ----------

  private val inRing = Array(RING) { FloatArray(Dpdfnet.HOP) }
  private val outRing = Array(RING) { FloatArray(Dpdfnet.HOP) }
  private val inStamp = LongArray(RING) { -1L }
  private val outStamp = LongArray(RING) { -1L }

  /** Ses iş parçacığının yazacağı sıradaki kare */
  private var inSeq = 0L

  /** Modelin işleyeceği sıradaki kare */
  private var workNext = 0L

  /** Modelin o an işlediği kare (-1: yok); ses iş parçacığı yalnızca bu kareyi bekler */
  @Volatile
  private var working = -1L

  /** Halka baştan başladıkça artar: eski karelerin sonuçları yeni halkaya yazılmaz, model durumu sıfırlanır */
  private var gen = 0

  // ---------- Ses iş parçacığı ----------

  private val hop = FloatArray(Dpdfnet.HOP)
  private val out = FloatArray(Dpdfnet.HOP)

  /** Geçiş için kuru kare ([-1, 1] ölçeğinde, temiz sonuçla aynı) */
  private val dryOut = FloatArray(Dpdfnet.HOP)

  /** Önceki kare kuru muydu ve son örneği ([-1, 1]): geçişte tık olmasın */
  private var prevDry = false
  private var prevLast = 0f

  /** Bu pencerede beklenen toplam süre (ns) */
  private var winWaitNs = 0L

  /** Sonucu bekleyen ses iş parçacığı (model bitirince uyandırır) */
  @Volatile
  private var waiting: Thread? = null

  @Volatile
  private var worker: Thread? = null
  private val workerLock = Any()

  // Ölçüm penceresi (ses iş parçacığı yazar; modelin süreleri aşağıdaki sayaçlardan toplanır)
  private var winStart = 0L
  private var winFrames = 0
  private var winLate = 0

  // Modelin iş parçacığının pencere sayaçları (ses iş parçacığı pencere sonunda sıfırlayarak okur)
  private val workFrames = AtomicInteger()
  private val workBusyNs = AtomicLong()
  private val workModelNs = AtomicLong()
  private val workMaxNs = AtomicLong()
  private val workOverHop = AtomicInteger()

  /** Açılıştan (ya da aradan) beri biten pencereler: ilki karar vermez */
  private var windows = 0

  /** Bu motorla yetişilen (karar veren) pencereler: oturum sağlıklı geçti mi (SlowMemory.clearStrikes) */
  @Volatile
  var healthyWindows = 0
    private set
  private var totalFrames = 0L

  @Volatile
  private var lastFrameAt = 0L

  /** Son ölçüm penceresinin özeti (JS okur) */
  @Volatile
  var stats: Stats? = null
    private set

  data class Stats(
    val avgMs: Double,
    /** Ortalamanın modele (ONNX Runtime) düşen kısmı; kalanı STFT/ISTFT */
    val modelMs: Double,
    val maxMs: Double,
    /** Modelin iş parçacığının yükü (işlem süresi / geçen süre) */
    val load: Double,
    val frames: Long,
    /** 10 ms'yi aşan kareler (tamponla sesi bozmaz; tanılama) */
    val overHop: Int,
    /** Tampon payını da aşıp kuru geçen kareler */
    val late: Int,
  )

  /**
   * Isınma ölçümü (ms/kare). avgMs ikinci yarının ortalaması, maxMs / spikeMs ikinci yarının en uzun ve ikinci
   * en uzun karesi; firstMs ilk yarınınki (ilk kare hariç; ikinci yarıdan çok yüksekse işlemci frekansı ısınma
   * sırasında yükseliyordu); modelMs ikinci yarıda modelin payı. Karar: DpdfnetBudget.judgeWarmUp.
   */
  data class WarmUp(
    val avgMs: Double,
    val modelMs: Double,
    val firstMs: Double,
    val maxMs: Double,
    val spikeMs: Double,
    val provider: String,
    /** Isınmanın bittiği çekirdek, ör. "7 (2600 MHz)" */
    val core: String?,
    /** Başarım ipucu (ADPF) kullanıldı mı */
    val hint: Boolean,
  ) {
    fun judge(): DpdfnetBudget.Miss? = DpdfnetBudget.judgeWarmUp(avgMs, spikeMs, firstMs)
  }

  /** Motoru takar (öncekini kapatır). Yeni motorla ölçümler ve bypass durumu sıfırlanır. */
  fun install(next: DpdfnetEngine?) {
    if (next != null) ensureWorker()
    val previous = lock.withLock {
      val old = engine
      engine = next
      if (next != null) provider = next.provider
      needsReset = true
      bypassReason = null
      // Ölçüm penceresi ses iş parçacığında needsReset ile sıfırlanır
      healthyWindows = 0
      stats = null
      old
    }
    previous?.close()
  }

  /**
   * Devre dışı kaldıktan sonra (ses iş parçacığı dışında): motor kapatılır ve bellekten atılır; neden ve son
   * ölçümler durum için kalır. Bu arada motor değiştiyse (ayrılıp yeniden katılındı) dokunulmaz: false döner
   * (eski oturumun bildirimi yeni oturumu standart engellemeye geçirmemeli).
   */
  fun unload(expected: DpdfnetEngine): Boolean {
    lock.withLock {
      if (engine !== expected || bypassReason == null) return false
      enabled = false
      engine = null
    }
    try {
      expected.close()
    } catch (_: Throwable) {
      // bellekten atılamadıysa da devre dışı: ses olduğu gibi geçer
    }
    return true
  }

  fun hasEngine(): Boolean = engine != null

  fun setEnabled(value: Boolean) {
    enabled = value
    if (value) needsReset = true
  }

  fun isActive(): Boolean = enabled && bypassReason == null && hasEngine()

  /** Son 1 saniyede işlenen kare var mı (mikrofon açık ve hız destekleniyor) */
  fun isProcessing(): Boolean = SystemClock.elapsedRealtime() - lastFrameAt < 1000

  fun setAttenLimit(db: Double) {
    lock.withLock { engine?.setAttenLimit(db) }
  }

  /** Telefon çok ısındı: çalışıyorsa bu oturum için devre dışı kalır (kalıcı kaydedilmez) */
  fun bypassThermal(reason: String) {
    if (!enabled || bypassReason != null) return
    val e = engine ?: return
    bypass(Bypass(reason, Kind.THERMAL, e))
  }

  /**
   * Telefon yetişemedi (genel yavaşlık ya da canlıda geç kalan kareler): bu açılışta bekleme süresi boyunca
   * yeniden denenmez; art arda oldukça bekleme uzar (DpdfnetBudget.retryDelayMs). Bekleme süresini döner.
   */
  @Synchronized
  fun noteSlow(reason: String, now: Long = SystemClock.elapsedRealtime()): Long {
    slowCount = DpdfnetBudget.nextRetryCount(slowCount, slowAt, now)
    slowAt = now
    val delay = DpdfnetBudget.retryDelayMs(slowCount)
    slowUntil = now + delay
    slowReason = reason
    return delay
  }

  /**
   * Isınmada ani takılma: sonraki katılış engellenmez (slowReason kurulmaz) ama sesli sohbetteyken yeniden deneme
   * art arda oldukça seyrekleşir (2, 4, 8, en fazla 15 dk): her 2 dakikada bir model yükleyip ısıtma döngüsü olmaz.
   * Bekleme süresini döner.
   */
  @Synchronized
  fun noteWarmSpike(now: Long = SystemClock.elapsedRealtime()): Long {
    spikeCount = DpdfnetBudget.nextRetryCount(spikeCount, spikeAt, now)
    spikeAt = now
    return DpdfnetBudget.retryDelayMs(spikeCount)
  }

  /** Bekleme sürüyorsa kalan süre (ms); bittiyse neden silinir ve null döner */
  @Synchronized
  fun slowRemainingMs(now: Long = SystemClock.elapsedRealtime()): Long? {
    if (slowReason == null) return null
    val left = slowUntil - now
    if (left > 0) return left
    slowReason = null
    return null
  }

  /** Oturum yetişerek geçti: sonraki yetişemedi yeniden en kısa beklemeyle başlar */
  @Synchronized
  fun clearSlowCount() {
    slowCount = 0
    spikeCount = 0
  }

  override fun isEnabled(): Boolean = enabled

  override fun getName(): String = "diskort_dpdfnet"

  override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
    sampleRate = sampleRateHz
    needsReset = true
  }

  override fun resetAudioProcessing(newRate: Int) {
    sampleRate = newRate
    needsReset = true
  }

  // ---------- Ses yakalama iş parçacığı ----------

  override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
    if (!enabled || bypassReason != null) return
    val e = engine ?: return
    // Model yalnızca 48 kHz (10 ms = 480 örnek); diğer hızlarda ses olduğu gibi geçer
    if (numFrames != Dpdfnet.HOP) return
    try {
      val fb = buffer.order(ByteOrder.nativeOrder()).asFloatBuffer()
      if (fb.capacity() < Dpdfnet.HOP) return
      fb.get(hop, 0, Dpdfnet.HOP)
      for (i in 0 until Dpdfnet.HOP) hop[i] /= SCALE
      val now = SystemClock.elapsedRealtime()
      // Yeni motor / hız değişti ya da uzun ara (mikrofon kapalıydı): halka ve ölçüm baştan başlar
      val restart = needsReset || (lastFrameAt != 0L && now - lastFrameAt > PAUSE_MS)
      if (restart) {
        needsReset = false
        winStart = 0
        windows = 0
        winWaitNs = 0
        prevDry = false
        prevLast = 0f
      }
      var seq = 0L
      synchronized(ringLock) {
        if (restart) {
          gen++
          inSeq = 0
          workNext = 0
          inStamp.fill(-1L)
          outStamp.fill(-1L)
        }
        seq = inSeq++
        val slot = (seq % RING).toInt()
        System.arraycopy(hop, 0, inRing[slot], 0, Dpdfnet.HOP)
        inStamp[slot] = seq
      }
      worker?.let { LockSupport.unpark(it) }

      // DELAY kare önceki karenin temiz sonucu; ilk karelerde sessizlik (halka doluyor)
      val o = seq - DELAY
      var late = false
      if (o < 0) {
        out.fill(0f)
      } else if (!take(o)) {
        // Yalnızca model tam bu kareyi işliyorsa beklenir; henüz başlamadıysa (geride) beklemek boşa gider
        val budget = WAIT_BUDGET_NS - winWaitNs
        var ready = false
        if (budget > 0 && working == o) {
          waiting = Thread.currentThread()
          val start = System.nanoTime()
          val deadline = start + minOf(WAIT_NS, budget)
          while (true) {
            if (take(o)) {
              ready = true
              break
            }
            // Model bu kareyi bıraktı (bitirdi ya da atladı): son bir kez bakılır
            if (working != o) {
              ready = take(o)
              break
            }
            val left = deadline - System.nanoTime()
            if (left <= 0) break
            LockSupport.parkNanos(left)
          }
          waiting = null
          winWaitNs += System.nanoTime() - start
        }
        if (!ready) {
          dry(o, out)
          late = true
        }
      }
      crossfade(o, late)
      for (i in 0 until Dpdfnet.HOP) out[i] *= SCALE
      fb.position(0)
      fb.put(out, 0, Dpdfnet.HOP)
      measure(now, late, e)
    } catch (t: Throwable) {
      bypass(Bypass("hata: ${t.message ?: t.javaClass.simpleName}", Kind.ERROR, engine))
    }
  }

  /** o. karenin temiz sonucu hazırsa out'a kopyalar */
  private fun take(o: Long): Boolean =
    synchronized(ringLock) {
      val slot = (o % RING).toInt()
      if (outStamp[slot] != o) return@synchronized false
      System.arraycopy(outRing[slot], 0, out, 0, Dpdfnet.HOP)
      true
    }

  /** o. karenin yerine kuru ses dst'ye: modelin algoritmik gecikmesi kadar geriden (yoksa sessizlik) */
  private fun dry(o: Long, dst: FloatArray) {
    synchronized(ringLock) {
      val d = o - DRY_LAG
      if (d >= 0 && inStamp[(d % RING).toInt()] == d) {
        System.arraycopy(inRing[(d % RING).toInt()], 0, dst, 0, Dpdfnet.HOP)
      } else {
        dst.fill(0f)
      }
    }
  }

  /**
   * Kuru↔temiz geçişinde ilk FADE örnek doğrusal geçer (out ve kuru kare aynı [-1, 1] ölçeğinde). Temizden kuruya
   * geçerken bu karenin temiz sonucu yok: önceki karenin son örneğinden kuru sese geçilir. o < 0 (halka doluyor,
   * sessizlik) geçiş sayılmaz.
   */
  private fun crossfade(o: Long, isDry: Boolean) {
    if (o >= 0 && isDry != prevDry) {
      if (isDry) {
        val from = prevLast
        for (i in 0 until FADE) {
          val w = (i + 1).toFloat() / (FADE + 1)
          out[i] = from + (out[i] - from) * w
        }
      } else {
        dry(o, dryOut)
        for (i in 0 until FADE) {
          val w = (i + 1).toFloat() / (FADE + 1)
          out[i] = dryOut[i] + (out[i] - dryOut[i]) * w
        }
      }
    }
    if (o >= 0) prevDry = isDry
    prevLast = out[Dpdfnet.HOP - 1]
  }

  private fun measure(now: Long, late: Boolean, e: DpdfnetEngine) {
    lastFrameAt = now
    totalFrames++
    if (winStart == 0L) {
      winStart = now
      winFrames = 0
      winLate = 0
      winWaitNs = 0
      drainWork()
    }
    winFrames++
    if (late) winLate++
    val elapsed = now - winStart
    if (elapsed < WINDOW_MS) return
    val w = drainWork()
    val avgMs = if (w.frames > 0) w.busyNs / 1e6 / w.frames else 0.0
    stats = Stats(
      avgMs = avgMs,
      modelMs = if (w.frames > 0) w.modelNs / 1e6 / w.frames else 0.0,
      maxMs = w.maxNs / 1e6,
      load = w.busyNs / 1e6 / elapsed,
      frames = totalFrames,
      overHop = w.overHop,
      late = winLate,
    )
    winStart = 0
    windows++
    // İlk pencere (iş parçacığının ilk kareleri, ipucu oturumu yeni) karar vermez; sonrakilerde tek pencere yeter
    if (windows < 2) return
    val miss = DpdfnetBudget.judgeWindow(avgMs, winLate, winFrames)
    if (miss == null) {
      healthyWindows++
      return
    }
    noteSlow(miss.reason, now)
    bypass(Bypass(miss.reason, if (miss.systematic) Kind.SLOW else Kind.SPIKE, e))
  }

  private class Work(val frames: Int, val busyNs: Long, val modelNs: Long, val maxNs: Long, val overHop: Int)

  private fun drainWork(): Work =
    Work(
      frames = workFrames.getAndSet(0),
      busyNs = workBusyNs.getAndSet(0),
      modelNs = workModelNs.getAndSet(0),
      maxNs = workMaxNs.getAndSet(0),
      overHop = workOverHop.getAndSet(0),
    )

  private fun bypass(b: Bypass) {
    synchronized(bypassLock) {
      if (bypassReason != null) return
      bypassReason = b.reason
    }
    try {
      onBypass?.invoke(b)
    } catch (_: Throwable) {
      // bildirim başarısızsa ses yine de olduğu gibi geçer
    }
  }

  // ---------- Modelin iş parçacığı ----------

  /** Modelin iş parçacığı ilk motor takılınca açılır, uygulama boyunca yaşar (iş yokken süresiz uyur) */
  private fun ensureWorker() {
    synchronized(workerLock) {
      // İş parçacığı beklenmedik biçimde öldüyse yeniden açılır
      if (worker?.isAlive == true) return
      val t = Thread({ workLoop() }, "DiskortDpdfnet")
      t.isDaemon = true
      t.start()
      worker = t
    }
  }

  private fun workLoop() {
    try {
      // WebRTC'nin ses iş parçacıklarıyla aynı öncelik
      android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
    } catch (_: Throwable) {
      // öncelik verilemezse normal öncelikte çalışır
    }
    val input = FloatArray(Dpdfnet.HOP)
    val result = FloatArray(Dpdfnet.HOP)
    var lastGen = -1
    var lastEngine: DpdfnetEngine? = null
    var lastWorkAt = 0L
    // Kareler atlandı: model durumu (STFT, GRU) atlanan sesle sürmez, sonraki işte sıfırlanır
    var resetNext = false
    while (true) {
      try {
        var seq = -1L
        var jobGen = 0
        var more = false
        synchronized(ringLock) {
          // Çok geride kaldı (uzun takılma): eski kareler artık işe yaramaz, en yeniden devam edilir
          if (inSeq - workNext > SKIP_HOPS) {
            workNext = inSeq - 1
            resetNext = true
          }
          if (workNext < inSeq) {
            val slot = (workNext % RING).toInt()
            if (inStamp[slot] == workNext) {
              System.arraycopy(inRing[slot], 0, input, 0, Dpdfnet.HOP)
              seq = workNext
              jobGen = gen
              // Aynı kilit içinde: ses iş parçacığı bu kareyi bekleyip beklememeye buna bakar
              working = seq
            }
            workNext++
            more = workNext < inSeq
          }
        }
        if (seq < 0) {
          if (more) continue
          // Uzun süredir iş yok: kapatılmış motora başvuru tutulmaz (sonraki işte zaten sıfırlanır)
          if (SystemClock.elapsedRealtime() - lastWorkAt > PAUSE_MS) lastEngine = null
          idle(lastWorkAt)
          continue
        }
        lastWorkAt = SystemClock.elapsedRealtime()
        try {
          if (!enabled || bypassReason != null) {
            lastEngine = null
            continue
          }
          lock.withLock {
            val e = engine
            if (e == null) {
              lastEngine = null
              return@withLock
            }
            // Halka baştan başladı, motor değişti ya da kareler atlandı: model durumu (STFT, GRU) sıfırlanır
            if (jobGen != lastGen || e !== lastEngine || resetNext) {
              e.reset()
              lastGen = jobGen
              lastEngine = e
              resetNext = false
            }
            val tid = android.os.Process.myTid()
            if (hintTid != tid) {
              hint.close()
              hint = PerfHint.forCurrentThread()
              hintTid = tid
              hintActive = hint.active
              audioTid = tid
            }
            val start = System.nanoTime()
            try {
              e.processHop(input, result)
            } catch (t: Throwable) {
              bypass(Bypass("hata: ${t.message ?: t.javaClass.simpleName}", Kind.ERROR, e))
              return@withLock
            }
            val took = System.nanoTime() - start
            hint.report(took)
            workFrames.incrementAndGet()
            workBusyNs.addAndGet(took)
            workModelNs.addAndGet(e.lastModelNs)
            while (true) {
              val m = workMaxNs.get()
              if (took <= m || workMaxNs.compareAndSet(m, took)) break
            }
            if (took > 10_000_000L) workOverHop.incrementAndGet()
            synchronized(ringLock) {
              if (jobGen == gen) {
                val slot = (seq % RING).toInt()
                System.arraycopy(result, 0, outRing[slot], 0, Dpdfnet.HOP)
                outStamp[slot] = seq
              }
              working = -1L
            }
          }
        } finally {
          // Her yolda (devre dışı, motor yok, hata): ses iş parçacığı artık bu kareyi beklemez
          working = -1L
        }
        waiting?.let { LockSupport.unpark(it) }
      } catch (t: Throwable) {
        working = -1L
        // İş parçacığı ölmemeli: beklenmedik hata devre dışı bırakır
        bypass(Bypass("hata: ${t.message ?: t.javaClass.simpleName}", Kind.ERROR, engine))
      }
    }
  }

  /**
   * İş yok: ses akarken bir sonraki kareye kadar uyunur. Bir süredir kare gelmiyorsa (mikrofon kapalı, devre dışı
   * ya da motor yok) başarım ipucu kapatılır (sistem frekansı boşuna yüksek tutmasın) ve süresiz uyunur.
   */
  private fun idle(lastWorkAt: Long) {
    if (hintTid == 0) {
      LockSupport.park()
      return
    }
    if (SystemClock.elapsedRealtime() - lastWorkAt > PAUSE_MS) {
      hint.close()
      hint = PerfHint.NONE
      hintTid = 0
      hintActive = false
      return
    }
    LockSupport.parkNanos(PAUSE_NS)
  }

  /**
   * Isınma ve hız ölçümü: canlı sesten önce çok kısık rastgele gürültüyle 40 kare çalıştırır; karar ikinci
   * yarıya göre verilir (ilk yarı JIT/önbellek ısınması). Motor ardından temiz duruma alınır.
   */
  fun warmUp(e: DpdfnetEngine): WarmUp {
    val h = FloatArray(Dpdfnet.HOP)
    val o = FloatArray(Dpdfnet.HOP)
    val warmHint = PerfHint.forCurrentThread()
    var seed = 1L
    var first = 0L
    var total = 0L
    var model = 0L
    var max = 0L
    var second = 0L
    val frames = 40
    val half = frames / 2
    for (f in 0 until frames) {
      for (i in h.indices) {
        seed = (seed * 1664525L + 1013904223L) and 0xffffffffL
        h[i] = ((seed.toDouble() / 4294967296.0 - 0.5) * 1e-3).toFloat()
      }
      val s = System.nanoTime()
      e.processHop(h, o)
      val took = System.nanoTime() - s
      warmHint.report(took)
      if (f >= half) {
        total += took
        model += e.lastModelNs
        if (took > max) {
          second = max
          max = took
        } else if (took > second) {
          second = took
        }
      } else if (f > 0) {
        // İlk kare (bellek ayırma, ilk çalıştırma) sayılmaz
        first += took
      }
    }
    warmHint.close()
    e.reset()
    val core = CpuInfo.describe(android.os.Process.myTid())
    return WarmUp(
      avgMs = total / 1e6 / half,
      modelMs = model / 1e6 / half,
      firstMs = first / 1e6 / (half - 1),
      maxMs = max / 1e6,
      spikeMs = second / 1e6,
      provider = e.provider,
      core = core,
      hint = warmHint.active,
    )
  }
}
