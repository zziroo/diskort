import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Permission as P,
  SOUNDBOARD_MAX_SOUNDS,
  SOUNDBOARD_MIN_GAP_MS,
  SOUNDBOARD_SOUND_MAX_BYTES,
  type Channel,
  type GuildData,
  type GuildSound,
} from '@diskort/shared';
import type { IntroSoundTranscode } from '../src/introSounds.js';
import { parseSoundName } from '../src/routes/soundboard.js';
import { auth, connectGateway, startServer, type Account, type GatewayClient, type TestServer } from './helpers.js';

let s: TestServer;
let dir: string;
const clients: GatewayClient[] = [];
/** Sahte dönüştürücünün aldığı (başlangıç, süre) çiftleri */
let calls: [number, number][];

/** Sahte ffmpeg: "bozuk" ile başlayan girdi okunamaz; diğerleri etiketlenip döner (giriş sesi testindeki gibi) */
const fakeTranscode: IntroSoundTranscode = async (input, startSec, durationSec) => {
  calls.push([startSec, durationSec]);
  const text = input.toString();
  if (text.startsWith('bozuk')) throw new Error('Invalid data found when processing input');
  // Gerçek çıktı gibi 96 kb/sn: süre sunucuda çıktı boyutundan tahmin edilir
  const head = Buffer.from(`ID3 mp3 ${text}`);
  return text.startsWith('kisa') ? head : Buffer.concat([head, Buffer.alloc(Math.max(0, durationSec * 12000 - head.length))]);
};

