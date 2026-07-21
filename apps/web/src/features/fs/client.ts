// Minimal filesystem probe + browse for the create-project flow. The full
// files browser is deleted; project creation just needs to classify a target
// folder (empty / has-files / git-repo) and let the user browse subfolders to
// pick one. Backed by POST /api/fs/probe and POST /api/fs/list (server
// sibling owns the routes).

import { postJson } from '@/api/http';

export interface FolderProbe {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  hasFiles: boolean;
  fileCount: number;
  isGitRepo: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export const fsApi = {
  probeFolder: (path: string) =>
    postJson<{ ok: true; probe: FolderProbe }>('/api/fs/probe', { path }).then(
      (r) => r.probe,
    ),
  listDir: (path?: string) =>
    postJson<{ ok: true; listing: DirListing }>('/api/fs/list', { path: path ?? '' }).then(
      (r) => r.listing,
    ),
};
