import { describe, expect, it } from 'vitest';
import { ApiError } from '@diskort/client-core';
import { SOUNDBOARD_NAME_MAX } from '@diskort/shared';
import { defaultSoundName, soundUploadError } from '../src/renderer/src/components/sounds/soundUploadView.js';

describe('defaultSoundName', () => {
  it('yalnız son uzantıyı atar', () => {
    expect(defaultSoundName('korna.mp3')).toBe('korna');
    expect(defaultSoundName('ses.son.hali.wav')).toBe('ses.son.hali');
    expect(defaultSoundName('uzantisiz')).toBe('uzantisiz');
  });

  it('adı en çok sınıra kısaltır ve boşlukla bitirmez', () => {
    expect(defaultSoundName(`${'a'.repeat(50)}.mp3`)).toHaveLength(SOUNDBOARD_NAME_MAX);
    expect(defaultSoundName(`${'a'.repeat(SOUNDBOARD_NAME_MAX - 1)} b.mp3`)).toBe('a'.repeat(SOUNDBOARD_NAME_MAX - 1));
  });

  it('emojiyi ortadan bölmez', () => {
    const name = defaultSoundName(`${'a'.repeat(SOUNDBOARD_NAME_MAX - 1)}🎺.mp3`);
    expect(name).toBe('a'.repeat(SOUNDBOARD_NAME_MAX - 1));
  });

  it('adı olmayan dosyada boş döner', () => {
    expect(defaultSoundName('.mp3')).toBe('');
  });
});

describe('soundUploadError', () => {
  it('bilinen kodları Türkçe metne çevirir', () => {
    expect(soundUploadError(new ApiError(409, 'sound_limit', 'x'))).toBe('Sunucuda en çok 64 ses olabilir.');
    expect(soundUploadError(new ApiError(413, 'too_large', 'x'))).toBe("Dosya 8 MB'tan büyük olamaz.");
    expect(soundUploadError(new ApiError(400, 'unsupported', 'x'))).toBe('Bu ses dosyası okunamadı.');
    expect(soundUploadError(new ApiError(429, 'rate_limited', 'x'))).toBe('Çok sık ses yüklüyorsun, biraz bekle.');
    expect(soundUploadError(new ApiError(507, 'no_space', 'x'))).toBe('Sunucuda yer kalmadı.');
    expect(soundUploadError(new ApiError(503, 'unavailable', 'x'))).toBe('Ses işleme şu an kapalı.');
  });

  it('diğer hatalarda ApiError iletisini gösterir', () => {
    expect(soundUploadError(new ApiError(400, 'invalid_name', 'Ses adı uygun değil.'))).toBe('Ses adı uygun değil.');
    expect(soundUploadError(new Error('Bağlantı koptu'))).toBe('Bağlantı koptu');
  });
});
