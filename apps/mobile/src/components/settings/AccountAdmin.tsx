import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Share, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import type { Invite, User } from '@diskort/shared';
import { api, errorMessage, normalizeServerUrl, useSession } from '@diskort/client-core';
import { animateNextLayout } from '../../motion';
import { useSettings } from '../../stores/settings';
import { toast } from '../../stores/ui';
import { brandTint, colors, createStyles, font, radius, space, tint } from '../../theme';
import { Avatar } from '../Avatar';
import { confirmDialog } from '../Dialog';
import { ListSkeleton } from '../Skeleton';
import { ErrorState } from '../States';
import { Button, Card, Choices, SectionTitle } from '../ui';

/**
 * Ayarlar > Hesaplar ve davetler (hesap yöneticilerine; indirgenmiş hâli hesap yardımcılarına;
 * masaüstündeki Yönetim bölümünün karşılığı). Hesap yöneticiliği hiçbir sunucuya bağlı değildir: hesap
 * yöneticileri, hesap yardımcıları, yalnızca hesap açtıran davetler, şifre sıfırlama kodu ve hesap silme.
 * Hesap yardımcısı yalnızca davetleri ve sıradan hesapların sıfırlama kodunu görür (sunucu da aynı sınırı
 * uygular). Sunucuya ait işler Sunucu Ayarları'nda kalır.
 */