beforeEach(async () => {
  calls = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-sounds-'));
  s = await startServer({ soundsDir: dir, introSoundTranscode: fakeTranscode });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.ws.close();
  await s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const files = () => fs.readdirSync(dir).sort();

const upload = (token: string | null, guildId: string, body: Buffer | string, query = '?name=Boru') =>
  s.app.inject({
    method: 'POST',
    url: `/api/guilds/${guildId}/sounds${query}`,
    headers: { ...(token ? auth(token) : {}), 'content-type': 'audio/mpeg' },
    payload: typeof body === 'string' ? Buffer.from(body) : body,
  });

const list = async (token: string, guildId = s.guildId): Promise<GuildSound[]> =>
  (await s.req(token, 'GET', `/api/guilds/${guildId}/sounds`)).json().sounds as GuildSound[];

/** Ses Panelini Yönet yetkili yeni üye */
async function manager(username: string): Promise<Account> {
  const account = await s.member(username);
  const role = await s.createRole(s.owner.token, { name: `${username}-rol`, permissions: P.MANAGE_SOUNDBOARD });
  expect(await s.giveRole(s.owner.token, account.user.id, role.id)).toBe(200);
  return account;
}

const connect = async (token: string): Promise<GatewayClient> => {
  const client = await connectGateway(s.app, token);
  clients.push(client);
  return client;
};

const play = (token: string, guildId: string, soundId: string) =>
  s.req(token, 'POST', '/api/voice/soundboard/play', { guildId, soundId });

/**
 * Saati dondurur, yalnız dönen işlevle ilerler (gerçek uyku yok): sınır testleri (süre-1 ms / süre) gerçek saatle
 * yarışmaz. Zamanlayıcılar gerçek kalır, yalnız Date.now taklit edilir; bekleme süreleri saniyelerle ölçüldüğü için
 * oturum belirteçleri etkilenmez.
 */
function advanceClock(): (ms: number) => void {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return (ms) => {
    now += ms;
  };
}

describe('ses paneli: ad temizliği ve süre', () => {
  it('görünmez karakterler silinir, uzunluk temizlikten sonra ölçülür', async () => {
    const mgr = await manager('temiz');
    const res = await upload(mgr.token, s.guildId, 'ses', `?name=${encodeURIComponent('\u200BBo\u202Eru\u0000 ' + '\u200B'.repeat(40) + ' Ses')}`);
    expect(res.statusCode).toBe(201);
    expect((res.json().sound as GuildSound).name).toBe('Boru Ses');
  });

  it('süre istenenden değil çıktı boyutundan tahmin edilir (en çok istenen süre)', async () => {
    const mgr = await manager('sure');
    // Sahte çıktı ~13 bayt: 100 ms'ye yuvarlanan en küçük süre
    const short = (await upload(mgr.token, s.guildId, 'kisa', '?name=Kisa&duration=4')).json().sound as GuildSound;
    expect(short.durationMs).toBe(100);
    // 96 kb/sn: 4 sn istenir, çıktı 4 sn'lik
    const full = (await upload(mgr.token, s.guildId, 'tam', '?name=Tam&duration=4')).json().sound as GuildSound;
    expect(full.durationMs).toBe(4000);
  });
});

describe('ses paneli: yönetim', () => {
  it('yükleme, liste, yeniden adlandırma ve silme; olaylar sunucu üyelerine gider', async () => {
    const mgr = await manager('yonetici');
    const member = await s.member('uye');
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const m = await connect(member.token);
    expect(m.ready.guilds[0]!.sounds).toEqual([]);

    const res = await upload(mgr.token, s.guildId, 'ses-1', '?name=%20Boru%20Sesi%20&emoji=%F0%9F%8E%BA&start=1.5&duration=2');
    expect(res.statusCode).toBe(201);
    const sound = res.json().sound as GuildSound;
    expect(sound).toMatchObject({
      guildId: s.guildId,
      name: 'Boru Sesi',
      emoji: '🎺',
      uploaderId: mgr.user.id,
      durationMs: 2000,
    });
    expect(sound.url).toMatch(new RegExp(`^/api/sounds/${s.guildId}/[0-9a-f]{32}\\.mp3$`));
    expect(calls).toEqual([[1.5, 2]]);
    expect(files()).toHaveLength(1);

    // Varsayılanlar: emoji yok, baştan 5 sn
    const second = (await upload(mgr.token, s.guildId, 'ses-2', '?name=Alkis')).json().sound as GuildSound;
    expect(second).toMatchObject({ emoji: null, durationMs: 5000 });
    expect(calls[1]).toEqual([0, 5]);

    // Liste ada göre sıralı, üyeye açık
    expect((await list(member.token)).map((x) => x.name)).toEqual(['Alkis', 'Boru Sesi']);
    // Kimliksiz liste yok, üye olmayan görmez
    expect((await s.app.inject({ method: 'GET', url: `/api/guilds/${s.guildId}/sounds` })).statusCode).toBe(401);

    const renamed = await s.req(mgr.token, 'PATCH', `/api/guilds/${s.guildId}/sounds/${sound.id}`, { name: 'Trompet', emoji: null });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().sound).toMatchObject({ id: sound.id, name: 'Trompet', emoji: null, url: sound.url });
    const onlyEmoji = await s.req(mgr.token, 'PATCH', `/api/guilds/${s.guildId}/sounds/${sound.id}`, { emoji: '👏' });
    expect(onlyEmoji.json().sound).toMatchObject({ name: 'Trompet', emoji: '👏' });
    expect((await s.req(mgr.token, 'PATCH', `/api/guilds/${s.guildId}/sounds/yok`, { name: 'x' })).statusCode).toBe(404);

    const del = await s.req(mgr.token, 'DELETE', `/api/guilds/${s.guildId}/sounds/${sound.id}`);
    expect(del.statusCode).toBe(204);
    expect((await s.req(mgr.token, 'DELETE', `/api/guilds/${s.guildId}/sounds/${sound.id}`)).statusCode).toBe(404);
    expect((await list(member.token)).map((x) => x.id)).toEqual([second.id]);
    expect(files()).toHaveLength(1);

    await m.settle();
    expect(m.of('GUILD_SOUND_CREATE').map((d) => d.sound.name)).toEqual(['Boru Sesi', 'Alkis']);
    expect(m.of('GUILD_SOUND_UPDATE').map((d) => [d.sound.name, d.sound.emoji])).toEqual([
      ['Trompet', null],
      ['Trompet', '👏'],
    ]);
    expect(m.of('GUILD_SOUND_DELETE')).toEqual([{ guildId: s.guildId, soundId: sound.id }]);

    // READY ve GUILD_CREATE sesleri taşır
    const again = await connect(member.token);
    expect(again.ready.guilds[0]!.sounds.map((x) => x.id)).toEqual([second.id]);
    const created = (await s.req(member.token, 'POST', '/api/guilds', { name: 'Yeni' })).json() as GuildData;
    expect(created.sounds).toEqual([]);
  });

  it('kimliksiz sunum: önbellek başlıkları, ETag, Range; silinen ve başka sunucunun özeti 404', async () => {
    const mgr = await manager('yonetici');
    const sound = (await upload(mgr.token, s.guildId, 'kisa-1')).json().sound as GuildSound;

    const served = await s.app.inject({ method: 'GET', url: sound.url });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('audio/mpeg');
    expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(served.headers['accept-ranges']).toBe('bytes');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.body).toBe('ID3 mp3 kisa-1');
    const etag = served.headers.etag as string;
    expect((await s.app.inject({ method: 'GET', url: sound.url, headers: { 'if-none-match': etag } })).statusCode).toBe(304);

    const part = await s.app.inject({ method: 'GET', url: sound.url, headers: { range: 'bytes=0-2' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-2/${'ID3 mp3 kisa-1'.length}`);
    expect(part.body).toBe('ID3');
    expect((await s.app.inject({ method: 'GET', url: sound.url, headers: { range: 'bytes=999-' } })).statusCode).toBe(416);

    const file = sound.url.split('/').pop()!;
    expect((await s.app.inject({ method: 'GET', url: `/api/sounds/baska/${file}` })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: `/api/sounds/${s.guildId}/../x.mp3` })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: `/api/sounds/${s.guildId}/${'a'.repeat(32)}.mp3` })).statusCode).toBe(404);

    await s.req(mgr.token, 'DELETE', `/api/guilds/${s.guildId}/sounds/${sound.id}`);
    expect((await s.app.inject({ method: 'GET', url: sound.url })).statusCode).toBe(404);
    expect(files()).toEqual([]);
  });

  it('yetki: yükleme ve düzenleme MANAGE_SOUNDBOARD ister; silmeyi hesap yöneticisi de yapar', async () => {
    const mgr = await manager('yonetici');
    const member = await s.member('uye');
    // Üye olmayan (hesap daveti var, sunucuya katılmamış): sunucu yokmuş gibi
    const code = (await s.req(s.owner.token, 'POST', '/api/invites', {})).json().code as string;
    const outsider = (
      await s.app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'disardan', password: 'sifre12345' } })
    ).json() as Account;

    expect((await upload(member.token, s.guildId, 'ses')).statusCode).toBe(403);
    expect((await upload(null, s.guildId, 'ses')).statusCode).toBe(401);
    const sound = (await upload(mgr.token, s.guildId, 'ses')).json().sound as GuildSound;
    expect((await s.req(member.token, 'PATCH', `/api/guilds/${s.guildId}/sounds/${sound.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await s.req(member.token, 'DELETE', `/api/guilds/${s.guildId}/sounds/${sound.id}`)).statusCode).toBe(403);
    expect((await s.req(outsider.token, 'GET', `/api/guilds/${s.guildId}/sounds`)).statusCode).toBe(404);

    // Hesap yöneticisi (sunucuda yetkisi olmayan üye) sesi kaldırabilir ama yükleyemez
    expect(s.ctx.store.setAdmin(member.user.id, true)).toBe('ok');
    expect((await upload(member.token, s.guildId, 'ses')).statusCode).toBe(403);
    expect((await s.req(member.token, 'DELETE', `/api/guilds/${s.guildId}/sounds/${sound.id}`)).statusCode).toBe(204);
    expect(files()).toEqual([]);
    // Sahip her şeyi yapabilir
    expect((await upload(s.owner.token, s.guildId, 'ses')).statusCode).toBe(201);

    // Üye olmayan: yönetici değilse 404 (sunucunun varlığı sızmaz), hesap yöneticisiyse silebilir
    const target = (await upload(mgr.token, s.guildId, 'ses-x', '?name=Hedef')).json().sound as GuildSound;
    expect((await s.req(outsider.token, 'DELETE', `/api/guilds/${s.guildId}/sounds/${target.id}`)).statusCode).toBe(404);
    expect(s.ctx.store.setAdmin(outsider.user.id, true)).toBe('ok');
    expect((await s.req(outsider.token, 'DELETE', `/api/guilds/${s.guildId}/sounds/${target.id}`)).statusCode).toBe(204);
  });

  it('doğrulama: ad, emoji, başlangıç, süre, boş ve okunamayan dosya, boyut', async () => {
    const mgr = await manager('yonetici');
    const bad = async (query: string, code: string, body: Buffer | string = 'ses') => {
      const res = await upload(mgr.token, s.guildId, body, query);
      expect([query, res.statusCode, res.json().error]).toEqual([query, code === 'too_large' ? 413 : 400, code]);
    };
    await bad('', 'invalid_name');
    await bad('?name=%20%20', 'invalid_name');
    // Yalnızca görünmez/kontrol karakterlerinden oluşan ad boş sayılır
    await bad('?name=%E2%80%8B', 'invalid_name'); // U+200B
    await bad('?name=%E2%80%AE', 'invalid_name'); // U+202E
    await bad('?name=%00', 'invalid_name'); // NUL
    await bad('?name=%E2%80%8B%20%00%20', 'invalid_name');
    await bad(`?name=${'a'.repeat(33)}`, 'invalid_name');
    await bad('?name=x&emoji=ab', 'invalid_emoji');
    await bad('?name=x&emoji=%F0%9F%8E%BA%F0%9F%8E%BA', 'invalid_emoji');
    await bad('?name=x&start=-1', 'invalid_start');
    await bad('?name=x&duration=9', 'invalid_duration');
    await bad('?name=x', 'unsupported', 'bozuk dosya');
    await bad('?name=x', 'empty', Buffer.alloc(0));
    await bad('?name=x', 'too_large', Buffer.alloc(SOUNDBOARD_SOUND_MAX_BYTES + 1, 1));
    expect(files()).toEqual([]);
    const ok = await upload(mgr.token, s.guildId, 'ses', `?name=${'a'.repeat(32)}&emoji=%E2%9D%A4`);
    expect(ok.statusCode).toBe(201);
    expect((ok.json().sound as GuildSound).emoji).toBe('❤️');
    const patch = await s.req(mgr.token, 'PATCH', `/api/guilds/${s.guildId}/sounds/${ok.json().sound.id}`, { name: '' });
    expect([patch.statusCode, patch.json().error]).toEqual([400, 'invalid_name']);
    const patchEmoji = await s.req(mgr.token, 'PATCH', `/api/guilds/${s.guildId}/sounds/${ok.json().sound.id}`, { emoji: 'x' });
    expect([patchEmoji.statusCode, patchEmoji.json().error]).toEqual([400, 'invalid_emoji']);
  });

  it(`sınır: sunucu başına ${SOUNDBOARD_MAX_SOUNDS} ses, fazlası 409`, async () => {
    const mgr = await manager('yonetici');
    for (let i = 0; i < SOUNDBOARD_MAX_SOUNDS - 1; i++) {
      const r = s.ctx.store.insertSound(
        s.guildId,
        { name: `s${i}`, emoji: null, hash: i.toString(16).padStart(32, '0'), size: 10, durationMs: 1000, uploaderId: null },
        SOUNDBOARD_MAX_SOUNDS,
      );
      expect(r).not.toBe('limit');
    }
    expect((await upload(mgr.token, s.guildId, 'son')).statusCode).toBe(201);
    const over = await upload(mgr.token, s.guildId, 'fazla');
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ error: 'sound_limit', message: `Sunucuda en çok ${SOUNDBOARD_MAX_SOUNDS} ses olabilir.` });
    expect(files()).toHaveLength(1);
    expect(s.ctx.store.countSounds(s.guildId)).toBe(SOUNDBOARD_MAX_SOUNDS);
  });

  it('hız sınırı: 10 dakikada 10 değişiklik (yükleme ve silme birlikte)', async () => {
    const mgr = await manager('yonetici');
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const res = await upload(mgr.token, s.guildId, `ses-${i}`, `?name=s${i}`);
      expect(res.statusCode).toBe(201);
      ids.push(res.json().sound.id as string);
    }
    expect((await s.req(mgr.token, 'DELETE', `/api/guilds/${s.guildId}/sounds/${ids[0]}`)).statusCode).toBe(204);
    const limited = await upload(mgr.token, s.guildId, 'ses-x', '?name=x');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
    expect((await s.req(mgr.token, 'DELETE', `/api/guilds/${s.guildId}/sounds/${ids[1]}`)).statusCode).toBe(429);
    // Yeniden adlandırma sayılmaz
    expect((await s.req(mgr.token, 'PATCH', `/api/guilds/${s.guildId}/sounds/${ids[1]}`, { name: 'y' })).statusCode).toBe(200);
  });

  it('sunucu silinince dosyalar silinir; temizlik artık dosyaları siler', async () => {
    const mgr = await manager('yonetici');
    const other = (await s.req(mgr.token, 'POST', '/api/guilds', { name: 'İkinci' })).json() as GuildData;
    const sound = (await upload(mgr.token, other.guild.id, 'ikinci-ses')).json().sound as GuildSound;
    const kept = (await upload(mgr.token, s.guildId, 'ana-ses')).json().sound as GuildSound;
    expect(files()).toHaveLength(2);

    fs.writeFileSync(path.join(dir, `${'b'.repeat(32)}.mp3`), 'artık');
    fs.writeFileSync(path.join(dir, `${'c'.repeat(16)}.tmp`), 'yarım');
    fs.writeFileSync(path.join(dir, 'baska-dosya.txt'), 'dokunma');
    expect(await s.ctx.soundboard.sweep()).toBe(0); // henüz taze
    expect(await s.ctx.soundboard.sweep(Date.now() + 2 * 3_600_000)).toBe(2);
    expect(files()).toHaveLength(3);

    expect((await s.req(mgr.token, 'DELETE', `/api/guilds/${other.guild.id}`)).statusCode).toBe(204);
    expect((await s.app.inject({ method: 'GET', url: sound.url })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: kept.url })).statusCode).toBe(200);
    expect(files()).toEqual([`${kept.url.split('/').pop()}`, 'baska-dosya.txt'].sort());
  });
});

