/**
 * Saves a file the server sent. The bytes are held only while the browser writes them to the user's disk.
 * The file name is set here as a display name for the download; the server never trusts it for anything.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Not revoked at once: some browsers need a moment to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
