import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { avatarUrl, streamPreviewHeaders, streamPreviewUrl, useChannelMemberColor, useGuild } from '@diskort/client-core';
import type { VoiceState } from '@diskort/shared';
import { useAppear, useTimingTo } from '../motion';
import { colors, createStyles, font, radius, space } from '../theme';
import { useVoice } from '../voice/voice';
import { Avatar } from './Avatar';
import { SpeakingRing } from './SpeakingRing';
import { StreamViewers } from './StreamViewers';
import { VoiceStateIcon } from './VoiceStateIcon';

// Ses ekranının kutucukları. Avatar sabit boyda bir "sahnenin" (avatar + konuşma halkasının payı) ortasında
// durur, ad sahnenin hemen altında sabit yükseklikte bir satırdadır. Sahne her kutucukta aynı boydadır,
// böylece bütün avatarlar ve adlar aynı hizada durur.

/** Kutucuğun iç boşluğu (üst/alt) */
const TILE_PAD = 10;
/** Ad satırının sabit yüksekliği ve sahneyle arası */
const NAME_HEIGHT = 20;
const NAME_GAP = 4;
/** En büyük avatar */
const AVATAR_MAX = 72;
/** Küçük kutucukta (yayın izlenirken) avatar */
const AVATAR_SMALL = 56;
/** Konuşma halkası avatarın dışına taşar (kalınlık + boşluk, iki yanda) */
const RING_ROOM = 12;

/** Büyük avatarın sığdığı en kısa kutucuk (sahne + ad + boşluklar) */
export const TILE_MIN_HEIGHT = AVATAR_MAX + RING_ROOM + NAME_GAP + NAME_HEIGHT + TILE_PAD * 2;

/** Kutucuk yüksekliğine göre avatar ve sahne (avatarın ortada durduğu kare) boyu */
function stageFor(height: number): { avatar: number; stage: number } {
  const room = height - TILE_PAD * 2 - NAME_HEIGHT - NAME_GAP;
  if (AVATAR_MAX + RING_ROOM <= room) return { avatar: AVATAR_MAX, stage: AVATAR_MAX + RING_ROOM };
  const avatar = Math.max(32, Math.min(AVATAR_SMALL, room - RING_ROOM));
  return { avatar, stage: avatar + RING_ROOM };
}

/** Kutucuğun dışı: katılınca büyüyerek belirir; konuşma kenarı içeriğin üstünde çizilir (avatarı örtmez) */
function TileFrame({
  width,
  height,
  edge,
  edgeColor,
  dark,
  children,
}: {
  width: number;
  height: number;
  edge?: Animated.Value;
  /** Kenar rengi (verilmezse konuşma yeşili); yalnızca renk değişir, kalınlık sabit */
  edgeColor?: string;
  dark?: boolean;
  children: ReactNode;
}) {
  const appear = useAppear(true, 260);
  // Render içinde interpolate() her çizimde yeni Animated düğümü yaratıp Android'de OOM'a yol
  // açıyordu; düğüm yalnız appear değişince oluşturulur.
  const scale = useMemo(() => appear.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }), [appear]);
  return (
    <Animated.View
      style={[
        styles.tile,
        dark && styles.tileDark,
        {
          width,
          height,
          opacity: appear,
          transform: [{ scale }],
        },
      ]}
    >
      {children}
      {edge && <Animated.View pointerEvents="none" style={[styles.tileEdge, { opacity: edge }, edgeColor ? { borderColor: edgeColor } : null]} />}
    </Animated.View>
  );
}

/**
 * Seste bir kişi: sabit sahnenin ortasında avatar (konuşunca yeşil halka ve kutucuğun kenarı yumuşakça
 * yanar), altta ad, sağ üstte ses durumu. Yayını ayrı bir kutucukta (StreamTile) gösterilir.
 */
