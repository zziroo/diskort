import type { Channel, Guild, GuildMember, ReadyPayload, Role, User } from '@diskort/shared';

/** Testlerde kullanıcı: profil + tek sunucudaki üyeliği (rolleri, eski üye mi) */
export type TestUser = User & { roles?: string[]; removed?: boolean };

/** Profil (üyelik alanları olmadan) */
export const profile = ({ roles: _roles, removed: _removed, ...rest }: TestUser): User => rest;

export const member = (u: TestUser): GuildMember => ({
  userId: u.id,
  roles: u.roles ?? [],
  joinedAt: 1,
  removed: u.removed ?? false,
});

/**
 * Tek sunuculu eski biçimden (guild, channels, roles, users) READY üretir: kullanıcıların rolleri ve
 * `removed` bilgisi sunucunun üyelerine taşınır.
 */
export function toReady(
  old: Omit<ReadyPayload, 'guilds' | 'users' | 'primaryGuildId'> & {
    guild: Guild;
    channels: Channel[];
    roles: Role[];
    users: TestUser[];
    primaryGuildId?: string | null;
  },
): ReadyPayload {
  const { guild, channels, roles, users, primaryGuildId, ...rest } = old;
  return {
    ...rest,
    user: profile(rest.user as TestUser),
    guilds: [{ guild, channels, roles, members: users.map(member), sounds: [] }],
    users: users.map(profile),
    primaryGuildId: primaryGuildId ?? guild.id,
  };
}
