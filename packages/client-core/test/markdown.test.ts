import { describe, expect, it } from 'vitest';
import { broadcastMention, markdownSegments, parseInline, parseMarkdown, plainText } from '../src/markdown';
import { decodeRoleMentions, encodeRoleMentions, roleMentionText, roleSuggestions, typableRoles } from '../src/composer';
import { isMentioned } from '../src/messages';
import type { Role } from '@diskort/shared';

describe('satır içi biçimlendirme', () => {
  it('iç içe stilleri ayrıştırır', () => {
    expect(parseInline('**kalın *italik* son**')).toEqual([
      {
        type: 'bold',
        children: [
          { type: 'text', text: 'kalın ' },
          { type: 'italic', children: [{ type: 'text', text: 'italik' }] },
          { type: 'text', text: ' son' },
        ],
      },
    ]);
  });

  it('kod içindeki işaretleri biçimlendirmez', () => {
    expect(parseInline('`**değil**` ve __altı__')).toEqual([
      { type: 'code', text: '**değil**' },
      { type: 'text', text: ' ve ' },
      { type: 'underline', children: [{ type: 'text', text: 'altı' }] },
    ]);
  });

  it('snake_case adlarını italik saymaz', () => {
    expect(parseInline('dosya_adi_uzun')).toEqual([{ type: 'text', text: 'dosya_adi_uzun' }]);
  });

  it('bağlantının sonundaki noktalama bağlantıya dahil değildir', () => {
    expect(parseInline('bak: https://ziroo.net/a?b=1).')).toEqual([
      { type: 'text', text: 'bak: ' },
      { type: 'link', url: 'https://ziroo.net/a?b=1' },
      { type: 'text', text: ').' },
    ]);
  });

  it('bahsetmeler: e-posta sayılmaz, sondaki nokta noktalama sayılır', () => {
    expect(parseInline('mail@uye.com @Ali. ~~x~~ ||s||')).toEqual([
      { type: 'text', text: 'mail@uye.com ' },
      { type: 'mention', username: 'ali', raw: '@Ali' },
      { type: 'text', text: '. ' },
      { type: 'strike', children: [{ type: 'text', text: 'x' }] },
      { type: 'text', text: ' ' },
      { type: 'spoiler', children: [{ type: 'text', text: 's' }] },
    ]);
  });

  it('HTML düz metin kalır', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { type: 'text', text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});

describe('bloklar', () => {
  it('alıntı, kod bloğu ve paragrafları ayırır', () => {
    const blocks = parseMarkdown('önce:\n> alıntı 1\n>alıntı 2\n```js\nconst x = 1;\n```\nsonra');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'quote', 'codeblock', 'paragraph']);
    expect(blocks[1]).toEqual({ type: 'quote', children: [{ type: 'text', text: 'alıntı 1\nalıntı 2' }] });
    expect(blocks[2]).toEqual({ type: 'codeblock', lang: 'js', text: 'const x = 1;' });
    expect(blocks[3]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'sonra' }] });
  });

  it('dilsiz ve tek satırlık kod bloğu', () => {
    expect(parseMarkdown('```merhaba```')).toEqual([{ type: 'codeblock', lang: null, text: 'merhaba' }]);
  });
});

describe('@everyone ve @here', () => {
  it('yalnızca mesajda bildirim olduysa bahsetme sayılır', () => {
    const [everyone, , here] = parseInline('@everyone ve @here');
    expect(everyone).toEqual({ type: 'mention', username: 'everyone', raw: '@everyone' });
    expect(here).toEqual({ type: 'mention', username: 'here', raw: '@here' });
    expect(broadcastMention('everyone', { mentionEveryone: true, mentionHere: false })).toBe('everyone');
    expect(broadcastMention('here', { mentionEveryone: true, mentionHere: false })).toBeNull();
    expect(broadcastMention('here', { mentionEveryone: false, mentionHere: true })).toBe('here');
    expect(broadcastMention('everyone', { mentionEveryone: false })).toBeNull();
    expect(broadcastMention('ali', { mentionEveryone: true, mentionHere: true })).toBeNull();
    expect(broadcastMention('everyone', undefined)).toBeNull();
  });
});

