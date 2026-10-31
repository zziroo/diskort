import { beforeEach, describe, expect, it, vi } from 'vitest';

const saved = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => void saved.set(key, value),
  removeItem: (key: string) => void saved.delete(key),
});

const { useSettings } = await import('../src/renderer/src/stores/settings.js');

/** Kayıtlı ayarı eski sürümden yükler ve depodaki sonucu döner */
async function loadFrom(version: number, state: Record<string, unknown>): Promise<Record<string, unknown>> {
  saved.set('diskort-settings', JSON.stringify({ state, version }));
  await useSettings.persist.rehydrate();
  return useSettings.getState() as unknown as Record<string, unknown>;
}

describe('ayar göçü: giriş sesi seviyesi → ses paneli seviyesi', () => {
  beforeEach(() => {
    useSettings.setState({ soundboardVolume: 1 });
  });

  it('eski değer taşınır, eski anahtar kalmaz', async () => {
    const state = await loadFrom(12, { introSoundVolume: 0.4 });
    expect(state.soundboardVolume).toBe(0.4);
    expect(state).not.toHaveProperty('introSoundVolume');
  });
  it('kapalı (0) kapalı kalır', async () => {
    expect((await loadFrom(12, { introSoundVolume: 0 })).soundboardVolume).toBe(0);
  });
  it('eski değeri olmayanda varsayılan kalır', async () => {
    expect((await loadFrom(11, {})).soundboardVolume).toBe(1);
  });
  it('aralık dışı değer 0–1 içine çekilir', async () => {
    expect((await loadFrom(12, { introSoundVolume: 1.8 })).soundboardVolume).toBe(1);
  });
});
