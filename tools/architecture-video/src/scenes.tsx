import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, Caption, FONT, Lines, MONO, Node, Pill, Scene, Sfx } from './kit';

export const DUR = { title: 180, clients: 300, server: 390, voice: 450, text: 360, pipeline: 480, outro: 210 };

const Fade: React.FC<{ dur: number; children: React.ReactNode }> = ({ dur, children }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 10, dur - 10, dur], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <div style={{ position: 'absolute', inset: 0, opacity: o, background: C.bg }}>{children}</div>;
};

const Big: React.FC<{ sub: string; sub2?: string; dur: number; ding?: number }> = ({ sub, sub2, dur, ding = 26 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f - 6, fps, config: { damping: 14, stiffness: 90 } });
  const o2 = interpolate(f, [40, 60], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const o3 = interpolate(f, [62, 82], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const glow = 0.5 + 0.2 * Math.sin(f / 12);
  return (
    <Fade dur={dur}>
      <Sfx at={0} name="whoosh" vol={0.5} />
      <Sfx at={ding} name="ding" vol={0.55} />
      <div style={{ position: 'absolute', left: 660, top: 190, width: 600, height: 600, borderRadius: 300, background: C.brand, filter: 'blur(160px)', opacity: glow * 0.55 }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 380, textAlign: 'center', fontFamily: FONT, fontWeight: 900, fontSize: 210, color: C.text, transform: `scale(${0.7 + 0.3 * s})`, opacity: s, letterSpacing: -4 }}>
        Disk<span style={{ color: C.brand }}>ort</span>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 640, textAlign: 'center', fontFamily: FONT, fontSize: 52, color: C.normal, opacity: o2 }}>{sub}</div>
      {sub2 && <div style={{ position: 'absolute', left: 0, right: 0, top: 730, textAlign: 'center', fontFamily: MONO, fontSize: 40, color: C.brandSoft, opacity: o3 }}>{sub2}</div>}
    </Fade>
  );
};

export const TitleScene = () => <Big dur={DUR.title} sub="Mimari turu: bir topluluk sunucusu nasıl çalışıyor?" sub2="ses · ekran paylaşımı · metin" />;

export const OutroScene = () => <Big dur={DUR.outro} ding={20} sub="Kendi sunucun, kendi topluluğun." sub2="diskort.ziroo.net" />;

export const ClientsScene = () => (
  <Scene n="01" title="İstemciler" dur={DUR.clients}>
    <Node x={480} y={330} delay={20} title="Masaüstü (Electron)" sub="Windows · Linux · macOS" />
    <Node x={960} y={330} delay={34} title="Android" sub="React Native · Expo" color={C.ok} />
    <Node x={1440} y={330} delay={48} title="iOS" sub="React Native · Expo" color={C.link} />
    <Lines
      lines={[
        { from: [480, 400], to: [700, 600], delay: 90, color: C.brand },
        { from: [960, 400], to: [960, 600], delay: 100, color: C.ok },
        { from: [1440, 400], to: [1220, 600], delay: 110, color: C.link },
      ]}
    />
    <Node x={960} y={680} w={1300} h={160} delay={80} title="packages/client-core" sub="Ortak TypeScript: API, gateway, mesajlar, izinler, ses tanılama" color={C.warn} />
    <Node x={960} y={890} w={800} h={100} delay={170} title="packages/shared" sub="Ortak türler ve yetki tanımları" color={C.muted} small />
    <Lines lines={[{ from: [960, 760], to: [960, 840], delay: 165, color: C.muted, dur: 14 }]} />
    <Caption delay={130} y={985}>Tek mantık, her platformda aynı davranış</Caption>
  </Scene>
);

