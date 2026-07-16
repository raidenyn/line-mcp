import type { LinePrincipal } from '../auth/line-auth-provider';
import type { RequestLineClient } from '../request-client';
import type { ImportService } from '../import-service';

export interface LineToolDeps {
  createRequestClient(principal: LinePrincipal): Promise<RequestLineClient>;
  importService: ImportService;
}

export const CONTENT_TYPE_LABELS: Record<number, string> = {
  0: 'text',
  1: 'image',
  2: 'video',
  3: 'audio',
  7: 'sticker',
  13: 'location',
  22: 'flex',
};
