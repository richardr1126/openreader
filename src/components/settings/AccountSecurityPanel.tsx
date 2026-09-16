'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { KeyIcon, MailIcon, PencilIcon, UserIcon, XIcon } from '@/components/icons/Icons';
import { Badge, Button, Field, Input } from '@/components/ui';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';

type EditSection = 'name' | 'email' | 'password';

function SettingRow({ icon: Icon, title, value, action, open, children }: {
  icon: typeof MailIcon;
  title: string;
  value: ReactNode;
  action: ReactNode;
  open: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-3.5 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-wash text-accent">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-soft">{value}</div>
          </div>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      {open && children ? <div className="mt-3 sm:pl-12">{children}</div> : null}
    </div>
  );
}

export function AccountSecurityPanel() {
  const { data: session } = useAuthSession();
  const { baseUrl } = useAuthConfig();
  const { accountEmailsEnabled } = useRuntimeConfig();
  const user = session?.user;
  const [name, setName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<'name' | 'email' | 'verify' | 'password' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditSection | null>(null);

  useEffect(() => { setName(user?.name ?? ''); }, [user?.id, user?.name]);

  // A role grant always wins over stale bootstrap-source metadata. The setup
  // prompt is for the one narrow state that has not received admin access yet.
  const authUser = user as (typeof user & { adminSource?: string; isAdmin?: boolean }) | undefined;
  const bootstrapPending = authUser?.adminSource === 'bootstrap' && !authUser?.isAdmin;

  // The bootstrap account must change its password to activate; open that row.
  useEffect(() => { if (bootstrapPending) setEditing('password'); }, [bootstrapPending]);

  if (!user || user.isAnonymous) return null;
  const authClient = getAuthClient(baseUrl);

  const openSection = (section: EditSection) => {
    setError(null);
    setEditing((current) => (current === section ? null : section));
  };
  const closeSection = () => {
    setError(null);
    setEditing(null);
    setName(user.name ?? '');
    setNewEmail('');
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
  };

  const saveName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || nextName.length > 100) return setError('Display name must be between 1 and 100 characters.');
    setBusy('name'); setError(null);
    try {
      const result = await authClient.updateUser({ name: nextName });
      if (result.error) throw new Error(result.error.message || 'Unable to update your name.');
      toast.success('Display name updated');
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update your name.');
    } finally { setBusy(null); }
  };

  const resendVerification = async () => {
    setBusy('verify'); setError(null);
    try {
      const result = await authClient.sendVerificationEmail({
        email: user.email,
        callbackURL: '/app/settings?section=account',
      });
      if (result.error) throw new Error(result.error.message || 'Unable to send verification email.');
      toast.success('Verification email requested');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to send verification email.');
    } finally { setBusy(null); }
  };

  const requestEmailChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextEmail = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) return setError('Enter a valid new email address.');
    if (nextEmail === user.email.toLowerCase()) return setError('Enter a different email address.');
    setBusy('email'); setError(null);
    try {
      const result = await authClient.changeEmail({
        newEmail: nextEmail,
        callbackURL: '/app/settings?section=account',
      });
      if (result.error) throw new Error(result.error.message || 'Unable to change your email.');
      setPendingEmail(nextEmail);
      setNewEmail('');
      setEditing(null);
      toast.success('Check your new email for a confirmation link');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to change your email.');
    } finally { setBusy(null); }
  };

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword.length < 8) return setError('New password must be at least 8 characters.');
    if (newPassword !== confirmPassword) return setError('New passwords do not match.');
    if (newPassword === currentPassword) return setError('Choose a different new password.');
    setBusy('password'); setError(null);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) throw new Error(result.error.message || 'Unable to change your password.');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      toast.success(bootstrapPending ? 'Password changed. Administrator setup is complete.' : 'Password changed. Other sessions were signed out.');
      if (bootstrapPending) { window.location.reload(); return; }
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to change your password.');
    } finally { setBusy(null); }
  };

  const editButton = (section: EditSection, label: string) => (
    editing === section ? (
      <Button type="button" size="sm" variant="ghost" onClick={closeSection} aria-label={`Cancel editing ${section}`}>
        <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    ) : (
      <Button type="button" size="sm" variant="outline" onClick={() => openSection(section)} className="gap-1.5">
        <PencilIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </Button>
    )
  );

  return (
    <div className="space-y-3">
      {bootstrapPending ? (
        <section className="rounded-lg border border-accent-line bg-accent-wash px-4 py-3" aria-label="Finish administrator setup">
          <p className="text-sm font-semibold text-foreground">Finish administrator setup</p>
          <p className="mt-1 text-xs leading-5 text-soft">Change the initial deployment password below to activate administrator access. The deployment secret will not update this account again.</p>
        </section>
      ) : null}
      {error ? <p role="alert" className="rounded-md border border-danger bg-danger-wash px-3 py-2 text-xs text-danger">{error}</p> : null}

      <section className="divide-y divide-line-soft rounded-lg border border-line bg-background" aria-label="Account and security">
        <SettingRow
          icon={UserIcon}
          title="Display name"
          value={<span className="truncate text-foreground">{user.name || 'Not set'}</span>}
          action={editButton('name', 'Edit')}
          open={editing === 'name'}
        >
          <form onSubmit={saveName} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Display name" className="min-w-0 flex-1">
              <Input aria-label="Display name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} autoComplete="name" autoFocus />
            </Field>
            <Button type="submit" size="sm" variant="primary" disabled={busy !== null || !name.trim() || name.trim() === user.name}>
              {busy === 'name' ? 'Saving…' : 'Save'}
            </Button>
          </form>
        </SettingRow>

        <SettingRow
          icon={MailIcon}
          title="Email address"
          value={<>
            <span className="min-w-0 break-all font-mono text-foreground">{user.email}</span>
            <Badge tone={user.emailVerified ? 'accent' : 'danger'}>{user.emailVerified ? 'Verified' : 'Not verified'}</Badge>
            {accountEmailsEnabled && !user.emailVerified ? (
              <button type="button" onClick={() => void resendVerification()} disabled={busy !== null} className="font-medium text-accent underline-offset-2 hover:underline disabled:opacity-60">
                {busy === 'verify' ? 'Sending…' : 'Resend link'}
              </button>
            ) : null}
          </>}
          action={accountEmailsEnabled ? editButton('email', 'Change') : null}
          open={editing === 'email'}
        >
          <form onSubmit={requestEmailChange} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="New email address" className="min-w-0 flex-1">
              <Input aria-label="New email address" type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} autoComplete="email" placeholder="you@example.com" autoFocus />
            </Field>
            <Button type="submit" size="sm" variant="primary" disabled={busy !== null || !newEmail.trim()}>
              {busy === 'email' ? 'Sending…' : 'Send link'}
            </Button>
          </form>
        </SettingRow>
        {pendingEmail ? (
          <div className="px-4 py-2 sm:px-5">
            <p role="status" className="text-xs text-accent">Confirmation requested for {pendingEmail}. Your current email stays active until you follow the link.</p>
          </div>
        ) : null}
        {!accountEmailsEnabled ? (
          <div className="px-4 py-2 sm:px-5">
            <p className="text-xs leading-5 text-soft">Email verification and address changes are unavailable until an administrator enables account email delivery.</p>
          </div>
        ) : null}

        <SettingRow
          icon={KeyIcon}
          title="Password"
          value={<span>{bootstrapPending ? 'Deployment password — change it to activate admin access.' : 'Change your password. Other sessions are signed out.'}</span>}
          action={editButton('password', bootstrapPending ? 'Activate' : 'Change')}
          open={editing === 'password'}
        >
          <form onSubmit={changePassword} className="grid gap-3 sm:grid-cols-2">
            <Field label="Current password" className="sm:col-span-2">
              <Input aria-label="Current password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" autoFocus />
            </Field>
            <Field label="New password">
              <Input aria-label="New password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} />
            </Field>
            <Field label="Confirm new password">
              <Input aria-label="Confirm new password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
              <p className="text-xs text-soft">At least 8 characters. Use a unique password.</p>
              <Button type="submit" size="sm" variant="primary" disabled={busy !== null || !currentPassword || !newPassword || !confirmPassword}>
                {busy === 'password' ? 'Changing…' : bootstrapPending ? 'Activate administrator access' : 'Change password'}
              </Button>
            </div>
          </form>
        </SettingRow>
      </section>
    </div>
  );
}
