import type { AuthData, StorageKeyMaterial } from '@raidenyn/line-client';

export const MOCK_ACCOUNT_MID = 'u_mock_account_0001';
export const MOCK_GROUP_MID = 'c_mock_bank_group_0001';
export const MOCK_DIRECT_MID = 'u_mock_alice_0001';
export const MOCK_BANK_SENDER_MID = 'u_mock_bank_sender_0001';
export const MOCK_PIN = '592130';
export const MOCK_CERTIFICATE = 'mock-certificate-v1';

export const VALID_STORAGE_KEY: Readonly<StorageKeyMaterial> = {
  mid: MOCK_ACCOUNT_MID,
  wrappedNonce: 'AjsSI8WwGhQoymf7fzeYgp4ecqDpl9htub88/l+416eGYZ0AkRAyICML306xrIBT',
  kdfParameter1: 'W5kowvH9dJNVemz7XD2dww==',
  kdfParameter2: '+ZFNyJlBAnn2W5e9m/ALYA==',
};

export const JPEG_BYTES = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==', 'base64');
export const EXPORT_FILE_TEXT = [
  'Chat history with Mock Bank Group',
  '',
  'Fri, 7/17/2026',
  '09:00\tAlice Mock\tImported deterministic message',
].join('\n');

export interface MockRawMessage {
  id: string;
  from: string;
  to: string;
  toType: number;
  createdTime: string;
  deliveredTime: string;
  contentType: number;
  text?: string;
  hasContent: boolean;
  contentMetadata?: Record<string, string>;
}

export interface MockFixtures {
  seededAuth: AuthData;
  tokenFixtures: {
    rotatedAccessToken: string;
    rotatedRefreshToken: string;
  };
  messagesByChat: Record<string, MockRawMessage[]>;
  image: { previewUrl: string; downloadUrl: string; bytes: Buffer; mimeType: 'image/jpeg' };
  expected: {
    listChatsText: string;
    recentMessagesText: string;
    importResult: Record<string, unknown>;
    transactions: readonly Record<string, unknown>[];
    filteredDebit: readonly Record<string, unknown>[];
    summaryByMonth: Readonly<Record<string, unknown>>;
    summaryByCategory: Readonly<Record<string, unknown>>;
  };
}

function rawMessage(input: {
  id: string;
  from: string;
  to: string;
  createdTime: string;
  text?: string;
  contentType?: number;
  hasContent?: boolean;
  contentMetadata?: Record<string, string>;
}): MockRawMessage {
  return {
    id: input.id,
    from: input.from,
    to: input.to,
    toType: input.to === MOCK_GROUP_MID ? 2 : 0,
    createdTime: input.createdTime,
    deliveredTime: input.createdTime,
    contentType: input.contentType ?? 0,
    text: input.text,
    hasContent: input.hasContent ?? false,
    contentMetadata: input.contentMetadata,
  };
}

export function makeMockLineJwt(id: string, iat: number, exp: number): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    jti: id, aud: 'LINE', iat, exp, scp: 'LINE_CORE', rtid: `refresh-${id}`,
    rexp: iat + 31_536_000, ver: '3.1', aid: MOCK_ACCOUNT_MID,
    lsid: `session-${id}`, did: 'NONE', ctype: 'CHROMEOS',
    cmode: 'SECONDARY', cid: '0300000000',
  })).toString('base64url');
  return `${header}.${payload}.mock-signature`;
}

