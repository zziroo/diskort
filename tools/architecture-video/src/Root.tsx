import { Composition } from 'remotion';
import { Video, TOTAL } from './Video';
import { SimpleVideo, STOTAL } from './Simple';

export const Root = () => (
  <>
    <Composition id="Mimari" component={Video} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
    <Composition id="NasilCalisir" component={SimpleVideo} durationInFrames={STOTAL} fps={30} width={1920} height={1080} />
  </>
);
