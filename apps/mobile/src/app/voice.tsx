import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { membersOf, ringDmCall, useCan, useChannelContext, useDmCall, useGuild, useSession } from '@diskort/client-core';
import { Permission } from '@diskort/shared';
import { absentParticipants } from '../calls';
import { Avatar } from '../components/Avatar';
import { MemberSheet } from '../components/MemberSheet';
import { EmptyState, Notice } from '../components/States';
import { StreamViewer } from '../components/StreamViewer';
import { StreamViewers } from '../components/StreamViewers';
import { VoiceControl } from '../components/VoiceBar';
import { ConnectionQualityBadge } from '../components/VoiceQuality';
import { MemberTile, StreamTile, TILE_MIN_HEIGHT } from '../components/VoiceTiles';
import { UserVolume } from '../components/VolumeControl';
import { useLayoutAnimationOn } from '../motion';
import { useSettings } from '../stores/settings';
import { toast } from '../stores/ui';
import { colors, createStyles, font, radius, space } from '../theme';
import { leaveVoice, toggleDeafen, toggleMute, toggleScreenShare, toggleSpeaker } from '../voice/actions';
import { useIsDmCall, useVoiceRoomName } from '../voice/roomName';
import { useVoice, voice, type ScreenShareStats } from '../voice/voice';

const GRID_PADDING = space.md;
const GRID_GAP = 10;

