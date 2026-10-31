import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOUNDBOARD_MIN_GAP_MS, soundboardCooldownMs } from '@diskort/shared';
import { api, ApiError } from '../src/api';
import { playGuildSound, useSoundboardCooldown } from '../src/soundboard';

const cooling = (): boolean => useSoundboardCooldown.getState().cooling;
const sound = (durationMs: number) => ({ guildId: 'g1', id: 's1', durationMs });

describe('soundboardCooldownMs', () => {
  it('sesin süresi kadardır, kısa seste taban uygulanır', () => {
    expect(soundboardCooldownMs(5000)).toBe(5000);
    expect(soundboardCooldownMs(SOUNDBOARD_MIN_GAP_MS)).toBe(SOUNDBOARD_MIN_GAP_MS);
    expect(soundboardCooldownMs(100)).toBe(SOUNDBOARD_MIN_GAP_MS);
    expect(soundboardCooldownMs(0)).toBe(SOUNDBOARD_MIN_GAP_MS);
  });
});

describe('playGuildSound', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('başarıda bekleme başlar, ses bitince biter', async () => {
    const send = vi.spyOn(api, 'playGuildSound').mockResolvedValue(undefined);
    await playGuildSound(sound(3000));
    expect(send).toHaveBeenCalledWith('g1', 's1');
    expect(cooling()).toBe(true);
    vi.advanceTimersByTime(2999);
    expect(cooling()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(cooling()).toBe(false);
  });

  it('kısa seste bekleme tabana uyar', async () => {
    vi.spyOn(api, 'playGuildSound').mockResolvedValue(undefined);
    await playGuildSound(sound(100));
    vi.advanceTimersByTime(SOUNDBOARD_MIN_GAP_MS - 1);
    expect(cooling()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(cooling()).toBe(false);
  });

  it('bekleme yanıttan sonra başlar, hata halinde başlamaz', async () => {
    let finish!: () => void;
    vi.spyOn(api, 'playGuildSound').mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const pending = playGuildSound(sound(3000));
    expect(cooling()).toBe(false);
    finish();
    await pending;
    expect(cooling()).toBe(true);
    vi.runOnlyPendingTimers();

    vi.spyOn(api, 'playGuildSound').mockRejectedValue(new ApiError(429, 'rate_limited', 'Sesin bitmeden yeni ses çalamazsın.'));
    await expect(playGuildSound(sound(3000))).rejects.toBeInstanceOf(ApiError);
    expect(cooling()).toBe(false);
  });

  it('yeni çalma tek zamanlayıcıyı yeniler', async () => {
    vi.spyOn(api, 'playGuildSound').mockResolvedValue(undefined);
    await playGuildSound(sound(3000));
    vi.advanceTimersByTime(2000);
    await playGuildSound(sound(3000));
    vi.advanceTimersByTime(2000);
    expect(cooling()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(cooling()).toBe(false);
  });
});
