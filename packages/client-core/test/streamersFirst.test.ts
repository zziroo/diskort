import { describe, expect, it } from 'vitest';
import { streamersFirst } from '../src/guild';

const m = (userId: string, streaming = false) => ({ userId, streaming });

describe('streamersFirst', () => {
  it('yayın açanları öne alır, grupların kendi sırasını korur', () => {
    const list = [m('a'), m('b', true), m('c'), m('d', true)];
    expect(streamersFirst(list).map((x) => x.userId)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('kimse yayında değilse sırayı değiştirmez, girdiyi kopyalar', () => {
    const list = [m('a'), m('b'), m('c')];
    const out = streamersFirst(list);
    expect(out.map((x) => x.userId)).toEqual(['a', 'b', 'c']);
    expect(out).not.toBe(list);
  });

  it('özel yayın ölçütü kullanabilir', () => {
    const list = [m('a'), m('b'), m('c')];
    expect(streamersFirst(list, (x) => x.userId === 'c').map((x) => x.userId)).toEqual(['c', 'a', 'b']);
  });
});