export default function VoiceScreen() {
  const router = useRouter();
  const channelId = useVoice((s) => s.channelId);
  const status = useVoice((s) => s.status);
  const listenOnly = useVoice((s) => s.listenOnly);
  // Sunucunun ses kanalı ya da DM araması (konuşmanın adı; DM'de sunucu bilgisi yok)
  const roomName = useVoiceRoomName(channelId);
  const dmCall = useIsDmCall(channelId);
  // Üye menüsü ses kanalının sunucusunun bağlamında (DM aramasında konuşmanın bağlamı)
  const memberContext = useChannelContext(channelId);
  const voiceStates = useGuild((s) => s.voiceStates);
  const members = useMemo(() => (channelId ? membersOf(voiceStates, channelId) : []), [voiceStates, channelId]);
  const watching = useVoice((s) => s.watching);
  // İzlenen ya da az önce biten yayın ("sona erdi" bilgisi gösterilirken görüntüleyici kalır)
  const viewing = useVoice((s) => s.watching ?? s.streamEnded);
  const selfId = useSession((s) => s.user?.id);
  const selfMute = useSettings((s) => s.selfMute);
  const selfDeaf = useSettings((s) => s.selfDeaf);
  const speaker = useSettings((s) => s.speaker);
  const sharing = useVoice((s) => s.sharing);
  const micAllowed = useVoice((s) => s.micAllowed);
  const canStream = useCan(Permission.STREAM, channelId ?? undefined);
  const { width } = useWindowDimensions();
  // Uzun basılan (yönetilecek / sesi ayarlanacak) üye
  const [member, setMember] = useState<string | null>(null);
  const { fullscreen, setFullscreen, rotate, screenOptions } = useStreamFullscreen(viewing, watching);
  // Yayın yapan kişinin hemen ardından yayınının kendi kutucuğu (masaüstündeki gibi); izlenen yayın
  // üstte büyük görünür, ızgarada tekrarlanmaz
  const tiles = useMemo(
    () =>
      members.flatMap((m) =>
        m.streaming && m.userId !== watching ? [{ state: m, stream: false }, { state: m, stream: true }] : [{ state: m, stream: false }],
      ),
    [members, watching],
  );
  // Katılan/ayrılan kutucukta diğerleri yumuşakça yer değiştirir
  // (yeni kutucuğun kendisi Animated ile büyür; LayoutAnimation yalnızca kaymayı ve çıkışı yapar)
  useLayoutAnimationOn(tiles.map((t) => (t.stream ? 's:' : '') + t.state.userId).join(','), 220, false);

  const title = channelId ? roomName : 'Ses';
  const options = useMemo(
    () => ({
      ...screenOptions,
      title,
      headerRight: status === 'idle' ? undefined : () => <ConnectionQualityBadge />,
    }),
    [screenOptions, title, status],
  );

  // Tek kutucuksa geniş, değilse iki sütun; yayın izlenirken kutucuklar kısalır. Hepsi aynı yükseklikte:
  // büyük avatar (TILE_MIN_HEIGHT) her telefonda sığar
  const single = tiles.length === 1;
  const tileWidth = single ? width - GRID_PADDING * 2 : Math.floor((width - GRID_PADDING * 2 - GRID_GAP) / 2);
  const tileHeight = viewing ? 118 : single ? 220 : Math.max(TILE_MIN_HEIGHT, Math.round(tileWidth * 0.86));
  const openMember = useCallback((userId: string) => setMember(userId), []);
  const openStream = useCallback((userId: string) => voice.watch(userId), []);

  if (status === 'idle' || !channelId) {
    return (
      <View style={styles.page}>
        <Stack.Screen options={{ ...screenOptions, title: 'Ses', headerRight: undefined }} />
        <EmptyState
          icon="volume-mute-outline"
          tone="muted"
          title="Bir ses kanalına bağlı değilsin"
          text="Kanal listesinden bir ses kanalına dokununca burada konuşanları görürsün."
          action={{ title: 'Kanallara dön', onPress: () => router.back() }}
        />
      </View>
    );
  }

  const micOff = selfMute || selfDeaf || !micAllowed;

  return (
    <SafeAreaView style={styles.page} edges={['bottom']}>
      <Stack.Screen options={options} />
      {status !== 'connected' && (
        <Notice icon="sync" tone="warn">
          {status === 'connecting'
            ? dmCall
              ? 'Aramaya bağlanılıyor…'
              : 'Ses kanalına bağlanılıyor…'
            : 'Bağlantı koptu, yeniden bağlanılıyor…'}
        </Notice>
      )}
      {!micAllowed && (
        <Notice icon="mic-off" tone="muted">
          {voice.micBlockedReason()} Yalnızca dinliyorsun.
        </Notice>
      )}
      {listenOnly && (
        <Notice icon="mic-off" tone="muted">
          Mikrofon izni verilmedi: yalnızca dinliyorsun. Ayarlardan izin verip yeniden katılabilirsin.
        </Notice>
      )}

      {sharing && (
        <View style={styles.sharing}>
          <View style={styles.sharingRow}>
            <View style={styles.liveDot} />
            <Text style={styles.sharingText}>Ekranını paylaşıyorsun</Text>
            {selfId && <StreamViewers userId={selfId} />}
          </View>
          <ShareStatsLine />
        </View>
      )}

      {/* Tam ekranda da aynı bileşen kalır (yalnızca yerleşimi değişir): video yeniden bağlanmaz */}
      {/* Doğrudan sayfanın çocuğu olmalı: tam ekranda sayfanın tamamını kaplar */}
      {viewing && (
        <StreamViewer key={viewing} userId={viewing} fullscreen={fullscreen} onFullscreen={setFullscreen} onRotate={rotate} />
      )}

      <ScrollView contentContainerStyle={styles.grid}>
        {tiles.map(({ state, stream }) =>
          stream ? (
            <StreamTile key={'s:' + state.userId} state={state} width={tileWidth} height={tileHeight} selfId={selfId} onOpen={openStream} />
          ) : (
            <MemberTile key={state.userId} state={state} width={tileWidth} height={tileHeight} selfId={selfId} onLongPress={openMember} />
          ),
        )}
        {dmCall && status === 'connected' && <AbsentParticipants dmId={channelId} selfId={selfId} />}
      </ScrollView>

      <View style={styles.controls}>
        <VoiceControl
          icon={speaker ? 'volume-high' : 'ear'}
          caption={speaker ? 'Hoparlör' : 'Kulaklık'}
          label={speaker ? 'Hoparlör açık, kulaklığa geç' : 'Ahize, hoparlöre geç'}
          size={52}
          motion="flip"
          onPress={toggleSpeaker}
        />
        <VoiceControl
          icon={sharing ? 'stop-circle-outline' : 'phone-portrait-outline'}
          caption={sharing ? 'Durdur' : 'Ekran'}
          label={sharing ? 'Ekran paylaşımını durdur' : 'Ekranını paylaş'}
          on={sharing}
          size={52}
          motion="rise"
          onPress={() => toggleScreenShare(canStream)}
        />
        <VoiceControl
          icon={micOff ? 'mic-off' : 'mic'}
          caption={micOff ? 'Sessiz' : 'Mikrofon'}
          label={micOff ? 'Mikrofonu aç' : 'Sustur'}
          off={micOff}
          size={52}
          onPress={toggleMute}
        />
        <VoiceControl
          icon={selfDeaf ? 'volume-mute' : 'headset'}
          caption={selfDeaf ? 'Sağır' : 'Ses'}
          label={selfDeaf ? 'Sağırlaştırmayı kaldır' : 'Sağırlaştır'}
          off={selfDeaf}
          size={52}
          motion="tilt"
          onPress={toggleDeafen}
        />
        <VoiceControl
          icon="call"
          danger
          caption="Ayrıl"
          label="Bağlantıyı kes"
          size={52}
          onPress={() => {
            leaveVoice();
            router.back();
          }}
        />
      </View>

      <MemberSheet
        userId={member}
        context={memberContext}
        onClose={() => setMember(null)}
        // Seste başka biri: sesini yalnızca kendin için ayarla
        renderExtra={(userId) => (userId !== selfId && voiceStates[userId]?.channelId === channelId ? <UserVolume userId={userId} /> : null)}
      />
    </SafeAreaView>
  );
}

