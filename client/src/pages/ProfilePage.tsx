import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Card, CardDescription, CardTitle } from '../components/ui/Card';
import { useAuth } from '../state/authContext';
import { useApp } from '../state/context';

export function ProfilePage() {
  const { state } = useApp();
  const auth = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const { user } = state;

  const NAMES = { gemini: 'Google Gemini', openai: 'OpenAI' } as const;
  const assistant =
    state.aiMode === 'gemini' || state.aiMode === 'openai'
      ? `${NAMES[state.aiMode]}${state.aiBackup ? `, with ${NAMES[state.aiBackup]} as backup` : ''}, with safety checks`
      : state.aiMode === 'rules'
        ? 'Not connected: guided steps only'
        : 'Checking...';

  return (
    <>
      <PageHeader title="Profile" subtitle="Your account and company." />
      <Card>
        <div className="flex items-center gap-4">
          <span className="flex size-14 items-center justify-center rounded-full bg-navy-900 text-xl font-bold text-white" aria-hidden>
            {user.firstName.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="text-lg font-semibold text-navy-900">{user.name}</p>
            <p className="truncate text-sm text-muted">{user.email}</p>
          </div>
        </div>
        <dl className="mt-4 divide-y divide-line text-sm">
          <div className="flex justify-between gap-4 py-2">
            <dt className="text-muted">Company</dt>
            <dd className="font-medium text-navy-900">{user.company || 'Not provided'}</dd>
          </div>
          <div className="flex justify-between gap-4 py-2">
            <dt className="text-muted">Applications</dt>
            <dd className="font-medium text-navy-900">{state.applications.length}</dd>
          </div>
          <div className="flex justify-between gap-4 py-2">
            <dt className="text-muted">Documents</dt>
            <dd className="font-medium text-navy-900">{state.documents.length}</dd>
          </div>
          <div className="flex justify-between gap-4 py-2">
            <dt className="text-muted">AI assistant</dt>
            <dd className="text-right font-medium text-navy-900">{assistant}</dd>
          </div>
        </dl>
      </Card>

      <Card className="mt-4">
        <CardTitle>Your data</CardTitle>
        <CardDescription>
          Your applications, documents and chats are kept on the server under your account. This is a prototype: fees, requirements and
          eligibility shown are sample information, and nothing is filed with any authority or lender.
        </CardDescription>
        <Button
          className="mt-4"
          variant="secondary"
          loading={signingOut}
          leadingIcon={<LogOut className="size-4" aria-hidden />}
          onClick={async () => {
            setSigningOut(true);
            await auth.logout();
            navigate('/login', { replace: true });
          }}
        >
          Sign out
        </Button>
      </Card>
    </>
  );
}
