import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, Check, Circle, Pencil } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  BUSINESS_ACTIVITIES,
  BUSINESS_CATEGORIES,
  businessDetailsSchema,
  formatAed,
  getJurisdiction,
  getPackage,
  jurisdictionsFor,
  packagesForJurisdiction,
  REGISTRATION_TYPE_LABELS,
  REGISTRATION_TYPES,
  requiredDocumentsFor,
  validateCompanyDraft,
} from '@tajir/shared';
import type { CompanyDraft, RegistrationType } from '@tajir/shared';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { Field, inputClass } from '../components/ui/Field';
import { requiredDocumentStatus } from '../domain/documents';
import { useApp } from '../state/context';

// ------------------------------------------------------------------ forms

interface SectionFormProps {
  company: CompanyDraft;
  onSave: (patch: Partial<CompanyDraft>) => void | Promise<void>;
  onCancel: () => void;
}

function FormActions({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="mt-4 flex gap-2">
      <Button type="submit" size="sm">
        Save
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

const registrationSchema = z
  .object({
    registrationType: z.enum(REGISTRATION_TYPES, 'Choose a registration type'),
    jurisdictionId: z.string().min(1, 'Choose a jurisdiction'),
  })
  .refine((v) => getJurisdiction(v.jurisdictionId)?.registrationType === v.registrationType, {
    path: ['jurisdictionId'],
    message: 'Choose a jurisdiction that matches the registration type',
  });
type RegistrationValues = z.infer<typeof registrationSchema>;

function RegistrationForm({ company, onSave, onCancel }: SectionFormProps) {
  const form = useForm<RegistrationValues>({
    resolver: zodResolver(registrationSchema),
    defaultValues: {
      registrationType: company.registrationType ?? ('' as RegistrationType),
      jurisdictionId: company.jurisdictionId ?? '',
    },
  });
  const { register, handleSubmit, setValue, control, formState } = form;
  const type = useWatch({ control, name: 'registrationType' });
  const options = jurisdictionsFor(type || undefined);

  return (
    <form onSubmit={handleSubmit((v) => onSave(v))} noValidate className="space-y-4">
      <Field label="Registration type" error={formState.errors.registrationType?.message}>
        {(props) => (
          <select
            {...props}
            className={inputClass}
            {...register('registrationType', { onChange: () => setValue('jurisdictionId', '') })}
          >
            <option value="">Select a type</option>
            {REGISTRATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {REGISTRATION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Jurisdiction" error={formState.errors.jurisdictionId?.message}>
        {(props) => (
          <select {...props} className={inputClass} disabled={!type} {...register('jurisdictionId')}>
            <option value="">{type ? 'Select a jurisdiction' : 'Choose a type first'}</option>
            {options.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <FormActions onCancel={onCancel} />
    </form>
  );
}

const activitySchema = businessDetailsSchema.pick({ activity: true, category: true });
type ActivityValues = z.infer<typeof activitySchema>;

function ActivityForm({ company, onSave, onCancel }: SectionFormProps) {
  const { register, handleSubmit, formState } = useForm<ActivityValues>({
    resolver: zodResolver(activitySchema),
    defaultValues: { activity: company.activity ?? '', category: company.category ?? '' },
  });
  const categories = company.category && !BUSINESS_CATEGORIES.includes(company.category)
    ? [...BUSINESS_CATEGORIES, company.category]
    : BUSINESS_CATEGORIES;
  return (
    <form onSubmit={handleSubmit((v) => onSave(v))} noValidate className="space-y-4">
      <Field label="Business activity" error={formState.errors.activity?.message}>
        {(props) => (
          <>
            <input {...props} list="activity-options" className={inputClass} {...register('activity')} />
            <datalist id="activity-options">
              {BUSINESS_ACTIVITIES.map((a) => (
                <option key={a.label} value={a.label} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field label="Business category" error={formState.errors.category?.message}>
        {(props) => (
          <select {...props} className={inputClass} {...register('category')}>
            <option value="">Select a category</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </Field>
      <FormActions onCancel={onCancel} />
    </form>
  );
}

const detailsSchema = businessDetailsSchema.pick({ companyName: true, description: true });
type DetailsValues = z.infer<typeof detailsSchema>;

function DetailsForm({ company, onSave, onCancel }: SectionFormProps) {
  const { register, handleSubmit, formState } = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { companyName: company.companyName ?? '', description: company.description ?? '' },
  });
  return (
    <form onSubmit={handleSubmit((v) => onSave(v))} noValidate className="space-y-4">
      <Field label="Company name" error={formState.errors.companyName?.message}>
        {(props) => <input {...props} className={inputClass} {...register('companyName')} />}
      </Field>
      <Field label="Business description (optional)" error={formState.errors.description?.message}>
        {(props) => (
          <textarea {...props} rows={3} className={`${inputClass} h-auto py-2.5`} {...register('description')} />
        )}
      </Field>
      <FormActions onCancel={onCancel} />
    </form>
  );
}

const shareholdersSchema = businessDetailsSchema.pick({ shareholders: true });
type ShareholderValues = z.infer<typeof shareholdersSchema>;

function ShareholdersForm({ company, onSave, onCancel }: SectionFormProps) {
  const { register, handleSubmit, formState } = useForm<ShareholderValues>({
    resolver: zodResolver(shareholdersSchema),
    defaultValues: { shareholders: company.shareholders },
  });
  return (
    <form onSubmit={handleSubmit((v) => onSave(v))} noValidate className="space-y-4">
      <Field label="Number of shareholders" error={formState.errors.shareholders?.message}>
        {(props) => (
          <input
            {...props}
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            className={inputClass}
            {...register('shareholders', { valueAsNumber: true })}
          />
        )}
      </Field>
      <FormActions onCancel={onCancel} />
    </form>
  );
}

const packageSchema = z.object({ packageId: z.string().min(1, 'Choose a package') });
type PackageValues = z.infer<typeof packageSchema>;

function PackageForm({ company, onSave, onCancel }: SectionFormProps) {
  const { register, handleSubmit, formState } = useForm<PackageValues>({
    resolver: zodResolver(packageSchema),
    defaultValues: { packageId: company.packageId ?? '' },
  });
  const options = packagesForJurisdiction(company.jurisdictionId);
  return (
    <form onSubmit={handleSubmit((v) => onSave(v))} noValidate className="space-y-4">
      <Field
        label="Package"
        error={formState.errors.packageId?.message}
        hint={options.length === 0 ? 'Choose a jurisdiction first to see its packages.' : undefined}
      >
        {(props) => (
          <select {...props} className={inputClass} disabled={options.length === 0} {...register('packageId')}>
            <option value="">Select a package</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} - {p.price !== undefined ? formatAed(p.price) : 'pricing on request'}
              </option>
            ))}
          </select>
        )}
      </Field>
      <FormActions onCancel={onCancel} />
    </form>
  );
}

// --------------------------------------------------------------- sections

type SectionId = 'registration' | 'activity' | 'details' | 'shareholders' | 'package';

function ReviewSection({
  title,
  rows,
  problems,
  editing,
  onEdit,
  children,
}: {
  title: string;
  rows: Array<{ label: string; value: string }>;
  problems: string[];
  editing: boolean;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <Card aria-label={title}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-navy-900">{title}</h2>
        <div className="flex items-center gap-2">
          {problems.length > 0 && <Badge tone="warning">Incomplete</Badge>}
          {!editing && (
            <Button size="sm" variant="ghost" leadingIcon={<Pencil className="size-4" aria-hidden />} aria-label={`Edit ${title}`} onClick={onEdit}>
              Edit
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <div className="mt-4">{children}</div>
      ) : (
        <>
          <dl className="mt-3 divide-y divide-line text-sm">
            {rows.map((row) => (
              <div key={row.label} className="flex justify-between gap-4 py-2">
                <dt className="shrink-0 text-muted">{row.label}</dt>
                <dd className="text-right font-medium text-navy-900">{row.value}</dd>
              </div>
            ))}
          </dl>
          {problems.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-warning-600">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

export function ReviewPage() {
  const { state, updateCompany, confirm, sendText } = useApp();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<SectionId | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { workflow } = state;

  if (workflow.type !== 'company_registration') {
    return (
      <>
        <PageHeader title="Review and submit" subtitle="Check everything before you submit." />
        <EmptyState
          title="Nothing to review yet"
          description="Start a company registration in chat and your answers will appear here."
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
      </>
    );
  }

  if (workflow.step === 'submitted') {
    return (
      <>
        <PageHeader title="Review and submit" subtitle="Check everything before you submit." />
        <EmptyState
          icon={<Check className="size-6" aria-hidden />}
          title="Already submitted"
          description="This registration has been submitted. You can follow it from Activity."
          action={
            <Link to="/activity" className="text-sm font-semibold text-brand-700 hover:underline">
              Go to Activity
            </Link>
          }
        />
      </>
    );
  }

  const company = workflow.company;
  const problems = validateCompanyDraft(company);
  const issuesFor = (...fields: Array<keyof CompanyDraft>) =>
    problems.filter((p) => fields.includes(p.field)).map((p) => p.message);
  const jurisdiction = getJurisdiction(company.jurisdictionId);
  const pkg = getPackage(company.packageId);
  const none = 'Not provided yet';
  const docs = requiredDocumentStatus(requiredDocumentsFor(company.registrationType), state.documents);
  const missingDocs = docs.filter((d) => !d.onRecord);

  const save = async (patch: Partial<CompanyDraft>) => {
    setSaveError(null);
    const result = await updateCompany(patch);
    if (result.ok) setEditing(null);
    else setSaveError(result.error ?? 'That change could not be saved. Please try again.');
  };
  const common = { company, onSave: save, onCancel: () => setEditing(null) };

  const submit = async () => {
    setSubmitError(null);
    setSubmitting(true);
    const outcome = await confirm('review');
    setSubmitting(false);
    setConfirming(false);
    if (outcome.createdApplicationId) {
      navigate(`/applications/${outcome.createdApplicationId}`, { state: { justSubmitted: true } });
    } else {
      setSubmitError(outcome.error ?? 'The registration could not be submitted. Please check the details and try again.');
    }
  };

  return (
    <>
      <PageHeader title="Review and submit" subtitle="Check every detail. You can edit any section before you submit." />

      {(saveError || submitError) && (
        <p role="alert" className="mb-4 rounded-card bg-danger-50 p-4 text-sm text-danger-600">
          {saveError ?? submitError}
        </p>
      )}

      {problems.length > 0 && (
        <div role="alert" className="mb-4 flex gap-2 rounded-card bg-warning-50 p-4 text-sm text-warning-600">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">Some information is missing</p>
            <ul className="mt-1 list-disc pl-5 text-xs">
              {problems.map((p) => (
                <li key={p.field}>{p.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="space-y-4">
        <ReviewSection
          title="Registration"
          editing={editing === 'registration'}
          onEdit={() => setEditing('registration')}
          problems={issuesFor('registrationType', 'jurisdictionId')}
          rows={[
            { label: 'Registration type', value: company.registrationType ? REGISTRATION_TYPE_LABELS[company.registrationType] : none },
            { label: 'Jurisdiction', value: jurisdiction?.name ?? none },
          ]}
        >
          <RegistrationForm {...common} />
        </ReviewSection>

        <ReviewSection
          title="Business activity"
          editing={editing === 'activity'}
          onEdit={() => setEditing('activity')}
          problems={issuesFor('activity', 'category')}
          rows={[
            { label: 'Activity', value: company.activity || none },
            { label: 'Category', value: company.category || none },
          ]}
        >
          <ActivityForm {...common} />
        </ReviewSection>

        <ReviewSection
          title="Business details"
          editing={editing === 'details'}
          onEdit={() => setEditing('details')}
          problems={issuesFor('companyName', 'description')}
          rows={[
            { label: 'Company name', value: company.companyName || none },
            { label: 'Description', value: company.description || 'No description' },
          ]}
        >
          <DetailsForm {...common} />
        </ReviewSection>

        <ReviewSection
          title="Shareholders"
          editing={editing === 'shareholders'}
          onEdit={() => setEditing('shareholders')}
          problems={issuesFor('shareholders')}
          rows={[
            { label: 'Number of shareholders', value: company.shareholders !== undefined ? String(company.shareholders) : none },
            { label: 'Applicant', value: state.user.name },
          ]}
        >
          <ShareholdersForm {...common} />
        </ReviewSection>

        <ReviewSection
          title="Package"
          editing={editing === 'package'}
          onEdit={() => setEditing('package')}
          problems={issuesFor('packageId')}
          rows={[
            { label: 'Package', value: pkg?.name ?? none },
            { label: 'Price', value: pkg ? (pkg.price !== undefined ? formatAed(pkg.price) : 'Pricing on request') : none },
            ...(pkg ? [{ label: 'Included', value: pkg.includes.join(', ') }] : []),
          ]}
        >
          <PackageForm {...common} />
        </ReviewSection>

        <Card aria-label="Required documents">
          <h2 className="text-base font-semibold text-navy-900">Required documents</h2>
          <ul className="mt-3 divide-y divide-line text-sm">
            {docs.map((d) => (
              <li key={d.typeId} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2">
                  {d.onRecord ? (
                    <Check className="size-4 text-success-600" aria-hidden />
                  ) : (
                    <Circle className="size-4 text-warning-600" aria-hidden />
                  )}
                  {d.label}
                </span>
                <span className={d.onRecord ? 'text-xs text-success-600' : 'text-xs text-warning-600'}>
                  {d.onRecord ? 'On record' : 'Needed after submission'}
                </span>
              </li>
            ))}
          </ul>
          {missingDocs.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Missing documents do not block submission. Tajir will ask for them and track them on your application.
            </p>
          )}
        </Card>
      </div>

      <div className="mt-6 space-y-2">
        <Button fullWidth size="lg" disabled={problems.length > 0 || editing !== null} onClick={() => setConfirming(true)}>
          Confirm &amp; Submit
        </Button>
        <p className="text-center text-xs text-muted">Prototype: submitting records an application in this app. Nothing is filed with any authority.</p>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Submit this application?"
        confirmLabel="Yes, submit"
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
        busy={submitting}
      >
        <p>
          You are about to submit the registration for <strong>{company.companyName}</strong>. You can still follow its progress from Activity afterwards.
        </p>
      </ConfirmDialog>
    </>
  );
}
