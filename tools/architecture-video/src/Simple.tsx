import { Sequence } from 'remotion';
import { C } from './kit';
import { SDUR, SDevice, SInvite, SOutro, SServer, SText, STitle, SUpdate, SVoice } from './sadeScenes';

const list = [
  [STitle, SDUR.title],
  [SDevice, SDUR.device],
  [SServer, SDUR.server],
  [SVoice, SDUR.voice],
  [SText, SDUR.text],
  [SInvite, SDUR.invite],
  [SUpdate, SDUR.update],
  [SOutro, SDUR.outro],
] as const;

export const STOTAL = list.reduce((a, [, d]) => a + d, 0);

export const SimpleVideo = () => {
  let at = 0;
  return (
    <div style={{ position: 'absolute', inset: 0, background: C.bg }}>
      {list.map(([Comp, d], i) => {
        const from = at;
        at += d;
        return (
          <Sequence key={i} from={from} durationInFrames={d}>
            <Comp />
          </Sequence>
        );
      })}
    </div>
  );
};
