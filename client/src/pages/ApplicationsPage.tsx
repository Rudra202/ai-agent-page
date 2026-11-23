import { FileText } from 'lucide-react';
import { updatedAtOf } from '@tajir/shared';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ApplicationCard } from '../features/applications/components/ApplicationCard';
import { useApp } from '../state/context';

export function ApplicationsPage() {
  const { state, sendText } = useApp();
  const navigate = useNavigate();
  const apps = [...state.applications].sort((a, b) => updatedAtOf(b).localeCompare(updatedAtOf(a)));

  return (
    <>
      <PageHeader title="Applications" subtitle="Everything you have started with Tajir." />
      {apps.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-6" aria-hidden />}
          title="No applications yet"
          description="Start a company or a Working Capital Finance request and it will show up here."
          action={
            <Button
              onClick={() => {
                void sendText('Start a company');
                navigate('/chat');
              }}
            >
              Start a company
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {apps.map((app) => (
            <li key={app.id}>
              <ApplicationCard app={app} variant="list" />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
