import { useRef, useState, type ReactNode } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import {
  acceptFriendRequest,
  blockUser,
  canMessageIn,
  cancelFriendRequest,
  declineFriendRequest,
  guildVoiceStateOf,
  memberActions,
  memberColorOf,
  moderation,
  moveTargets,
  openDirectMessage,
  removeFriend,
  sendFriendRequest,
  showsGuildInfo,
  showsStreamInfo,
  streamPreviewHeaders,
  streamPreviewUrl,
  unblockUser,
  useCustomStatus,
  useFriendStatus,
  useGuild,
  useOnMobile,
  useSession,
  useStatus,
  voiceStateIn,
  type ProfileContext,
} from '@diskort/client-core';
import { usePathname, useRouter } from 'expo-router';
import { feedback, haptic } from '../haptics';
import { animateNextLayout } from '../motion';
import { showChat } from '../stores/nav';
import { toast } from '../stores/ui';
import { useVoice, voice as voiceClient } from '../voice/voice';
import { BAN_REASON_MAX_LENGTH } from '@diskort/shared';
import { colors, createStyles, font, radius, space } from '../theme';
import { ActivityCards } from './ActivityCard';
import { ProfileHeader } from './ProfileHeader';
import { BottomSheet, SheetGroup, SheetItem, SheetNote } from './BottomSheet';
import { confirmDialog, promptDialog } from './Dialog';

/** Menünün alt sayfası: ana menü, ses kanalı seçimi (taşı) ya da roller */
type Page = 'main' | 'move' | 'roles';

/**
 * Bir üyeye basınca açılan menü: başkasıysa "Mesaj gönder", sonra yetkiye ve hiyerarşiye göre yönetim
 * (masaüstündeki üye menüsüyle aynı): seste sunucuda susturma, sağırlaştırma, başka kanala taşıma, sesten
 * çıkarma; rol verme/alma; atma ve yasaklama (temalı onay penceresiyle; yasaklarken isteğe bağlı sebep).
 * DM bağlamında sunucu yoktur: yalnızca hesap düzeyi bilgiler ve işlemler (mesaj, kullanıcı adını kopyala);
 * rol, rol rengi, sahiplik, ses ve yönetim gösterilmez (kişi başka bir sunucuda olsa da).
 */
