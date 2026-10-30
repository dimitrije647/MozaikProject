'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { SettingsSection } from '@/components/settings-section';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { useChangePassword } from '@/lib/hooks';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(8, 'Use at least 8 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type Values = z.infer<typeof schema>;

export default function SecuritySettingsPage() {
  const change = useChangePassword();
  const toast = useToast();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  return (
    <form
      onSubmit={handleSubmit(({ currentPassword, newPassword }) =>
        change.mutate(
          { currentPassword, newPassword },
          {
            onSuccess: () => {
              toast.success('Password changed');
              reset();
            },
            onError: (e) => toast.error(e.message),
          },
        ),
      )}
    >
      <SettingsSection
        title="Password"
        description="Use a long, unique password. You stay signed in on this device after changing it."
        footer={<Button type="submit" loading={change.isPending}>Update password</Button>}
      >
        <Field label="Current password" htmlFor="currentPassword" error={errors.currentPassword?.message}>
          <Input id="currentPassword" type="password" autoComplete="current-password" {...register('currentPassword')} />
        </Field>
        <Field label="New password" htmlFor="newPassword" error={errors.newPassword?.message}>
          <Input id="newPassword" type="password" autoComplete="new-password" {...register('newPassword')} />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm" error={errors.confirm?.message}>
          <Input id="confirm" type="password" autoComplete="new-password" {...register('confirm')} />
        </Field>
      </SettingsSection>
    </form>
  );
}
