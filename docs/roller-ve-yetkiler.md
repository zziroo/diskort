# Roller ve yetkiler

Discord'un rol modeli, 10–20 kişilik bir arkadaş grubu için sadeleştirildi. Yetki hesabı sunucuda ve
istemcilerde **aynı koddur** ([`packages/shared/src/permissions.ts`](../packages/shared/src/permissions.ts)):
sunucu her isteği ve her gateway olayını denetler, istemciler yalnızca yapılamayacak düğmeleri gizler.

## Temel kavramlar

| Kavram | Açıklama |
|---|---|
| **Rol** | Ad, renk, sıra, "üyeleri ayrı göster" ve yetkiler. Üyenin adının rengi, renkli rollerinden en üsttekinin rengidir. |
| **@everyone** | Herkeste örtük olarak bulunan rol (kimliği sunucunun kimliğidir). Varsayılan yetkiler buradadır. |
| **Sahip** | Sunucuyu kuran. Her yetkiye sahiptir, kimse onu atamaz, yasaklayamaz, rollerini değiştiremez. Ayrılmadan önce sahipliği devretmeli ya da sunucuyu silmelidir. |
| **Hiyerarşi** | Kişi yalnızca kendi en üst rolünün altındaki rolleri düzenleyebilir ve yalnızca kendisinden alttaki üyeleri yönetebilir. Kimse kendinde olmayan bir yetkiyi başkasına veremez (Yönetici hariç). |

## Yetkiler

| Grup | Yetki | @everyone'da varsayılan |
|---|---|---|
| Genel | Yönetici (her şey, kanal izinlerini de aşar), Sunucuyu Yönet, Ses Panelini Yönet (ses yükle, adlandır, sil; çalmak için Konuş yeter), Rolleri Yönet, Kanalları Yönet, Davetleri Yönet, Üyeleri At, Üyeleri Yasakla | yok |
| Genel | Davet Oluştur (kendi davetlerini görür ve siler) | var |
| Metin | Kanalları Gör, Mesaj Gönder, Dosya Ekle, Tepki Ekle | var |
| Metin | @everyone ve @here Bahset | var |
| Metin | Mesajları Yönet (başkasının mesajını sil), Mesajları Sabitle | yok |
| Ses | Bağlan, Konuş, Ekran Paylaş | var |
| Ses | Üyeleri Sustur, Üyeleri Sağırlaştır, Üyeleri Taşı (sesten çıkarma dahil) | yok |

## Kanal izinleri

Her kanalda rol başına **izin ver / varsayılan / engelle** seçilir. Sıra Discord'daki gibidir:

1. @everyone'ın rol yetkileri
2. Kanalın @everyone izni
3. Üyenin rollerinin kanal izinleri (izin verme, engellemeye üstün gelir)

Kanalı göremeyen orada hiçbir şey yapamaz. Mesaj gönderemeyen dosya ekleyemez ve @everyone kullanamaz.
Bağlanamayan ses yetkilerini kullanamaz. Kanal düzenleme penceresindeki **"Özel kanal"** kısayolu,
@everyone'ın kanalı görme iznini kaldırır.

## Görünürlük

Kullanıcı yalnızca görebildiği kanalları, onların mesajlarını, tepkilerini, "yazıyor" bilgisini ve ses durumlarını
alır. READY ve tüm gateway olayları süzülür, görülemeyen kaynak için REST 404 döner. Rol ya da izin değişince bağlı
herkesin görünümü anında güncellenir.

> **Not:** Dosya ekleri kimlik doğrulaması istemez ama adresleri tahmin edilemez. Adresi önceden bilen biri,
> kanalı artık göremese de dosyayı açabilir.

## Seste yönetim

- LiveKit jetonu ve katılımcının izinleri kanaldaki yetkilerden gelir (Konuş → mikrofon, Ekran Paylaş → ekran ve sesi).
- **Sunucuda susturma** mikrofon iznini LiveKit tarafında kaldırır; değiştirilmiş bir istemci bile mikrofonu açamaz.
  **Sağırlaştırma** mikrofonu da alır, duymayı ise uygulama keser. İkisi de kalıcıdır (kanaldan çıkıp girince sürer).
- **Taşıma** istemci üzerinden yapılır (LiveKit katılımcı taşımayı desteklemez): sunucu hedef kanala bağlanma
  yetkisini denetler, istemciye `VOICE_MOVE` gönderir, istemci o kanala geçer.
- Bağlanma yetkisini kaybeden ya da atılan kişi sesten çıkarılır.

## Atma ve yasaklama

İkisi de sunucu başınadır.

- **Atma:** kişi o sunucunun sesinden çıkar, oradaki rolleri silinir, sunucu listesinden kalkar. Hesabı, diğer
  sunucuları ve yazdığı mesajlar kalır. Yeni bir sunucu davetiyle geri dönebilir (roller geri gelmez).
- **Yasaklama:** kişi o sunucuya davetle de dönemez. Yasak, Sunucu Ayarları → Yasaklar'dan kaldırılınca atılmış sayılır.
- **Hesabı silme** yalnızca hesap yöneticisinin yapabildiği ayrı bir işlemdir, hesabı kalıcı olarak siler.

## Hesap yöneticileri

Hesap yöneticiliği **hesabın kendi bayrağıdır** (`users.is_admin`), hiçbir sunucuya bağlı değildir. Sunucu sahipliği
ya da Yönetici rolü bunu vermez. Hesap yöneticileri:

- hesap açtıran davetleri oluşturur,
- şifre sıfırlama kodu üretir, hesap siler,
- geri bildirimleri yönetir ve [yönetim panelini](yonetim.md) kullanır.

İlk hesap yöneticidir. Son yönetici çıkarılamaz. Ayrıntılar ve komut satırı araçları: [Yönetim](yonetim.md).

## Eski sürümlerden geçiş

- **Şema 8 (rollerin gelişi):** eski yöneticiler "Yönetici" rolüne geçti, en eski yönetici sahip oldu; herkesin
  yetkileri @everyone'da kaldı. Rollerden önceki istemciler çalışmaya devam eder.
- **Şema 17:** hesap yöneticiliği rollerden ayrılıp hesabın kendi bayrağı oldu.
