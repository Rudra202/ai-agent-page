import { Link } from 'react-router-dom';
import { PageHeader } from '../components/layout/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" subtitle="That page does not exist." />
      <EmptyState
        title="We could not find that page"
        action={
          <Link to="/dashboard" className="text-sm font-semibold text-brand-700 hover:underline">
            Go to Home
          </Link>
        }
      />
    </>
  );
}