describe('ses paneli: çalma', () => {
  it('olay yalnızca o ses kanalındakilere gider (çalan dahil); seste değilken 409', async () => {
    const mgr = await manager('yonetici');
    const listener = await s.member('dinleyen');
    const watcher = await s.member('bakan');
    const sound = (await upload(mgr.token, s.guildId, 'ses')).json().sound as GuildSound;
    const voice = s.channel('voice');
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const [p, l, w] = await Promise.all([connect(mgr.token), connect(listener.token), connect(watcher.token)]);

    expect((await play(mgr.token, s.guildId, sound.id)).json()).toMatchObject({ error: 'not_in_voice' });
    s.ctx.voice.join(mgr.user.id, voice.id);
    s.ctx.voice.join(listener.user.id, voice.id);

    expect((await play(mgr.token, s.guildId, sound.id)).statusCode).toBe(204);
    await p.settle();
    const expected = { channelId: voice.id, guildId: s.guildId, userId: mgr.user.id, sound };
    expect(p.of('SOUNDBOARD_PLAY')).toEqual([expected]);
    expect(l.of('SOUNDBOARD_PLAY')).toEqual([expected]);
    expect(w.of('SOUNDBOARD_PLAY')).toEqual([]);

    // Geçersiz gövde ve bilinmeyen ses
    expect((await play(mgr.token, s.guildId, 'yok')).json()).toMatchObject({ error: 'unknown_sound' });
    expect((await s.req(mgr.token, 'POST', '/api/voice/soundboard/play', { guildId: s.guildId })).statusCode).toBe(400);
  });

  it('susturulmuş, sağırlaştırılmış ya da kendini sağırlaştırmış çalamaz; Konuş yetkisi gerekir', async () => {
    const mgr = await manager('yonetici');
    const member = await s.member('uye');
    const sound = (await upload(mgr.token, s.guildId, 'ses')).json().sound as GuildSound;
    const voice = s.channel('voice');
    s.ctx.voice.join(member.user.id, voice.id);
    const advance = advanceClock();
    expect((await play(member.token, s.guildId, sound.id)).statusCode).toBe(204);
    advance(sound.durationMs);

    await s.ctx.moderation.setServerFlags(s.guildId, member.user.id, { serverMute: true, serverDeaf: false });
    const muted = await play(member.token, s.guildId, sound.id);
    expect([muted.statusCode, muted.json().error]).toEqual([403, 'muted']);
    await s.ctx.moderation.setServerFlags(s.guildId, member.user.id, { serverMute: false, serverDeaf: true });
    expect((await play(member.token, s.guildId, sound.id)).statusCode).toBe(403);
    await s.ctx.moderation.setServerFlags(s.guildId, member.user.id, { serverMute: false, serverDeaf: false });

    s.ctx.voice.setSelf(member.user.id, { selfMute: false, selfDeaf: true });
    expect((await play(member.token, s.guildId, sound.id)).statusCode).toBe(403);
    s.ctx.voice.setSelf(member.user.id, { selfMute: true, selfDeaf: false });
    expect((await play(member.token, s.guildId, sound.id)).statusCode).toBe(204);

    // Kanalda Konuş yetkisi kaldırılınca
    const res = await s.req(s.owner.token, 'PATCH', `/api/channels/${voice.id}`, {
      overwrites: [{ roleId: s.guildId, allow: 0, deny: P.SPEAK }],
    });
    expect(res.statusCode).toBe(200);
    advance(sound.durationMs);
    expect((await play(member.token, s.guildId, sound.id)).statusCode).toBe(403);
  });

  it('başka sunucunun sesi üyeyse çalınır, değilse 404', async () => {
    const mgr = await manager('yonetici');
    const listener = await s.member('dinleyen');
    const other = (await s.req(mgr.token, 'POST', '/api/guilds', { name: 'İkinci' })).json() as GuildData;
    const sound = (await upload(mgr.token, other.guild.id, 'ikinci-ses')).json().sound as GuildSound;
    const voice = s.channel('voice');
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const l = await connect(listener.token);
    s.ctx.voice.join(mgr.user.id, voice.id);
    s.ctx.voice.join(listener.user.id, voice.id);

    // Dinleyen ikinci sunucunun üyesi değil: kendisi çalamaz ama olayı tam nesneyle alır
    expect((await play(listener.token, other.guild.id, sound.id)).json()).toMatchObject({ error: 'unknown_sound' });
    expect((await play(mgr.token, other.guild.id, sound.id)).statusCode).toBe(204);
    await l.settle();
    expect(l.of('SOUNDBOARD_PLAY')).toEqual([{ channelId: voice.id, guildId: other.guild.id, userId: mgr.user.id, sound }]);
  });
});

