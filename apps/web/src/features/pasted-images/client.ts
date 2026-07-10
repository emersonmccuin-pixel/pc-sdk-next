// Attachments never ride the WS wire: images POST to the server, the returned
// path is spliced into the composer text, and the agent reads the file.

export type UploadResult = { ok: true; path: string } | { ok: false; error: string };

export async function uploadPastedImage(projectId: string, blob: Blob): Promise<UploadResult> {
  try {
    const form = new FormData();
    form.append('image', blob, 'pasted.png');
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/pasted-images`, {
      method: 'POST',
      body: form,
    });
    const data = (await res.json()) as { ok?: boolean; path?: string; error?: string };
    if (!res.ok || data.ok === false || !data.path) {
      return { ok: false, error: data.error ?? `upload → ${res.status}` };
    }
    return { ok: true, path: data.path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