/**
 * Yayın tam ekranı. Ayrı bir Modal yerine ses ekranının kendisi kullanılır: başlık, durum çubuğu ve
 * gezinme çubuğu react-native-screens'in ekran seçenekleriyle gizlenir (sürükleyince geçici görünür),
 * yatay çevirme de aynı yolla (ekran yönü seçeneği) yapılır. Hepsi uygulamada zaten olan yerel
 * kütüphanelerle; yeni APK gerekmez.
 *
 * Eskiden Modal + <StatusBar hidden> kullanılıyordu: gizlenen durum çubuğu Modal'ın değil alttaki
 * ekranın penceresine uygulandığından Modal kapanınca çubuk geri gelip bütün ses ekranı aşağı
 * kayıyordu; ekrana tek dokunuş da tam ekranı kapatıyordu.
 */
function useStreamFullscreen(viewing: string | null, watching: string | null) {
  const [requested, setRequested] = useState(false);
  // Kullanıcının döndür düğmesiyle zorladığı yön (tam ekrandan çıkınca bırakılır)
  const [orientation, setOrientation] = useState<'landscape' | 'portrait' | null>(null);
  const fullscreen = requested && viewing !== null;
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  // Tam ekrandan yeni çıkıldıysa (zorlanan yön bırakılıp telefon kendiliğinden döndüyse) yeniden girilmez
  const exitedAt = useRef(0);
  const setFullscreen = useCallback((on: boolean) => {
    setRequested(on);
    if (!on) {
      setOrientation(null);
      exitedAt.current = Date.now();
    }
  }, []);

  // Yayın kapanınca tam ekran ve zorlanan yön sıfırlanır
  useEffect(() => {
    if (!viewing) setFullscreen(false);
  }, [viewing, setFullscreen]);

  // Telefon yan çevrilince izlenen yayın kendiliğinden tam ekrana geçer (YouTube gibi)
  const wasLandscape = useRef(landscape);
  useEffect(() => {
    if (landscape && !wasLandscape.current && watching && Date.now() - exitedAt.current > 1500) setRequested(true);
    wasLandscape.current = landscape;
  }, [landscape, watching]);

  // Geri tuşu / geri hareketi önce tam ekrandan çıkar
  useEffect(() => {
    if (!fullscreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setFullscreen(false);
      return true;
    });
    return () => sub.remove();
  }, [fullscreen, setFullscreen]);

  const rotate = useCallback(() => setOrientation(landscape ? 'portrait' : 'landscape'), [landscape]);

  const screenOptions = useMemo(
    () => ({
      headerShown: !fullscreen,
      statusBarHidden: fullscreen,
      navigationBarHidden: fullscreen,
      // 'default' açıkça verilmeli: seçenek kaldırılınca react-native-screens yönü geri bırakmıyor
      orientation: orientation ?? ('default' as const),
    }),
    [fullscreen, orientation],
  );

  return { fullscreen, setFullscreen, rotate, screenOptions };
}

/**
 * DM aramasında olmayan katılımcılar: çalınıyorsa "Çalıyor…", değilse "Tekrar çal" (aramadaki herkes
 * katılmayan birini yeniden çalabilir; çalma kişi başına 30 sn sürer).
 */
