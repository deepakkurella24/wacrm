"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Contact, Tag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslations } from "next-intl";
import { contactHandle } from "@/lib/whatsapp/wa-identity";

interface ContactSidebarProps {
  contact: Contact | null;
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const [copied, setCopied] = useState(false);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch tags
    const { data: tagsData } = await supabase
      .from("contact_tags")
      .select("id, tag_id, tags(*)")
      .eq("contact_id", contact.id);

    if (tagsData) {
      const mapped = tagsData
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  useEffect(() => {
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    const handle = contact ? contactHandle(contact) : '';
    if (!handle) return;
    await navigator.clipboard.writeText(handle);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [contact]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contactHandle(contact);
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">
                {contactHandle(contact)}
              </span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              {tSidebar("tags")}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
