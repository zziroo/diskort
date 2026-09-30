import { Sequence } from 'remotion';
import { C } from './kit';
import { ClientsScene, DUR, OutroScene, PipelineScene, ServerScene, TextScene, TitleScene, VoiceScene } from './scenes';

const list = [
  [TitleScene, DUR.title],
  [ClientsScene, DUR.clients],
  [ServerScene, DUR.server],
  [VoiceScene, DUR.voice],
  [TextScene, DUR.text],
  [PipelineScene, DUR.pipeline],
  [OutroScene, DUR.outro],
] as const;

export const TOTAL = list.reduce((a, [, d]) => a + d, 0);

export const Video = () => {
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