function AbsentParticipants({ dmId, selfId }: { dmId: string; selfId: string | undefined }) {
  const call = useDmCall(dmId);
  const participantIds = useGuild((s) => s.dms[dmId]?.participantIds);
  const voiceStates = useGuild((s) => s.voiceStates);
  const users = useGuild((s) => s.users);
  const absent = useMemo(
    () =>
      participantIds
        ? absentParticipants(participantIds, membersOf(voiceStates, dmId).map((m) => m.userId), call, selfId)
        : [],
    [participantIds, voiceStates, dmId, call, selfId],
  );
  if (!call || absent.length === 0) return null;
  return (
    <View style={styles.absent}>
      <Text style={styles.absentTitle}>Aramada değil</Text>
      {absent.map(({ userId, ringing }) => (
        <View key={userId} style={styles.absentRow}>
          <Avatar user={users[userId]} size={32} />
          <Text style={styles.absentName} numberOfLines={1}>
            {users[userId]?.displayName ?? 'Silinmiş Kullanıcı'}
          </Text>
          {ringing ? (
            <View style={styles.ringing}>
              <Ionicons name="call" size={13} color={colors.okText} />
              <Text style={styles.ringingText}>Çalıyor…</Text>
            </View>
          ) : (
            <Pressable
              onPress={() =>
                void ringDmCall(dmId, userId).then((ok) => ok && toast(`${users[userId]?.displayName ?? 'Kişi'} yeniden aranıyor`))
              }
              android_ripple={{ color: 'rgba(255,255,255,0.12)', borderless: false }}
              accessibilityRole="button"
              accessibilityLabel={`${users[userId]?.displayName ?? 'Kişiyi'} tekrar çal`}
              style={styles.ringAgain}
            >
              <Ionicons name="call" size={14} color="#fff" />
              <Text style={styles.ringAgainText}>Tekrar çal</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

/** Yayının gerçekte nasıl gittiği: çözünürlük, kare hızı, bit hızı, kodlayıcı ve varsa darboğaz */
function ShareStatsLine() {
  const [stats, setStats] = useState<ScreenShareStats | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = (): void =>
      void voice
        .screenShareStats()
        .then((next) => alive && setStats(next))
        .catch(() => undefined);
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!stats) return null;
  const parts = [
    stats.width ? `${stats.width}×${stats.height}` : null,
    `${stats.fps} FPS`,
    `${(stats.kbps / 1000).toFixed(1).replace('.', ',')} Mbps`,
    stats.encoder,
    stats.limit ? `darboğaz: ${stats.limit === 'cpu' ? 'işlemci' : stats.limit === 'bandwidth' ? 'bağlantı' : stats.limit}` : null,
    stats.keyframeRequests ? `anahtar kare isteği: ${stats.keyframeRequests}` : null,
  ];
  return (
    <Text style={styles.statsText} selectable>
      {parts.filter(Boolean).join(' · ')}
    </Text>
  );
}

const styles = createStyles(() => ({
  page: { flex: 1, backgroundColor: colors.deep },
  sharing: {
    backgroundColor: colors.okSoft,
    marginHorizontal: space.sm,
    marginTop: space.sm,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  sharingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.ok },
  sharingText: { color: colors.okText, fontSize: font.small, fontWeight: '700' },
  statsText: { color: colors.muted, fontSize: 11.5, textAlign: 'center', marginTop: 2 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    padding: GRID_PADDING,
    gap: GRID_GAP,
  },
  absent: {
    width: '100%',
    marginTop: space.sm,
    backgroundColor: colors.rail,
    borderRadius: radius.md,
    paddingVertical: space.xs,
  },
  absentTitle: {
    color: colors.muted,
    fontSize: font.caption,
    fontWeight: '800',
    letterSpacing: 0.4,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  absentRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: 6 },
  absentName: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: '600' },
  ringing: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  ringingText: { color: colors.okText, fontSize: font.small, fontWeight: '700' },
  ringAgain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.ok,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    height: 32,
    overflow: 'hidden',
  },
  ringAgainText: { color: '#fff', fontSize: font.small, fontWeight: '700' },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'flex-start',
    paddingTop: space.md,
    paddingBottom: space.md,
    backgroundColor: colors.rail,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
}));
