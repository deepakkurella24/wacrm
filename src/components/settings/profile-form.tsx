'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import {
  Avatar,
  AvatarFallback,
} from '@/components/ui/avatar';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/db/client';
import { SettingsPanelHead } from './settings-panel-head';
import { BrowserNotificationsCard } from './browser-notifications-card';

export function ProfileForm() {
  const t = useTranslations('Settings.profile');
  const { user, profile, refreshProfile } = useAuth();
  const db = createClient();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  // Seed form state once the profile loads.
  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
    setEmail(profile.email ?? '');
  }, [profile]);

  const initial = (fullName || profile?.full_name || profile?.email || 'U')
    .charAt(0)
    .toUpperCase();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !profile) return;

    const trimmedName = fullName.trim();
    if (!trimmedName) {
      toast.error(t('nameRequired'));
      return;
    }

    setSaving(true);
    try {
      // Persist updated display name to profiles in Neon
      const { error: updateError } = await db
        .from('profiles')
        .update({
          full_name: trimmedName,
        })
        .eq('user_id', user.id);

      if (updateError) {
        throw new Error(t('saveFailed', { message: updateError.message }));
      }

      await refreshProfile();
      toast.success(t('profileSaved'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('unknownError');
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    !!profile &&
    fullName.trim() !== (profile.full_name ?? '');

  const joined = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '—';

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <CardContent className="space-y-6">
            {/* User display avatar */}
            <div className="flex items-center gap-5">
              <Avatar size="lg" className="size-16">
                <AvatarFallback className="bg-primary/10 text-xl font-semibold text-primary">
                  {initial}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium text-foreground">{fullName || profile?.email}</p>
                <p className="text-xs text-muted-foreground">{profile?.account_role || 'Agent'}</p>
              </div>
            </div>

            {/* Name + email fields */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="full_name">{t('displayName')}</Label>
                <Input
                  id="full_name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('fullNamePlaceholder')}
                  disabled={saving}
                  autoComplete="name"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">{t('email')}</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  disabled={true}
                  className="bg-muted text-muted-foreground cursor-not-allowed"
                  autoComplete="email"
                />
                <p className="text-[11px] text-muted-foreground">
                  Email is managed by your Clerk identity provider.
                </p>
              </div>
            </div>

            {/* Metadata row */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs text-muted-foreground">
              <span>{t('joined')}: {joined}</span>
              {user?.id && (
                <span className="font-mono text-[11px] opacity-75">
                  ID: {user.id}
                </span>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button type="submit" disabled={!dirty || saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {t('saveChanges')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>

      {/* Browser push notifications card */}
      <div className="mt-6">
        <BrowserNotificationsCard />
      </div>
    </section>
  );
}
