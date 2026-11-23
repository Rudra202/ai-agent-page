import { zodResolver } from '@hookform/resolvers/zod';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { ApiError } from '../api/http';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Field, inputClass } from '../components/ui/Field';
import { safeDestination } from '../lib/redirect';
import { useAuth } from '../state/authContext';

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex size-10 items-center justify-center rounded-control bg-navy-900 text-white">
            <Sparkles className="size-5" aria-hidden />
          </span>
          <span className="text-xl font-bold tracking-tight text-navy-900">Tajir AI</span>
        </div>
        <Card>
          <h1 className="text-2xl font-bold tracking-tight text-navy-900">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </Card>
        <p className="mt-4 text-center text-sm text-muted">{footer}</p>
        <p className="mt-6 text-center text-[11px] text-muted">Prototype · sample data · nothing is filed with any authority</p>
      </div>
    </div>
  );
}

function useDestination(): string {
  return safeDestination(useLocation().state);
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-600">
      {message}
    </p>
  );
}

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address').pipe(z.email('Enter a valid email address')),
  password: z.string().min(1, 'Enter your password'),
});
type LoginValues = z.infer<typeof loginSchema>;

export function LoginPage() {
  const { login, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const destination = useDestination();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Sign in to continue with Tajir."
      footer={
        <>
          New to Tajir?{' '}
          <Link to="/register" className="font-semibold text-brand-700 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={handleSubmit(async (values) => {
          setFormError(null);
          try {
            await login(values);
            navigate(destination, { replace: true });
          } catch (error) {
            setFormError(error instanceof ApiError ? error.message : 'Could not sign in. Please try again.');
          }
        })}
      >
        {sessionExpired && !formError && (
          <p role="status" className="rounded-control bg-warning-50 px-3 py-2 text-sm text-warning-600">
            Your session ended. Please sign in again.
          </p>
        )}
        <FormError message={formError} />
        <Field label="Email" error={formState.errors.email?.message}>
          {(props) => <input {...props} type="email" autoComplete="email" inputMode="email" className={inputClass} {...register('email')} />}
        </Field>
        <Field label="Password" error={formState.errors.password?.message}>
          {(props) => <input {...props} type="password" autoComplete="current-password" className={inputClass} {...register('password')} />}
        </Field>
        <Button type="submit" fullWidth size="lg" loading={formState.isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(100, 'Keep your name under 100 characters'),
  email: z.string().trim().min(1, 'Enter your email address').pipe(z.email('Enter a valid email address')),
  password: z.string().min(8, 'Use at least 8 characters').max(72, 'Use at most 72 characters'),
  company: z.string().trim().max(120, 'Keep the company name under 120 characters'),
});
type RegisterValues = z.infer<typeof registerSchema>;

export function RegisterPage() {
  const { register: signUp } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '', company: '' },
  });

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Set up a company by talking to Tajir instead of filling in long forms."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-brand-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={handleSubmit(async (values) => {
          setFormError(null);
          try {
            await signUp({ name: values.name, email: values.email, password: values.password, ...(values.company ? { company: values.company } : {}) });
            navigate('/dashboard', { replace: true });
          } catch (error) {
            setFormError(error instanceof ApiError ? error.message : 'Could not create the account. Please try again.');
          }
        })}
      >
        <FormError message={formError} />
        <Field label="Your name" error={formState.errors.name?.message}>
          {(props) => <input {...props} autoComplete="name" className={inputClass} {...register('name')} />}
        </Field>
        <Field label="Email" error={formState.errors.email?.message}>
          {(props) => <input {...props} type="email" autoComplete="email" inputMode="email" className={inputClass} {...register('email')} />}
        </Field>
        <Field label="Password" hint="8 to 72 characters." error={formState.errors.password?.message}>
          {(props) => <input {...props} type="password" autoComplete="new-password" className={inputClass} {...register('password')} />}
        </Field>
        <Field label="Company name (optional)" hint="Used for Working Capital Finance requests." error={formState.errors.company?.message}>
          {(props) => <input {...props} autoComplete="organization" className={inputClass} {...register('company')} />}
        </Field>
        <Button type="submit" fullWidth size="lg" loading={formState.isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
