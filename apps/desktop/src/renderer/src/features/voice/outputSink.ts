// Çıkış aygıtı çözümleme: kayıtlı aygıt artık yoksa ya da 'default' ise sistem varsayılanı kullanılır.
// Böylece setSinkId reddi (kaybolmuş aygıt) her attach'te hata üretmez.

/**
 * Kayıtlı çıkış aygıtı kimliğini uygulanacak sink kimliğine çevirir. 'default'/boş ya da sistemde artık
 * olmayan aygıt → '' (sistem varsayılanı; LiveKit somut aygıta sabitlemesin). Aygıt listesi okunamazsa
 * kayıtlı kimlik olduğu gibi döner.
 */
export async function resolveOutputSink(deviceId: string): Promise<string> {
  if (!deviceId || deviceId === 'default') return '';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    // İzin verilmemişken Chromium kayıtları boş deviceId ile döndürebilir ya da hiç döndürmeyebilir:
    // liste güvenilmez, kayıtlı kimlik olduğu gibi kalır
    if (outputs.length === 0 || outputs.some((d) => d.deviceId === '')) return deviceId;
    return outputs.some((d) => d.deviceId === deviceId) ? deviceId : '';
  } catch {
    return deviceId;
  }
}
