// @raidenyn/mcp-runtime — generic, product-agnostic MCP-over-HTTP hosting layer.
// Depends on Express directly and the MCP SDK as a peer; imports no LINE or
// product-specific package.

export { normalizeBasePath } from './base-path';
export {
  createMcpHost,
  type Principal,
  type AuthProvider,
  type RequestContext,
  type Registration,
  type HostServer,
  type HostTransport,
  type McpHost,
  type McpHostOptions,
} from './host';
export {
  createTokenCodec,
  type TokenCodec,
  type TokenCodecConfig,
  type TokenClaims,
  type TokenKind,
  type IssueOptions,
  type VerifyOptions,
} from './token-codec';
