import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCreateUser, useListEntities, useListUsers, useResetUserPassword, useUpdateUser,
  getListUsersQueryKey, type AppUser, type Role,
} from '@workspace/api-client-react';
import { PageContent, PageHeader } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { entityLabel } from '@/lib/constants';
import { ROLE_DESCRIPTIONS, useAuth } from '@/lib/auth';
import { KeyRound, MoreHorizontal, Pencil, RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';

// Settings › Team & Access (2026-09-17). Admin-only (route guard + server).

const ROLES: Role[] = ['Admin', 'Manager', 'Bookkeeper', 'Auditor'];

const ROLE_CHIP: Record<Role, string> = {
  Admin: 'bg-gray-900 text-white',
  Manager: 'bg-blue-100 text-blue-800',
  Bookkeeper: 'bg-emerald-100 text-emerald-800',
  Auditor: 'bg-amber-100 text-amber-800',
};

// Strong random temporary password (letters + digits + symbol, 16 chars).
function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(14);
  crypto.getRandomValues(buf);
  const body = Array.from(buf, (n) => chars[n % chars.length]).join('');
  return `${body.slice(0, 7)}-${body.slice(7)}${(buf[0] % 8) + 2}`;
}

function EntityAccessPicker({ entities, allEntities, entityIds, onChange, forcedAll }: {
  entities: any[]; allEntities: boolean; entityIds: number[]; onChange: (all: boolean, ids: number[]) => void; forcedAll: boolean;
}) {
  const toggle = (id: number, on: boolean) => onChange(false, on ? [...new Set([...entityIds, id])] : entityIds.filter((x) => x !== id));
  const all = forcedAll || allEntities;
  return (
    <div className="rounded-md border p-3" data-entity-access>
      <label className="flex items-center gap-2 border-b pb-2 text-sm font-medium">
        <Checkbox
          checked={all}
          disabled={forcedAll}
          onCheckedChange={(v) => onChange(!!v, v ? [] : entityIds)}
          aria-label="All Entities"
        />
        All Entities
        <span className="text-[11px] font-normal text-gray-500">{forcedAll ? '— Admins always have every entity' : '— includes entities added later'}</span>
      </label>
      <div className="mt-2 grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto">
        {entities.map((e) => (
          <label key={e.id} className={`flex items-center gap-2 text-sm ${all ? 'text-gray-400' : ''}`}>
            <Checkbox
              checked={all || entityIds.includes(e.id)}
              disabled={all}
              onCheckedChange={(v) => toggle(e.id, !!v)}
              aria-label={entityLabel(e.name)}
            />
            {entityLabel(e.name)}
          </label>
        ))}
      </div>
    </div>
  );
}

