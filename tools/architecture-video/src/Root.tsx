import { Composition } from 'remotion';
import { Video, TOTAL } from './Video';

export const Root = () => (
  <Composition id="Mimari" component={Video} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
);
