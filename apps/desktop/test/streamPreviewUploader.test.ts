import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamPreviewUploader } from '../src/renderer/src/features/voice/streamPreviewUploader';

const reportStreamSource = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@diskort/client-core', () => ({
  ApiError: class extends Error {},
  reportStreamSource,
  uploadStreamPreview: vi.fn(),
}));

const track = { readyState: 'ended' } as unknown as MediaStreamTrack;

describe('yayın kaynağı bildirimi', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    reportStreamSource.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('kurulurken ve yeniden bildirilince aynı kaynak gönderilir', () => {
    const uploader = new StreamPreviewUploader(track, { name: 'Oyun', kind: 'window' });
    expect(reportStreamSource).toHaveBeenCalledTimes(1);
    uploader.reportSource();
    expect(reportStreamSource).toHaveBeenCalledTimes(2);
    expect(reportStreamSource).toHaveBeenLastCalledWith('Oyun', 'window');
    uploader.stop();
  });

  it('kaynak yoksa ya da yayın durduysa bildirilmez', () => {
    new StreamPreviewUploader(track, null).reportSource();
    expect(reportStreamSource).not.toHaveBeenCalled();
    const uploader = new StreamPreviewUploader(track, { name: 'Ekran', kind: 'screen' });
    uploader.stop();
    uploader.reportSource();
    expect(reportStreamSource).toHaveBeenCalledTimes(1);
  });

  it('sunucu reddederse sessizce yutulur', async () => {
    reportStreamSource.mockRejectedValueOnce(new Error('409'));
    const uploader = new StreamPreviewUploader(track, { name: 'Ekran', kind: 'screen' });
    await vi.advanceTimersByTimeAsync(0);
    uploader.stop();
  });
});