function UserFormDialog({ user, open, onOpenChange, entities }: { user: AppUser | null; open: boolean; onOpenChange: (o: boolean) => void; entities: any[] }) {
  const isEdit = !!user;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user: me, refresh } = useAuth();
  const create = useCreateUser();
  const update = useUpdateUser();

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState(() => (isEdit ? '' : generatePassword()));
  const [role, setRole] = useState<Role>(user?.role ?? 'Bookkeeper');
  const [allEntities, setAllEntities] = useState<boolean>(user ? user.allEntities : false);
  const [entityIds, setEntityIds] = useState<number[]>(user?.entityIds ?? []);
  const [showPassword, setShowPassword] = useState(true);

  const forcedAll = role === 'Admin';
  const hasEntityAccess = forcedAll || allEntities || entityIds.length > 0;
  const canSave = !!fullName.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && hasEntityAccess && (isEdit || password.length >= 10);

  const save = () => {
    const done = (title: string, description?: string) => () => {
      toast({ title, description });
      queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
      if (user && user.id === me.id) refresh(); // own role/access changed → reflect immediately
      onOpenChange(false);
    };
    const fail = (err: any) => toast({ title: 'Could not save user', description: err.message, variant: 'destructive' });
    const access = { role, allEntities: forcedAll || allEntities, entityIds: forcedAll || allEntities ? [] : entityIds };
    if (isEdit) update.mutate({ id: user!.id, fullName: fullName.trim(), email: email.trim(), ...access }, { onSuccess: done('User updated'), onError: fail });
    else create.mutate({ fullName: fullName.trim(), email: email.trim(), password, ...access }, {
      onSuccess: done('User added', 'Share the temporary password securely — they must change it at first sign-in.'),
      onError: fail,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${user!.fullName}` : 'Add New User'}</DialogTitle>
          <DialogDescription>{isEdit ? 'Role and entity changes apply on their next request.' : 'The user signs in with the temporary password and must replace it.'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Full Name</span>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus aria-label="Full Name" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Email Address</span>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email Address" />
            </label>
          </div>
          {!isEdit && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Temporary Password</span>
              <div className="flex gap-2">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="font-mono"
                  aria-label="Temporary Password"
                  autoComplete="new-password"
                />
                <Button type="button" variant="outline" size="icon" onClick={() => setPassword(generatePassword())} title="Generate a new password" aria-label="Generate password">
                  <RefreshCw className="size-4" />
                </Button>
              </div>
              <span className="mt-1 flex items-center justify-between text-[11px] text-gray-500">
                At least 10 characters with a letter and a number.
                <button type="button" className="hover:underline" onClick={() => setShowPassword((s) => !s)}>{showPassword ? 'Hide' : 'Show'}</button>
              </span>
            </label>
          )}
          <div>
            <span className="mb-1 block text-xs font-medium">Role</span>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger aria-label="Role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-gray-500" data-role-description>{ROLE_DESCRIPTIONS[role]}</p>
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium">Accessible Entities</span>
            <EntityAccessPicker
              entities={entities}
              allEntities={allEntities}
              entityIds={entityIds}
              forcedAll={forcedAll}
              onChange={(all, ids) => { setAllEntities(all); setEntityIds(ids); }}
            />
            {!hasEntityAccess && <p className="mt-1 text-[11px] text-red-700">Select at least one entity, or All Entities.</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!canSave || create.isPending || update.isPending}>
            {create.isPending || update.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add user'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onOpenChange }: { user: AppUser | null; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const reset = useResetUserPassword();
  const [password, setPassword] = useState(generatePassword());
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>{user?.fullName} is signed out everywhere and must choose a new password at next sign-in.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" aria-label="New temporary password" />
          <Button type="button" variant="outline" size="icon" onClick={() => setPassword(generatePassword())} aria-label="Generate password"><RefreshCw className="size-4" /></Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={password.length < 10 || reset.isPending}
            onClick={() => reset.mutate({ id: user!.id, password }, {
              onSuccess: () => { toast({ title: 'Temporary password set', description: 'Share it securely.' }); queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() }); onOpenChange(false); },
              onError: (err: any) => toast({ title: 'Could not reset password', description: err.message, variant: 'destructive' }),
            })}
          >
            Reset password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TeamAccess() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const { data: users, isLoading } = useListUsers();
  const { data: entitiesData } = useListEntities();
  const entities = (entitiesData || []) as any[];
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const update = useUpdateUser();
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [resetting, setResetting] = useState<AppUser | null>(null);

  const setStatus = (u: AppUser, status: 'Active' | 'Disabled') => {
    if (status === 'Disabled' && !confirm(`Disable ${u.fullName}? They are signed out immediately and can't sign in until re-enabled.`)) return;
    update.mutate({ id: u.id, status }, {
      onSuccess: () => { toast({ title: status === 'Disabled' ? 'User disabled' : 'User enabled' }); queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() }); },
      onError: (err: any) => toast({ title: 'Could not change status', description: err.message, variant: 'destructive' }),
    });
  };

  const accessLabel = (u: AppUser) =>
    u.allEntities ? 'All Entities' : u.entityIds.map((id) => entityLabel(entityById.get(id)?.name || `#${id}`)).join(', ');

  return (
    <>
      <PageHeader title="Team & Access" description="Who can sign in, what their role allows, and which entities they can see">
        <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <UserPlus className="mr-2 size-4" /> Add New User
        </Button>
      </PageHeader>
      <PageContent>
        <div className="overflow-x-auto rounded-2xl border border-gray-100 bg-white shadow-sm">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="font-mono text-xs font-semibold">User Name</TableHead>
                <TableHead className="font-mono text-xs font-semibold">Email</TableHead>
                <TableHead className="font-mono text-xs font-semibold">Assigned Role</TableHead>
                <TableHead className="font-mono text-xs font-semibold">Entity Access</TableHead>
                <TableHead className="font-mono text-xs font-semibold">Status</TableHead>
                <TableHead className="w-[70px] text-right font-mono text-xs font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>{Array.from({ length: 6 }).map((__, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
                ))
              ) : (users || []).map((u) => (
                <TableRow key={u.id} data-user-row={u.email}>
                  <TableCell className="text-sm">
                    <span className="font-medium">{u.fullName}</span>
                    {u.id === me.id && <span className="ml-1.5 text-[10px] text-gray-400">(you)</span>}
                    {u.mustChangePassword && <div className="text-[10px] text-amber-700">Temporary password — not yet changed</div>}
                  </TableCell>
                  <TableCell className="text-xs text-gray-600">{u.email}</TableCell>
                  <TableCell><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${ROLE_CHIP[u.role]}`}>{u.role}</span></TableCell>
                  <TableCell className="max-w-[220px] truncate text-xs" title={accessLabel(u)}>{accessLabel(u)}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center gap-1 text-xs ${u.status === 'Active' ? 'text-emerald-700' : 'text-gray-400'}`}>
                      <span className={`size-1.5 rounded-full ${u.status === 'Active' ? 'bg-emerald-500' : 'bg-gray-300'}`} /> {u.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for ${u.fullName}`}><MoreHorizontal className="size-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => { setEditing(u); setFormOpen(true); }}><Pencil className="mr-2 size-3.5" /> Edit role & access</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setResetting(u)}><KeyRound className="mr-2 size-3.5" /> Reset password</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {u.status === 'Active' ? (
                          <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={u.id === me.id} onClick={() => setStatus(u, 'Disabled')}>Disable user</DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => setStatus(u, 'Active')}>Enable user</DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ROLES.map((r) => (
            <div key={r} className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold"><ShieldCheck className="size-3.5 text-gray-400" /> {r}</div>
              <p className="text-[11px] leading-snug text-gray-500">{ROLE_DESCRIPTIONS[r]}</p>
            </div>
          ))}
        </div>
      </PageContent>

      {formOpen && (
        <UserFormDialog key={editing ? `edit-${editing.id}` : 'new'} user={editing} open={formOpen} onOpenChange={setFormOpen} entities={entities} />
      )}
      {resetting && <ResetPasswordDialog key={resetting.id} user={resetting} onOpenChange={(o) => { if (!o) setResetting(null); }} />}
    </>
  );
}
