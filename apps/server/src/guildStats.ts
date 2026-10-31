import type { DatabaseSync } from 'node:sqlite';
import { firstMessageIdSince } from './dashboard.js';

// Yönetim paneli: sunucu (topluluk) başına ayrıntılar — üyeler, kanallar, mesajlar (toplam ve son 7 gün),
// ses/yayın süreleri (göç 20 sonrası kayıtlardan), en çok yazanlar (yalnızca sayılar), dosya ekleri ve ses
// paneli sesleri.
// Direkt mesajlar ayrı satırdır. Mesaj içerikleri okunmaz.

const DAY = 86_400_000;

export interface GuildStat {
  id: string;
  name: string;
  ownerId: string | null;
  createdAt: number;
  members: number;
  /** Ayrılan/atılan ve yasaklanan eski üyeler */
  formerMembers: number;
  banned: number;
  channels: { text: number; voice: number };
  messages: { total: number; last7d: number; lastAt: number | null };
  attachments: { count: number; bytes: number };
  /** Ses paneli sesleri (guild_sounds) */
  sounds: { count: number; bytes: number };
  voice7d: { voiceMin: number; streamMin: number };
  /** Son 7 günde en çok mesaj yazanlar (en fazla 5) */
  topPosters: { userId: string; count: number }[];
  invites: number;
}

export interface GuildStats {
  generatedAt: number;
  guilds: GuildStat[];
  dms: { conversations: number; messages: number; last7d: number; attachments: { count: number; bytes: number } };
}

export function computeGuildStats(db: DatabaseSync, now = Date.now()): GuildStats {
  const all = <T>(sql: string, ...params: (number | string)[]): T[] => db.prepare(sql).all(...params) as unknown as T[];
  const guilds = all<{ id: string; name: string; owner_id: string | null; created_at: number }>(
    'SELECT id, name, owner_id, created_at FROM guilds ORDER BY created_at, rowid',
  );
  const byGuild = new Map<string, GuildStat>();
  for (const g of guilds) {
    byGuild.set(g.id, {
      id: g.id,
      name: g.name,
      ownerId: g.owner_id,
      createdAt: g.created_at,
      members: 0,
      formerMembers: 0,
      banned: 0,
      channels: { text: 0, voice: 0 },
      messages: { total: 0, last7d: 0, lastAt: null },
      attachments: { count: 0, bytes: 0 },
      sounds: { count: 0, bytes: 0 },
      voice7d: { voiceMin: 0, streamMin: 0 },
      topPosters: [],
      invites: 0,
    });
  }
  for (const r of all<{ g: string; current: number; former: number; banned: number }>(
    `SELECT guild_id AS g, SUM(removed_at IS NULL) AS current, SUM(removed_at IS NOT NULL) AS former,
            SUM(banned_at IS NOT NULL) AS banned
     FROM guild_members GROUP BY guild_id`,
  )) {
    const s = byGuild.get(r.g);
    if (s) Object.assign(s, { members: r.current, formerMembers: r.former, banned: r.banned });
  }
  for (const r of all<{ g: string; type: string; n: number }>(
    `SELECT guild_id AS g, type, COUNT(*) AS n FROM channels WHERE type IN ('text', 'voice') GROUP BY guild_id, type`,
  )) {
    const s = byGuild.get(r.g);
    if (s && (r.type === 'text' || r.type === 'voice')) s.channels[r.type] = r.n;
  }
  const dms = { conversations: 0, messages: 0, last7d: 0, attachments: { count: 0, bytes: 0 } };
  dms.conversations = (db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE type = 'dm'`).get() as { n: number }).n;
  for (const r of all<{ g: string | null; n: number; last: number | null }>(
    `SELECT c.guild_id AS g, COUNT(*) AS n, MAX(m.created_at) AS last
     FROM messages m JOIN channels c ON c.id = m.channel_id GROUP BY c.guild_id`,
  )) {
    const s = r.g ? byGuild.get(r.g) : null;
    if (s) s.messages = { ...s.messages, total: r.n, lastAt: r.last };
    else if (!r.g) dms.messages = r.n;
  }
  const weekFrom = firstMessageIdSince(db, now - 7 * DAY);
  if (weekFrom !== null) {
    const posters = new Map<string, { userId: string; count: number }[]>();
    for (const r of all<{ g: string | null; a: string | null; n: number }>(
      `SELECT c.guild_id AS g, m.author_id AS a, COUNT(*) AS n
       FROM messages m JOIN channels c ON c.id = m.channel_id
       WHERE m.id >= ? GROUP BY c.guild_id, m.author_id ORDER BY n DESC`,
      weekFrom,
    )) {
      const s = r.g ? byGuild.get(r.g) : null;
      if (s) {
        s.messages.last7d += r.n;
        if (r.a) {
          const list = posters.get(r.g!) ?? [];
          if (list.length < 5) list.push({ userId: r.a, count: r.n });
          posters.set(r.g!, list);
        }
      } else if (!r.g) dms.last7d += r.n;
    }
    for (const [g, list] of posters) byGuild.get(g)!.topPosters = list;
  }
  for (const r of all<{ g: string | null; n: number; size: number }>(
    `SELECT c.guild_id AS g, COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS size
     FROM attachments a JOIN channels c ON c.id = a.channel_id GROUP BY c.guild_id`,
  )) {
    const s = r.g ? byGuild.get(r.g) : null;
    if (s) s.attachments = { count: r.n, bytes: r.size };
    else if (!r.g) dms.attachments = { count: r.n, bytes: r.size };
  }
  for (const r of all<{ g: string; n: number; size: number }>(
    'SELECT guild_id AS g, COUNT(*) AS n, COALESCE(SUM(size), 0) AS size FROM guild_sounds GROUP BY guild_id',
  )) {
    const s = byGuild.get(r.g);
    if (s) s.sounds = { count: r.n, bytes: r.size };
  }
  const from = now - 7 * DAY;
  for (const r of all<{ g: string | null; kind: string; ms: number }>(
    `SELECT guild_id AS g, kind,
            SUM(MAX(0, MIN(COALESCE(ended_at, ?), ?) - MAX(started_at, ?))) AS ms
     FROM voice_sessions WHERE (ended_at IS NULL OR ended_at >= ?) GROUP BY guild_id, kind`,
    now,
    now,
    from,
    from,
  )) {
    const s = r.g ? byGuild.get(r.g) : null;
    if (!s) continue;
    const min = Math.round((r.ms / 60_000) * 10) / 10;
    if (r.kind === 'stream') s.voice7d.streamMin = min;
    else s.voice7d.voiceMin = min;
  }
  for (const r of all<{ g: string | null; n: number }>(
    `SELECT guild_id AS g, COUNT(*) AS n FROM invites
     WHERE guild_id IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)
     GROUP BY guild_id`,
    now,
  )) {
    const s = r.g ? byGuild.get(r.g) : null;
    if (s) s.invites = r.n;
  }
  return { generatedAt: now, guilds: [...byGuild.values()], dms };
}