export function AccountAdmin() {
  const selfId = useSession((s) => s.user?.id);
  const isAdmin = useSession((s) => s.user?.isAdmin === true);
  const isHelper = useSession((s) => s.user?.isAccountHelper === true);
  const allowed = isAdmin || isHelper;
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback((): void => {
    setError(null);
    api
      .listUsers()
      .then((list) => {
        animateNextLayout(180);
        setUsers(list);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);
  useEffect(() => {
    if (allowed) reload();
  }, [allowed, reload]);

  if (!allowed) {
    return <Text style={styles.intro}>Bu bölümü yalnızca hesap yöneticileri ve hesap yardımcıları görebilir.</Text>;
  }

  return (
    <View>
      <Text style={styles.intro}>
        {isAdmin
          ? 'Hesap yöneticileri tüm hesaplardan sorumludur; hiçbir sunucunun rolü ya da sahipliği bu yetkiyi vermez. Geri bildirimleri de hesap yöneticileri yönetir.'
          : 'Hesap yardımcısısın: hesap daveti oluşturabilir, sıradan hesaplar için şifre sıfırlama kodu üretebilirsin. Hesap silme ve yönetici işleri hesap yöneticilerindedir.'}
      </Text>
      {error ? (
        <ErrorState text={error} onRetry={reload} />
      ) : users === null ? (
        <ListSkeleton rows={4} avatar={36} />
      ) : (
        <>
          {isAdmin && <AdminsBlock users={users} selfId={selfId} onChange={reload} />}
          {isAdmin && <HelpersBlock users={users} selfId={selfId} onChange={reload} />}
          <AccountInvitesBlock users={users} selfId={selfId} isAdmin={isAdmin} />
          <AccountsBlock users={users} selfId={selfId} isAdmin={isAdmin} onChange={reload} />
        </>
      )}
    </View>
  );
}

const byName = (a: User, b: User): number => a.displayName.localeCompare(b.displayName, 'tr');

function matches(user: User, query: string): boolean {
  const q = query.trim().toLocaleLowerCase('tr');
  return !q || user.username.includes(q) || user.displayName.toLocaleLowerCase('tr').includes(q);
}

// ---------- Hesap yöneticileri ----------

function AdminsBlock({ users, selfId, onChange }: { users: User[]; selfId?: string; onChange: () => void }) {
  const [query, setQuery] = useState('');
  const admins = useMemo(() => users.filter((u) => u.isAdmin).sort(byName), [users]);
  const candidates = useMemo(
    () => (query.trim() ? users.filter((u) => !u.isAdmin && matches(u, query)).sort(byName).slice(0, 8) : []),
    [users, query],
  );

  const grant = async (user: User): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Hesap yöneticisi yapılsın mı?',
      message: `${user.displayName} (@${user.username}) tüm hesapları yönetebilir: geri bildirimler, hesap davetleri, şifre sıfırlama kodları ve hesap silme. Başka yönetici de ekleyip çıkarabilir.`,
      icon: 'shield-checkmark-outline',
      confirmLabel: 'Yönetici yap',
    });
    if (!ok) return;
    try {
      await api.grantAdmin(user.id);
      toast(`${user.displayName} artık hesap yöneticisi.`);
      setQuery('');
      onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const revoke = async (user: User): Promise<void> => {
    const self = user.id === selfId;
    const ok = await confirmDialog({
      title: self ? 'Yöneticiliği bırakmak istiyor musun?' : 'Yöneticilik alınsın mı?',
      message: self
        ? 'Geri bildirimleri ve hesapları artık yönetemezsin. Geri almak için başka bir yöneticinin seni yeniden eklemesi gerekir.'
        : `${user.displayName} (@${user.username}) artık hesapları ve geri bildirimleri yönetemez.`,
      icon: 'shield-outline',
      confirmLabel: self ? 'Bırak' : 'Yöneticiliği al',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeAdmin(user.id);
      toast(self ? 'Artık hesap yöneticisi değilsin.' : `${user.displayName} artık hesap yöneticisi değil.`);
      // Kendi yöneticiliğini bırakan bu sayfayı artık göremez
      if (self) {
        if (router.canGoBack()) router.back();
      } else onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const last = admins.length <= 1;
  return (
    <>
      <SectionTitle>Hesap yöneticileri</SectionTitle>
      <Card>
        {admins.map((u, i) => (
          <UserLine key={u.id} user={u} selfId={selfId} first={i === 0}>
            <IconButton
              icon="shield-outline"
              label={u.id === selfId ? 'Yöneticiliği bırak' : 'Yöneticiliği al'}
              danger
              disabledReason={last ? 'Son hesap yöneticisi çıkarılamaz.' : undefined}
              onPress={() => void revoke(u)}
            />
          </UserLine>
        ))}
      </Card>
      <SearchBox value={query} onChange={setQuery} placeholder="Yönetici eklemek için hesap ara" style={styles.searchAfter} />
      {candidates.length > 0 ? (
        <Card>
          {candidates.map((u, i) => (
            <UserLine key={u.id} user={u} selfId={selfId} first={i === 0}>
              <Pressable
                onPress={() => void grant(u)}
                android_ripple={{ color: tint(0.14), foreground: true }}
                accessibilityRole="button"
                accessibilityLabel={`${u.displayName} kişisini hesap yöneticisi yap`}
                style={styles.pill}
              >
                <Ionicons name="shield-checkmark-outline" size={15} color={colors.onControl} />
                <Text style={styles.pillText}>Yönetici yap</Text>
              </Pressable>
            </UserLine>
          ))}
        </Card>
      ) : query.trim() ? (
        <Text style={styles.empty}>Eşleşen hesap yok.</Text>
      ) : null}
    </>
  );
}

// ---------- Hesap yardımcıları (yalnızca yönetici atar) ----------

function HelpersBlock({ users, selfId, onChange }: { users: User[]; selfId?: string; onChange: () => void }) {
  const [query, setQuery] = useState('');
  const helpers = useMemo(() => users.filter((u) => u.isAccountHelper).sort(byName), [users]);
  const candidates = useMemo(
    () =>
      query.trim()
        ? users.filter((u) => !u.isAdmin && !u.isAccountHelper && matches(u, query)).sort(byName).slice(0, 8)
        : [],
    [users, query],
  );

  const grant = async (user: User): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Hesap yardımcısı yapılsın mı?',
      message: `${user.displayName} (@${user.username}) hesap daveti oluşturabilir ve sıradan hesaplar için şifre sıfırlama kodu üretebilir. Hesap silemez, yönetici ya da yardımcı ekleyemez; yöneticilerin ve diğer yardımcıların şifresini sıfırlayamaz.`,
      icon: 'person-add-outline',
      confirmLabel: 'Yardımcı yap',
    });
    if (!ok) return;
    try {
      await api.grantHelper(user.id);
      toast(`${user.displayName} artık hesap yardımcısı.`);
      setQuery('');
      onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const revoke = async (user: User): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Yardımcılık alınsın mı?',
      message: `${user.displayName} (@${user.username}) artık hesap daveti oluşturamaz ve şifre sıfırlama kodu üretemez.`,
      icon: 'person-remove-outline',
      confirmLabel: 'Yardımcılığı al',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeHelper(user.id);
      toast(`${user.displayName} artık hesap yardımcısı değil.`);
      onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <>
      <SectionTitle>Hesap yardımcıları</SectionTitle>
      <Text style={styles.intro}>
        Hesap yardımcısı hesap daveti oluşturur ve sıradan hesaplar için şifre sıfırlama kodu üretir; başka bir
        yetkisi yoktur.
      </Text>
      <Card>
        {helpers.length === 0 && <Text style={styles.cardEmpty}>Hesap yardımcısı yok.</Text>}
        {helpers.map((u, i) => (
          <UserLine key={u.id} user={u} selfId={selfId} first={i === 0}>
            <IconButton icon="person-remove-outline" label="Yardımcılığı al" danger onPress={() => void revoke(u)} />
          </UserLine>
        ))}
      </Card>
      <SearchBox value={query} onChange={setQuery} placeholder="Yardımcı eklemek için hesap ara" style={styles.searchAfter} />
      {candidates.length > 0 ? (
        <Card>
          {candidates.map((u, i) => (
            <UserLine key={u.id} user={u} selfId={selfId} first={i === 0}>
              <Pressable
                onPress={() => void grant(u)}
                android_ripple={{ color: tint(0.14), foreground: true }}
                accessibilityRole="button"
                accessibilityLabel={`${u.displayName} kişisini hesap yardımcısı yap`}
                style={styles.pill}
              >
                <Ionicons name="person-add-outline" size={15} color={colors.onControl} />
                <Text style={styles.pillText}>Yardımcı yap</Text>
              </Pressable>
            </UserLine>
          ))}
        </Card>
      ) : query.trim() ? (
        <Text style={styles.empty}>Eşleşen hesap yok.</Text>
      ) : null}
    </>
  );
}

// ---------- Hesap davetleri ----------

const USES = [
  { value: 1, label: '1 kişi' },
  { value: 5, label: '5 kişi' },
  { value: 10, label: '10 kişi' },
  { value: 0, label: 'Sınırsız' },
] as const;

const EXPIRES = [
  { value: 1, label: '1 saat' },
  { value: 24, label: '1 gün' },
  { value: 168, label: '7 gün' },
  { value: 0, label: 'Süresiz' },
] as const;

async function copyCode(code: string, text = 'Davet kodu kopyalandı.'): Promise<void> {
  await Clipboard.setStringAsync(code).catch(() => undefined);
  toast(text);
}

function AccountInvitesBlock({ users, selfId, isAdmin }: { users: User[]; selfId?: string; isAdmin: boolean }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [maxUses, setMaxUses] = useState<number>(1);
  const [expires, setExpires] = useState<number>(168);
  const [busy, setBusy] = useState(false);
  const serverUrl = useSettings((s) => s.serverUrl);
  const names = useMemo(() => new Map(users.map((u) => [u.id, u.displayName])), [users]);

  const load = useCallback((): void => {
    api
      .listAccountInvites()
      .then((list) => {
        animateNextLayout(180);
        setInvites(list.sort((a, b) => b.createdAt - a.createdAt));
      })
      .catch((err) => toast(errorMessage(err), 'error'));
  }, []);
  useEffect(load, [load]);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const invite = await api.createAccountInvite({
        maxUses: maxUses === 0 ? null : maxUses,
        expiresInHours: expires === 0 ? null : expires,
      });
      await copyCode(invite.code);
      load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (inv: Invite): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Davet silinsin mi?',
      message: `${inv.code} koduyla artık hesap açılamaz.`,
      icon: 'trash-outline',
      confirmLabel: 'Sil',
      danger: true,
    });
    if (!ok) return;
    api
      .deleteAccountInvite(inv.code)
      .then(load)
      .catch((err) => toast(errorMessage(err), 'error'));
  };

  const share = (code: string): void => {
    const site = normalizeServerUrl(serverUrl);
    void Share.share({
      message: `Diskort davet kodun: ${code}\nUygulamayı ${site} adresinden indir, giriş ekranında “Davet koduyla kaydol”u seç.`,
    }).catch(() => undefined);
  };

  return (
    <>
      <SectionTitle>Hesap davetleri</SectionTitle>
      <Text style={styles.intro}>
        Kişi bu kodla giriş ekranında Davet koduyla kaydol seçeneğinden hesap açar ama hiçbir sunucuya katılmaz;
        kendi sunucusunu kurabilir ya da bir sunucu davetiyle katılır.
      </Text>
      <Card style={styles.pad}>
        <Text style={styles.label}>Kullanım hakkı</Text>
        <Choices options={USES} value={maxUses} onChange={setMaxUses} label="Kullanım hakkı" />
        <Text style={[styles.label, { marginTop: space.md }]}>Geçerlilik</Text>
        <Choices options={EXPIRES} value={expires} onChange={setExpires} label="Geçerlilik" />
        <View style={{ marginTop: space.lg }}>
          <Button title="Davet oluştur" busy={busy} onPress={() => void create()} />
        </View>
      </Card>
      <Card style={{ marginTop: space.md }}>
        {invites === null ? (
          <ActivityIndicator color={colors.muted} style={{ padding: space.lg }} />
        ) : invites.length === 0 ? (
          <Text style={styles.cardEmpty}>Hesap daveti yok.</Text>
        ) : (
          invites.map((inv, i) => {
            const expired = inv.expiresAt !== null && inv.expiresAt < Date.now();
            const used = inv.maxUses !== null && inv.uses >= inv.maxUses;
            const creator = names.get(inv.createdBy);
            return (
              <View key={inv.code}>
                {i > 0 && <View style={styles.divider} />}
                <View style={styles.inviteRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.code, (expired || used) && styles.dead]} selectable>
                      {inv.code}
                    </Text>
                    <Text style={styles.meta}>
                      {inv.uses}/{inv.maxUses ?? '∞'} kullanım ·{' '}
                      {inv.expiresAt ? `${new Date(inv.expiresAt).toLocaleString('tr-TR')} tarihine kadar` : 'süresiz'}
                      {creator ? ` · ${creator}` : ''}
                    </Text>
                  </View>
                  <IconButton icon="share-social-outline" label="Paylaş" onPress={() => share(inv.code)} />
                  <IconButton icon="copy-outline" label="Kodu kopyala" onPress={() => void copyCode(inv.code)} />
                  <IconButton
                    icon="trash-outline"
                    label="Daveti sil"
                    danger
                    disabledReason={
                      isAdmin || inv.createdBy === selfId ? undefined : 'Yalnızca kendi oluşturduğun daveti silebilirsin.'
                    }
                    onPress={() => void remove(inv)}
                  />
                </View>
              </View>
            );
          })
        )}
      </Card>
    </>
  );
}

