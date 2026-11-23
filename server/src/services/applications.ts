import { randomUUID } from 'node:crypto';
import {
  ACTIVITY_FILTERS,
  activityFilterFor,
  APPLICATION_STATUS_LABELS,
  buildCompanyApplication,
  buildFinanceApplication,
  businessDetailsSchema,
  completeCompanySchema,
  completeFinanceSchema,
  createdAtOf,
  detailRowsOf,
  getJurisdiction,
  getPackage,
  nextAction,
  nextExternalStep,
  progressOf,
  provideRequirement,
  requirementsOfApp,
  settleApplication,
  simulateNext,
  statusOf,
  submittedAtOf,
  updatedAtOf,
  WorkflowError,
} from '@tajir/shared';
import type {
  ActivityFilter,
  Application,
  ApplicationProgress,
  ApplicationStatus,
  DetailRow,
  Requirement,
  WorkflowEvent,
  WorkflowType,
} from '@tajir/shared';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import type { ApplicationRecord, User } from '../domain/entities.js';
import { HttpError } from '../middleware/errorHandler.js';
import { DuplicateError } from '../repositories/errors.js';
import type { Repositories } from '../repositories/types.js';

// ----------------------------------------------------------------- schemas

/** Strict: unknown fields are rejected, so a caller cannot slip in a status or a date. */
const companyInput = completeCompanySchema.extend({ description: businessDetailsSchema.shape.description.default('') }).strict();

export const createApplicationSchema = z.discriminatedUnion('service', [
  z.object({ service: z.literal('company_registration'), company: companyInput }).strict(),
  z.object({ service: z.literal('working_capital_finance'), finance: completeFinanceSchema.strict() }).strict(),
]);
export type CreateApplicationInput = z.output<typeof createApplicationSchema>;

export const patchApplicationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('provide_information'),
      requirementId: z.string().min(1).max(96),
      value: z.string().trim().min(1, 'Enter an answer').max(120, 'Keep the answer under 120 characters'),
    })
    .strict(),
  z.object({ action: z.literal('simulate_next') }).strict(),
]);
export type PatchApplicationInput = z.output<typeof patchApplicationSchema>;

export const listApplicationsQuerySchema = z.object({ filter: z.enum(ACTIVITY_FILTERS).optional() }).strict();

export const APPLICATION_REFERENCE = /^(REG|FIN)-\d{4}-\d{6}$/;

// -------------------------------------------------------------------- views

export interface ApplicationView {
  /** The human-readable reference. This is the identifier clients use. */
  id: string;
  service: WorkflowType;
  title: string;
  subtitle: string;
  status: ApplicationStatus;
  statusLabel: string;
  activityFilter: ActivityFilter;
  progress: ApplicationProgress;
  requirements: Requirement[];
  details: DetailRow[];
  events: WorkflowEvent[];
  nextAction: { text: string; needsAction: boolean };
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  /** Prototype only: the next external step that can be recorded as a simulation. */
  simulation: { available: boolean; nextStep: string | null };
}

const toApp = (record: ApplicationRecord, events: WorkflowEvent[]): Application => ({
  id: record.reference,
  service: record.service,
  title: record.title,
  subtitle: record.subtitle,
  details: record.details,
  events,
});

export function toApplicationView(record: ApplicationRecord, events: WorkflowEvent[], simulationEnabled: boolean): ApplicationView {
  const app = toApp(record, events);
  const status = statusOf(app);
  const step = simulationEnabled ? nextExternalStep(app.service, app.events) : null;
  return {
    id: record.reference,
    service: record.service,
    title: record.title,
    subtitle: record.subtitle,
    status,
    statusLabel: APPLICATION_STATUS_LABELS[status],
    activityFilter: activityFilterFor(status),
    progress: progressOf(app),
    requirements: requirementsOfApp(app),
    details: detailRowsOf(app),
    events,
    nextAction: nextAction(app),
    createdAt: createdAtOf(app) || record.createdAt.toISOString(),
    updatedAt: updatedAtOf(app) || record.createdAt.toISOString(),
    submittedAt: submittedAtOf(app) ?? null,
    simulation: { available: step !== null, nextStep: step?.label ?? null },
  };
}