describe('ses paneli: çalma beklemesi', () => {
  /** Yönetici ve dinleyen aynı ses kanalında, iki ses yüklü (5 sn ve çok kısa) */
  async function setup() {
    const mgr = await manager('yonetici');
    const listener = await s.member('dinleyen');
    const long = (await upload(mgr.token, s.guildId, 'uzun', '?name=Uzun')).json().sound as GuildSound;
    const short = (await upload(mgr.token, s.guildId, 'kisa', '?name=Kisa')).json().sound as GuildSound;
    expect([long.durationMs, short.durationMs]).toEqual([5000, 100]);
    const voice = s.channel('voice');
    s.ctx.voice.join(mgr.user.id, voice.id);
    s.ctx.voice.join(listener.user.id, voice.id);
    return { mgr, listener, long, short, advance: advanceClock() };
  }

  it('ses bitmeden ikinci çalma 429, farklı ses de bekler; süre dolunca 204', async () => {
    const { mgr, long, short, advance } = await setup();
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(204);

    const again = await play(mgr.token, s.guildId, long.id);
    expect([again.statusCode, again.json().error]).toEqual([429, 'rate_limited']);
    expect(again.json().message).toBe('Sesin bitmeden yeni ses çalamazsın.');
    expect((await play(mgr.token, s.guildId, short.id)).statusCode).toBe(429);

    advance(long.durationMs - 1000);
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(429);
    advance(1000);
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(204);
  });

  it(`kısa ses de en az ${SOUNDBOARD_MIN_GAP_MS} ms bekletir`, async () => {
    const { mgr, short, advance } = await setup();
    expect((await play(mgr.token, s.guildId, short.id)).statusCode).toBe(204);
    advance(short.durationMs);
    expect((await play(mgr.token, s.guildId, short.id)).statusCode).toBe(429);
    advance(SOUNDBOARD_MIN_GAP_MS - short.durationMs);
    expect((await play(mgr.token, s.guildId, short.id)).statusCode).toBe(204);
  });

  it('başka kullanıcı aynı anda çalabilir', async () => {
    const { mgr, listener, long, short } = await setup();
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(204);
    expect((await play(listener.token, s.guildId, short.id)).statusCode).toBe(204);
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(429);
  });

  it('reddedilen çalma beklemeyi uzatmaz ve başlatmaz', async () => {
    const { mgr, long, advance } = await setup();
    // Bilinmeyen sesle reddedilen istek beklemeyi başlatmaz
    expect((await play(mgr.token, s.guildId, 'yok')).statusCode).toBe(404);
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(204);
    // Bekleme sırasındaki 429'lar bitiş anını ileri almaz
    advance(long.durationMs - 1);
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(429);
    advance(1);
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(204);
  });

  it('kanal değiştirmek beklemeyi sıfırlamaz', async () => {
    const { mgr, long } = await setup();
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(204);
    const other = (await s.req(s.owner.token, 'POST', `/api/guilds/${s.guildId}/channels`, { name: 'ikinci', type: 'voice' })).json() as Channel;
    s.ctx.voice.join(mgr.user.id, other.id);
    expect((await play(mgr.token, s.guildId, long.id)).statusCode).toBe(429);
  });
});

describe('parseSoundName', () => {
  it('sekme ve satır sonu boşluğa iner, görünmez karakterler silinir', () => {
    expect(parseSoundName('Boru\tSes')).toBe('Boru Ses');
    expect(parseSoundName('iki\nsatir')).toBe('iki satir');
    expect(parseSoundName('  Bo\u200Bru \u202ESes\u0000 ')).toBe('Boru Ses');
  });

  it('emoji birleştiricisi korunur, yalnız görünmezlerden oluşan ad geçersizdir', () => {
    expect(parseSoundName('👩\u200D💻 Ses')).toBe('👩\u200D💻 Ses');
    expect(parseSoundName('\u200D')).toBeNull();
    expect(parseSoundName('\u200B \u0000')).toBeNull();
    expect(parseSoundName('x'.repeat(33))).toBeNull();
  });
});
