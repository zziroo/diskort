/**
 * Shift basılıyken kökte `data-shift-held` durur; Shift ile onaysız çalışan düğmeler (`.shift-danger`) buna göre
 * dolu kırmızıya döner (styles.css). Durum React'e değil köke yazılır: Shift'e her basışta ekrandaki bütün mesajlar
 * yeniden çizilmez.
 */
export function installShiftHeld(): void {
  const root = document.documentElement;
  const sync = (e: KeyboardEvent | MouseEvent): void => {
    root.toggleAttribute('data-shift-held', e.shiftKey);
  };
  window.addEventListener('keydown', sync, true);
  window.addEventListener('keyup', sync, true);
  // Pencere arka plandayken basılan ya da bırakılan Shift, fare dönünce düzelir
  window.addEventListener('mousemove', sync, true);
  // Shift basılıyken pencereden çıkılırsa keyup gelmez
  window.addEventListener('blur', () => root.removeAttribute('data-shift-held'));
}
