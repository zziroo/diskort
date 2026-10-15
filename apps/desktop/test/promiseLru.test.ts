import { describe, expect, it, vi } from 'vitest';
import { createPromiseLru } from '../src/renderer/src/lib/promiseLru';

describe('createPromiseLru', () => {
  it('aynı anahtarı bir kez yükler', async () => {
    const load = vi.fn(async (k: string) => k.toUpperCase());
    const lru = createPromiseLru(2, load);
    expect(await lru.get('a')).toBe('A');
    expect(await lru.get('a')).toBe('A');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('sınırı aşınca en eski kullanılanı atar', async () => {
    const load = vi.fn(async (k: string) => k);
    const lru = createPromiseLru(2, load);
    await lru.get('a');
    await lru.get('b');
    await lru.get('a'); // a en son kullanılan olur
    await lru.get('c'); // b atılır
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('c')).toBe(true);
    expect(lru.size).toBe(2);
  });

  it('başarısız yüklemeyi tutmaz', async () => {
    let fail = true;
    const load = vi.fn(async (k: string) => {
      if (fail) throw new Error('yok');
      return k;
    });
    const lru = createPromiseLru(4, load);
    await expect(lru.get('a')).rejects.toThrow('yok');
    expect(lru.has('a')).toBe(false);
    fail = false;
    expect(await lru.get('a')).toBe('a');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