interface MemberTileProps {
  state: VoiceState;
  width: number;
  height: number;
  selfId: string | undefined;
  onLongPress: (userId: string) => void;
}

export const MemberTile = memo(function MemberTile({ state, width, height, selfId, onLongPress }: MemberTileProps) {
  const user = useGuild((s) => s.users[state.userId]);
  const color = useChannelMemberColor(state.userId, state.channelId);
  const speaking = useVoice((s) => Boolean(s.speaking[state.userId]));
  // Giriş sesi çalarken halka ve kenar sarı (konuşmanın önüne geçer)
  const intro = useVoice((s) => s.introPlayingUserId === state.userId);
  const lit = speaking || intro;
  // Sönüş sırasında kenar rengi son haliyle kalsın
  const lastIntro = useRef(false);
  if (lit) lastIntro.current = intro;
  // Konuşma kenarı: açılışı hızlı, sönüşü yavaş (kısa sessizliklerde titremez)
  const edge = useTimingTo(lit ? 1 : 0, lit ? 90 : 280);
  const self = state.userId === selfId;
  const { avatar, stage } = stageFor(height);
  return (
    <Pressable
      onLongPress={() => onLongPress(state.userId)}
      delayLongPress={300}
      accessibilityLabel={`${user?.displayName ?? 'Üye'}${speaking ? ', konuşuyor' : ''}${state.streaming ? ', yayında' : ''}`}
      accessibilityHint="Ses seviyesi ve seçenekler için uzun bas"
    >
      <TileFrame width={width} height={height} edge={edge} edgeColor={lastIntro.current ? colors.warn : undefined}>
        <View style={[styles.stage, { width: stage, height: stage }]}>
          <SpeakingRing speaking={speaking} intro={intro} size={avatar}>
            <Avatar user={user} size={avatar} />
          </SpeakingRing>
        </View>
        <View style={styles.nameRow}>
          <Text style={[styles.name, self && { color: colors.head }, color ? { color } : null]} numberOfLines={1}>
            {user?.displayName ?? '…'}
          </Text>
        </View>
        <View style={styles.stateIcon} pointerEvents="none">
          <VoiceStateIcon state={state} size={15} />
        </View>
      </TileFrame>
    </Pressable>
  );
}, sameMemberTile);

/** Kişi kutucuğu yayın önizlemesi tazelenince (birkaç saniyede bir) yeniden çizilmesin */
function sameMemberTile(a: MemberTileProps, b: MemberTileProps): boolean {
  if (a.width !== b.width || a.height !== b.height || a.selfId !== b.selfId || a.onLongPress !== b.onLongPress) return false;
  if (a.state === b.state) return true;
  const keys = new Set([...Object.keys(a.state), ...Object.keys(b.state)] as (keyof VoiceState)[]);
  for (const key of keys) {
    if (key === 'streamPreviewAt' || key === 'streamSourceName') continue;
    if (a.state[key] !== b.state[key]) return false;
  }
  return true;
}

/**
 * Bir ekran yayını, yayıncının kutucuğunun yanında kendi kutucuğunda (masaüstündeki gibi): sunucudaki
 * önizleme karesi varsa o, yoksa yayıncının bulanık avatarı. Dokununca yayın izlenir; izlenen yayın
 * ızgarada tekrarlanmaz (üstte büyük görünür, denetimleri videonun üstünde). Kendi yayınında önizleme
 * gösterilmez (pil): yalnızca "Ekranını paylaşıyorsun".
 */
