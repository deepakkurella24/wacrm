'use client';

import { useEffect } from 'react';

export interface RealtimeOptions {
  channelName?: string;
  onMessageEvent?: (event: any) => void;
  onConversationEvent?: (event: any) => void;
  enabled?: boolean;
}

export function useRealtime({ enabled = true }: RealtimeOptions = {}) {
  const isConnected = true;

  useEffect(() => {
    if (!enabled) return;
  }, [enabled]);

  return { isConnected };
}
