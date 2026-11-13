import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, PixelRatio, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { VideoTrack } from '@livekit/react-native';
import { RemoteVideoTrack, Track } from 'livekit-client';
import { isStreamMuted, shownStreamVolume, useGuild } from '@diskort/client-core';
import { timing } from '../motion';
import { useSettings } from '../stores/settings';
import { colors, createStyles } from '../theme';
import { noteStreamView } from '../voice/connectionStats';
import { useVoice, voice } from '../voice/voice';
import { StreamViewers } from './StreamViewers';
import { SwapIcon, type SwapMotion } from './SwapIcon';
import { VolumeControl } from './VolumeControl';
import { useViewerGestures } from './viewerGestures';
import { clamp, type Size } from './viewerZoom';

/** Denetimler son dokunuştan bu kadar sonra kaybolur */
const CONTROLS_MS = 3000;
/** "Yayın sona erdi" bu kadar sonra kendiliğinden kapanır */
const ENDED_MS = 4000;

/**
 * İzlenen ekran yayını. Aynı bileşen hem ses ekranındaki küçük görünümü hem tam ekranı çizer:
 * tam ekrana geçince yalnızca yerleşimi değişir, video (VideoTrack) yeniden bağlanmaz ve kararmaz.
 *
 * - Dokun: denetimleri göster/gizle (3 sn sonra kendiliğinden kaybolur)
 * - Çift dokun: küçükken tam ekran; tam ekranda sığdır/doldur (yakınlaştırılmışsa sıfırla)
 * - Tam ekranda iki parmakla yakınlaştır, tek parmakla kaydır, aşağı sürükleyerek çık
 */