// ------------------------------------------------------------------ service

export interface ApplicationServiceDeps {
  repos: Repositories;
  config: AppConfig;
  clock: () => Date;
  newId?: () => string;
}

export function createApplicationService({ repos, config, clock, newId = randomUUID }: ApplicationServiceDeps) {
  const eventContext = () => ({ now: clock(), newId });

  async function load(user: User, reference: string): Promise<{ record: ApplicationRecord; app: Application }> {
    // The user id is part of the lookup, so another user's application is simply "not found".
    const record = await repos.applications.findByReference(user.id, reference);
    if (!record) throw new HttpError(404, 'Application not found');
    return { record, app: toApp(record, await repos.events.listByApplication(record.id)) };
  }

  /** Writes the events added since `before`, then refreshes the cached status. */
  async function persist(user: User, record: ApplicationRecord, before: Application, after: Application): Promise<ApplicationView> {
    const fresh = after.events.slice(before.events.length);
    for (const event of fresh) {
      try {
        await repos.events.append({ applicationId: record.id, userId: user.id, event });
      } catch (error) {
        // The database refused a duplicate step, for example two requests at once.
        if (error instanceof DuplicateError) throw new HttpError(409, 'That step was already recorded. Reload and try again.');
        throw error;
      }
    }
    if (fresh.length > 0) {
      await repos.applications.updateCache(user.id, record.id, { status: statusOf(after), lastEventAt: new Date(updatedAtOf(after)) });
    }
    return toApplicationView({ ...record, status: statusOf(after) }, after.events, config.simulationEnabled);
  }

  /** Types of documents the user actually has stored. Only real stored files count as "on record". */
  async function documentsOnRecord(user: User): Promise<Array<{ typeId: string }>> {
    const docs = await repos.documents.listByUser(user.id, 500);
    return docs.map((d) => ({ typeId: d.typeId }));
  }

  function checkCompanyAgainstCatalog(company: z.output<typeof companyInput>): void {
    const jurisdiction = getJurisdiction(company.jurisdictionId);
    if (!jurisdiction || jurisdiction.registrationType !== company.registrationType) {
      throw new HttpError(422, 'That jurisdiction is not available for this registration type', [
        { path: 'company.jurisdictionId', message: 'Choose a jurisdiction that matches the registration type' },
      ]);
    }
    const pkg = getPackage(company.packageId);
    if (!pkg || pkg.jurisdictionId !== company.jurisdictionId) {
      throw new HttpError(422, 'That package is not available for this jurisdiction', [
        { path: 'company.packageId', message: 'Choose a package that belongs to the jurisdiction' },
      ]);
    }
  }

  return {
    async create(user: User, input: CreateApplicationInput): Promise<ApplicationView> {
      const documents = await documentsOnRecord(user);
      const now = clock();
      const buildContext = { now, newId, documents, existingIds: [] as string[] };

      let build: () => Application;
      let businessProfileId: string | undefined;

      if (input.service === 'company_registration') {
        checkCompanyAgainstCatalog(input.company);
        const c = input.company;
        const profile = await repos.businessProfiles.create({
          userId: user.id,
          kind: 'new_company',
          name: c.companyName,
          registrationType: c.registrationType,
          jurisdictionId: c.jurisdictionId,
          packageId: c.packageId,
          activity: c.activity,
          category: c.category,
          description: c.description || undefined,
          shareholders: c.shareholders,
        });
        businessProfileId = profile.id;
        build = () => buildCompanyApplication(c, buildContext);
      } else {
        const company = (await repos.businessProfiles.findPrimaryCompany(user.id))?.name ?? user.name;
        build = () => buildFinanceApplication(input.finance, company, buildContext);
      }

      const service = await repos.services.findByIdOrSlug(input.service);
      let record: ApplicationRecord | undefined;
      let app: Application | undefined;
      for (let attempt = 0; attempt < 5 && !record; attempt += 1) {
        app = build();
        try {
          record = await repos.applications.create({
            userId: user.id,
            reference: app.id,
            service: app.service,
            serviceId: service?.id,
            title: app.title,
            subtitle: app.subtitle,
            details: app.details,
            businessProfileId,
            status: statusOf(app),
            lastEventAt: new Date(updatedAtOf(app)),
          });
        } catch (error) {
          // A reference collision is astronomically unlikely, but the unique index makes it safe to retry.
          if (!(error instanceof DuplicateError)) throw error;
        }
      }
      if (!record || !app) throw new HttpError(503, 'Could not create the application. Please try again.');

      for (const event of app.events) await repos.events.append({ applicationId: record.id, userId: user.id, event });
      return toApplicationView(record, app.events, config.simulationEnabled);
    },

    async list(user: User, filter?: ActivityFilter): Promise<ApplicationView[]> {
      const records = await repos.applications.listByUser(user.id);
      const events = await repos.events.listByApplications(records.map((r) => r.id));
      return records
        .map((record) => toApplicationView(record, events.get(record.id) ?? [], config.simulationEnabled))
        .filter((view) => !filter || view.activityFilter === filter);
    },

    async get(user: User, reference: string): Promise<ApplicationView> {
      const { record, app } = await load(user, reference);
      return toApplicationView(record, app.events, config.simulationEnabled);
    },

    async patch(user: User, reference: string, input: PatchApplicationInput): Promise<ApplicationView> {
      const { record, app } = await load(user, reference);
      // Finish any follow-on steps an earlier request was interrupted before recording.
      const healed = settleApplication(app, eventContext());

      if (input.action === 'simulate_next') {
        if (!config.simulationEnabled) throw new HttpError(403, 'Simulation is not available');
        const outcome = simulateNext(healed, eventContext());
        if (!outcome) throw new HttpError(409, 'There is no step that can be simulated for this application right now');
        return persist(user, record, app, outcome.app);
      }

      const requirement = requirementsOfApp(healed).find((r) => r.id === input.requirementId);
      if (!requirement) throw new HttpError(404, 'Requirement not found');
      if (requirement.kind !== 'information') throw new HttpError(422, 'Documents are provided by uploading a file');
      if (requirement.done) throw new HttpError(409, 'That requirement was already provided');
      return persist(user, record, app, provideRequirement(healed, requirement.id, eventContext(), { actor: 'user', value: input.value }));
    },

    /** Checks, before any file is stored, that a document can satisfy this requirement. */
    async assertDocumentRequirement(user: User, reference: string, requirementId: string, typeId: string): Promise<void> {
      const { app } = await load(user, reference);
      const requirement = requirementsOfApp(app).find((r) => r.id === requirementId);
      if (!requirement) throw new HttpError(404, 'Requirement not found');
      if (requirement.kind !== 'document') throw new HttpError(422, 'That requirement is not a document');
      if (requirement.docTypeId !== typeId) throw new HttpError(422, 'That is not the type of document this requirement needs');
      if (requirement.done) throw new HttpError(409, 'That document was already provided');
    },

    /** Records an uploaded document against a requirement. Only the original file name is kept as detail. */
    async provideDocument(user: User, reference: string, requirementId: string, fileName: string): Promise<ApplicationView> {
      const { record, app } = await load(user, reference);
      const healed = settleApplication(app, eventContext());
      if (!requirementsOfApp(healed).some((r) => r.id === requirementId && !r.done && r.kind === 'document')) {
        throw new HttpError(409, 'That document is not outstanding');
      }
      try {
        return await persist(user, record, app, provideRequirement(healed, requirementId, eventContext(), { actor: 'user', detail: fileName }));
      } catch (error) {
        if (error instanceof WorkflowError) throw new HttpError(409, error.message);
        throw error;
      }
    },

    /** The internal record, for services that need its id (documents). */
    async record(user: User, reference: string): Promise<ApplicationRecord> {
      return (await load(user, reference)).record;
    },
  };
}

export type ApplicationService = ReturnType<typeof createApplicationService>;
