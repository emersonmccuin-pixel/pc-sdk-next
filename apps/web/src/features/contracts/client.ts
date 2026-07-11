// Contract HTTP client — read-side only (list + detail). The route shapes are
// declared in @pc/contracts contractRoutes; mutations stay pc_* tool doors.

import { getJson } from '@/api/http';
import { contractRoutes, type Contract, type ULID } from '@pc/contracts';

export const contractsApi = {
  listContracts: (projectId: ULID) =>
    getJson<{ contracts: Contract[] }>(contractRoutes.forProject(projectId)).then(
      (r) => r.contracts,
    ),

  getContract: (contractId: ULID) =>
    getJson<{ contract: Contract }>(contractRoutes.detail(contractId)).then((r) => r.contract),
};
