import { detectedTypeLabel } from '@tajir/shared';
import type { DocumentAiStatus, DocumentProcessingStatus } from '../../api/types';
import { AI_LABEL, AI_TONE, PROCESSING_LABEL, PROCESSING_TONE } from '../../lib/documentStatus';
import { Badge } from '../ui/Badge';

/**
 * Where a document is in being read, in words. "Stored" says the file itself is safe on the server; the next badge says
 * how far reading it has got; the AI badge only appears once that optional step has something to say.
 */
export function DocumentStatusBadges({
  processingStatus,
  aiStatus,
  detectedType,
  showStored = true,
}: {
  processingStatus: DocumentProcessingStatus;
  aiStatus: DocumentAiStatus;
  detectedType: string | null;
  showStored?: boolean;
}) {
  const ai = AI_LABEL[aiStatus];
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {showStored && <Badge tone="success">Stored</Badge>}
      <Badge tone={PROCESSING_TONE[processingStatus]} data-testid="processing-status">
        {PROCESSING_LABEL[processingStatus]}
      </Badge>
      {ai && <Badge tone={AI_TONE[aiStatus]}>{ai}</Badge>}
      {detectedType && (processingStatus === 'completed' || processingStatus === 'partially_completed') && <Badge tone="info">Looks like: {detectedTypeLabel(detectedType)}</Badge>}
    </div>
  );
}
