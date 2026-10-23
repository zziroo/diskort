package expo.modules.crashreporter

import android.annotation.TargetApi
import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.PrintWriter
import java.io.StringWriter
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.system.exitProcess

/**
 * JavaScript'in göremediği çökmeleri bir sonraki açılışta bildirmek için (JS: src/crashReports.ts):
 *  - Java/Kotlin: yakalanmamış istisnada yığın filesDir'e küçük bir JSON dosyası olarak yazılır, sonra önceki
 *    işleyiciye devredilir: çökme yutulmaz, Android uygulamayı yine kapatır.
 *  - Android 11+: sistemin çıkış kayıtları (ApplicationExitInfo) okunur. Yerel (C++, GPU sürücüsü)
 *    çökmeler ve ANR'ler Java işleyicisine hiç uğramaz; yalnızca buradan görünür.
 * Raporlara JavaScript'in son bildirdiği bağlam (sürüm, güncelleme, açık ekran) eklenir.
 */
internal object CrashStore {
  private const val DIR = "diskort-crashes"
  /** Çökme döngüsünde dosyalar birikmesin */
  private const val MAX_FILES = 10
  /** Çok uzun yığında (ör. StackOverflowError) baş ve son (asıl sebep) kalır; JS sunucu sınırına göre kısaltır */
  private const val MAX_STACK_CHARS = 64_000
  private const val MAX_CONTEXT_CHARS = 500
  /** Android'in süreç özeti sınırı (setProcessStateSummary) */
  private const val MAX_SUMMARY_BYTES = 128

  private const val PREFS = "diskort_crash_reporter"
  private const val KEY_EXIT_SEEN = "exitSeenAt"
  /** İlk açılışta (bu modülü içeren ilk APK) geriye doğru bakılan süre */
  private const val FIRST_LOOKBACK_MS = 7L * 24 * 60 * 60 * 1000
  private const val MAX_EXITS = 16
  private const val MAX_EXIT_REPORTS = 5
  private const val ANR_HEAD_BYTES = 32 * 1024
  /** Tombstone'un başı: sinyal, iptal mesajı ve iş parçacıkları baştadır; bellek haritaları ve günlükler sonda */
  private const val TOMBSTONE_HEAD_BYTES = 1024 * 1024

  @Volatile private var application: Application? = null
  @Volatile private var context = ""
  /** APK sürümü: çökme anında paket yöneticisine (IPC) gidilmesin diye açılışta alınır */
  @Volatile private var nativeVersion: String? = null
  private val installed = AtomicBoolean(false)
  private val handling = AtomicBoolean(false)

