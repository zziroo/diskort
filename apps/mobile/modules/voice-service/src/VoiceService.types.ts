export type VoiceServiceAction = 'toggleMute' | 'disconnect';

export type VoiceServiceModuleEvents = {
  onAction: (params: { action: VoiceServiceAction }) => void;
  onTimer: (params: { id: number }) => void;
};
