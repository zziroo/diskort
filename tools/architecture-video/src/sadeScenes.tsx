import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Big } from './scenes';
import { C, FONT, Lines, Scene, Sfx } from './kit';

// "Nasıl çalışır?" videosu: jargonsuz, sahne başına tek fikir
export const SDUR = { title: 150, device: 330, server: 330, voice: 480, text: 450, invite: 270, update: 300, outro: 180 };

const EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

const useIn = (delay: number) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 16, stiffness: 90 } });
  const opacity = interpolate(frame - delay, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return { s, opacity };
};

/** İkon + başlık + kısa açıklama; büyük yazılı kutu */
const Box: React.FC<{
  x: number; y: number; w: number; h: number; delay: number; emoji: string; title: string; sub?: string; color?: string;
}> = ({ x, y, w, h, delay, emoji, title, sub, color = C.brand }) => {
  const { s, opacity } = useIn(delay);
  return (
    <>
      <Sfx at={delay} name="pop" vol={0.3} />
      <div
        style={{
          position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, opacity,
          transform: `scale(${0.7 + 0.3 * s})`, background: C.card, border: `4px solid ${color}`, borderRadius: 28,
          boxShadow: `0 0 50px ${color}33`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', padding: '0 20px', boxSizing: 'border-box',
        }}
      >
        <div style={{ fontFamily: EMOJI, fontSize: 92, lineHeight: 1.1 }}>{emoji}</div>
        <div style={{ fontFamily: FONT, fontSize: 46, fontWeight: 800, color: C.text, marginTop: 6 }}>{title}</div>
        {sub && <div style={{ fontFamily: FONT, fontSize: 34, color: C.normal, marginTop: 8, lineHeight: 1.25 }}>{sub}</div>}
      </div>
    </>
  );
};

/** Grup çerçevesi: "burası hangi yer" */
const Frame: React.FC<{ x: number; y: number; w: number; h: number; delay: number; label: string; color?: string }> = ({ x, y, w, h, delay, label, color = C.brand }) => {
  const { opacity } = useIn(delay);
  return (
    <div style={{ position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, opacity, border: `3px dashed ${color}`, borderRadius: 36, background: `${color}0d`, boxSizing: 'border-box' }}>
      <div style={{ position: 'absolute', left: 30, top: -30, padding: '0 18px', background: C.bg, fontFamily: FONT, fontSize: 40, fontWeight: 700, color }}>{label}</div>
    </div>
  );
};

