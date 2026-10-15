/**
 * Küçük, en son kullanılanı tutan önbellek (giriş sesleri için: adres → çözülmüş ses). Aynı anahtar için
 * süren yükleme paylaşılır (aynı anda gelen iki giriş aynı dosyayı iki kez indirmez); başarısız yükleme
 * önbellekte kalmaz, bir sonraki istekte yeniden denenir.
 */
export interface PromiseLru<T> {
  get(key: string): Promise<T>;
  readonly size: number;
  has(key: string): boolean;
}

export function createPromiseLru<T>(max: number, load: (key: string) => Promise<T>): PromiseLru<T> {
  const entries = new Map<string, Promise<T>>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit) {
        // Map ekleme sırasını korur: sona taşınan en son kullanılan olur
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      const p = load(key);
      entries.set(key, p);
      p.catch(() => {
        if (entries.get(key) === p) entries.delete(key);
      });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return p;
    },
    get size() {
      return entries.size;
    },
    has(key) {
      return entries.has(key);
    },
  };
}
