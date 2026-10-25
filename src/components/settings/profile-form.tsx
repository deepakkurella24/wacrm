'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Mail, CircleAlert } from 'lucide-react';
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
import { createClient } from '@/lib/supabase/client';
import { SettingsPanelHead } from './settings-panel-head';
import { BrowserNotificationsCard } from './browser-notifications-card';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ProfileForm() {
  const t = useTranslations('Settings.profile');
  const { user, profile, refreshProfile } = useAuth();
  const supabase = createClient();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [emailChangePending, setEmailChangePending] = useState(false);

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
    const trimmedEmail = email.trim();
    if (!EMAIL_RE.test(trimmedEmail)) {
      toast.error(t('invalidEmail'));
      return;
    }

    setSaving(true);
    try {
      // Persist name to profiles.
      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          full_name: trimmedName,
        })
        .eq('user_id', user.id);
      if (updateError) {
        throw new Error(t('saveFailed', { message: updateError.message }));
      }

      let emailSent = false;
      if (trimmedEmail.toLowerCase() !== profile.email.toLowerCase()) {
        const { error: emailError } = await supabase.auth.updateUser({
          email: trimmedEmail,
        });
        if (emailError) {
          toast.success(t('profileSaved'));
          toast.error(t('emailChangeFailed', { message: emailError.message }));
          setSaving(false);
          await refreshProfile();
          return;
        }
        emailSent = true;
      }

      setEmailChangePending(emailSent);
      await refreshProfile();

      toast.success(
        emailSent
          ? t('profileSavedEmailCheck')
          : t('profileSaved'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('unknownError');
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    !!profile &&
    (fullName.trim() !== (profile.full_name ?? '') ||
      email.trim().toLowerCase() !== (profile.email ?? '').toLowerCase());

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

            {/* Email change in-flight banner */}
            {emailChangePending && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
                <Mail className="mt-0.5 size-4 shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">{t('profileSavedEmailCheck')}</p>
                </div>
              </div>
            )}

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
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={saving}
                  autoComplete="email"
                />
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