  fun install(app: Application) {
    if (!installed.compareAndSet(false, true)) return
    application = app
    // JS başlamadan olan çökmeler de APK sürümünü taşısın
    nativeVersion = versionOf(app)
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      record(thread, error)
      // Çökme yutulmaz: Android'in işleyicisi (ya da öncekiler) uygulamayı kapatır
      if (previous != null) {
        previous.uncaughtException(thread, error)
      } else {
        Process.killProcess(Process.myPid())
        exitProcess(10)
      }
    }
  }

  /** JS iş parçacığından çağrılır (açılışta ve ekran değiştikçe) */
  fun setContext(info: String) {
    context = info.take(MAX_CONTEXT_CHARS)
    // Açılışta alınamadıysa
    if (nativeVersion.isNullOrEmpty()) nativeVersion = application?.let { versionOf(it) }
    // Yerel çökmede Java işleyicisi çalışmaz: bağlamın başı sistemin çıkış kaydına eklenir (Android 11+)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      try {
        setSummary(info)
      } catch (_: Throwable) {
        // özet yazılamadı: rapor bağlamsız gelir
      }
    }
  }

  @TargetApi(Build.VERSION_CODES.R)
  private fun setSummary(info: String) {
    val am = application?.getSystemService(ActivityManager::class.java) ?: return
    am.setProcessStateSummary(utf8Head(info, MAX_SUMMARY_BYTES))
  }

  /** Çökme anında: yığını dosyaya yazar (eşzamanlı, küçük, IPC yok). Hiçbir durumda fırlatmaz. */
  private fun record(thread: Thread, error: Throwable) {
    try {
      if (!handling.compareAndSet(false, true)) return
      val app = application ?: return
      val dir = File(app.filesDir, DIR)
      if (!dir.isDirectory && !dir.mkdirs()) return
      if ((dir.list()?.size ?: 0) >= MAX_FILES) return
      val now = System.currentTimeMillis()
      val pid = Process.myPid()
      val json = JSONObject()
        .put("kind", "java")
        .put("at", now)
        .put("pid", pid)
        .put("thread", thread.name)
        .put("stack", headAndTail(stackOf(error), MAX_STACK_CHARS))
        .put("nativeVersion", nativeVersion ?: "")
        .put("context", context)
      // Yazma yarıda kalırsa bozuk dosya okunmasın: önce geçici dosya, sonra adı değişir
      val tmp = File(dir, "$now-$pid.json.tmp")
      tmp.writeText(json.toString())
      tmp.renameTo(File(dir, "$now-$pid.json"))
    } catch (_: Throwable) {
      // kaydedilemedi (ör. bellek yetersiz): çökme yine önceki işleyiciye gider
    }
  }

  /**
   * Log.getStackTraceString ile aynı ("Caused by" zinciri dahil); ama o, zincirde UnknownHostException varsa
   * boş döner (ağ yokken günlük kirlenmesin diye). Burada her zaman tam yığın gerekir.
   */
  private fun stackOf(error: Throwable): String {
    val writer = StringWriter()
    PrintWriter(writer).use { error.printStackTrace(it) }
    return writer.toString()
  }

  /** Uzun metnin başı ve sonu (asıl sebep, son "Caused by:" bölümü, yığının sonundadır) */
  private fun headAndTail(text: String, max: Int): String =
    if (text.length <= max) text else text.take(max / 2) + "\n…\n" + text.takeLast(max / 2)

  @Suppress("DEPRECATION")
  private fun versionOf(app: Context): String =
    try {
      val info = app.packageManager.getPackageInfo(app.packageName, 0)
      val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
      "${info.versionName} ($code)"
    } catch (_: Throwable) {
      ""
    }

  /**
   * Önceki çalıştırmalardan bekleyen raporlar (JSON metinleri): önce Java çökme dosyaları (okunanlar silinir),
   * sonra (Android 11+) son bildirilenden yeni çıkış kayıtları. Hiçbir durumda fırlatmaz.
   */
  fun takePending(app: Context): List<String> {
    val reports = mutableListOf<String>()
    val javaPids = mutableSetOf<Int>()
    try {
      val files = File(app.filesDir, DIR).listFiles()?.sortedBy { it.name } ?: emptyList()
      for (file in files) {
        // Yarıda kalmış geçici dosyalar yalnızca silinir
        if (file.name.endsWith(".json")) {
          try {
            val text = file.readText()
            javaPids.add(JSONObject(text).optInt("pid"))
            reports.add(text)
          } catch (_: Throwable) {
            // bozuk dosya: atlanır
          }
        }
        file.delete()
      }
    } catch (_: Throwable) {
      // dosyalar okunamadı
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      try {
        reports.addAll(exitReports(app, javaPids))
      } catch (_: Throwable) {
        // çıkış kayıtları okunamadı
      }
    }
    return reports
  }

  @TargetApi(Build.VERSION_CODES.R)
  private fun exitReports(app: Context, javaPids: Set<Int>): List<String> {
    val am = app.getSystemService(ActivityManager::class.java) ?: return emptyList()
    val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    var seen = prefs.getLong(KEY_EXIT_SEEN, now - FIRST_LOOKBACK_MS)
    // Saat geri alındıysa (kaydedilen an gelecekte) yeni kayıtlar gizlenmesin
    if (seen > now) seen = now - FIRST_LOOKBACK_MS
    // En yenisi başta. Geleceğe tarihli kayıtlar (ileri saatle yazılmış) atlanır: her açılışta yeniden gelmesinler
    val fresh = am.getHistoricalProcessExitReasons(app.packageName, 0, MAX_EXITS)
      .filter { it.timestamp > seen && it.timestamp <= now }
    if (fresh.isEmpty()) return emptyList()
    prefs.edit().putLong(KEY_EXIT_SEEN, fresh.maxOf { it.timestamp }).commit()
    return fresh
      // Java çökmesinin yığını zaten dosyada (aynı süreç): sistem kaydı ikinci kez bildirilmez
      .filter { wanted(it) && !(it.reason == ApplicationExitInfo.REASON_CRASH && it.pid in javaPids) }
      .take(MAX_EXIT_REPORTS)
      .map { exitJson(it).toString() }
  }

  @TargetApi(Build.VERSION_CODES.R)
  private fun wanted(info: ApplicationExitInfo): Boolean =
    when (info.reason) {
      ApplicationExitInfo.REASON_CRASH,
      ApplicationExitInfo.REASON_CRASH_NATIVE,
      ApplicationExitInfo.REASON_ANR,
      ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> true
      // Bellek yetersizliği, aşırı kaynak kullanımı ya da sinyalle kapatılma: arka plandaki uygulama için
      // olağan; yalnızca kullanıcı uygulamayı görürken ya da seste (ön plan servisi) olduysa çökme gibidir
      ApplicationExitInfo.REASON_LOW_MEMORY,
      ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
      ApplicationExitInfo.REASON_SIGNALED ->
        info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
      else -> false
    }

  @TargetApi(Build.VERSION_CODES.R)
  private fun exitJson(info: ApplicationExitInfo): JSONObject {
    val json = JSONObject()
      .put("kind", "exit")
      .put("at", info.timestamp)
      .put("pid", info.pid)
      .put("reason", reasonName(info.reason))
      .put("description", info.description ?: "")
      .put("status", info.status)
      .put("importance", info.importance)
      .put("pssKb", info.pss)
      .put("rssKb", info.rss)
      .put("process", info.processName)
    info.processStateSummary?.let { json.put("context", String(it, Charsets.UTF_8)) }
    try {
      info.traceInputStream?.use { input ->
        when {
          // ANR: sistemin iş parçacığı dökümü (metin); JS ana iş parçacığının bölümünü ayıklar
          info.reason == ApplicationExitInfo.REASON_ANR -> {
            json.put("traceKind", "anr").put("trace", String(readHead(input, ANR_HEAD_BYTES), Charsets.UTF_8))
          }
          // Yerel çökme (Android 12+): tombstone protobuf'tur. Ham baytlar (base64) JS'e verilir; JS yalnızca
          // güvenli alanları (sinyal, iptal mesajı, çöken iş parçacığının yığını) okur, gerisini atar
          // (bkz. src/tombstone.ts). Bellek dökümleri uygulama verisi içerebilir: burada da hiçbir yere yazılmaz.
          info.reason == ApplicationExitInfo.REASON_CRASH_NATIVE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            json.put("tombstone", Base64.encodeToString(readHead(input, TOMBSTONE_HEAD_BYTES), Base64.NO_WRAP))
          }
          else -> Unit
        }
      }
    } catch (_: Throwable) {
      // döküm okunamadı: rapor dökümsüz gider
    }
    return json
  }

  @TargetApi(Build.VERSION_CODES.R)
  private fun reasonName(reason: Int): String =
    when (reason) {
      ApplicationExitInfo.REASON_CRASH -> "CRASH"
      ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
      ApplicationExitInfo.REASON_ANR -> "ANR"
      ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
      ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
      ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
      ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
      else -> "REASON_$reason"
    }

  private fun readHead(input: InputStream, max: Int): ByteArray {
    val buffer = ByteArray(max)
    var total = 0
    while (total < max) {
      val n = input.read(buffer, total, max - total)
      if (n < 0) break
      total += n
    }
    return buffer.copyOf(total)
  }

  /** Metnin UTF-8 baytlarının başı; çok baytlı bir karakterin ortasından kesilmez */
  private fun utf8Head(text: String, max: Int): ByteArray {
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (bytes.size <= max) return bytes
    var end = max
    while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
    return bytes.copyOf(end)
  }
}
