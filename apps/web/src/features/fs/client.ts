// Minimal filesystem probe for the create-project flow. The full files browser
// is deleted; project creation just needs to classify a target folder
// (empty / has-files / git-repo) so the server can pick the create mode.
// Backed by POST /api/fs/probe (server sibling owns the route).

import { postJson } from '@/api/http';

export interface FolderProbe {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  hasFiles: boolean;
  fileCount: number;
  isGitRepo: boolean;
}

export const fsApi = {
  probeFolder: (path: string) =>
    postJson<{ ok: true; probe: FolderProbe }>('/api/fs/probe', { path }).then(
      (r) => r.probe,
    ),
};