export function MemberSheet({
  userId: requested,
  context,
  onClose,
  renderExtra,
}: {
  userId: string | null;
  /** Menünün açıldığı bağlam (açan yer bildirir; seçili sunucudan çıkarılmaz) */
  context: ProfileContext;
  onClose: () => void;
  /** Başlığın altında gösterilecek ek bölüm (ör. ses ekranında kişinin ses seviyesi) */
  renderExtra?: (userId: string) => ReactNode;
}) {
  // Kapanış animasyonu sürerken içerik kaybolmasın: son üye ve bağlamı tutulur
  const last = useRef({ userId: requested, context });
  if (requested) last.current = { userId: requested, context };
  const userId = requested ?? last.current.userId;
  const shownContext = requested ? context : last.current.context;
  // Sunucu bilgisi (roller, taç, ses, yönetim) yalnızca o sunucunun bağlamında
  const guildInfo = useGuild((s) => showsGuildInfo(s, shownContext));
  const user = useGuild((s) => (userId ? s.users[userId] : undefined));
  // Sesteki yönetim (susturma, taşıma) seçili sunucunun yetkileriyle: yalnızca o sunucunun bağlamında. DM
  // aramasındaki ses durumu sunucu bağlamında hiç görünmez (aramada olduğu, yayını sunucuya sızmasın).
  const voice = useGuild((s) => (guildInfo ? guildVoiceStateOf(s, userId) : undefined));
  // Seste olduğu ve "Yayını izle": her sunucu bağlamında (seçili olmayan sunucunun ses kanalı da), DM'de değil
  const live = useGuild((s) => (showsStreamInfo(shownContext) ? voiceStateIn(s, shownContext, userId) : undefined));
  const status = useStatus(userId);
  const mobile = useOnMobile(userId);
  const custom = useCustomStatus(userId);
  const color = useGuild((s) => (guildInfo ? memberColorOf(s, userId) : null));
  const guildRoles = useGuild((s) => s.roles);
  const owner = useGuild((s) => Boolean(guildInfo && userId && s.guild?.ownerId === userId));
  const [page, setPage] = useState<Page>('main');
  const moving = page === 'move';
  const userRoles = useGuild((s) => (userId && guildInfo ? s.users[userId]?.roles : undefined));
  const selfId = useSession((s) => s.user?.id);
  // Mesaj: ortak sunucusu olan herkese (DM'deki başka sunucudan biri de); o kişiyle bire bir konuşmada değil
  const canMessage = useGuild((s) => Boolean(user && userId && canMessageIn(s, shownContext, userId, selfId)));
  // Başkası ekran paylaşıyorsa "Yayını izle" (o kanalda değilsen önce katılır)
  const streaming = Boolean(live?.streaming && userId !== selfId);
  const watchingThis = useVoice((s) => s.watching !== null && s.watching === userId);
  // DM bağlamında başkası: engelle / engeli kaldır (yalnızca DM'leri etkiler; sunucuda bir şey değişmez)
  const canBlock = shownContext.kind === 'dm' && Boolean(user && userId && userId !== selfId);
  const blockedThis = useGuild((s) => Boolean(userId && s.blockedIds[userId]));
  // Arkadaşlık durumu düğmesi: kendinde ve engellediğin kişide yok (her bağlamda, hesap düzeyi)
  const friendStatus = useFriendStatus(userId);
  const showFriend = Boolean(user && userId) && friendStatus !== 'self' && !blockedThis;
  const router = useRouter();
  const pathname = usePathname();

  const close = (): void => {
    setPage('main');
    onClose();
  };

  const actions = guildInfo && userId && user && !user.removed ? memberActions(userId) : null;
  const targets = moving && user ? moveTargets(user) : [];
  const done = (ok: boolean, message: string): void => {
    feedback(ok ? 'moderate' : 'error');
    if (ok) toast(message);
    close();
  };

  const goTo = (next: Page): void => {
    animateNextLayout(180);
    setPage(next);
  };

  /** Geri alınamaz işlemler temalı onay penceresiyle (menü önce kapanır) */
  const disconnect = async (): Promise<void> => {
    const id = userId!;
    close();
    const ok = await confirmDialog({
      title: `${name} sesten çıkarılsın mı?`,
      message: 'Sesli sohbetten çıkarılır; istediğinde yeniden katılabilir.',
      icon: 'call',
      confirmLabel: 'Sesten çıkar',
      danger: true,
    });
    if (ok) done(await moderation.disconnect(id), `${name} sesten çıkarıldı.`);
  };

  const kick = async (): Promise<void> => {
    const id = userId!;
    close();
    const ok = await confirmDialog({
      title: `${name} atılsın mı?`,
      message: 'Sunucudan çıkarılır ve bu sunucudaki rolleri alınır. Mesajları kalır; yeni bir davetle geri dönebilir.',
      icon: 'exit-outline',
      confirmLabel: 'At',
      danger: true,
    });
    if (ok) done(await moderation.kick(id), `${name} sunucudan atıldı.`);
  };

  const ban = async (): Promise<void> => {
    const id = userId!;
    close();
    const reason = await promptDialog({
      title: `${name} yasaklansın mı?`,
      message: 'Sunucudan çıkarılır, rolleri alınır ve yasak kaldırılana kadar yeni bir davetle de geri dönemez. Hesabı, diğer sunucuları ve mesajları etkilenmez.',
      icon: 'ban',
      label: 'Sebep (isteğe bağlı, yalnızca yetkililer görür)',
      placeholder: 'ör. kurallara uymadı',
      maxLength: BAN_REASON_MAX_LENGTH,
      optional: true,
      confirmLabel: 'Yasakla',
      danger: true,
    });
    if (reason !== null) done(await moderation.ban(id, reason || undefined), `${name} yasaklandı.`);
  };

  const name = user?.displayName ?? '';
  const extra = userId ? renderExtra?.(userId) : null;
  const voiceActions = Boolean(voice && actions && (actions.mute || actions.deafen || actions.move));
  const nothing =
    !extra && !showFriend && !canMessage && !streaming && actions && !voiceActions && !actions.kick && !actions.ban && actions.roles.length === 0;
  // Rolleri, en üstteki önce (masaüstündeki profil kartı gibi renk noktasıyla); DM'de yok
  const roles = (guildInfo ? (user?.roles ?? []) : [])
    .map((id) => guildRoles[id])
    .filter((r) => r !== undefined)
    .sort((a, b) => b.position - a.position);

  const message = async (): Promise<void> => {
    close();
    const dm = await openDirectMessage(userId!);
    if (dm) showChat(dm.id);
  };

  const copyUsername = (): void => {
    const username = user?.username;
    close();
    if (!username) return;
    void Clipboard.setStringAsync(username).then(
      () => toast('Kullanıcı adı kopyalandı'),
      () => undefined,
    );
  };

  /** Arkadaşlık durumuna göre: ekle, isteği geri çek, kabul et / reddet, arkadaşlıktan çıkar (onaylı) */
  const friendAction = async (action: 'add' | 'cancel' | 'accept' | 'decline' | 'remove'): Promise<void> => {
    const id = userId!;
    const username = user?.username ?? '';
    close();
    switch (action) {
      case 'add': {
        const res = await sendFriendRequest(username);
        if ('error' in res) toast(res.error, 'error');
        else toast(res.status === 'friends' ? `${name} ile artık arkadaşsınız.` : 'İstek gönderildi');
        return;
      }
      case 'cancel':
        if (await cancelFriendRequest(id)) toast('İstek geri çekildi.');
        return;
      case 'accept':
        if (await acceptFriendRequest(id)) toast(`${name} ile artık arkadaşsınız.`);
        return;
      case 'decline':
        await declineFriendRequest(id);
        return;
      case 'remove': {
        const ok = await confirmDialog({
          title: `${name} arkadaşlıktan çıkarılsın mı?`,
          message:
            'Ortak sunucunuz yoksa bire bir konuşmanız salt okunur olur (geçmiş kalır). Gruplar etkilenmez; ona bildirim gitmez.',
          icon: 'person-remove-outline',
          confirmLabel: 'Arkadaşlıktan çıkar',
          danger: true,
        });
        if (ok && (await removeFriend(id))) toast(`${name} arkadaşlıktan çıkarıldı.`);
        return;
      }
    }
  };

  const toggleBlock = async (): Promise<void> => {
    const id = userId!;
    close();
    if (blockedThis) {
      if (await unblockUser(id)) toast(`${name} kişisinin engeli kaldırıldı.`);
      return;
    }
    const ok = await confirmDialog({
      title: `${name} engellensin mi?`,
      message:
        'Bire bir konuşmanız ikiniz için de salt okunur olur: geçmiş kalır ama mesaj, tepki ve arama yapılamaz. Sana yeni konuşma açamaz, başlattığı grup araması seni çalmaz. Sunucu kanallarında hiçbir şey değişmez ve ona engellendiği söylenmez.',
      icon: 'ban',
      confirmLabel: 'Engelle',
      danger: true,
    });
    if (ok && (await blockUser(id))) toast(`${name} engellendi.`);
  };

  const watchStream = async (): Promise<void> => {
    const target = userId!;
    const channelId = live!.channelId;
    close();
    if (watchingThis) {
      voiceClient.watch(null);
      return;
    }
    const current = useVoice.getState();
    if (current.channelId !== channelId || current.status === 'idle') {
      haptic('join');
      try {
        await voiceClient.join(channelId);
      } catch (err) {
        feedback('error');
        toast((err as Error).message, 'error');
        return;
      }
      if (useVoice.getState().channelId !== channelId) return;
    }
    voiceClient.watch(target);
    if (pathname !== '/voice') router.push('/voice');
  };

  return (
    <BottomSheet visible={Boolean(requested && user)} onClose={close}>
      {user && (
        <ProfileHeader
          user={user}
          status={user.removed ? undefined : status}
          mobile={mobile}
          nameColor={color}
          badge={
            owner && (
              <MaterialCommunityIcons name="crown-outline" size={17} color={colors.warn} accessibilityLabel="Sunucunun sahibi" />
            )
          }
          lines={live ? 'Sesli sohbette' : undefined}
          custom={custom}
          style={styles.header}
        >
          {/* Oynadığı oyunlar hesap düzeyidir: DM bağlamında da görünür */}
          {page === 'main' && <ActivityCards userId={userId} style={styles.activity} />}
        </ProfileHeader>
      )}
      {roles.length > 0 && page === 'main' && (
        <View style={styles.roles}>
          {roles.map((r) => (
            <View key={r.id} style={styles.role}>
              <View style={[styles.roleDotSmall, { backgroundColor: r.color ?? '#99aab5' }]} />
              <Text style={styles.roleText}>{r.name}</Text>
            </View>
          ))}
        </View>
      )}
      {page === 'main' && extra}
      {page === 'main' && guildInfo && user?.removed && <SheetNote>Artık bu sunucuda değil.</SheetNote>}
      <ScrollView style={styles.scroll} bounces={false}>
        {moving ? (
          <>
            <SheetNote>{name} hangi ses kanalına taşınsın?</SheetNote>
            {targets.length === 0 && <SheetNote>Taşınabilecek başka ses kanalı yok.</SheetNote>}
            <SheetGroup>
              {targets.map((c) => (
                <SheetItem
                  key={c.id}
                  icon="volume-medium"
                  label={c.name}
                  onPress={() => void moderation.move(userId!, c.id).then((ok) => done(ok, `${name} → ${c.name}`))}
                />
              ))}
            </SheetGroup>
            <SheetGroup>
              <SheetItem icon="arrow-back" label="Geri" onPress={() => goTo('main')} />
            </SheetGroup>
          </>
        ) : page === 'roles' ? (
          <>
            <SheetNote>{name} kişisinin rolleri. Dokununca verilir ya da alınır.</SheetNote>
            <SheetGroup>
              {(actions?.roles ?? []).map((r) => {
                const has = Boolean(userRoles?.includes(r.id));
                return (
                  <SheetItem
                    key={r.id}
                    icon={has ? 'checkbox' : 'square-outline'}
                    label={r.name}
                    trailing={<View style={[styles.roleDot, { backgroundColor: r.color ?? '#99aab5' }]} />}
                    onPress={() => {
                      feedback('tick');
                      void moderation.setRole(userId!, r.id, !has);
                    }}
                  />
                );
              })}
            </SheetGroup>
            <SheetGroup>
              <SheetItem icon="arrow-back" label="Geri" onPress={() => goTo('main')} />
            </SheetGroup>
          </>
        ) : (
          <>
            {streaming && (
              <SheetGroup>
                {live?.streamPreviewAt !== undefined && (
                  <View style={styles.preview}>
                    <Image
                      source={{ uri: streamPreviewUrl(live), headers: streamPreviewHeaders() }}
                      style={styles.previewImage}
                      resizeMode="contain"
                      accessibilityLabel="Yayın önizlemesi"
                    />
                    {live.streamSourceName !== undefined && (
                      <Text style={styles.previewName} numberOfLines={1}>
                        {live.streamSourceName}
                      </Text>
                    )}
                  </View>
                )}
                <SheetItem
                  icon={watchingThis ? 'eye-off' : 'eye'}
                  label={watchingThis ? 'İzlemeyi bırak' : 'Yayını izle'}
                  onPress={() => void watchStream()}
                />
              </SheetGroup>
            )}
            {(canMessage || !guildInfo) && (
              <SheetGroup>
                {canMessage && (
                  <SheetItem key="message" icon="chatbubble-outline" label="Mesaj gönder" onPress={() => void message()} />
                )}
                {/* DM'de hesap düzeyi işlem */}
                {!guildInfo && <SheetItem key="copy" icon="at" label="Kullanıcı adını kopyala" onPress={copyUsername} />}
              </SheetGroup>
            )}
            {showFriend && (
              <SheetGroup>
                {friendStatus === 'none' && (
                  <SheetItem key="f-add" icon="person-add-outline" label="Arkadaş ekle" onPress={() => void friendAction('add')} />
                )}
                {friendStatus === 'outgoing' && (
                  <SheetItem
                    key="f-cancel"
                    icon="time-outline"
                    label="İstek gönderildi"
                    hint="Geri çekmek için dokun"
                    onPress={() => void friendAction('cancel')}
                  />
                )}
                {friendStatus === 'incoming' && (
                  <SheetItem
                    key="f-accept"
                    icon="person-add-outline"
                    label="Kabul et"
                    hint="Sana arkadaşlık isteği gönderdi"
                    onPress={() => void friendAction('accept')}
                  />
                )}
                {friendStatus === 'incoming' && (
                  <SheetItem key="f-decline" icon="close-circle-outline" label="Reddet" onPress={() => void friendAction('decline')} />
                )}
                {friendStatus === 'friend' && (
                  <SheetItem
                    key="f-remove"
                    icon="people-outline"
                    label="Arkadaş"
                    hint="Arkadaşlıktan çıkarmak için dokun"
                    onPress={() => void friendAction('remove')}
                  />
                )}
              </SheetGroup>
            )}
            {canBlock && (
              <SheetGroup>
                <SheetItem
                  key="block"
                  icon={blockedThis ? 'lock-open-outline' : 'ban'}
                  danger={!blockedThis}
                  label={blockedThis ? 'Engeli kaldır' : 'Engelle'}
                  onPress={() => void toggleBlock()}
                />
              </SheetGroup>
            )}
            {voice && voiceActions && (
              <SheetGroup>
                {actions?.mute && (
                  <SheetItem
                    key="mute"
                    icon={voice.serverMute ? 'mic' : 'mic-off'}
                    label={voice.serverMute ? 'Sunucu susturmasını kaldır' : 'Sunucuda sustur'}
                    onPress={() =>
                      void moderation
                        .setServerMute(userId!, !voice.serverMute)
                        .then((ok) => done(ok, voice.serverMute ? `${name} artık konuşabilir.` : `${name} susturuldu.`))
                    }
                  />
                )}
                {actions?.deafen && (
                  <SheetItem
                    key="deafen"
                    icon={voice.serverDeaf ? 'headset' : 'volume-mute'}
                    label={voice.serverDeaf ? 'Sunucu sağırlaştırmasını kaldır' : 'Sunucuda sağırlaştır'}
                    onPress={() =>
                      void moderation
                        .setServerDeaf(userId!, !voice.serverDeaf)
                        .then((ok) => done(ok, voice.serverDeaf ? `${name} artık duyabilir.` : `${name} sağırlaştırıldı.`))
                    }
                  />
                )}
                {actions?.move && (
                  <SheetItem
                    key="move"
                    icon="swap-horizontal"
                    label="Başka kanala taşı"
                    onPress={() => goTo('move')}
                  />
                )}
              </SheetGroup>
            )}
            {actions && actions.roles.length > 0 && (
              <SheetGroup>
                <SheetItem
                  icon="shield-half-outline"
                  label="Roller"
                  hint={`${actions.roles.filter((r) => userRoles?.includes(r.id)).length} / ${actions.roles.length} rol verili`}
                  trailing={<Ionicons name="chevron-forward" size={18} color={colors.faint} />}
                  onPress={() => goTo('roles')}
                />
              </SheetGroup>
            )}
            {(voice && actions?.move) || actions?.kick || actions?.ban ? (
              <SheetGroup>
                {voice && actions?.move && (
                  <SheetItem
                    key="disconnect"
                    icon="call"
                    danger
                    label="Sesten çıkar"
                    onPress={() => void disconnect()}
                  />
                )}
                {actions?.kick && (
                  <SheetItem key="kick" icon="exit-outline" danger label="Sunucudan at" onPress={() => void kick()} />
                )}
                {actions?.ban && <SheetItem key="ban" icon="ban" danger label="Yasakla" onPress={() => void ban()} />}
              </SheetGroup>
            ) : null}
            {nothing && <SheetNote>Bu üye için yapabileceğin bir şey yok.</SheetNote>}
          </>
        )}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = createStyles(() => ({
  header: { marginHorizontal: space.md, marginBottom: space.md },
  activity: { marginTop: space.md },
  roles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: space.lg + 2, paddingBottom: space.md },
  role: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.main,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  roleText: { color: colors.text, fontSize: font.caption, fontWeight: '600' },
  preview: { padding: space.md, gap: 6 },
  previewImage: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.md, backgroundColor: '#000' },
  previewName: { color: colors.muted, fontSize: font.small },
  roleDot: { width: 12, height: 12, borderRadius: 6 },
  roleDotSmall: { width: 9, height: 9, borderRadius: 4.5 },
  // Uzun menü (çok kanal) sayfanın sınırlı yüksekliğine sığsın diye daralabilir
  scroll: { flexShrink: 1, flexGrow: 0 },
}));
