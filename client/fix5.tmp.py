def patch(p, pairs):
    s = open(p, encoding='utf-8').read()
    for a, b in pairs:
        assert a in s, (p, a[:80])
        s = s.replace(a, b, 1)
    open(p, 'w', encoding='utf-8').write(s)


patch('src/api/types.ts', [
("""export interface UploadFields {
  typeId: string;
  applicationId?: string;
  requirementId?: string;
}""", """export interface UploadFields {
  typeId: string;
  applicationId?: string;
  requirementId?: string;
  /** If the same file is already one of the user's documents, use that one instead of keeping a second copy. */
  reuseExisting?: boolean;
}"""),
("upload(file: File, fields: UploadFields): Promise<{ document: DocumentView; application?: ApplicationView }>;", "upload(file: File, fields: UploadFields): Promise<{ document: DocumentView; application?: ApplicationView; reused?: boolean }>;"),
])
patch('src/api/httpApi.ts', [
("        if (fields.requirementId) form.append('requirementId', fields.requirementId);", "        if (fields.requirementId) form.append('requirementId', fields.requirementId);\n        if (fields.reuseExisting) form.append('reuseExisting', 'true');"),
("return http.request<{ document: DocumentView; application?: ApplicationView }>('POST', '/api/documents/upload', form);", "return http.request<{ document: DocumentView; application?: ApplicationView; reused?: boolean }>('POST', '/api/documents/upload', form);"),
])
patch('src/state/context.ts', [(
"  /** Removes a document, its file and what was read from it. */",
"  /** Attaches a document that is already in the Documents section to the chat. Nothing is uploaded again. */\n  attachExisting: (documentId: string) => Promise<ActionResult>;\n  /** Removes a document, its file and what was read from it. */")])
patch('src/state/AppStore.tsx', [
("    async (file, fields: { typeId: string; applicationId?: string; requirementId?: string }) => {", "    async (file, fields: { typeId: string; applicationId?: string; requirementId?: string; reuseExisting?: boolean }) => {"),
("        documentId = await upload(file, { typeId: 'other' });", "        // If the same file is already one of the user's documents, that one is used and no second copy is kept.\n        documentId = await upload(file, { typeId: 'other', reuseExisting: true });"),
("""  const removeDocument = useCallback<AppApi['removeDocument']>(""", """  const attachExisting = useCallback<AppApi['attachExisting']>(
    async (documentId) => {
      const doc = stateRef.current.documents.find((d) => d.id === documentId);
      if (!doc) return { ok: false, error: 'That document is no longer in your Documents.' };
      const display = `Attached ${doc.name}`.slice(0, 120);
      const outcome = await runTurn({ action: { type: 'document_uploaded', documentId }, display }, display);
      return outcome.error ? { ok: false, error: outcome.error } : { ok: true };
    },
    [runTurn],
  );

  const removeDocument = useCallback<AppApi['removeDocument']>("""),
("      attachInChat,\n      removeDocument,", "      attachInChat,\n      attachExisting,\n      removeDocument,"),
("attachInChat, removeDocument, reprocessDocument, updateCompany,", "attachInChat, attachExisting, removeDocument, reprocessDocument, updateCompany,"),
])
print('ok')
