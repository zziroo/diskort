import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { paths } = vi.hoisted(() => ({ paths: { userData: '' } }));

vi.mock('electron', () => ({
  app: { getPath: () => paths.userData },
}));

import { closeAction, launchModeFor, savedShowTrayIcon, saveShowTrayIcon } from '../src/main/trayIcon.js';

const win = { isMac: false };
const mac = { isMac: true };

describe('closeAction: pencere kapatılınca', () => {
  it('küçültme kapalıysa ya da uygulamadan çıkılıyorsa pencere kapanır', () => {
    for (const ctx of [win, mac]) {
      for (const hasTray of [true, false]) {
        expect(closeAction({ ...ctx, hasTray, isMinimized: false, quitting: false, minimizeToTray: false })).toBe('close');
        expect(closeAction({ ...ctx, hasTray, isMinimized: false, quitting: true, minimizeToTray: true })).toBe('close');
      }
    }
  });

  it('simge varken pencere gizlenir (bugünkü davranış)', () => {
    expect(closeAction({ ...win, hasTray: true, isMinimized: false, quitting: false, minimizeToTray: true })).toBe('hide');
    expect(closeAction({ ...mac, hasTray: true, isMinimized: false, quitting: false, minimizeToTray: true })).toBe('hide');
  });

  it('simge gizliyken Windows/Linux: gizlenmez, görev çubuğuna küçülür (geri dönüş yolu kalsın)', () => {
    expect(closeAction({ ...win, hasTray: false, isMinimized: false, quitting: false, minimizeToTray: true })).toBe('minimize');
  });

  it('simge gizliyken Windows/Linux: zaten küçültülmüş pencereye gelen kapatma gerçekten kapatır (çıkış yolu)', () => {
    expect(closeAction({ ...win, hasTray: false, isMinimized: true, quitting: false, minimizeToTray: true })).toBe('close');
    // simge varken ya da macOS'ta küçültülmüş pencere yine gizlenir
    expect(closeAction({ ...win, hasTray: true, isMinimized: true, quitting: false, minimizeToTray: true })).toBe('hide');
    expect(closeAction({ ...mac, hasTray: false, isMinimized: true, quitting: false, minimizeToTray: true })).toBe('hide');
  });

  it('simge gizliyken macOS: Dock simgesinden dönülebildiği için gizlenir, ses kesilmez', () => {
    expect(closeAction({ ...mac, hasTray: false, isMinimized: false, quitting: false, minimizeToTray: true })).toBe('hide');
  });
});

describe('launchModeFor: sessiz güncellemeden sonraki açılış', () => {
  it('simge gizliyken Windows/Linux: gizli açılış küçültülmüş açılışa döner', () => {
    expect(launchModeFor('hidden', { ...win, hasTray: false })).toBe('minimized');
    expect(launchModeFor('minimized', { ...win, hasTray: false })).toBe('minimized');
    expect(launchModeFor('normal', { ...win, hasTray: false })).toBe('normal');
  });

  it('simge varken ya da macOS\'ta gizli açılış korunur', () => {
    expect(launchModeFor('hidden', { ...win, hasTray: true })).toBe('hidden');
    expect(launchModeFor('hidden', { ...mac, hasTray: false })).toBe('hidden');
    expect(launchModeFor('hidden', { ...mac, hasTray: true })).toBe('hidden');
  });
});

describe('tepsi simgesi tercihinin saklanması', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'diskort-tray-'));
    paths.userData = root;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('kayıt yoksa simge gösterilir', () => {
    expect(savedShowTrayIcon()).toBe(true);
  });

  it('gizle ve göster kalıcıdır', () => {
    saveShowTrayIcon(false);
    expect(savedShowTrayIcon()).toBe(false);
    saveShowTrayIcon(true);
    expect(savedShowTrayIcon()).toBe(true);
  });

  it('bozuk kayıt simgeyi göstermeye düşer', () => {
    writeFileSync(join(paths.userData, 'tray-icon'), 'saçma');
    expect(savedShowTrayIcon()).toBe(true);
  });

  it('yazılamayan klasörde hata vermez', () => {
    paths.userData = join(root, 'yok', 'alt');
    expect(() => saveShowTrayIcon(false)).not.toThrow();
    expect(savedShowTrayIcon()).toBe(true);
  });
});