export const StreamTile = memo(function StreamTile({
  state,
  width,
  height,
  selfId,
  onOpen,
}: {
  state: VoiceState;
  width: number;
  height: number;
  selfId: string | undefined;
  onOpen: (userId: string) => void;
}) {
  const user = useGuild((s) => s.users[state.userId]);
  const self = state.userId === selfId;
  const name = user?.displayName ?? '…';
  // Yüklenemeyen önizleme karesi (yayın bitti, ağ) bulanık avatara döner; yeni kare gelince yeniden denenir
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [state.streamPreviewAt]);
  const preview = !self && state.streamPreviewAt !== undefined && !failed;
  const photo = avatarUrl(user);
  const avatar = Math.min(44, Math.round(height * 0.3));
  return (
    <View>
      <Pressable
        onPress={self ? undefined : () => onOpen(state.userId)}
        disabled={self}
        accessibilityRole={self ? undefined : 'button'}
        accessibilityLabel={self ? 'Ekranını paylaşıyorsun' : `${name} yayında`}
        accessibilityHint={self ? undefined : 'Yayını izler'}
      >
        <TileFrame width={width} height={height} dark>
          {preview ? (
            <Image
              source={{ uri: streamPreviewUrl(state), headers: streamPreviewHeaders() }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              // Yeni kare gelince eskisinin üstüne solmadan geçer (titremez)
              fadeDuration={0}
              onError={() => setFailed(true)}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <>
              {photo ? (
                <Image
                  source={{ uri: photo }}
                  style={[StyleSheet.absoluteFill, styles.blurred]}
                  blurRadius={24}
                  resizeMode="cover"
                  accessibilityIgnoresInvertColors
                />
              ) : (
                <View style={[StyleSheet.absoluteFill, styles.blurred, { backgroundColor: user?.avatarColor ?? '#747f8d' }]} />
              )}
              <View style={styles.dim} />
            </>
          )}

          <View style={styles.center} pointerEvents="none">
            {!preview && (
              <View style={styles.dimAvatar}>
                <Avatar user={user} size={avatar} />
              </View>
            )}
            {self && <Text style={styles.centerText}>Ekranını paylaşıyorsun</Text>}
          </View>

          <View style={styles.live} pointerEvents="none">
            <Text style={styles.liveText}>YAYINDA</Text>
          </View>
          <View style={styles.caption} pointerEvents="none">
            <Ionicons name="desktop-outline" size={13} color="#fff" />
            <Text style={styles.captionText} numberOfLines={1}>
              {name}
            </Text>
          </View>
        </TileFrame>
      </Pressable>
      {/* Kutucuğun dokunma alanının dışında, üstünde: ekran okuyucu ayrı düğme olarak ulaşır.
          Kendi izleyicilerin "Ekranını paylaşıyorsun" şeridinde */}
      {!self && <StreamViewers userId={state.userId} style={styles.viewers} />}
    </View>
  );
});

const styles = createStyles(() => ({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.rail,
    borderRadius: radius.lg - 2,
    paddingVertical: TILE_PAD,
    paddingHorizontal: space.sm,
    overflow: 'hidden',
  },
  tileDark: { backgroundColor: '#000' },
  tileEdge: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: radius.lg - 2,
    borderWidth: 2,
    borderColor: colors.ok,
  },
  // Avatar karenin ortasında
  stage: { alignItems: 'center', justifyContent: 'center' },
  nameRow: {
    height: NAME_HEIGHT,
    marginTop: NAME_GAP,
    maxWidth: '100%',
    justifyContent: 'center',
  },
  name: { color: colors.text, fontSize: font.body - 0.5, fontWeight: '600', textAlign: 'center' },
  stateIcon: { position: 'absolute', top: space.sm, right: space.sm },
  blurred: { opacity: 0.55 },
  dim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  center: { alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm },
  dimAvatar: { opacity: 0.8 },
  centerText: { color: '#fff', fontSize: font.small, fontWeight: '700', textAlign: 'center' },
  live: {
    position: 'absolute',
    top: space.sm,
    left: space.sm,
    backgroundColor: colors.danger,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  liveText: { color: '#fff', fontSize: 10.5, fontWeight: '800' },
  viewers: { position: 'absolute', top: space.sm, right: space.sm },
  caption: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  captionText: { color: '#fff', fontSize: 12.5, fontWeight: '700', flexShrink: 1 },
}));