const Chip: React.FC<{ x: number; y: number; delay: number; text: string; color?: string; w?: number }> = ({ x, y, delay, text, color = C.ok, w = 520 }) => {
  const { s, opacity } = useIn(delay);
  return (
    <div style={{ position: 'absolute', left: x - w / 2, top: y - 34, width: w, height: 68, opacity, transform: `scale(${0.8 + 0.2 * s})`, border: `3px solid ${color}`, background: `${color}22`, borderRadius: 34, color, fontFamily: FONT, fontSize: 38, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>
      {text}
    </div>
  );
};

/** Alt yazı: kısa cümle, [from, until) aralığında görünür */
const Say: React.FC<{ from: number; until?: number; children: React.ReactNode; color?: string }> = ({ from, until, children, color = C.text }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, until === undefined ? [from, from + 14] : [from, from + 14, until - 8, until], until === undefined ? [0, 1] : [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', left: 60, right: 60, top: 920, textAlign: 'center', opacity: o, transform: `translateY(${(1 - o) * 14}px)`, fontFamily: FONT, fontSize: 56, fontWeight: 700, color }}>
      {children}
    </div>
  );
};

/** Sahne içinde belli aralıkta görünen grup (aşama) */
const Phase: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({ from, to, children }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [from, from + 10, to - 10, to], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <div style={{ position: 'absolute', inset: 0, opacity: o }}>{children}</div>;
};

export const STitle = () => <Big dur={SDUR.title} sub="Nasıl çalışır? Ne nerede?" sub2="kısaca, sade anlatım" />;
export const SOutro = () => <Big dur={SDUR.outro} ding={20} sub="Kendi sunucun, kendi topluluğun." sub2="diskort.ziroo.net" />;

export const SDevice = () => (
  <Scene n="01" title="Senin cihazın" dur={SDUR.device}>
    <Frame x={960} y={520} w={1500} h={600} delay={14} label="📱💻 Uygulama burada çalışır" color={C.link} />
    <Box x={480} y={540} w={400} h={330} delay={60} emoji="🎤" title="Mikrofon" color={C.link} />
    <Box x={960} y={540} w={400} h={330} delay={100} emoji="🖥️" title="Ekranın" color={C.link} />
    <Box x={1440} y={540} w={400} h={330} delay={140} emoji="🔊" title="Sesler" sub="hoparlör, bildirim" color={C.link} />
    <Say from={30} until={200}>Uygulama senin cihazında çalışır.</Say>
    <Say from={200}>Mikrofon, ekran ve sesler senin cihazında.</Say>
  </Scene>
);

export const SServer = () => (
  <Scene n="02" title="Diskort'un sunucusu" dur={SDUR.server}>
    <Frame x={960} y={520} w={1700} h={640} delay={14} label="🏢 Kiralık, hep açık tek bir bilgisayar" color={C.warn} />
    <Box x={560} y={570} w={720} h={400} delay={60} emoji="🎙️" title="Toplantı odası" sub="Ses ve görüntü buradan herkese dağıtılır" color={C.warn} />
    <Box x={1360} y={570} w={720} h={400} delay={130} emoji="📬" title="Posta kutusu" sub="Mesajlar ve dosyalar burada saklanır" color={C.warn} />
    <Say from={40} until={190}>Sunucu, toplantı odası ve posta kutusu gibidir.</Say>
    <Say from={190}>Bu bilgisayar her zaman açıktır.</Say>
  </Scene>
);

export const SVoice = () => (
  <Scene n="03" title="Sesin yolculuğu" dur={SDUR.voice}>
    <Frame x={430} y={470} w={760} h={400} delay={10} label="Senin cihazın" color={C.link} />
    <Box x={250} y={490} w={270} h={300} delay={20} emoji="🗣️" title="Sen" color={C.link} />
    <Box x={610} y={490} w={290} h={300} delay={130} emoji="🧼" title="Temizlik" sub="gürültü kesilir" color={C.ok} />
    <Lines lines={[{ from: [385, 490], to: [465, 490], delay: 110, dur: 16, color: C.ok }]} />
    <Box x={1120} y={490} w={290} h={300} delay={250} emoji="🏢" title="Sunucu" color={C.warn} />
    <Lines lines={[{ from: [755, 490], to: [975, 490], delay: 240, dur: 24, color: C.ok }]} />
    <Box x={1660} y={330} w={340} h={250} delay={310} emoji="🙂" title="Arkadaşın" color={C.brand} />
    <Box x={1660} y={640} w={340} h={250} delay={325} emoji="🙂" title="Arkadaşın" color={C.brand} />
    <Lines
      lines={[
        { from: [1265, 460], to: [1490, 350], delay: 305, dur: 20, color: C.ok },
        { from: [1265, 520], to: [1490, 630], delay: 320, dur: 20, color: C.ok },
      ]}
    />
    <Chip x={1120} y={700} delay={400} text="🖥️ ekran yayını" w={400} color={C.warn} />
    <Chip x={1660} y={160} delay={430} text="👀 izliyor" w={300} color={C.warn} />
    <Chip x={1660} y={815} delay={440} text="izlemiyor" w={300} color={C.muted} />
    <Say from={20} until={130}>Sen konuşursun.</Say>
    <Say from={130} until={250}>Ses önce cihazında temizlenir.</Say>
    <Say from={250} until={380}>Sonra sunucuya gider, o da arkadaşlarına ulaştırır.</Say>
    <Say from={385}>Ekran yayını yalnızca izlemek isteyene gider.</Say>
  </Scene>
);

export const SText = () => (
  <Scene n="04" title="Mesajlar" dur={SDUR.text}>
    <Phase from={0} to={235}>
      <Box x={300} y={470} w={330} h={320} delay={14} emoji="✍️" title="Sen" sub="mesaj yazarsın" color={C.link} />
      <Box x={960} y={470} w={400} h={320} delay={60} emoji="📬" title="Sunucu" sub="mesaj saklanır" color={C.warn} />
      <Lines lines={[{ from: [465, 470], to: [760, 470], delay: 40, dur: 20, color: C.link }]} />
      <Box x={1590} y={470} w={380} h={320} delay={130} emoji="😴" title="Arkadaşın" sub="şu an çevrimdışı" color={C.brand} />
      <Chip x={1540} y={760} delay={180} text="🔔 telefonuna bildirim" w={560} color={C.ok} />
      <Lines lines={[{ from: [1165, 470], to: [1395, 470], delay: 170, dur: 20, color: C.ok, dashed: true }]} />
      <Say from={40} until={130}>Yazdığın mesaj sunucuda saklanır.</Say>
      <Say from={130}>Çevrimdışı arkadaşın sonra görür; telefonuna bildirim gelir.</Say>
    </Phase>
    <Phase from={235} to={450}>
      <Box x={330} y={440} w={340} h={320} delay={250} emoji="🧑" title="Sen" color={C.link} />
      <Box x={960} y={440} w={460} h={320} delay={270} emoji="🔒" title="Direkt mesaj" color={C.ok} />
      <Box x={1590} y={440} w={340} h={320} delay={290} emoji="🧑" title="Arkadaşın" color={C.link} />
      <Lines
        lines={[
          { from: [500, 440], to: [730, 440], delay: 285, dur: 18, color: C.ok },
          { from: [1190, 440], to: [1420, 440], delay: 300, dur: 18, color: C.ok },
        ]}
      />
      <Chip x={960} y={700} delay={335} text="🕵️ yönetici: göremez" w={640} color={C.danger} />
      <Chip x={960} y={790} delay={400} text="📍 fotoğraflardaki konum silinir" w={820} color={C.ok} />
      <Say from={250} until={330}>Direkt mesajı yalnızca konuşmadakiler görür.</Say>
      <Say from={330} until={395}>Sunucu yöneticileri bile okuyamaz.</Say>
      <Say from={395}>Fotoğraflardaki konum bilgisi de silinir.</Say>
    </Phase>
  </Scene>
);

export const SInvite = () => (
  <Scene n="05" title="Kapalı topluluk" dur={SDUR.invite}>
    <Box x={960} y={470} w={480} h={340} delay={14} emoji="🚪" title="Topluluk" sub="yalnızca davetliler" color={C.brand} />
    <Box x={320} y={330} w={420} h={260} delay={50} emoji="🎟️" title="Davet kodu var" color={C.ok} />
    <Lines lines={[{ from: [530, 360], to: [720, 430], delay: 90, dur: 22, color: C.ok }]} />
    <Lines lines={[{ from: [1200, 400], to: [1400, 330], delay: 100, dur: 20, color: C.ok }]} />
    <Chip x={1560} y={330} delay={120} text="✅ girer" w={320} color={C.ok} />
    <Box x={320} y={690} w={420} h={260} delay={150} emoji="😕" title="Kodu yok" color={C.danger} />
    <Lines lines={[{ from: [530, 660], to: [700, 560], delay: 180, dur: 22, color: C.danger, dashed: true }]} />
    <Lines lines={[{ from: [1200, 540], to: [1400, 690], delay: 180, dur: 20, color: C.danger, dashed: true }]} />
    <Chip x={1560} y={690} delay={200} text="✋ giremez" w={320} color={C.danger} />
    <Say from={40} until={170}>Davet kodu olan girer.</Say>
    <Say from={170}>Kodu olmayan giremez.</Say>
  </Scene>
);

export const SUpdate = () => (
  <Scene n="06" title="Güncellemeler" dur={SDUR.update}>
    <Box x={340} y={470} w={400} h={340} delay={14} emoji="🛠️" title="Yeni sürüm" sub="hazırlanır" color={C.brand} />
    <Box x={960} y={470} w={400} h={340} delay={80} emoji="🏢" title="Sunucu" sub="haber verir" color={C.warn} />
    <Box x={1580} y={470} w={420} h={340} delay={150} emoji="📱" title="Senin cihazın" sub="kendini günceller" color={C.link} />
    <Lines
      lines={[
        { from: [545, 470], to: [755, 470], delay: 60, dur: 20 },
        { from: [1165, 470], to: [1365, 470], delay: 130, dur: 20, color: C.warn },
      ]}
    />
    <Chip x={1580} y={740} delay={220} text="✅ güncel" w={320} color={C.ok} />
    <Sfx at={225} name="ding" vol={0.5} />
    <Say from={30} until={170}>Yeni sürüm hazırlanınca uygulama haber alır.</Say>
    <Say from={170}>Ve kendini günceller.</Say>
  </Scene>
);