describe('rol etiketleri', () => {
  const role = (id: string, name: string, position: number, color: string | null = null): Role => ({
    id,
    name,
    color,
    position,
    hoist: false,
    permissions: 0,
  });
  const roles: Record<string, Role> = {
    g1: role('g1', '@everyone', 0),
    r_ad: role('r_ad', 'Admin', 3, '#ff0000'),
    'r-oy': role('r-oy', 'Oyun Ekibi', 2),
    r_ali: role('r_ali', 'ali', 1),
  };
  const isUsername = (name: string): boolean => name === 'ali';

  it('gömülü biçimi rol etiketi düğümüne ayrıştırır', () => {
    expect(parseInline('selam <@&r_ad> ve <@&r-oy>!')).toEqual([
      { type: 'text', text: 'selam ' },
      { type: 'roleMention', roleId: 'r_ad', raw: '<@&r_ad>' },
      { type: 'text', text: ' ve ' },
      { type: 'roleMention', roleId: 'r-oy', raw: '<@&r-oy>' },
      { type: 'text', text: '!' },
    ]);
    // Kod içinde etiket sayılmaz; kullanıcı etiketiyle karışmaz
    expect(parseInline('`<@&r_ad>`')).toEqual([{ type: 'code', text: '<@&r_ad>' }]);
    expect(parseInline('<@&>')).toEqual([{ type: 'text', text: '<@&>' }]);
  });

  it('düz metinde rol adıyla, rol yoksa silinmiş olarak yazılır', () => {
    expect(plainText('<@&r_ad> <@&yok>', () => undefined, (id) => roles[id]?.name)).toBe('@Admin @silinmiş-rol');
    expect(plainText('<@&r_ad>', () => undefined)).toBe('@silinmiş-rol');
  });

  it('yazma kutusundaki @RolAdı yazılarını gönderirken gömülü biçime çevirir', () => {
    const list = Object.values(roles).filter((r) => r.position > 0);
    expect(encodeRoleMentions('@admin @Oyun Ekibi gelin', list, isUsername)).toBe('<@&r_ad> <@&r-oy> gelin');
    // Kelime ortasındaki @, devam eden ad, kod içi ve kullanıcı adıyla aynı adlı rol çevrilmez
    expect(encodeRoleMentions('a@Admin @Adminler `@Admin` @ali', list, isUsername)).toBe('a@Admin @Adminler `@Admin` @ali');
    // Noktalama sınır sayılır; hazır gömülü biçim olduğu gibi kalır
    expect(encodeRoleMentions('@Admin, <@&r-oy>', list, isUsername)).toBe('<@&r_ad>, <@&r-oy>');
  });

  it('düzenlerken gömülü biçimi ada çevirir, geri çevirince aynı metin çıkar', () => {
    const content = 'selam <@&r_ad> ve <@&r-oy> <@&r_ali> <@&yok>';
    const decoded = decodeRoleMentions(content, roles, isUsername);
    expect(decoded).toBe('selam @Admin ve @Oyun Ekibi <@&r_ali> <@&yok>');
    expect(encodeRoleMentions(decoded, Object.values(roles), isUsername)).toBe(content);
    // Geri çevirince başka bir role kayacaksa çevrilmeden gösterilir
    const tricky = { ...roles, r_oy2: role('r_oy2', 'Oyun', 1) };
    expect(decodeRoleMentions('<@&r_oy2> Ekibi', tricky, isUsername)).toBe('<@&r_oy2> Ekibi');
  });

  it('önerilerde @everyone yok, adı yazılanla başlayanlar önce gelir', () => {
    expect(roleSuggestions('', roles, 'g1', 5).map((r) => r.id)).toEqual(['r_ad', 'r-oy', 'r_ali']);
    expect(roleSuggestions('e', roles, 'g1', 5).map((r) => r.id)).toEqual(['r-oy']);
    expect(roleSuggestions('everyone', roles, 'g1', 5)).toEqual([]);
    expect(roleMentionText(roles.r_ad!, isUsername)).toBe('@Admin ');
    expect(roleMentionText(roles.r_ali!, isUsername)).toBe('<@&r_ali> ');
  });

  it('bağlantı içindeki @ad rolü çevrilmez', () => {
    const list = Object.values(roles).filter((r) => r.position > 0);
    const url = 'bak https://medium.com/@admin/yazi';
    expect(encodeRoleMentions(url, list, isUsername)).toBe(url);
    expect(encodeRoleMentions(`${url} @admin`, list, isUsername)).toBe(`${url} <@&r_ad>`);
  });

  it('Türkçe büyük I/İ ile yazılan rol adı eşleşir, uzunluk korunur', () => {
    const list = [role('r_is', 'Işık Ekibi', 1), role('r_ad', 'admin', 2)];
    expect(encodeRoleMentions('@ADMIN @IŞIK EKİBİ @İŞİK ekİbi', list, isUsername)).toBe('<@&r_ad> <@&r_is> <@&r_is>');
    expect(encodeRoleMentions('@Admin', list, isUsername)).toBe('<@&r_ad>');
  });

  it('prototip anahtarı sahte rol sayılmaz', () => {
    expect(decodeRoleMentions('<@&constructor>', roles, isUsername)).toBe('<@&constructor>');
  });

  it('stil kuralı rol etiketini bölmez', () => {
    expect(parseInline('__x <@&ab__cd> y__')).toEqual([
      {
        type: 'underline',
        children: [
          { type: 'text', text: 'x ' },
          { type: 'roleMention', roleId: 'ab__cd', raw: '<@&ab__cd>' },
          { type: 'text', text: ' y' },
        ],
      },
    ]);
    expect(parseInline('**a** ~~<@&r_ad>~~')).toEqual([
      { type: 'bold', children: [{ type: 'text', text: 'a' }] },
      { type: 'text', text: ' ' },
      { type: 'strike', children: [{ type: 'roleMention', roleId: 'r_ad', raw: '<@&r_ad>' }] },
    ]);
  });

  it('@everyone rolü ve everyone/here adlı roller yazma adayı olmaz', () => {
    const all = { ...roles, g1: role('g1', '@everyone', 0), r_h: role('r_h', 'HERE', 3), r_e: role('r_e', 'Everyone', 4) };
    expect(typableRoles(all, 'g1').map((r) => r.id).sort()).toEqual(['r-oy', 'r_ad', 'r_ali']);
  });

  it('sahip olunan rolün etiketi bahsetme sayılır (yazarın kendisi hariç)', () => {
    const message = { content: 'bakın <@&r_ad>', mentionEveryone: false, mentionHere: false, authorId: 'u2', replyMentionUserId: null };
    const me = { id: 'u1', username: 'veli' };
    expect(isMentioned(message, me, ['r_ad'])).toBe(true);
    expect(isMentioned(message, me, ['r-oy'])).toBe(false);
    expect(isMentioned(message, me)).toBe(false);
    expect(isMentioned({ ...message, authorId: 'u1' }, me, ['r_ad'])).toBe(false);
    expect(isMentioned({ ...message, content: '`<@&r_ad>`' }, me, ['r_ad'])).toBe(false);
  });
});

