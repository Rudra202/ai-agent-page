export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg'];
export const ACCEPT_ATTRIBUTE = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

export interface UploadCheck {
  ok: boolean;
  error?: string;
}

/**
 * Client-side pre-check so users get instant feedback. The server repeats
 * these checks (and verifies the file signature) in the integration phase.
 */
export function validateUpload(file: { name: string; size: number }): UploadCheck {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    return { ok: false, error: 'Please upload a PDF, PNG or JPG file.' };
  }
  if (file.size === 0) return { ok: false, error: 'That file is empty.' };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: 'Files must be 10 MB or smaller.' };
  return { ok: true };
}
