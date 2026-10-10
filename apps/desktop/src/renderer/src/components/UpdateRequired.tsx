import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { DOWNLOAD_PAGE_URL } from '../../../shared/distribution';
import { bridge } from '../lib/bridge';
import { errorMessage } from '@diskort/client-core';
import { useUpdate } from '../stores/update';

const mb = (bytes: number): string => (bytes / 1048576).toFixed(1).replace('.', ',');

/**
 * Sunucu bu sürümü artık kabul etmiyor: güncelleme tamamlanana kadar uygulama kullanılamaz.
 * Windows/Linux'ta indirme hemen başlar ve kurulumdan sonra uygulama yeniden açılır.
 */
export function UpdateRequired({ version }: { version: string }) {
  const state = useUpdate((s) => s.state);
  const support = bridge?.updates.support ?? 'none';
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(() => {
    setError(null);
    bridge?.updates.install().catch((err) => setError(errorMessage(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  }, []);

  useEffect(() => {
    if (support === 'auto') start();
  }, [support, start]);

  let detail: string;
  if (support === 'manual') detail = 'Devam etmek için yeni sürümü indirip kurman gerekiyor.';
  else if (support === 'none') detail = 'Geliştirme sürümü: depodaki son değişiklikleri çekip yeniden başlat.';
  else if (error) detail = error;
  else if (state.kind === 'downloading' && state.total)
    detail = `İndiriliyor… ${mb(state.transferred)} / ${mb(state.total)} MB`;
  else if (state.kind === 'installing' || state.kind === 'ready') detail = 'Kuruluyor, Diskort birazdan yeniden açılacak…';
  else detail = 'Güncelleme hazırlanıyor…';

  const percent = state.kind === 'downloading' ? state.percent : state.kind === 'ready' || state.kind === 'installing' ? 100 : 0;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg-rail p-8 text-center">
      <div className="mb-2 flex h-20 w-20 items-center justify-center rounded-3xl bg-brand text-white">
        <Download size={40} />
      </div>
      <h1 className="text-xl font-bold text-text-head">Diskort {version} gerekli</h1>
      <p className="max-w-sm text-sm text-text-muted">{detail}</p>
      {support === 'auto' && !error && (
        <div className="mt-2 h-1.5 w-64 overflow-hidden rounded bg-bg-main">
          <div className="h-full rounded bg-brand transition-[width]" style={{ width: `${Math.max(3, percent)}%` }} />
        </div>
      )}
      {support === 'auto' && error && (
        <>
          <button className="mt-2 rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover" onClick={start}>
            Tekrar dene
          </button>
          {/* Otomatik kurulum üst üste başarısız olursa (ör. macOS'ta imza doğrulaması) elle kurma yolu */}
          <button
            className="text-xs text-text-muted underline hover:text-text-normal"
            onClick={() => void bridge?.openExternal(DOWNLOAD_PAGE_URL)}
          >
            Olmuyorsa indirme sayfasından kur
          </button>
        </>
      )}
      {support === 'manual' && (
        <button
          className="mt-2 rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
          onClick={() => void bridge?.openExternal(DOWNLOAD_PAGE_URL)}
        >
          İndirme sayfasını aç
        </button>
      )}
    </div>
  );
}

/** Arka planda indirilen güncelleme hazır: Discord'daki yeşil "güncelle" düğmesinin karşılığı. */
export function UpdateReadyBar() {
  const state = useUpdate((s) => s.state);
  if (state.kind !== 'ready' && state.kind !== 'installing') return null;
  return (
    <div className="flex items-center justify-center gap-3 bg-ok px-4 py-1 text-sm font-medium text-white">
      <span>Diskort {state.version} hazır.</span>
      <button
        className="rounded border border-white/70 px-2 py-px text-xs font-semibold hover:bg-white/15 disabled:opacity-60"
        disabled={state.kind === 'installing'}
        onClick={() => void bridge?.updates.install()}
      >
        {state.kind === 'installing' ? 'Yeniden başlatılıyor…' : 'Şimdi yeniden başlat'}
      </button>
    </div>
  );
}
