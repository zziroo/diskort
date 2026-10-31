import { useEffect, useState, type ReactNode } from 'react';
import { AppWindow, Monitor, RefreshCw } from 'lucide-react';
import type { ScreenSource } from '../../../../shared/bridge';
import { SCREEN_PRESETS } from '../../features/voice/screenPresets';
import { voice } from '../../features/voice/voiceClient';
import { errorMessage } from '@diskort/client-core';
import { bridge } from '../../lib/bridge';
import { cn } from '../../lib/utils';
import { useSettings, type ScreenPresetId } from '../../stores/settings';
import { toast, useUi } from '../../stores/ui';
import { Modal } from '../ui/Modal';
import { Button, Select, Toggle } from '../ui/controls';

type Tab = 'window' | 'screen';

/** Discord tarzı ekran/pencere seçici. Tarayıcıda sistem seçicisi kullanılır. */
export function ScreenSharePicker() {
  const close = useUi((s) => s.closeModal);
  const settings = useSettings();
  const useCustomPicker = Boolean(bridge);
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [loading, setLoading] = useState(useCustomPicker);
  const [tab, setTab] = useState<Tab>('window');
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const load = async (): Promise<void> => {
    if (!bridge) return;
    setLoading(true);
    try {
      const list = await bridge.screen.getSources();
      setSources(list);
      if (!list.some((s) => s.kind === 'window')) setTab('screen');
    } catch (err) {
      toast(`Kaynaklar alınamadı: ${errorMessage(err)}`, 'error');
    } finally {
      // Kaynak listesi izin yokken hata verse de izin bildirimi çıksın
      setAccessDenied(await bridge.screen.accessDenied());
      setLoading(false);
    }
  };

  useEffect(() => {
    if (useCustomPicker) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      const warning = await voice.startScreenShare({
        sourceId: selected ?? undefined,
        preset: settings.screenPreset,
        codec: settings.screenCodec,
        content: settings.screenContent,
        audio: settings.shareAudio && Boolean(bridge?.screen.supportsAudio),
        ...sourceLabel(sources, selected),
      });
      if (warning) toast(warning);
      close();
    } catch (err) {
      toast(`Yayın başlatılamadı: ${errorMessage(err)}`, 'error');
    } finally {
      setStarting(false);
    }
  };

  const visible = sources.filter((s) => s.kind === tab);

  return (
    <Modal
      title="Ekran Paylaş"
      subtitle={useCustomPicker ? 'Paylaşmak istediğin pencereyi veya ekranı seç.' : undefined}
      onClose={close}
      className="w-[760px]"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Vazgeç
          </Button>
          <Button onClick={() => void start()} disabled={starting || (useCustomPicker && !selected)}>
            {starting ? 'Başlatılıyor…' : 'Yayına Başla'}
          </Button>
        </>
      }
    >
      {accessDenied && (
        <div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-text-muted">
          <p>Ekran paylaşmak için Sistem Ayarları'nda Diskort'a Ekran Kaydı izni ver, sonra uygulamayı yeniden başlat.</p>
          <Button onClick={() => void bridge?.screen.openAccessSettings()}>Sistem Ayarlarını Aç</Button>
        </div>
      )}
      {useCustomPicker && !accessDenied && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <TabButton active={tab === 'window'} onClick={() => setTab('window')} icon={<AppWindow size={16} className="ico-lift" />}>
              Uygulamalar
            </TabButton>
            <TabButton active={tab === 'screen'} onClick={() => setTab('screen')} icon={<Monitor size={16} className="ico-lift" />}>
              Ekranlar
            </TabButton>
            <button
              className="ml-auto rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-head"
              data-tooltip="Yenile"
              aria-label="Yenile"
              onClick={() => void load()}
            >
              <RefreshCw size={16} className={cn('ico-spin', loading && 'animate-spin')} />
            </button>
          </div>
          <div className="grid max-h-[330px] grid-cols-3 gap-3 overflow-y-auto pr-1">
            {visible.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s.id)}
                onDoubleClick={() => {
                  setSelected(s.id);
                  void start();
                }}
                className={cn(
                  'rounded-md p-1.5 text-left transition-colors',
                  selected === s.id ? 'bg-brand/30 ring-2 ring-brand' : 'bg-bg-side hover:bg-bg-hover',
                )}
              >
                <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-black">
                  {s.thumbnail ? (
                    <img src={s.thumbnail} alt="" className="h-full w-full object-contain" />
                  ) : (
                    <Monitor className="text-text-faint" />
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-sm">
                  {s.appIcon && <img src={s.appIcon} alt="" className="h-4 w-4" />}
                  <span className="truncate">{s.name}</span>
                </div>
              </button>
            ))}
            {!loading && visible.length === 0 && (
              <div className="col-span-3 py-10 text-center text-sm text-text-muted">Kaynak bulunamadı.</div>
            )}
          </div>
        </>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1.5 text-xs font-bold text-text-muted uppercase">Kalite</div>
          <Select<ScreenPresetId>
            aria-label="Yayın kalitesi"
            value={settings.screenPreset}
            onChange={(screenPreset) => settings.set({ screenPreset })}
            options={Object.entries(SCREEN_PRESETS).map(([value, p]) => ({
              value: value as ScreenPresetId,
              // Yayıncının yükleme hızı en az bu kadar olmalı (bant yetmezse WebRTC kendiliğinden düşürür)
              label: `${p.label} · ${p.bitrate / 1_000_000} Mbps`,
            }))}
          />
        </div>
        <div>
          <div className="mb-1.5 text-xs font-bold text-text-muted uppercase">İçerik</div>
          <Select
            aria-label="İçerik türü"
            value={settings.screenContent}
            onChange={(screenContent) => settings.set({ screenContent })}
            options={[
              { value: 'motion', label: 'Oyun / Video (akıcılık)' },
              { value: 'detail', label: 'Metin / Kod (netlik)' },
            ]}
          />
        </div>
      </div>
      {bridge?.screen.supportsAudio && (
        <div className="mt-2">
          <Toggle
            label="Sistem sesini paylaş"
            description="Oyun/video sesi yayına eklenir; sohbetteki sesler hariç tutulur."
            checked={settings.shareAudio}
            onChange={(shareAudio) => settings.set({ shareAudio })}
          />
        </div>
      )}
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-bg-active text-text-head' : 'text-text-muted hover:bg-bg-hover hover:text-text-normal',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/** Kartta görünecek ad: pencerenin başlığı ya da "Ekran 1", "Ekran 2"… */
function sourceLabel(
  sources: ScreenSource[],
  id: string | null,
): { sourceName?: string; sourceKind?: 'screen' | 'window'; sourceIcon?: string | null } {
  const source = sources.find((s) => s.id === id);
  if (!source) return {};
  if (source.kind === 'window') return { sourceName: source.name, sourceKind: 'window', sourceIcon: source.appIcon };
  const index = sources.filter((s) => s.kind === 'screen').indexOf(source);
  return { sourceName: `Ekran ${index + 1}`, sourceKind: 'screen' };
}