export function StreamViewer({
  userId,
  fullscreen,
  onFullscreen,
  onRotate,
}: {
  userId: string;
  fullscreen: boolean;
  onFullscreen: (on: boolean) => void;
  /** Yatay/dikey arasında döndür (yalnızca tam ekranda gösterilir) */
  onRotate: () => void;
}) {
  const window = useWindowDimensions();
  const landscape = window.width > window.height;
  const insets = useSafeAreaInsets();
  const name = useGuild((s) => s.users[userId]?.displayName ?? '…');
  const ended = useVoice((s) => s.streamEnded === userId && s.watching !== userId);
  const hasAudio = useVoice((s) => Boolean(s.streamAudio[userId]));
  // Kaydedilmiş istek (sessize alma ayrı tutulur); ses izi her geldiğinde voice bunu yeniden uygular
  const volume = useSettings((s) => shownStreamVolume(s, userId));
  const streamMuted = useSettings((s) => isStreamMuted(s, userId));
  // Abonelik değişince (iz geldi/gitti) yeniden çiz
  useVoice((s) => s.tracksVersion);
  const found = ended ? null : voice.getScreenPublication(userId);
  const track = found?.publication.videoTrack;
  const videoTrack = track instanceof RemoteVideoTrack ? track : undefined;
  const video = useVideoInfo(videoTrack, found?.publication.dimensions);
  const loading = !ended && (!videoTrack || !video.ready);

  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [fit, setFit] = useState<'contain' | 'cover'>('contain');

  // Ölçüm (bağlantı paneli ve ses kalitesi özeti): görünüm tam ekran mı, kaç fiziksel piksel
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return;
    const k = PixelRatio.get();
    noteStreamView({
      mode: fullscreen ? 'fullscreen' : 'inline',
      width: Math.round(size.width * k),
      height: Math.round(size.height * k),
    });
  }, [fullscreen, size]);
  useEffect(() => () => noteStreamView(null), []);

  // Denetimler: dokununca görünür, bir süre sonra kaybolur; bilgi gösterilirken (yükleniyor) kalır
  const [controls, setControls] = useState(true);
  const fade = useRef(new Animated.Value(1)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinned = loading || ended;
  const poke = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), CONTROLS_MS);
  }, []);
  useEffect(() => {
    timing(fade, controls || pinned ? 1 : 0, 180).start();
    if (controls && !pinned) poke();
    else if (hideTimer.current) clearTimeout(hideTimer.current);
  }, [controls, pinned, fade, poke]);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  // Tam ekrana girip çıkınca denetimler bir süre görünür; küçük görünümde hep "sığdır"
  useEffect(() => {
    setControls(true);
    if (!fullscreen) setFit('contain');
  }, [fullscreen]);

  // Yayın bitti: bilgi kısa süre görünür, sonra kapanır (tam ekrandaysa ondan da çıkılır)
  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(() => voice.dismissEndedStream(), ENDED_MS);
    return () => clearTimeout(timer);
  }, [ended]);

  const gestures = useViewerGestures({
    zoomable: fullscreen && !ended,
    size,
    onTap: () => setControls((on) => !on),
    onDoubleTap: () => {
      if (!fullscreen) onFullscreen(true);
      else setFit((f) => (f === 'contain' ? 'cover' : 'contain'));
    },
    onSwipeDown: () => onFullscreen(false),
  });

  const aspect = video.size ? clamp(video.size.width / video.size.height, 0.4, 2.6) : 16 / 9;
  const inlineHeight = Math.round(Math.min(window.width / aspect, window.height * (landscape ? 0.62 : 0.42)));
  const showControls = controls || pinned;
  const edge = fullscreen
    ? { paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }
    : { paddingHorizontal: 8 };

  return (
    <View
      style={fullscreen ? styles.full : [styles.inline, { height: inlineHeight }]}
      onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: gestures.transform }]}>
        {found?.publication.track ? (
          <VideoTrack
            trackRef={{ participant: found.participant, publication: found.publication, source: Track.Source.ScreenShare }}
            objectFit={fullscreen ? fit : 'contain'}
            style={styles.video}
          />
        ) : null}
      </Animated.View>

      {/* Dokunma/yakınlaştırma katmanı (denetimlerin altında) */}
      <View style={StyleSheet.absoluteFill} {...gestures.panHandlers} />

      {loading && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.info}>{videoTrack ? 'Yayın yükleniyor…' : 'Yayına bağlanılıyor…'}</Text>
        </View>
      )}

      {ended && (
        <View style={[StyleSheet.absoluteFill, styles.center, styles.endedBg]}>
          <Ionicons name="videocam-off-outline" size={30} color={colors.muted} />
          <Text style={styles.info}>{name} yayını bitirdi</Text>
          <Pressable
            onPress={() => voice.dismissEndedStream()}
            style={({ pressed }) => [styles.endedButton, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.endedButtonText}>Kapat</Text>
          </Pressable>
        </View>
      )}

      {!ended && (
        <Animated.View
          pointerEvents={showControls ? 'box-none' : 'none'}
          style={[StyleSheet.absoluteFill, styles.overlay, { opacity: fade }]}
        >
          <View style={[styles.bar, edge, fullscreen && { paddingTop: insets.top + 8 }]}>
            {fullscreen && (
              <RoundButton icon="chevron-down" label="Tam ekrandan çık" onPress={() => onFullscreen(false)} />
            )}
            <View style={styles.live}>
              <Text style={styles.liveText}>YAYINDA</Text>
            </View>
            <Text style={[styles.name, !fullscreen && styles.nameSmall]} numberOfLines={1}>
              {name}
            </Text>
            <View style={{ flex: 1 }} />
            <StreamViewers userId={userId} />
            {!fullscreen && <RoundButton icon="close" label="İzlemeyi bırak" onPress={() => voice.watch(null)} small />}
          </View>

          <View style={[styles.bar, edge, fullscreen && { paddingBottom: insets.bottom + 10 }]}>
            {hasAudio ? (
              <VolumeControl
                label="Yayın sesi"
                style={{ flex: 1, maxWidth: fullscreen ? 380 : undefined }}
                value={volume}
                muted={streamMuted}
                onToggleMute={() => voice.toggleStreamAudio(userId)}
                onInteract={poke}
                onPreview={(v) => voice.setVolume(userId, 'stream', v, false)}
                onCommit={(v) => voice.setVolume(userId, 'stream', v)}
              />
            ) : (
              <Text style={styles.noAudio}>Yayında ses yok</Text>
            )}
            <View style={{ flex: hasAudio ? 0 : 1, minWidth: 4 }} />
            {fullscreen && (
              <RoundButton
                icon={fit === 'contain' ? 'crop-outline' : 'scan-outline'}
                label={fit === 'contain' ? 'Ekranı doldur' : 'Ekrana sığdır'}
                onPress={() => {
                  poke();
                  setFit((f) => (f === 'contain' ? 'cover' : 'contain'));
                }}
              />
            )}
            {fullscreen && (
              <RoundButton
                icon={landscape ? 'phone-portrait-outline' : 'phone-landscape-outline'}
                label={landscape ? 'Dikey çevir' : 'Yatay çevir'}
                motion="turn"
                onPress={() => {
                  poke();
                  onRotate();
                }}
              />
            )}
            <RoundButton
              icon={fullscreen ? 'contract' : 'expand'}
              label={fullscreen ? 'Tam ekrandan çık' : 'Tam ekran'}
              onPress={() => onFullscreen(!fullscreen)}
              small={!fullscreen}
            />
          </View>
        </Animated.View>
      )}
    </View>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
  small,
  motion,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  small?: boolean;
  /** Simge değişince (tam ekran ↔ çık, yatay ↔ dikey) yenisine geçerken oynayan hareket */
  motion?: SwapMotion;
}) {
  const size = small ? 32 : 40;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.round,
        { width: size, height: size, borderRadius: size / 2 },
        pressed && { backgroundColor: 'rgba(255,255,255,0.22)' },
      ]}
    >
      <SwapIcon name={icon} size={small ? 17 : 21} color="#fff" motion={motion} />
    </Pressable>
  );
}

