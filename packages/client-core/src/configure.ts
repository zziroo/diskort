import { setEnvironment, type ClientEnvironment } from './env';
import { useSession } from './session';

/**
 * Uygulama açılırken, arayüz çizilmeden önce bir kez çağrılır: platform ayrıntılarını verir ve
 * kayıtlı oturumu yükler. Masaüstünde (eşzamanlı depolama) oturum bu çağrı dönünce hazırdır;
 * mobilde (eşzamansız depolama) dönen söz tamamlanınca hazırdır.
 */
export function configureClient(environment: ClientEnvironment): Promise<void> {
  setEnvironment(environment);
  return useSession.persist.rehydrate() ?? Promise.resolve();
}