describe('yazma kutusu önizleme parçaları', () => {
  const show = (text: string): [string, string][] =>
    markdownSegments(text).map((s) => [text.slice(s.start, s.end), [...s.marks].sort().join('+')]);

  it('işaretleri ve iç içe stilleri konumlarıyla verir', () => {
    expect(show('a **b *c* e** d')).toEqual([
      ['a ', ''],
      ['**', 'marker'],
      ['b ', 'bold'],
      ['*', 'bold+marker'],
      ['c', 'bold+italic'],
      ['*', 'bold+marker'],
      [' e', 'bold'],
      ['**', 'marker'],
      [' d', ''],
    ]);
  });

  it('kapanmamış işareti biçimlendirmez', () => {
    expect(show('**yarım')).toEqual([['**yarım', '']]);
  });

  it('kod bloğu, satır içi kod ve alıntı', () => {
    expect(show('> x `y`\n```\n**z**\n```')).toEqual([
      ['> ', 'marker+quote'],
      ['x ', 'quote'],
      ['`', 'code+marker+quote'],
      ['y', 'code+quote'],
      ['`', 'code+marker+quote'],
      ['\n', ''],
      ['```', 'codeblock+marker'],
      ['\n**z**\n', 'codeblock'],
      ['```', 'codeblock+marker'],
    ]);
  });

  it('parçalar metnin tamamını boşluksuz kaplar', () => {
    const text = 'selam @ali https://x.com ||gizli|| ~~eski~~ __alt__\n> alıntı\nson';
    const segs = markdownSegments(text);
    expect(segs[0]!.start).toBe(0);
    expect(segs.at(-1)!.end).toBe(text.length);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toBe(segs[i - 1]!.end);
  });
});