export const ServerScene = () => (
  <Scene n="02" title="Sunucu" dur={DUR.server}>
    <Node x={230} y={520} w={300} h={130} delay={16} title="İstemciler" sub="HTTPS · WSS" />
    <Node x={640} y={520} w={340} h={150} delay={40} title="Caddy" sub="Otomatik HTTPS (Let's Encrypt)" color={C.warn} />
    <Lines lines={[{ from: [380, 520], to: [470, 520], delay: 36 }]} />
    <Node x={1140} y={330} w={400} h={130} delay={80} title="Fastify API" sub="REST  /api/*" />
    <Node x={1140} y={520} w={400} h={130} delay={100} title="Gateway" sub="WebSocket  /gateway" />
    <Node x={1140} y={710} w={400} h={130} delay={120} title="Web sayfası" sub="İndirme · /updates" color={C.muted} />
    <Lines
      lines={[
        { from: [810, 500], to: [940, 340], delay: 76 },
        { from: [810, 520], to: [940, 520], delay: 96 },
        { from: [810, 540], to: [940, 700], delay: 116, color: C.muted },
      ]}
    />
    <Node x={1650} y={330} w={340} h={130} delay={170} title="Dosya deposu" sub="Ekler ve avatarlar" color={C.ok} />
    <Node x={1650} y={600} w={340} h={130} delay={190} title="SQLite" sub="node:sqlite · kalıcı veri" color={C.ok} />
    <Lines
      lines={[
        { from: [1340, 330], to: [1480, 330], delay: 166, color: C.ok },
        { from: [1300, 395], to: [1560, 535], delay: 186, color: C.ok },
        { from: [1340, 530], to: [1480, 585], delay: 200, color: C.ok },
      ]}
    />
    <Pill x={1140} y={850} delay={230} w={560} text="Davet kodu + hesap · Argon2 + JWT" />
    <Caption delay={270} y={960}>Docker Compose ile tek VPS: diskort.ziroo.net</Caption>
  </Scene>
);

export const VoiceScene = () => {
  const ys = [330, 560, 790];
  const names = ['Kişi A', 'Kişi B', 'Kişi C'];
  return (
    <Scene n="03" title="Ses ve ekran paylaşımı" dur={DUR.voice}>
      {ys.map((y, i) => (
        <React.Fragment key={i}>
          <Node x={300} y={y - 30} w={340} h={100} delay={14 + i * 10} title={names[i]} small />
          <Pill x={300} y={y + 55} delay={70 + i * 8} w={340} text="AI gürültü engelleme" />
        </React.Fragment>
      ))}
      <Lines
        lines={ys.map((y, i) => ({ from: [470, y - 30], to: [790, 560], delay: 150 + i * 12, both: true, label: i === 1 ? 'WebRTC · UDP' : undefined }))}
      />
      <Node x={960} y={560} w={330} h={200} delay={130} title="LiveKit SFU" sub="Ses ve görüntüyü dağıtır" color={C.brand} />
      <Node x={1570} y={330} w={420} h={120} delay={250} title="TURN / UDP 3478" sub="Yedek bağlantı" color={C.warn} small />
      <Node x={1570} y={560} w={420} h={130} delay={290} title="TURN / TLS 443" sub="Caddy üzerinden, okul/iş ağları" color={C.warn} small />
      <Lines
        lines={[
          { from: [1125, 500], to: [1360, 350], delay: 250, color: C.warn, dashed: true },
          { from: [1125, 560], to: [1360, 560], delay: 290, color: C.warn, dashed: true },
        ]}
      />
      <Node x={1570} y={790} w={420} h={130} delay={330} title="API" sub="Kısa ömürlü erişim belirteci" color={C.brand} small />
      <Lines lines={[{ from: [1360, 780], to: [1040, 665], delay: 335, color: C.brand, dashed: true }]} />
      <Caption delay={80} until={230} y={985} color={C.ok}>Gürültü engelleme cihazın içinde çalışır: DPDFNet / DeepFilterNet</Caption>
      <Caption delay={370} y={985}>Opus ses · 720p30 → 1440p60 ekran · yayın yalnızca izleyene gider</Caption>
    </Scene>
  );
};

