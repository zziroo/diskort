import { Stack, useLocalSearchParams } from 'expo-router';
import { guildSettingsSections, isOwner, useGuild, usePermissions, useSession, type GuildSettingsSection } from '@diskort/client-core';
import { BansSection } from '../../components/serverSettings/Bans';
import { ChannelsSection } from '../../components/serverSettings/Channels';
import { NoAccess, SECTION_INFO, SettingsPage, useSettingsGuild } from '../../components/serverSettings/common';
import { InvitesSection } from '../../components/serverSettings/Invites';
import { MembersSection } from '../../components/serverSettings/Members';
import { OverviewSection } from '../../components/serverSettings/Overview';
import { RolesSection } from '../../components/serverSettings/Roles';
import { SoundsSection } from '../../components/serverSettings/Sounds';

const isSection = (value: string | undefined): value is GuildSettingsSection =>
  value !== undefined && value in SECTION_INFO;

/** Sunucu ayarlarının bir bölümü (Genel, Kanallar, Roller, Üyeler, Sesler, Davetler, Yasaklar) */
export default function ServerSettingsSectionScreen() {
  const guild = useSettingsGuild();
  const { bolum } = useLocalSearchParams<{ bolum: string }>();
  const perms = usePermissions();
  const selfId = useSession((s) => s.user?.id);
  const owner = useGuild((s) => isOwner(s, selfId));
  if (!guild || !isSection(bolum)) return null;
  // Yetki alınırsa bölüm kapanmaz ama içerik gizlenir
  const allowed = guildSettingsSections(perms, owner).includes(bolum);

  return (
    <SettingsPage>
      <Stack.Screen options={{ title: SECTION_INFO[bolum].label }} />
      {!allowed ? (
        <NoAccess />
      ) : bolum === 'overview' ? (
        <OverviewSection key={guild.name} guild={guild} />
      ) : bolum === 'channels' ? (
        <ChannelsSection guild={guild} />
      ) : bolum === 'roles' ? (
        <RolesSection guild={guild} />
      ) : bolum === 'members' ? (
        <MembersSection />
      ) : bolum === 'sounds' ? (
        <SoundsSection guild={guild} />
      ) : bolum === 'invites' ? (
        <InvitesSection guild={guild} />
      ) : (
        <BansSection guild={guild} />
      )}
    </SettingsPage>
  );
}