/**
 * Videonun boyutu ve ilk karenin gelip gelmediği (alıcı istatistiklerinden). Boyut gelene kadar
 * yayıncının bildirdiği boyut kullanılır. Görünüm açıldıktan sonra yeni kare çözülünce "hazır" olur.
 */
function useVideoInfo(track: RemoteVideoTrack | undefined, announced: Size | undefined): { size: Size | null; ready: boolean } {
  const [size, setSize] = useState<Size | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (!track) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let base: number | null = null;
    const tick = async (): Promise<void> => {
      let next = 3000;
      try {
        const stats = await track.getReceiverStats();
        if (!alive) return;
        // İstatistik alınamıyorsa bekletme (görüntü zaten geldiğinde görünür)
        if (!stats) {
          setReady(true);
          return;
        }
        const decoded = stats.framesDecoded ?? 0;
        if (base === null) base = decoded;
        if (decoded > base) setReady(true);
        else next = 400;
        const { frameWidth: width, frameHeight: height } = stats;
        if (width && height) {
          setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
        }
      } catch {
        if (alive) setReady(true);
        return;
      }
      if (alive) timer = setTimeout(() => void tick(), next);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [track]);

  const fallback = announced && announced.width > 0 && announced.height > 0 ? announced : null;
  return { size: size ?? fallback, ready };
}

const styles = createStyles(() => ({
  inline: { backgroundColor: '#000', overflow: 'hidden' },
  // Ses ekranının tamamını kaplar (başlık, durum çubuğu ve gezinme çubuğu gizlenir)
  full: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10, backgroundColor: '#000' },
  video: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10 },
  info: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '500' },
  endedBg: { backgroundColor: 'rgba(0,0,0,0.75)' },
  endedButton: {
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  endedButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  overlay: { justifyContent: 'space-between' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  live: { backgroundColor: colors.danger, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  liveText: { color: '#fff', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.4 },
  name: { color: '#fff', fontSize: 15, fontWeight: '600', flexShrink: 1 },
  nameSmall: { fontSize: 13 },
  noAudio: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, marginLeft: 4 },
  round: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.1)' },
}));