export const TextScene = () => (
  <Scene n="04" title="Metin, DM, dosya ve bildirim" dur={DUR.text}>
    <Node x={960} y={430} w={420} h={140} delay={14} title="Gateway" sub="Gerçek zamanlı olaylar" />
    <Node x={380} y={300} w={460} h={130} delay={40} title="Metin kanalları" sub="Geçmiş · tepkiler · @bahsetme" small />
    <Node x={380} y={560} w={460} h={130} delay={60} title="Direkt mesajlar" sub="Bire bir ve küçük grup" small />
    <Node x={1540} y={300} w={460} h={130} delay={80} title="Dosya ve resim" sub="Yükleme · konum bilgisi silinir" color={C.ok} small />
    <Node x={1540} y={560} w={460} h={130} delay={100} title="Profil fotoğrafı" sub="256×256 WebP" color={C.ok} small />
    <Lines
      lines={[
        { from: [750, 400], to: [610, 320], delay: 44, both: true },
        { from: [750, 460], to: [610, 550], delay: 64, both: true },
        { from: [1170, 400], to: [1310, 320], delay: 84, color: C.ok },
        { from: [1170, 460], to: [1310, 550], delay: 104, color: C.ok },
      ]}
    />
    <Node x={230} y={860} w={320} h={110} delay={170} title="Yeni mesaj" small color={C.muted} />
    <Node x={690} y={860} w={320} h={110} delay={200} title="Sunucu" sub="Çevrimdışıysa push" small />
    <Node x={1200} y={860} w={360} h={110} delay={230} title="FCM / APNs" sub="Android / iOS" small color={C.warn} />
    <Node x={1680} y={860} w={320} h={110} delay={260} title="Telefon" sub="Bildirim" small color={C.ok} />
    <Lines
      lines={[
        { from: [390, 860], to: [530, 860], delay: 196 },
        { from: [850, 860], to: [1020, 860], delay: 226 },
        { from: [1380, 860], to: [1520, 860], delay: 256, color: C.warn },
      ]}
    />
    <Sfx at={290} name="ding" vol={0.5} />
    <Caption delay={300} y={730}>Bahsetmeler ve DM mesajları çevrimdışıyken de kaybolmaz</Caption>
  </Scene>
);

export const PipelineScene = () => {
  const xs = [190, 575, 960, 1345, 1730];
  return (
    <Scene n="05" title="Geliştirmeden yayına" dur={DUR.pipeline}>
      <Node x={xs[0]} y={340} w={280} h={130} delay={14} title="git push" sub="v* etiketi" small mono />
      <Node x={xs[1]} y={340} w={300} h={130} delay={40} title="GitHub Actions" sub="5 platform derlenir" small color={C.ok} />
      <Node x={xs[2]} y={340} w={300} h={130} delay={70} title="GitHub Release" sub="Taslak → yayın" small color={C.warn} />
      <Node x={xs[3]} y={340} w={300} h={130} delay={100} title="Diskort sunucusu" sub="/updates yönlendirir" small />
      <Node x={xs[4]} y={340} w={280} h={130} delay={130} title="İstemciler" sub="Sürüm bildirimi" small color={C.link} />
      <Lines
        lines={[
          { from: [xs[0] + 145, 340], to: [xs[1] - 155, 340], delay: 34, dur: 14 },
          { from: [xs[1] + 155, 340], to: [xs[2] - 155, 340], delay: 64, dur: 14, color: C.ok },
          { from: [xs[2] + 155, 340], to: [xs[3] - 155, 340], delay: 94, dur: 14, color: C.warn },
          { from: [xs[3] + 155, 340], to: [xs[4] - 145, 340], delay: 124, dur: 14 },
        ]}
      />
      <Sfx at={150} name="rise" vol={0.5} />
      <Node x={380} y={720} w={520} h={190} delay={200} title="Masaüstü" sub="electron-updater · latest.yml" color={C.brand} />
      <Node x={960} y={720} w={520} h={190} delay={250} title="Android" sub="İmzalı APK + Expo OTA /updates/expo/android" color={C.ok} />
      <Node x={1540} y={720} w={520} h={190} delay={300} title="iOS" sub="Ad Hoc IPA (itms-services) + OTA" color={C.link} />
      <Lines
        lines={[
          { from: [xs[3] + 60, 405], to: [1540, 625], delay: 296, color: C.link, dur: 26 },
          { from: [xs[3], 405], to: [960, 625], delay: 246, color: C.ok, dur: 30 },
          { from: [xs[3] - 60, 405], to: [380, 625], delay: 196, color: C.brand, dur: 34 },
        ]}
      />
      <Sfx at={340} name="ding" vol={0.5} />
      <Caption delay={340} y={930}>Yerel kısım değişmediyse telefon uygulaması yeniden kurulmadan güncellenir (OTA)</Caption>
      <Caption delay={400} y={990} color={C.muted}>Eski istemciler sunucu tarafından güncellemeye yönlendirilir</Caption>
    </Scene>
  );
};

