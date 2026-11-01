import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { Permission as P, STREAM_PREVIEW_MAX_BYTES, type Channel } from '@diskort/shared';
import { sanitizeSourceName } from '../src/streamPreview.js';
import { auth, connectGateway, startServer, type Account, type GatewayClient, type TestServer } from './helpers.js';

let s: TestServer;
const clients: GatewayClient[] = [];

beforeEach(async () => {
  s = await startServer();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await s.close();
});

async function frame(width = 1920, height = 1080): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function upload(token: string, body: Buffer, type = 'image/jpeg') {
  return s.app.inject({
    method: 'PUT',
    url: '/api/voice/stream-preview',
    headers: { ...auth(token), 'content-type': type },
    payload: body,
  });
}

function fetchPreview(token: string, channelId: string, userId: string) {
  return s.app.inject({ method: 'GET', url: `/api/voice/${channelId}/stream-preview/${userId}`, headers: auth(token) });
}

/** Sahip ana sunucunun ses kanalında yayında */
function startStreaming(account: Account = s.owner, channel: Channel = s.channel('voice')): void {
  s.ctx.voice.join(account.user.id, channel.id);
  s.ctx.voice.setStreaming(account.user.id, channel.id, true);
}

describe('yayın önizlemesi', () => {
  it('yayıncı kare yükler; küçültülmüş WebP kanalı görebilenlere sunulur ve ses durumuna zamanı eklenir', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    startStreaming();
    expect(s.ctx.voice.get(s.owner.user.id)?.streamStartedAt).toBeTypeOf('number');

    const res = await upload(s.owner.token, await frame());
    expect(res.statusCode).toBe(200);
    const at = res.json().at as number;
    expect(s.ctx.voice.get(s.owner.user.id)?.streamPreviewAt).toBe(at);

    const got = await fetchPreview(member.token, voice.id, s.owner.user.id);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/webp');
    expect(got.headers['cache-control']).toContain('no-store');
    const meta = await sharp(got.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(270);
  });

  it('SVG ve GIF, başlık ne derse desin çözücüye ulaşmaz; PNG ve WebP geçer', async () => {
    startStreaming();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    const base = sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 40, b: 40 } } });
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      const res = await upload(s.owner.token, svg, type);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_image');
    }
    expect((await upload(s.owner.token, await base.clone().gif().toBuffer(), 'image/png')).statusCode).toBe(400);
    expect((await upload(s.owner.token, await base.clone().png().toBuffer(), 'image/png')).statusCode).toBe(200);
    expect((await upload(s.owner.token, await base.clone().webp().toBuffer(), 'image/webp')).statusCode).toBe(200);
    // Süreç geneli engel: kapıdan kaçan bir yol olsa da sharp SVG açmaz
    await expect(sharp(svg).png().toBuffer()).rejects.toThrow();
  });

  it('başka sunucunun üyesi, kanalı göremeyen ve yayında olmayan için 404', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    // Başka sunucu: yalnızca hesap daveti, sonra kendi sunucusunu kurar
    const code = (await s.req(s.owner.token, 'POST', '/api/invites', {})).json().code as string;
    const outsider = (
      await s.app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'yabanci', password: 'sifre12345' } })
    ).json() as Account;
    expect((await s.req(outsider.token, 'POST', '/api/guilds', { name: 'Başka' })).statusCode).toBe(201);

    startStreaming();
    expect((await upload(s.owner.token, await frame())).statusCode).toBe(200);
    expect((await fetchPreview(member.token, voice.id, s.owner.user.id)).statusCode).toBe(200);
    expect((await fetchPreview(outsider.token, voice.id, s.owner.user.id)).statusCode).toBe(404);
    // Yanlış kanal kimliğiyle de (kişi orada değil) 404
    expect((await fetchPreview(member.token, s.channel('text').id, s.owner.user.id)).statusCode).toBe(404);

    // Kanal gizlendi: üye artık göremez
    const hide = await s.req(s.owner.token, 'PATCH', `/api/channels/${voice.id}`, {
      overwrites: [{ roleId: s.guildId, allow: 0, deny: P.VIEW_CHANNEL }],
    });
    expect(hide.statusCode).toBe(200);
    expect((await fetchPreview(member.token, voice.id, s.owner.user.id)).statusCode).toBe(404);
    expect((await fetchPreview(s.owner.token, voice.id, s.owner.user.id)).statusCode).toBe(200);

    // Yayında olmayan
    s.ctx.voice.join(member.user.id, voice.id);
    expect((await fetchPreview(s.owner.token, voice.id, member.user.id)).statusCode).toBe(404);
    expect((await upload(member.token, await frame())).statusCode).toBe(409);
  });

  it('yayın bitince, kanal değişince ya da sesten çıkınca önizleme silinir', async () => {
    const voice = s.channel('voice');
    startStreaming();
    expect((await upload(s.owner.token, await frame())).statusCode).toBe(200);
    expect(s.ctx.streamPreviews.size).toBe(1);

    s.ctx.voice.setStreaming(s.owner.user.id, voice.id, false);
    expect(s.ctx.streamPreviews.size).toBe(0);
    const state = s.ctx.voice.get(s.owner.user.id)!;
    expect(state.streamPreviewAt).toBeUndefined();
    expect(state.streamStartedAt).toBeUndefined();
    expect((await fetchPreview(s.owner.token, voice.id, s.owner.user.id)).statusCode).toBe(404);

    s.ctx.voice.setStreaming(s.owner.user.id, voice.id, true);
    expect((await upload(s.owner.token, await frame())).statusCode).toBe(200);
    s.ctx.voice.leave(s.owner.user.id, voice.id);
    expect(s.ctx.streamPreviews.size).toBe(0);
  });

  it('boyut, tür ve sıklık sınırları', async () => {
    startStreaming();
    const big = Buffer.alloc(STREAM_PREVIEW_MAX_BYTES + 1, 1);
    expect((await upload(s.owner.token, big)).statusCode).toBe(413);
    expect((await upload(s.owner.token, await frame(), 'image/gif')).statusCode).toBe(415);
    expect((await upload(s.owner.token, Buffer.from('resim değil'))).statusCode).toBe(400);
    // Kimliksiz
    const anon = await s.app.inject({
      method: 'PUT',
      url: '/api/voice/stream-preview',
      headers: { 'content-type': 'image/jpeg' },
      payload: await frame(),
    });
    expect(anon.statusCode).toBe(401);

    const small = await frame(320, 180);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await upload(s.owner.token, small)).statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it('kaynak adı temizlenip ses durumuna eklenir; yayın bitince unutulur', async () => {
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const member = await s.member('uye');
    const voice = s.channel('voice');
    const m = await connectGateway(s.app, member.token);
    clients.push(m);

    // Seste değilken reddedilir
    expect((await s.req(s.owner.token, 'PUT', '/api/voice/stream-source', { name: 'X', kind: 'window' })).statusCode).toBe(409);

    s.ctx.voice.join(s.owner.user.id, voice.id);
    // Webhook'tan önce bildirilebilir
    const res = await s.req(s.owner.token, 'PUT', '/api/voice/stream-source', {
      name: '  Davinci‮   Resolve\n',
      kind: 'window',
    });
    expect(res.statusCode).toBe(204);
    expect(s.ctx.voice.get(s.owner.user.id)?.streamSourceName).toBeUndefined();
    s.ctx.voice.setStreaming(s.owner.user.id, voice.id, true);
    expect(s.ctx.voice.get(s.owner.user.id)).toMatchObject({ streamSourceName: 'Davinci Resolve', streamSourceKind: 'window' });

    await m.settle();
    const last = m.of('VOICE_STATE_UPDATE').at(-1)!;
    expect(last).toMatchObject({ streaming: true, streamSourceName: 'Davinci Resolve' });

    s.ctx.voice.setStreaming(s.owner.user.id, voice.id, false);
    s.ctx.voice.setStreaming(s.owner.user.id, voice.id, true);
    expect(s.ctx.voice.get(s.owner.user.id)?.streamSourceName).toBeUndefined();
  });

  it('kaynak adı 64 karakterle sınırlanır', () => {
    expect(sanitizeSourceName('a'.repeat(100))).toHaveLength(64);
    expect(sanitizeSourceName(' ​ ')).toBeNull();
    expect(sanitizeSourceName('Ekran 1')).toBe('Ekran 1');
  });
});
