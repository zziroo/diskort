import { afterEach, describe, expect, it, vi } from 'vitest';

const reported = vi.hoisted(() => [] as { message: string; where: string }[]);
vi.mock('../src/errors', () => ({
  reportClientError: (err: Error, where: string) => reported.push({ message: err.message, where }),
}));

import { reportVoiceLog, SpuriousDuplicateGuard } from '../src/voiceDiagnostics';

afterEach(() => vi.useRealTimers());

describe('yeniden bağlanma sonrası "başka cihaz" uyarısı', () => {
  it('yalnızca yeniden bağlanmanın hemen ardından ve dakikada bir kez sessizce geri döner', () => {
    vi.useFakeTimers();
    const guard = new SpuriousDuplicateGuard();
    // Yeniden bağlanma olmadan: gerçekten başka cihaz
    expect(guard.shouldRejoin(true)).toBe(false);

    guard.noteReconnect();
    expect(guard.shouldRejoin(false)).toBe(false); // başka bir kopuş nedeni
    expect(guard.shouldRejoin(true)).toBe(true);
    // Hemen tekrar olursa döngüye girilmez
    guard.noteReconnect();
    expect(guard.shouldRejoin(true)).toBe(false);

    // 30 saniyeden eski yeniden bağlanma sayılmaz
    vi.advanceTimersByTime(61_000);
    expect(guard.shouldRejoin(true)).toBe(false);
    guard.noteReconnect();
    expect(guard.shouldRejoin(true)).toBe(true);
  });
});

describe('LiveKit uyarılarının bildirimi', () => {
  it('sesten çıktıktan sonra eski bağlantının uyarıları bildirilmez; seste bildirilir', () => {
    reported.length = 0;
    reportVoiceLog(3, 3, 'ping timeout triggered. last pong received at: …', { room: 'ch_x' }, false);
    expect(reported).toEqual([]);
    reportVoiceLog(3, 3, 'ping timeout triggered', undefined, true);
    expect(reported).toHaveLength(1);
    // Başka türden hatalar seste olmasa da bildirilir; uyarı seviyesinin altı hiç bildirilmez
    reportVoiceLog(4, 3, 'could not publish track', undefined, false);
    reportVoiceLog(2, 3, 'ping timeout', undefined, true);
    expect(reported.map((r) => r.message)).toEqual(['ping timeout triggered', 'could not publish track']);
    expect(reported.every((r) => r.where === 'livekit')).toBe(true);
  });

  it('Error/DOMException bağlamı tür ve iletiyle yazılır ({} değil)', () => {
    reported.length = 0;
    reportVoiceLog(4, 3, 'Failed to set sink id', new DOMException('aygıt yok', 'NotFoundError'), true);
    expect(reported[0]?.message).toBe('Failed to set sink id NotFoundError: aygıt yok');
  });
});
