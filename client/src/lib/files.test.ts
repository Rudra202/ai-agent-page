import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, validateUpload } from './files';

describe('validateUpload', () => {
  it('accepts PDF, PNG and JPG files, whatever the case', () => {
    expect(validateUpload({ name: 'statement.pdf', size: 1000 }).ok).toBe(true);
    expect(validateUpload({ name: 'ID.PNG', size: 1000 }).ok).toBe(true);
    expect(validateUpload({ name: 'photo.jpeg', size: 1000 }).ok).toBe(true);
  });

  it('rejects other types, including a double extension', () => {
    expect(validateUpload({ name: 'run.exe', size: 1000 })).toEqual({ ok: false, error: 'Please upload a PDF, PNG or JPG file.' });
    expect(validateUpload({ name: 'statement.pdf.exe', size: 1000 }).ok).toBe(false);
    expect(validateUpload({ name: 'noextension', size: 1000 }).ok).toBe(false);
  });

  it('rejects empty and oversized files', () => {
    expect(validateUpload({ name: 'a.pdf', size: 0 }).error).toContain('empty');
    expect(validateUpload({ name: 'a.pdf', size: MAX_UPLOAD_BYTES + 1 }).error).toContain('10 MB');
    expect(validateUpload({ name: 'a.pdf', size: MAX_UPLOAD_BYTES }).ok).toBe(true);
  });
});
