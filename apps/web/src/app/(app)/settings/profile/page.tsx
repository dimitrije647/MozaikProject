'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Avatar } from '@/components/app-shell';
import { SettingsSection } from '@/components/settings-section';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { useMe, useUpdateProfile } from '@/lib/hooks';

const schema = z.object({
  name: z.string().min(2, 'Enter your name').max(80),
  avatarUrl: z.union([z.literal(''), z.string().url('Enter a full image URL')]),
});
type Values = z.infer<typeof schema>;

export default function ProfileSettingsPage() {
  const me = useMe();
  const update = useUpdateProfile();
  const toast = useToast();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: '', avatarUrl: '' } });

  React.useEffect(() => {
    if (me.data) reset({ name: me.data.name, avatarUrl: me.data.avatarUrl ?? '' });
  }, [me.data, reset]);

  const [name, avatarUrl] = watch(['name', 'avatarUrl']);

  return (
    <form
      onSubmit={handleSubmit((v) =>
        update.mutate(v, {
          onSuccess: () => toast.success('Profile updated'),
          onError: (e) => toast.error(e.message),
        }),
      )}
    >
      <SettingsSection
        title="Profile"
        description="How you appear across LaunchPilot."
        footer={
          <Button type="submit" loading={update.isPending} disabled={!isDirty}>
            Save changes
          </Button>
        }
      >
        <div className="flex items-center gap-4">
          <Avatar name={name || 'U'} url={avatarUrl && !errors.avatarUrl ? avatarUrl : null} className="h-14 w-14 text-lg" />
          <p className="text-sm text-muted">Avatar uploads are not available yet. Paste an image URL below.</p>
        </div>
        <Field label="Full name" htmlFor="name" error={errors.name?.message}>
          <Input id="name" {...register('name')} />
        </Field>
        <Field label="Email" htmlFor="email" hint="Email changes are not supported yet.">
          <Input id="email" value={me.data?.email ?? ''} disabled readOnly />
        </Field>
        <Field label="Avatar URL" htmlFor="avatarUrl" optional error={errors.avatarUrl?.message}>
          <Input id="avatarUrl" placeholder="https://" {...register('avatarUrl')} />
        </Field>
      </SettingsSection>
    </form>
  );
}