// ---------- Hesaplar: şifre sıfırlama kodu, hesap silme ----------

interface ResetCode {
  user: User;
  code: string;
  expiresAt: number;
}

function AccountsBlock({
  users,
  selfId,
  isAdmin,
  onChange,
}: {
  users: User[];
  selfId?: string;
  isAdmin: boolean;
  onChange: () => void;
}) {
  const [query, setQuery] = useState('');
  const [resetCode, setResetCode] = useState<ResetCode | null>(null);
  const list = useMemo(() => users.filter((u) => matches(u, query)).sort(byName), [users, query]);

  const createCode = (user: User): void => {
    api
      .createResetCode(user.id)
      .then((r) => {
        animateNextLayout(200);
        setResetCode({ user, code: r.code, expiresAt: r.expiresAt });
      })
      .catch((err) => toast(errorMessage(err), 'error'));
  };

  const remove = async (user: User): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Hesap silinsin mi?',
      message: `${user.displayName} (@${user.username}) hesabı kalıcı olarak silinir; mesajları "Silinmiş Kullanıcı" adıyla kalır. Yalnızca bir sunucudan uzaklaştırmak istiyorsan o sunucudan atman yeterli.`,
      icon: 'person-remove-outline',
      confirmLabel: 'Hesabı sil',
      danger: true,
      requireText: user.username,
    });
    if (!ok) return;
    try {
      await api.deleteUser(user.id);
      toast(`${user.displayName} silindi.`);
      if (resetCode?.user.id === user.id) setResetCode(null);
      onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <>
      <SectionTitle>Hesaplar ({users.length})</SectionTitle>
      <Text style={styles.intro}>
        {isAdmin
          ? 'Şifresini unutan için tek kullanımlık sıfırlama kodu üret. Başka bir hesap yöneticisinin şifresini sıfırlayamaz, hesabını silemezsin; önce yöneticiliğini al.'
          : 'Şifresini unutan için tek kullanımlık sıfırlama kodu üret. Hesap yöneticilerinin, diğer hesap yardımcılarının ve bir sunucunun sahibi ya da yöneticisi olan hesapların şifresini sıfırlayamazsın.'}
      </Text>
      {resetCode ? <ResetCodeCard {...resetCode} onClose={() => setResetCode(null)} /> : null}
      <SearchBox value={query} onChange={setQuery} placeholder="Hesap ara" />
      <Card>
        {list.length === 0 && <Text style={styles.cardEmpty}>Eşleşen hesap yok.</Text>}
        {list.map((u, i) => {
          const self = u.id === selfId;
          const protectedAdmin = u.isAdmin && !self;
          // Yardımcı başka bir yardımcının da şifresini sıfırlayamaz
          const protectedHelper = !isAdmin && u.isAccountHelper === true && !self;
          return (
            <UserLine
              key={u.id}
              user={u}
              selfId={selfId}
              first={i === 0}
              admin={u.isAdmin}
              helper={u.isAccountHelper === true}
            >
              <IconButton
                icon="key-outline"
                label="Şifre sıfırlama kodu üret"
                disabledReason={
                  protectedAdmin
                    ? 'Başka bir yöneticinin şifresi sıfırlanamaz.'
                    : protectedHelper
                      ? 'Başka bir yardımcının şifresi sıfırlanamaz.'
                      : undefined
                }
                onPress={() => createCode(u)}
              />
              {isAdmin && (
                <IconButton
                  icon="person-remove-outline"
                  label="Hesabı kalıcı olarak sil"
                  danger
                  disabledReason={
                    self
                      ? 'Kendi hesabını Ayarlar > Hesabım bölümünden silebilirsin.'
                      : protectedAdmin
                        ? 'Önce yöneticiliğini al.'
                        : undefined
                  }
                  onPress={() => void remove(u)}
                />
              )}
            </UserLine>
          );
        })}
      </Card>
    </>
  );
}

