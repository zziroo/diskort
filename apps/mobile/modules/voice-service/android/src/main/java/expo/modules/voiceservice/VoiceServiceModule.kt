package expo.modules.voiceservice

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap

class VoiceServiceModule : Module() {
  private val timerHandler = Handler(Looper.getMainLooper())
  private val timers = ConcurrentHashMap<Int, Runnable>()

  override fun definition() = ModuleDefinition {
    Name("VoiceService")

    /** Bildirim düğmeleri: { action: "toggleMute" | "disconnect" }; zamanlayıcı: { id } */
    Events("onAction", "onTimer")

    OnCreate {
      VoiceForegroundService.onAction = { action -> sendEvent("onAction", mapOf("action" to action)) }
    }

    OnDestroy {
      VoiceForegroundService.onAction = null
      timerHandler.removeCallbacksAndMessages(null)
      timers.clear()
    }

    /**
     * React Native'in JS zamanlayıcıları Activity duraklayınca durur (ekran kapalı, uygulama arka planda).
     * LiveKit'in yeniden bağlanması ve pingi bunlara bağlı olduğu için arka planda da dolan zamanlayıcı
     * (bkz. src/voice/backgroundTimers.ts). Ön plan servisinin WakeLock'u işlemciyi uyanık tutar.
     */
    Function("setTimer") { id: Int, delayMs: Double ->
      val fire = Runnable {
        timers.remove(id)
        sendEvent("onTimer", mapOf("id" to id))
      }
      timers[id] = fire
      timerHandler.postDelayed(fire, delayMs.toLong())
      Unit
    }

    Function("clearTimer") { id: Int ->
      timers.remove(id)?.let { timerHandler.removeCallbacks(it) }
      Unit
    }

    /** Servisi başlatır; yalnızca uygulama öndeyken çağrılmalı (sese katılırken). */
    Function("start") { title: String, text: String, muted: Boolean ->
      appContext.reactContext?.let { context ->
        val intent = Intent(context, VoiceForegroundService::class.java).apply {
          action = VoiceForegroundService.ACTION_SHOW
          putExtra("title", title)
          putExtra("text", text)
          putExtra("muted", muted)
        }
        ContextCompat.startForegroundService(context, intent)
      }
      Unit
    }

    /** Bildirimi günceller (ör. susturma durumu değişince); arka planda da çağrılabilir. */
    Function("update") { title: String, text: String, muted: Boolean ->
      appContext.reactContext?.let { context -> VoiceForegroundService.update(context, title, text, muted) }
      Unit
    }

    Function("stop") {
      appContext.reactContext?.let { context ->
        context.stopService(Intent(context, VoiceForegroundService::class.java))
      }
      Unit
    }
  }
}