export function buildMockFixtures(input: { origin: string; epochSeconds: number }): MockFixtures {
  const { origin, epochSeconds } = input;

  const seededAccessId = 'seeded-access';
  const seededRefreshId = 'seeded-refresh';
  const seededAuth: AuthData = {
    accessToken: makeMockLineJwt(seededAccessId, epochSeconds - 60, epochSeconds + 3600),
    refreshToken: makeMockLineJwt(seededRefreshId, epochSeconds - 60, epochSeconds + 31_536_000),
    certificate: MOCK_CERTIFICATE,
    mid: MOCK_ACCOUNT_MID,
    wrappedNonce: VALID_STORAGE_KEY.wrappedNonce,
    kdfParameter1: VALID_STORAGE_KEY.kdfParameter1,
    kdfParameter2: VALID_STORAGE_KEY.kdfParameter2,
  };

  const rotatedAccessId = 'rotated-access';
  const rotatedRefreshId = 'rotated-refresh';
  const tokenFixtures = {
    rotatedAccessToken: makeMockLineJwt(rotatedAccessId, epochSeconds + 1, epochSeconds + 86400 + 7200),
    rotatedRefreshToken: makeMockLineJwt(rotatedRefreshId, epochSeconds + 1, epochSeconds + 31_536_000),
  };

  const groupMessages = Array.from({ length: 202 }, (_, index) => rawMessage({
    id: `group-history-${String(index).padStart(3, '0')}`,
    from: MOCK_DIRECT_MID,
    to: MOCK_GROUP_MID,
    createdTime: String(Date.UTC(2026, 6, 14, 0, index)),
    text: `Deterministic history message ${index}`,
  }));

  groupMessages.push(
    rawMessage({
      id: 'group-debit', from: MOCK_BANK_SENDER_MID, to: MOCK_GROUP_MID,
      createdTime: String(Date.UTC(2026, 6, 17, 2, 0)),
      text: 'MOCK TX -125.50 THB at Mock Cafe | 2026-07-17T02:00:00.000Z | acct 1234 | bal 1000.00',
    }),
    rawMessage({
      id: 'group-credit', from: MOCK_BANK_SENDER_MID, to: MOCK_GROUP_MID,
      createdTime: String(Date.UTC(2026, 6, 17, 3, 0)),
      text: 'MOCK TX +500.00 THB at Mock Employer | 2026-07-17T03:00:00.000Z | acct 1234 | bal 1500.00',
    }),
    rawMessage({
      id: 'group-image', from: MOCK_DIRECT_MID, to: MOCK_GROUP_MID,
      createdTime: String(Date.UTC(2026, 6, 17, 4, 0)), contentType: 1, hasContent: true,
      contentMetadata: {
        PREVIEW_URL: `${origin}/fixtures/images/message-preview.jpg`,
        DOWNLOAD_URL: `${origin}/fixtures/images/message-full.jpg`,
      },
    }),
  );

  const directMessages = [
    rawMessage({
      id: 'direct-001', from: MOCK_DIRECT_MID, to: MOCK_ACCOUNT_MID,
      createdTime: String(Date.UTC(2026, 6, 17, 1, 0)),
      text: 'Direct message from Alice',
    }),
  ];

  const messagesByChat: Record<string, MockRawMessage[]> = {
    [MOCK_GROUP_MID]: groupMessages,
    [MOCK_DIRECT_MID]: directMessages,
  };

  const image = {
    previewUrl: `${origin}/fixtures/images/message-preview.jpg`,
    downloadUrl: `${origin}/fixtures/images/message-full.jpg`,
    bytes: JPEG_BYTES,
    mimeType: 'image/jpeg' as const,
  };

  const listChatsText = [
    '[GROUP] Mock Bank Group (2 members)',
    `  mid: ${MOCK_GROUP_MID}`,
    `  pictureUrl: https://profile.line-scdn.net/mock-group-picture.png/preview`,
    '[USER] Alice Mock',
    `  mid: ${MOCK_DIRECT_MID}`,
  ].join('\n');

  const recentMessagesText = groupMessages.slice(-5).map((m) => {
    const createdMs = parseInt(m.createdTime, 10);
    const time = Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : 'unknown';
    const sender = m.from === MOCK_BANK_SENDER_MID ? 'Mock Bank'
      : m.from === MOCK_DIRECT_MID ? 'Alice Mock'
      : m.from;
    if (m.contentType === 1) {
      const preview = m.contentMetadata?.['PREVIEW_URL'] ?? '';
      return `[${time}] ${sender}: [image] (preview: ${preview})`;
    }
    return `[${time}] ${sender}: ${m.text}`;
  }).join('\n');

  const importResult = {
    status: 'success',
    parsed: 1,
    imported: 1,
    chat_mid: MOCK_GROUP_MID,
    chat_name: 'Mock Bank Group',
    date_range: { from: '2026-07-17T09:00:00.000Z', to: '2026-07-17T09:00:00.000Z' },
  };

  const transactions = [
    {
      id: 'group-debit',
      date: '2026-07-17T02:00:00.000Z',
      original_amount: -125.5,
      original_currency: 'THB',
      rawText: 'MOCK TX -125.50 THB at Mock Cafe | 2026-07-17T02:00:00.000Z | acct 1234 | bal 1000.00',
      merchant: 'Mock Cafe',
      account: '1234',
      balance: 1000,
      amount: -125.5,
      currency: 'THB',
      category: 'Smoke Banking',
    },
    {
      id: 'group-credit',
      date: '2026-07-17T03:00:00.000Z',
      original_amount: 500,
      original_currency: 'THB',
      rawText: 'MOCK TX +500.00 THB at Mock Employer | 2026-07-17T03:00:00.000Z | acct 1234 | bal 1500.00',
      merchant: 'Mock Employer',
      account: '1234',
      balance: 1500,
      amount: 500,
      currency: 'THB',
      category: 'Smoke Banking',
    },
  ];

  const filteredDebit = [transactions[0]];

  const summaryByMonth = {
    total_debit: 125.5,
    total_credit: 500,
    net: 374.5,
    by_group: { '2026-07': { debit: 125.5, credit: 500, count: 2 } },
    currency: 'THB',
    transactions_count: 2,
    unknown_currency: {
      total_debit: 0,
      total_credit: 0,
      net: 0,
      transactions_count: 0,
    },
    unknown_by_group: {},
  };

  const summaryByCategory = {
    total_debit: 125.5,
    total_credit: 500,
    net: 374.5,
    by_group: { 'Smoke Banking': { debit: 125.5, credit: 500, count: 2 } },
    currency: 'THB',
    transactions_count: 2,
    unknown_currency: {
      total_debit: 0,
      total_credit: 0,
      net: 0,
      transactions_count: 0,
    },
    unknown_by_group: {},
  };

  return {
    seededAuth,
    tokenFixtures,
    messagesByChat,
    image,
    expected: {
      listChatsText,
      recentMessagesText,
      importResult,
      transactions,
      filteredDebit,
      summaryByMonth,
      summaryByCategory,
    },
  };
}