function ResetCodeCard({ user, code, expiresAt, onClose }: ResetCode & { onClose: () => void }) {
  const share = (): void => {
    void Share.share({
      message: `Diskort şifre sıfırlama kodun: ${code}\nKullanıcı adın: @${user.username}\nGiriş ekranında “Sıfırlama koduyla yenile”yi seç.`,
    }).catch(() => undefined);
  };
  return (
    <View style={styles.reset}>
      <View style={styles.resetHead}>
        <Text style={[styles.resetText, { flex: 1 }]}>
          <Text style={styles.resetName}>{user.displayName}</Text> için şifre sıfırlama kodu (tek kullanımlık,{' '}
          {new Date(expiresAt).toLocaleString('tr-TR')} tarihine kadar geçerli):
        </Text>
        <IconButton icon="close" label="Kapat" onPress={onClose} />
      </View>
      <Text style={styles.resetCode} selectable>
        {code}
      </Text>
      <Text style={styles.resetText}>
        Kullanıcı adı: <Text style={styles.resetName}>@{user.username}</Text> — ikisini birlikte gönder. Giriş
        ekranında “Sıfırlama koduyla yenile” ile yeni şifre belirlenir.
      </Text>
      <View style={styles.resetButtons}>
        <View style={{ flex: 1 }}>
          <Button title="Kopyala" variant="secondary" onPress={() => void copyCode(code, 'Kopyalandı.')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Paylaş" onPress={share} />
        </View>
      </View>
    </View>
  );
}

// ---------- Ortak parçalar ----------

function UserLine({
  user,
  selfId,
  first,
  admin = false,
  helper = false,
  children,
}: {
  user: User;
  selfId?: string;
  first: boolean;
  /** "Yönetici" etiketi */
  admin?: boolean;
  /** "Yardımcı" etiketi */
  helper?: boolean;
  children?: ReactNode;
}) {
  return (
    <View>
      {!first && <View style={styles.userDivider} />}
      <View style={styles.userRow}>
        <Avatar user={user} size={36} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {user.displayName}
            </Text>
            {user.id === selfId && <Text style={styles.you}>(sen)</Text>}
          </View>
          <View style={styles.nameRow}>
            <Text style={styles.sub} numberOfLines={1}>
              @{user.username}
            </Text>
            {admin && <Text style={styles.badge}>Yönetici</Text>}
            {helper && <Text style={[styles.badge, styles.helperBadge]}>Yardımcı</Text>}
          </View>
        </View>
        {children}
      </View>
    </View>
  );
}

/**
 * Satırdaki simge düğmesi. `disabledReason` verilirse soluk görünür ve dokununca nedenini söyler
 * (telefonda ipucu balonu yok).
 */
function IconButton({
  icon,
  label,
  onPress,
  danger,
  disabledReason,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabledReason?: string;
}) {
  const disabled = disabledReason !== undefined;
  return (
    <Pressable
      onPress={disabled ? () => toast(disabledReason) : onPress}
      hitSlop={4}
      android_ripple={{ color: tint(0.14), borderless: true, radius: 18 }}
      style={[styles.iconButton, disabled && { opacity: 0.4 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={disabledReason}
      accessibilityState={{ disabled }}
    >
      <Ionicons name={icon} size={19} color={danger && !disabled ? colors.danger : colors.muted} />
    </Pressable>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.search, style]}>
      <Ionicons name="search" size={18} color={colors.muted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        selectionColor={colors.brand}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.searchInput}
      />
      {value ? (
        <Pressable onPress={() => onChange('')} hitSlop={8} accessibilityLabel="Aramayı temizle">
          <Ionicons name="close-circle" size={18} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = createStyles(() => ({
  intro: { color: colors.muted, fontSize: font.small, lineHeight: 20, marginBottom: space.md },
  pad: { padding: space.lg },
  label: { color: colors.muted, fontSize: font.caption, fontWeight: '700', textTransform: 'uppercase' },
  empty: { color: colors.muted, fontSize: font.small, marginHorizontal: space.xs },
  cardEmpty: { color: colors.muted, fontSize: font.small, padding: space.lg },
  divider: { height: 0.5, backgroundColor: colors.line, marginLeft: space.lg },
  userDivider: { height: 0.5, backgroundColor: colors.line, marginLeft: 64 },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    paddingVertical: space.sm + 2,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: colors.head, fontSize: font.row, fontWeight: '600', flexShrink: 1 },
  you: { color: colors.muted, fontSize: font.caption },
  sub: { color: colors.muted, fontSize: font.caption + 0.5, marginTop: 1, flexShrink: 1 },
  badge: {
    color: colors.brandText,
    backgroundColor: brandTint(0.18),
    fontSize: 11,
    fontWeight: '700',
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  helperBadge: { color: colors.muted, backgroundColor: tint(0.1) },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 32,
    paddingHorizontal: space.md,
    borderRadius: 16,
    backgroundColor: colors.control,
    overflow: 'hidden',
    marginRight: space.xs,
  },
  pillText: { color: colors.onControl, fontSize: font.small, fontWeight: '600' },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    paddingVertical: space.sm + 2,
  },
  code: { color: colors.head, fontSize: font.row, fontFamily: 'monospace', fontWeight: '600' },
  dead: { textDecorationLine: 'line-through', opacity: 0.5 },
  meta: { color: colors.muted, fontSize: font.caption, marginTop: 2, lineHeight: 16 },
  iconButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.input,
    marginBottom: space.md,
  },
  searchAfter: { marginTop: space.md },
  searchInput: { flex: 1, color: colors.text, fontSize: font.body, paddingVertical: 0 },
  reset: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: brandTint(0.6),
    backgroundColor: brandTint(0.1),
    padding: space.lg,
    marginBottom: space.md,
    gap: space.sm,
  },
  resetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginRight: -space.sm, marginTop: -space.xs },
  resetText: { color: colors.muted, fontSize: font.small, lineHeight: 19 },
  resetName: { color: colors.head, fontWeight: '700' },
  resetCode: { color: colors.head, fontSize: 26, fontFamily: 'monospace', fontWeight: '700', letterSpacing: 4 },
  resetButtons: { flexDirection: 'row', gap: space.sm + 2, marginTop: space.xs },
}));
