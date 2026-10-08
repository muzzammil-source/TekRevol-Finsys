import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBootstrapAdmin, useChangePassword, useLogin, useLogout } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { resetSessionQueries } from '@/lib/auth';

// Sign-in, first-run setup and forced password change (2026-09-17).

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="size-8 object-contain" />
          <div className="leading-tight">
            <div className="text-[13px] font-bold tracking-tight text-gray-900">TekRevol FinSys</div>
            <div className="text-[10px] uppercase tracking-wider text-gray-400">Finance Platform</div>
          </div>
        </div>
        <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
        <p className="mb-4 mt-1 text-xs text-gray-500">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-700">{label}</span>
      <Input {...props} />
    </label>
  );
}

const PASSWORD_HINT = 'At least 10 characters, with a letter and a number.';

export function LoginScreen() {
  const queryClient = useQueryClient();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    login.mutate({ email, password }, {
      onSuccess: () => { resetSessionQueries(queryClient); },
      onError: (err: any) => setError(err.message),
    });
  };

  return (
    <AuthCard title="Sign in" subtitle="Use the email and password your administrator gave you.">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div role="alert" className="text-xs text-red-700">{error}</div>}
        <Button type="submit" className="w-full" disabled={login.isPending || !email || !password}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  );
}

export function SetupScreen() {
  const queryClient = useQueryClient();
  const bootstrap = useBootstrapAdmin();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError('Passwords do not match');
    bootstrap.mutate({ fullName, email, password }, {
      onSuccess: () => { resetSessionQueries(queryClient); },
      onError: (err: any) => setError(err.message),
    });
  };

  return (
    <AuthCard title="Create the administrator account" subtitle="No users exist yet. This first account is an Admin with access to every entity; add the rest of the team from Settings › Team & Access.">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus required />
        <Field label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Field label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <Field label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        <p className="text-[11px] text-gray-500">{PASSWORD_HINT}</p>
        {error && <div role="alert" className="text-xs text-red-700">{error}</div>}
        <Button type="submit" className="w-full" disabled={bootstrap.isPending || !fullName || !email || !password}>
          {bootstrap.isPending ? 'Creating…' : 'Create admin & sign in'}
        </Button>
      </form>
    </AuthCard>
  );
}

export function ChangePasswordScreen({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const change = useChangePassword();
  const logout = useLogout();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) return setError('New passwords do not match');
    change.mutate({ currentPassword, newPassword }, {
      onSuccess: () => { resetSessionQueries(queryClient); },
      onError: (err: any) => setError(err.message),
    });
  };

  return (
    <AuthCard title="Set your password" subtitle={`Welcome, ${name}. You signed in with a temporary password — choose your own to continue.`}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Temporary password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} autoFocus required />
        <Field label="New password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} required />
        <Field label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        <p className="text-[11px] text-gray-500">{PASSWORD_HINT}</p>
        {error && <div role="alert" className="text-xs text-red-700">{error}</div>}
        <Button type="submit" className="w-full" disabled={change.isPending}>
          {change.isPending ? 'Saving…' : 'Save password'}
        </Button>
        <button
          type="button"
          className="w-full text-center text-xs text-gray-500 hover:underline"
          onClick={() => logout.mutate(undefined, { onSettled: () => { resetSessionQueries(queryClient); } })}
        >
          Sign out
        </button>
      </form>
    </AuthCard>
  );
}
