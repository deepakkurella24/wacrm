"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Message, Conversation } from "@/types";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
  pollIntervalMs?: number;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
  pollIntervalMs = 5000,
}: UseRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  // Supabase WebSocket Realtime Subscription (if available)
  useEffect(() => {
    if (!enabled) return;

    let channel: RealtimeChannel | null = null;
    let isCancelled = false;

    try {
      const supabase = createClient();
      if (!supabase?.channel) return;

      channel = supabase
        .channel(channelName)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "messages" },
          (payload) => {
            onMessageRef.current?.({
              eventType: payload.eventType as RealtimeEvent<Message>["eventType"],
              new: payload.new as Message,
              old: payload.old as Partial<Message>,
            });
          }
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "conversations" },
          (payload) => {
            onConversationRef.current?.({
              eventType: payload.eventType as RealtimeEvent<Conversation>["eventType"],
              new: payload.new as Conversation,
              old: payload.old as Partial<Conversation>,
            });
          }
        )
        .subscribe((status) => {
          if (!isCancelled) {
            setIsConnected(status === "SUBSCRIBED");
          }
        });

      channelRef.current = channel;
    } catch {
      // Supabase Realtime not configured; fallback to polling below
      setIsConnected(false);
    }

    return () => {
      isCancelled = true;
      if (channel) {
        try {
          const supabase = createClient();
          supabase.removeChannel(channel);
        } catch {
          // ignore
        }
      }
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, enabled]);

  // Lightweight Polling Fallback (ensures inbox stays fresh even without WS Realtime)
  useEffect(() => {
    if (!enabled || isConnected) return;

    let lastPolledAt = new Date().toISOString();

    const interval = setInterval(async () => {
      try {
        const supabase = createClient();
        if (!supabase?.from) return;

        // Poll for newly created or updated conversations
        const { data: convs } = await supabase
          .from("conversations")
          .select("*")
          .gt("updated_at", lastPolledAt)
          .order("updated_at", { ascending: false })
          .limit(10);

        if (convs && convs.length > 0) {
          for (const conv of convs) {
            onConversationRef.current?.({
              eventType: "UPDATE",
              new: conv as Conversation,
              old: {},
            });
          }
        }

        // Poll for newly created messages
        const { data: msgs } = await supabase
          .from("messages")
          .select("*")
          .gt("created_at", lastPolledAt)
          .order("created_at", { ascending: false })
          .limit(20);

        if (msgs && msgs.length > 0) {
          for (const msg of msgs) {
            onMessageRef.current?.({
              eventType: "INSERT",
              new: msg as Message,
              old: {},
            });
          }
        }

        lastPolledAt = new Date().toISOString();
      } catch {
        // Polling error silently handled
      }
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [enabled, isConnected, pollIntervalMs]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      try {
        const supabase = createClient();
        supabase.removeChannel(channelRef.current);
      } catch {
        // ignore
      }
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
