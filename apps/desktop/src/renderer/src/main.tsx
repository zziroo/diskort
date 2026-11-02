// Ortak çekirdeğin platform ayarı her şeyden önce yapılır (kayıtlı oturum burada yüklenir)
import './platform';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppCrashScreen, ErrorBoundary } from './components/ErrorBoundary';
import { installTurnPortRewrite } from './features/voice/turnPort';
import { installShiftHeld } from './lib/shiftHeld';
import { installTheme } from './lib/theme';
import { voice } from './features/voice/voiceClient';
import { micDebug } from './features/voice/micProcessor';
import { reportClientError, useGuild, useMessages, useSession } from '@diskort/client-core';
import { useSettings } from './stores/settings';
import { useVoice } from './stores/voice';
import './styles.css';

// Kayıtlı tema ilk çizimden önce uygulanır (varsayılan temanın bir an görünüp seçili temaya dönmemesi için)
installTheme();
installShiftHeld();

// Herhangi bir WebRTC bağlantısı kurulmadan önce (bkz. turnPort.ts)
installTurnPortRewrite();

// Beklenmedik hatalar sunucu kayıtlarına bildirilir (kullanıcılardaki sorunları görebilmek için)
window.addEventListener('error', (e) => reportClientError(e.error ?? e.message, 'pencere'));
window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason, 'promise'));

// Yalnızca geliştirme: otomatik testlerin iç duruma erişebilmesi için. Gürültü engelleyici düşüşü denemesi:
// __diskort.voice.debugFailDenoiser() (çalışan modeli düşürür), __diskort.micDebug.failNextSetups = 1 (sonraki
// model kurulumu "işlemci yetersiz" olur).
if (import.meta.env.DEV) {
  Object.assign(window, { __diskort: { voice, micDebug, useVoice, useGuild, useSettings, useMessages, useSession } });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Çizim hatası tüm pencereyi beyaz bırakmasın */}
    <ErrorBoundary where="uygulama" fallback={<AppCrashScreen />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
