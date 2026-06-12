# LINE Chrome Extension — API Specification (v3.7.2)

> **Source:** This specification is derived from four sources combined:
> - A live HAR capture (`ophjlpahpchlmihnnnihgmmeilfjmjjc.har`) from the LINE Chrome extension v3.7.2 recorded on 2026-06-11, containing 135 real HTTP entries including a full QR login flow, chat listing, and message retrieval.
> - `main.js` — the Chrome extension's bundled JavaScript (6.7 MB, 138k lines), analyzed for the request-signing (`x-hmac`) mechanism and SSE authentication.
> - `ltsmSandbox.js` (`specs/raw/ltsm/ltsmSandbox.js`) — the HMAC signing sandbox source, analyzed to confirm the exact signing algorithm, static tokens, and `storage_key_init` behavior.
> - `LINE_Login_Protocol_Specification.md` — prior reverse-engineering notes for context on E2EE and Thrift legacy flows.
>
> HAR entries and sandbox source override any conflicting information from prior reverse-engineering. All endpoints, headers, and body shapes below are confirmed from live traffic or sandbox source unless explicitly marked [unverified].

---

## 1. Transport & Protocol

### 1.1 Base URL

```
https://line-chrome-gw.line-apps.com
```

All API calls go to this gateway. The older `ga2.line.naver.jp` / `gf.line.naver.jp` gateways are **not used** by the Chrome extension.

### 1.2 Protocol

The Chrome extension uses **JSON over HTTPS**, not Thrift binary. Despite `/thrift/` appearing in URL paths (a naming artifact), every request body is `application/json` and every response is a JSON envelope:

```json
{"code": 0, "message": "OK", "data": <result>}
```

Non-zero `code` values indicate errors.

### 1.3 URL Structure

```
POST /api/talk/thrift/<Namespace>/<ServiceName>/<MethodName>
```

Examples:
- `/api/talk/thrift/Talk/TalkService/getProfile`
- `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession`
- `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified`

### 1.4 Request Body Convention

The body is a **JSON array of positional arguments** mirroring the Thrift method signature:

```json
[arg1, arg2, ...]
```

No-argument methods send either `[]` or `[{}]`. Some methods pass a trailing integer (likely a Thrift sequence number or API version tag; value `1` or `2` observed).

---

## 2. HTTP Headers

### 2.1 Headers Present on Every Request (Pre- and Post-Auth)

These headers must be sent on all requests, including unauthenticated login steps:

```
:authority:              line-chrome-gw.line-apps.com
:method:                 POST
:scheme:                 https
accept:                  application/json, text/plain, */*
accept-encoding:         gzip, deflate, br, zstd
accept-language:         en-US
content-type:            application/json
origin:                  chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc
priority:                u=1, i
sec-ch-ua:               "Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"
sec-ch-ua-mobile:        ?0
sec-ch-ua-platform:      "Windows"
sec-fetch-dest:          empty
sec-fetch-mode:          cors
sec-fetch-site:          none
sec-fetch-storage-access: active
user-agent:              Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36
x-hmac:                  <base64 HMAC signature — see §2.3>
x-lal:                   en_US
x-line-chrome-version:   3.7.2
```

### 2.2 Additional Headers After Authentication

Once `accessToken` has been obtained, add:

```
x-line-access: <JWT accessToken>
```

Example JWT (from HAR):
```
eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJlODk5MjcxYS04OTM3
LTQ3ZjMtOTczYS05MmRlZTNmNGY2YjMiLCJhdWQiOiJMSU5FIiwiaWF0IjoxNzgxMTg4
NTU0LCJleHAiOjE3ODE3OTMzNTQsInNjcCI6IkxJTkVfQ09SRSIsInJ0aWQiOiI3NzY1
ZjU3OS0yMjk1LTQ0MDYtYTgzYS00N2E1YTc5ODY2MzQiLCJyZXhwIjoxODEyNzI0NTU0
LCJ2ZXIiOiIzLjEiLCJhaWQiOiJ1YTdmNGE5MjYxNTBiY2JiNjY5YjAwZjA2ZWJjYmU0
MjAiLCJsc2lkIjoiMGMxN2M3ZjEtNTBlNS00ODE5LTkzMmYtOGU4NmM1MGViNGFmIiwi
ZGlkIjoiTk9ORSIsImN0eXBlIjoiQ0hST01FT1MiLCJjbW9kZSI6IlNFQ09OREFSWSIs
ImNpZCI6IjAzMDAwMDAwMDAifQ.VeqIYiN9fCCDhTrax7e-sPkKIzVdlPZ5MdJmZVWIclw
```

Decoded JWT payload:
```json
{
  "jti": "e899271a-8937-47f3-973a-92dee3f4f6b3",
  "aud": "LINE",
  "iat": 1781188554,
  "exp": 1781793354,
  "scp": "LINE_CORE",
  "rtid": "7765f579-2295-4406-a83a-47a5a7986634",
  "rexp": 1812724554,
  "ver": "3.1",
  "aid": "ua7f4a926150bcbb669b00f06ebcbe420",
  "lsid": "0c17c7f1-50e5-4819-932f-8e86c50eb4af",
  "did": "NONE",
  "ctype": "CHROMEOS",
  "cmode": "SECONDARY",
  "cid": "0300000000"
}
```

Token lifetime: ~7 days (`exp - iat`). Refresh token lifetime: ~1 year (`rexp`).

### 2.3 x-hmac Signing

Every POST request to the gateway includes an `x-hmac` header containing a base64-encoded signature:

```
x-hmac: xc7hTRfwaauLuMpoXQRt2DDZE+nu+8e4auOw1F/UQZo=
```

#### Algorithm (confirmed from `ltsmSandbox.js` source)

The signature is **HMAC-SHA256** (32-byte output, base64-encoded). It is computed by the `ltsmSandbox.js` script running inside a sandboxed iframe, using the Web Crypto API. The algorithm was confirmed by reading the sandbox source (`specs/raw/ltsm/ltsmSandbox.js`):

**Helper:**
```javascript
tm(x) = SHA-256(x)   // window.crypto.subtle.digest("SHA-256", encode(x))
```

**Key derivation (performed once during `init`):**
```javascript
cS = SecureKey.loadToken(staticToken)   // static token looked up by window.origin
lS = tm("3.7.2")                        // derived from the extension version string
```

Where `staticToken` is a hardcoded string per extension origin:

| Origin | Static Token |
|---|---|
| `chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc` | `wODdrvWqmdP4Zliay-iF3cz3KZcK0ekrial868apg06TXeCo7A1hIQO0ESElHg6D` |
| `chrome-extension://jeafcjlknhfnfkfeliiolabnpjahldie` | `GS-30Ed0WxiXR50y9hED4O1qmJ2QaBK0dFpc_w9ZaBSisb2rlnKvPUkMK_93GS30` |

**Per-request signing (performed for every `get_hmac` command):**
```javascript
key  = cS.deriveKey(lS, tm(accessToken))  // accessToken = "" for pre-auth requests
hmac = base64( Hmac(key).digest(path + body) )  // path and body concatenated directly, no separator
```

The message signed is `path + body` — the URL path string concatenated with the JSON body string, with no delimiter between them.

**Inputs passed to the sandbox for each request:**
```javascript
{
  accessToken: string,   // JWT accessToken, or "" before login completes
  path: string,          // request URL path, e.g. "/api/talk/thrift/Talk/TalkService/getProfile"
  body: string           // JSON.stringify(requestBody)
}
```

**`storage_key_init` does NOT affect HMAC signing.** The `storage_key_init` sandbox command (called after login with `wrappedNonce`, `kdfParameter1`, `kdfParameter2` from `getEncryptedIdentityV3`) sets an **AES storage encryption key** (`hS`) used only by the `encrypt`/`decrypt` sandbox commands. The HMAC signing key is set once during `init` from the static token above and never changes. The spec's earlier implied connection between `storage_key_init` and HMAC key derivation is incorrect.

**IMPORTANT — Concurrent signing:** The sandbox `responseHandlers` map uses fixed string keys (`'response'` / `'error'`). Concurrent `get_hmac` calls will overwrite each other's handlers, causing one request to receive the wrong HMAC. The server returns `REQUEST_INVALID_HMAC` (error code 10005) in this case. All sandbox `sendCommand` calls must be serialized (e.g. via a promise queue).

#### Observed Example Values (HAR)

| Endpoint | accessToken | Body | x-hmac |
|---|---|---|---|
| `createSession` | `""` | `[{}]` | `xc7hTRfwaauLuMpoXQRt2DDZE+nu+8e4auOw1F/UQZo=` |
| `createQrCode` | `""` | `[{"authSessionId":"SQ..."}]` | `uXPAdcyQptjp9TzA7yVzUiDxZX1ARAFur4HEylLIW74=` |
| `getLastOpRevision` | `<JWT>` | `[]` | `hOllK+6E5Lsf/QQVkbr53IxhDOkSqFtM/3NIUOkPCK4=` |
| `getAllChatMids` | `<JWT>` | `[{"withMemberChats":true,...},2]` | `Ztx+06U5BioHU/9+rzDzRQ1wOYq/xJQcz+29OuviExY=` |

### 2.4 Long-Poll Headers

For blocking/long-poll endpoints, add:

```
x-lst:             150000       (timeout in milliseconds)
x-line-session-id: <authSessionId>
```

---

## 3. QR Code Login Flow

The Chrome extension registers as a **secondary device** by scanning a QR code with the LINE mobile app. This is the only observed login method in the HAR.

### 3.1 High-Level Flow

```
Chrome Extension                         LINE Server              Mobile App
       |                                      |                        |
       |-- createSession() ----------------> |                        |
       |<- {authSessionId} --------------- - |                        |
       |                                      |                        |
       |-- createQrCode(authSessionId) ----> |                        |
       |<- {callbackUrl, longPollingInterval} |                        |
       |                                      |                        |
       | [generate Curve25519 keypair]        |                        |
       | [qrUrl = callbackUrl + ?secret=...]  |                        |
       | [display QR code]                    |                        |
       |                                      |                        |
       |-- checkQrCodeVerified (long-poll) -> |  <-- user scans QR -- |
       |<- {} (empty data = success) ------- |                        |
       |   [HTTP 400/410 also means confirmed]|                        |
       |                                      |                        |
       |-- verifyCertificate(sessionId,cert)->|  [MANDATORY step —    |
       |<- {} (cert accepted = skip PIN) --- |   even with empty cert]|
       |   OR code 2 (cert rejected)          |                        |
       |                                      |                        |
       |  [if cert accepted:]                 |                        |
       |-- qrCodeLoginV2(...) ------------> |                        |
       |                                      |                        |
       |  [if cert rejected — PIN flow:]      |                        |
       |-- createPinCode(authSessionId) ----> |                        |
       |<- {pinCode: "123456"} ------------- |                        |
       | [display PIN to user]                |                        |
       |                                      | <-- user enters PIN -- |
       |-- checkPinCodeVerified (long-poll) ->|                        |
       |<- {} (success) ------------------- |                        |
       |-- qrCodeLoginV2(...) ------------> |                        |
       |                                      |                        |
       |<- {accessToken, refreshToken,        |                        |
       |    certificate, mid, metaData} ---- |                        |
```

### 3.2 Step 1 — Create Session

**Request:**
```
POST https://line-chrome-gw.line-apps.com/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession
Content-Type: application/json
[standard headers — see §2.1]
x-hmac: <signature>

[{}]
```

**Response:**
```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "authSessionId": "SQ4d46594f773853546e4852586a4d6b6e3376456d55355a4d4152545453356d4f"
  }
}
```

Save `authSessionId` for all subsequent login steps.

### 3.3 Step 2 — Create QR Code URL

**Request:**
```
POST https://line-chrome-gw.line-apps.com/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode
Content-Type: application/json
[standard headers]
x-hmac: <signature>

[{"authSessionId": "SQ4d46594f7..."}]
```

**Response:**
```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "callbackUrl": "https://line.me/R/au/lgn/sq/SQ4d46594f773853546e4852586a4d6b6e3376456d55355a4d4152545453356d4f",
    "longPollingMaxCount": 2,
    "longPollingIntervalSec": 150
  }
}
```

### 3.4 Step 3 — Build QR URL with E2EE Secret

Generate a Curve25519 keypair:

```python
secret    = os.urandom(32)                        # private key (32 bytes)
secretPK  = Curve25519.generatePublicKey(secret)  # public key
secretUrl = "?secret=" + base64url_encode(secretPK)
qrUrl     = callbackUrl + secretUrl
```

Render `qrUrl` as a QR code image and display it to the user.

### 3.5 Step 4 — Long-Poll for QR Scan

**Request:**
```
POST https://line-chrome-gw.line-apps.com/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified
Content-Type: application/json
[standard headers]
x-hmac: <signature>
x-lst: 150000
x-line-session-id: SQ4d46594f7...

[{"authSessionId": "SQ4d46594f7..."}]
```

Blocks until the user scans the QR with their mobile app. Retry up to `longPollingMaxCount` times.

**Response on success:**
```json
{"code": 0, "message": "OK", "data": {}}
```

**HTTP 400 or 410 responses** from this endpoint can mean the session was already confirmed by the mobile app before the poll registered (race condition). Treat HTTP 400/410 as "proceed to `verifyCertificate`" rather than a fatal error. Do not throw on these status codes.

### 3.6 Step 5 — Verify Certificate (MANDATORY state machine step)

This call is **always required** after `checkQrCodeVerified`, even if no certificate is available. It is a mandatory server-side state machine transition. Skipping it causes `createPinCode` to return `SecondaryQrCodeException` code 100 ("Your QR code has expired") even though the session is still valid.

**Request:**
```
POST https://line-chrome-gw.line-apps.com/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate
Content-Type: application/json
[standard headers]
x-hmac: <signature>

[{"authSessionId": "SQ4d46594f7...", "certificate": "3df83f30788c3ad01c4b5876eeb95fa3c3b67ec84fb9967d97ecce39f31728e0"}]
```

When no saved certificate exists, send `"certificate": ""` (empty string).

**Response — certificate accepted (skip PIN):**
```json
{"code": 0, "message": "OK", "data": {}}
```

**Response — certificate rejected (proceed to PIN):**
```json
{
  "code": 10051,
  "data": {"code": 2, "alertMessage": "The verification code you entered is incorrect."}
}
```

Error code meanings for `SecondaryQrCodeException` (LINE API code 10051):

| `data.code` | Meaning |
|---|---|
| `2` | Certificate rejected — expected when sending empty or stale certificate. Proceed to PIN flow. |
| `100` | Session expired / wrong state — occurs when `verifyCertificate` was not called before `createPinCode`. Start over. |

**Decision logic:** If `verifyCertificate` returns 200, skip PIN and proceed to `qrCodeLoginV2`. If it returns an error with `data.code === 2`, proceed to PIN flow (§3.7). Any other error code indicates the session is invalid; restart from `createSession`.

### 3.7 Step 5b — PIN Flow (required when certificate not accepted)

The PIN flow is required on first login (no saved certificate) or when the saved certificate is rejected. The server generates a 6-digit PIN that the user must enter in the LINE mobile app.

**Step 5b-1 — Generate PIN:**

```
POST https://line-chrome-gw.line-apps.com/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode
Content-Type: application/json
[standard headers]
x-hmac: <signature>

[{"authSessionId": "SQ4d46594f7..."}]
```

**Response:**
```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "pinCode": "592130"
  }
}
```

Display the `pinCode` to the user. The user must open the LINE mobile app and enter this PIN in the QR login confirmation screen.

**Step 5b-2 — Wait for PIN confirmation:**

```
POST https://line-chrome-gw.line-apps.com/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified
Content-Type: application/json
[standard headers]
x-hmac: <signature>
x-lst: 150000
x-line-session-id: SQ4d46594f7...

[{"authSessionId": "SQ4d46594f7..."}]
```

Blocks until the user enters the PIN on mobile. Same long-poll headers as `checkQrCodeVerified`. Returns `{"code": 0, "message": "OK", "data": {}}` on success.

### 3.8 Step 6 — Complete QR Login

**Request:**
```
POST https://line-chrome-gw.line-apps.com/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2
Content-Type: application/json
[standard headers]
x-hmac: <signature>

[{
  "systemName": "CHROMEOS",
  "modelName": "CHROME",
  "autoLoginIsRequired": false,
  "authSessionId": "SQ4d46594f7..."
}]
```

**Response:**
```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "certificate": "3df83f30788c3ad01c4b5876eeb95fa3c3b67ec84fb9967d97ecce39f31728e0",
    "tokenV3IssueResult": {
      "accessToken": "<JWT>",
      "refreshToken": "<opaque long string>",
      "durationUntilRefreshInSec": "391466",
      "refreshApiRetryPolicy": {
        "initialDelayInMillis": "200",
        "maxDelayInMillis": "104857600",
        "multiplier": 2,
        "jitterRate": 0.3
      },
      "loginSessionId": "0c17c7f1-50e5-4819-932f-8e86c50eb4af",
      "tokenIssueTimeEpochSec": "1781188554"
    },
    "mid": "UeaqlOg_Nfz_dvBikxijYQK8rPZlNcBTKMKQo7fF5DWs",
    "lastBindTimestamp": "0",
    "metaData": {
      "keyId": "5384376",
      "errorCode": "SUCCESS",
      "encryptedKeyChain": "<base64 AES-CBC encrypted key chain>"
    }
  }
}
```

---

## 4. Token Storage & Refresh

| Token | Source Field | Where to Persist | Used As |
|---|---|---|---|
| `accessToken` | `data.tokenV3IssueResult.accessToken` | Memory + optional cache | `x-line-access` header on every authenticated request |
| `refreshToken` | `data.tokenV3IssueResult.refreshToken` | Persistent storage | Renew `accessToken` before `exp` |
| `certificate` | `data.certificate` | Persistent storage (e.g. `.sqr.crt`) | Pass to `verifyCertificate` on next login to skip PIN |
| `mid` | `data.mid` | Memory | User's own MID (used in message sender/recipient fields) |
| `durationUntilRefreshInSec` | `data.tokenV3IssueResult.durationUntilRefreshInSec` | Reference only | Schedule refresh ~`durationUntilRefreshInSec` seconds after `tokenIssueTimeEpochSec` |

---

### 4.1 Token Refresh

The `accessToken` JWT expires at `exp` (typically ~7 days from issue). Refresh before expiry using the `refreshToken`:

```
POST /api/auth/tokenRefresh
Content-Type: application/json
[standard headers, NO x-line-access]

{"refreshToken": "<refreshToken>"}
```

The `durationUntilRefreshInSec` field in the `qrCodeLoginV2` response tells you when to schedule the refresh: `tokenIssueTimeEpochSec + durationUntilRefreshInSec`. The refresh retry policy:
```json
{
  "initialDelayInMillis": "200",
  "maxDelayInMillis": "104857600",
  "multiplier": 2,
  "jitterRate": 0.3
}
```

Use exponential backoff with jitter if the refresh fails.

---

## 5. Post-Login Bootstrap Sequence

After obtaining `accessToken`, the Chrome extension performs these calls in order:

### 5.1 Get User Profile

```
POST /api/talk/thrift/Talk/TalkService/getProfile
x-line-access: <accessToken>

[2]
```

Response `data` fields:
```json
{
  "mid": "UeaqlOg_Nfz_dvBikxijYQK8rPZlNcBTKMKQo7fF5DWs",
  "userid": "ynagaev",
  "regionCode": "TH",
  "phone": "<encrypted>",
  "displayName": "ynagaev",
  "pictureStatus": "0hvebU20RW...",
  "statusMessage": ""
}
```

### 5.2 Get Encrypted Identity (Required for Storage Key Init)

This call is mandatory after login — its response is used to initialize the **storage encryption key** in the sandbox, which enables the `encrypt`/`decrypt` sandbox commands.

**Note:** This does NOT initialize or change the HMAC signing key. The HMAC key is set during `init` from the static token (see §2.3) and never changes.

```
POST /api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3
x-line-access: <accessToken>

[]
```

Response:
```json
{
  "code": 0, "message": "OK",
  "data": {
    "wrappedNonce":  "AjsSI8WwGhQoymf7fzeYgp4ecqDpl9htub88/l+416eGYZ0AkRAyICML306xrIBT",
    "kdfParameter1": "W5kowvH9dJNVemz7XD2dww==",
    "kdfParameter2": "+ZFNyJlBAnn2W5e9m/ALYA=="
  }
}
```

`wrappedNonce` is 48 bytes (base64). `kdfParameter1` and `kdfParameter2` are each 16 bytes (base64). These are passed to the sandbox via `{command: "storage_key_init", payload: {wrappedNonce, kdfParameter1, kdfParameter2}}`, which sets `hS = new AesKey(...)` — an AES encryption key for local storage operations. This key must be initialized before calling any `encrypt`/`decrypt` sandbox commands.

### 5.3 Get Server Time

```
POST /api/talk/thrift/Talk/TalkService/getServerTime
x-line-access: <accessToken>

[]
```

### 5.4 Get Last Op Revision

Returns the current operation revision — required as `localRev` parameter for the SSE stream.

```
POST /api/talk/thrift/Talk/TalkService/getLastOpRevision
x-line-access: <accessToken>

[]
```

Response:
```json
{"code": 0, "message": "OK", "data": "36541"}
```

Save this value. It is the starting point for the real-time operations stream.

### 5.5 Get Configurations and Settings

```
POST /api/talk/thrift/Talk/TalkService/getConfigurations
POST /api/talk/thrift/Talk/TalkService/getSettings
x-line-access: <accessToken>

[]
```

---

## 6. Listing Chats

### 6.1 Get All Chat MIDs (Groups Only)

```
POST /api/talk/thrift/Talk/TalkService/getAllChatMids
x-line-access: <accessToken>

[{"withMemberChats": true, "withInvitedChats": true}, 2]
```

Response:
```json
{
  "code": 0, "message": "OK",
  "data": {
    "memberChatMids": [
      "Ccy07VtUgjG0SceVWRuM4GQAolDfMEQ1hp5qNa724n1k",
      "CKAmm0aTe99QlIAoShjkaw4YOOqFdzeiIyrwbteNyErg"
    ],
    "invitedChatMids": []
  }
}
```

MIDs starting with `C` are group chats; `U` is a user (1:1); `R` is a multi-person room.

### 6.2 Get All Contact IDs (1:1 Conversations)

```
POST /api/talk/thrift/Talk/TalkService/getAllContactIds
x-line-access: <accessToken>

[2]
```

Returns a flat array of contact MIDs.

### 6.3 Get Message Boxes (Inbox with Unread Counts)

Fetches the full inbox sorted by last activity, with unread counts and the most recent messages.

```
POST /api/talk/thrift/Talk/TalkService/getMessageBoxes
x-line-access: <accessToken>

[{
  "activeOnly": true,
  "unreadOnly": false,
  "messageBoxCountLimit": 100,
  "withUnreadCount": true,
  "lastMessagesPerMessageBoxCount": 5
}, 2]
```

Response `data.messageBoxes` is an array of message box objects. Each object includes:
- `id` — chat MID
- `midType` — 0=user, 1=room, 2=group
- `lastDeliveredMessageId.deliveredTime`
- `lastDeliveredMessageId.messageId`
- `lastSeenMessageId`
- `unreadCount`

### 6.4 Get Chat Metadata (Names, Members)

Takes the MID list from `getAllChatMids` and returns chat details.

```
POST /api/talk/thrift/Talk/TalkService/getChats
x-line-access: <accessToken>

[{
  "chatMids": [
    "Ccy07VtUgjG0SceVWRuM4GQAolDfMEQ1hp5qNa724n1k",
    "CKAmm0aTe99QlIAoShjkaw4YOOqFdzeiIyrwbteNyErg"
  ]
}, 2]
```

Response `data.chats` array — each entry includes:
- `type` — 1=group, 0=user
- `chatMid`
- `createdTime`
- `notificationDisabled`
- `chatName`
- `memberCount`
- `picturePath`

---

## 7. Reading Messages

### 7.1 Get Recent Messages (Latest N)

Fetches up to `count` most recent messages for a chat.

```
POST /api/talk/thrift/Talk/TalkService/getRecentMessagesV2
x-line-access: <accessToken>

["<chatMid>", 50]
```

Example:
```
["URLrlVGjUBXM3-W7x0s5g6GhhK_RdxRRTyf6yBGjT0wg", 50]
```

Response `data` is an array of message objects (see §7.3).

### 7.2 Get Older Messages (Pagination)

To load messages older than a known message, use `getPreviousMessagesV2WithRequest`:

```
POST /api/talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest
x-line-access: <accessToken>

[{
  "messageBoxId": "<chatMid>",
  "endMessageId": {
    "deliveredTime": "1780049990595",
    "messageId": "616090722214347565"
  },
  "messagesCount": 50
}, 1]
```

Returns messages older than `endMessageId`, up to `messagesCount`. Use the oldest message's `id` and `deliveredTime` as the next `endMessageId` for subsequent pages.

### 7.3 Message Object Structure

All message endpoints return the same message object shape:

```json
{
  "from": "UVU_oPtM5UASm6P9QuqR7bOqysED9A8CxupLSs3eaVgA",
  "to": "UeaqlOg_Nfz_dvBikxijYQK8rPZlNcBTKMKQo7fF5DWs",
  "toType": 0,
  "id": "617993075302072356",
  "createdTime": "1781183881292",
  "deliveredTime": "1781183881292",
  "hasContent": false,
  "contentType": 0,
  "text": "message text here",
  "contentMetadata": {}
}
```

Key fields:

| Field | Type | Notes |
|---|---|---|
| `from` | string | Sender MID |
| `to` | string | Recipient MID (for 1:1: the other user's MID; for group: the group MID) |
| `toType` | int | 0=user, 1=room, 2=group |
| `id` | string | Unique message ID (use as cursor for pagination) |
| `createdTime` | string | Unix timestamp in milliseconds |
| `deliveredTime` | string | Unix timestamp in milliseconds |
| `hasContent` | bool | true if message has media attachment |
| `contentType` | int | 0=text, 1=image, 2=video, 3=audio, 7=sticker, 13=location, 22=flex-message |
| `text` | string | Plain text (may be null for non-text contentTypes) |
| `contentMetadata` | object | Type-specific metadata; for FLEX messages contains `FLEX_JSON` key |

### 7.4 Mark Messages as Read

```
POST /api/talk/thrift/Talk/TalkService/sendChatChecked
x-line-access: <accessToken>

[<sequenceId>, "<chatMid>", "<messageId>", 0]
```

Example (from HAR): `[489408281, "URLrlVGjUBXM3-W7x0s5g6GhhK_RdxRRTyf6yBGjT0wg", "617973232184328253", 0]`

`sequenceId` is a monotonically increasing integer (client-side counter).

### 7.5 Get Message Read Status

```
POST /api/talk/thrift/Talk/TalkService/getMessageReadRange
x-line-access: <accessToken>

[["<chatMid1>", "<chatMid2>"], 1]
```

Response:
```json
{
  "data": [
    {"chatId": "<chatMid>", "ranges": {}}
  ]
}
```

---

## 8. Real-Time Operations Stream (SSE)

After bootstrap, the extension opens a Server-Sent Events connection to receive incoming messages and operation notifications.

### 8.1 Endpoint

```
GET https://line-chrome-gw.line-apps.com/api/operation/receive
    ?localRev=<lastOpRevision>
    &version=3.7.2
    &lastPartialFullSyncs=%7B%7D
    &language=en_US
```

Parameters:
- `localRev` — revision from `getLastOpRevision` (or last received operation's revision); start the stream from this point
- `version` — Chrome extension version string (`3.7.2`)
- `lastPartialFullSyncs` — URL-encoded JSON object (`{}` initially)
- `language` — locale (`en_US`)

### 8.2 Request Headers

```
:method:          GET
accept:           text/event-stream
accept-encoding:  gzip, deflate, br, zstd
accept-language:  en-TH,en-GB;q=0.9,en-US;q=0.8,en;q=0.7
cache-control:    no-cache
pragma:           no-cache
sec-ch-ua:        "Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "Windows"
sec-fetch-dest:   empty
sec-fetch-mode:   cors
sec-fetch-site:   none
sec-fetch-storage-access: active
user-agent:       Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36
```

> **Authentication mechanism (from main.js):** The SSE transport is constructed with `withCredentials: true` (see `HA.SSETransport` in `main.js`). This tells the browser to include cookies for `line-chrome-gw.line-apps.com` with the EventSource request. The cookie is named `lct` (LINE Chrome Token) and is removed on logout via `chrome.cookies.remove({url: ..., name: "lct"})`. The server sets this cookie implicitly (no `Set-Cookie` header was observed in the HAR, suggesting it may be set server-side on a domain-level basis prior to the capture, or via a Chrome extension privilege). For implementations outside the Chrome extension context, include `x-line-access: <accessToken>` as a fallback; the SSE stream returned 200 in the HAR without any visible auth header, which may indicate the `lct` cookie was already present from a previous request.

### 8.3 Response

```
Content-Type: text/event-stream
Cache-Control: no-cache
```

The stream delivers Server-Sent Events with named event types. Event types (from main.js `Md` constants and `HA` interceptors):

| SSE Event Type | Description |
|---|---|
| `op` / default | Operation event — new message, read receipt, member change, etc. |
| `ping` | Keep-alive heartbeat |
| `connInfoRevision` | CDN routing revision changed; triggers connInfo re-fetch |
| `reconnect` | Server instructs client to reconnect |
| `talkException` | Server-side exception on the talk service |
| `fullSync` | Full data synchronization required |
| `partialFullSync` | Partial sync for specific data categories |

**Operation event payload** (JSON, from `handleReceiveOpEvent` in main.js):
```json
{
  "revision": "36542",
  "type": 25,
  "message": { ...Message object... }
}
```

- `revision` — update `localRev` to this value after processing; skip events where `revision <= current localRev`
- `type` — OperationType (25 = RECEIVE_MESSAGE, others include read receipts, group member events, etc.)
- `message` — Message object (see §7.3), present when `type = 25`

The ping interceptor is configured with `range: [20000, 20000]` (20 second interval). On reconnect, reopen the connection with the latest `localRev` as a query parameter.

---

## 9. API Endpoint Reference

All endpoints are `POST https://line-chrome-gw.line-apps.com<path>` unless noted.

| Path | Auth Required | Observed Status | Purpose |
|---|---|---|---|
| `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession` | No | 200 | Start QR login — get `authSessionId` |
| `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode` | No | 200 | Get `callbackUrl` for QR rendering |
| `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified` | No (x-lst + x-line-session-id) | 200 (or 400/410 = already confirmed) | Long-poll: wait for mobile scan |
| `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate` | No | 200 (accepted) or 400 code 2 (rejected) | Mandatory state transition; always call even with empty cert |
| `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode` | No | 200 | Generate PIN for first-time login (when cert rejected) |
| `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified` | No (x-lst + x-line-session-id) | 200 | Long-poll: wait for user to enter PIN on mobile |
| `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2` | No | 200 | Complete login — get tokens |
| `/api/talk/thrift/Talk/TalkService/getProfile` | Yes | 200 | Own user profile |
| `/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3` | Yes | 200 | Encrypted identity blob |
| `/api/talk/thrift/Talk/TalkService/getServerTime` | Yes | 200 | Server time |
| `/api/talk/thrift/Talk/TalkService/getLastOpRevision` | Yes | 200 | Current op revision (for SSE) |
| `/api/talk/thrift/Talk/TalkService/getConfigurations` | Yes | 200 | Client configuration |
| `/api/talk/thrift/Talk/TalkService/getSettings` | Yes | 200 | User settings |
| `/api/talk/thrift/Talk/TalkService/getAllContactIds` | Yes | 200 | All 1:1 contact MIDs |
| `/api/talk/thrift/Talk/TalkService/getAllChatMids` | Yes | 200 | All group chat MIDs |
| `/api/talk/thrift/Talk/TalkService/getMessageBoxes` | Yes | 200 | Inbox with unread counts |
| `/api/talk/thrift/Talk/TalkService/getContactsV2` | Yes | 200 | Contact metadata by MID list |
| `/api/talk/thrift/Talk/TalkService/getChats` | Yes | 200 | Group chat metadata |
| `/api/talk/thrift/Talk/TalkService/getRecentMessagesV2` | Yes | 200 | Latest messages for a chat |
| `/api/talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest` | Yes | 200 | Paginated older messages |
| `/api/talk/thrift/Talk/TalkService/getMessageReadRange` | Yes | 200 | Read position per chat |
| `/api/talk/thrift/Talk/TalkService/sendChatChecked` | Yes | 200 | Mark messages as read |
| `/api/talk/thrift/Talk/BuddyService/getBuddyDetail` | Yes | 200/400 | Official account details |
| `GET /api/operation/receive` | Yes (mechanism unclear) | 200 | SSE real-time operation stream |
| `GET /api/lan/notice` | No | 200 | Notice/announcement banner |

---

## 10. Ancillary Services

### 10.1 Region Check (CDN Routing)

On startup and after login, the extension sends a region check:

```
GET https://ci.line-apps.com/R4
    ?type=Chrome_OS
    &version=3.7.2
    &region=JP
    &time=<unix_timestamp_seconds>
    &key=<md5_hash>
```

**`key` computation** (from main.js, `rN` class):
```
key = MD5(UTF8(type + version + region + time) + secret_bytes)
```

Where `secret_bytes` is a static hex constant embedded in `main.js`:
```
4c605effdf3dfca1217d48174020569180dc2338a5772a80ed0aaa01bcd0a08f
```

The hash input concatenates the raw bytes of the query string fields with the 32 decoded secret bytes.

This determines regional CDN routing (JP vs global). Not required for main API calls.

### 10.2 Error Reporting (Sentry)

```
POST https://sentry-uit.line-apps.com/api/12/envelope/?sentry_key=56dc42acf92b4b6e9a064e629eae78d8&sentry_version=7&...
```

Internal error/session telemetry. Not relevant for API implementation.

### 10.3 Profile Images

Profile picture thumbnails are served from:
```
GET https://profile.line-scdn.net/<pictureStatus>/preview
```

Where `pictureStatus` is the value from the `getProfile` response.

---

## 11. Relation to Old Thrift Spec

The `LINE_Login_Protocol_Specification.md` in this directory describes a **Thrift binary / TCompact protocol** targeting `ga2.line.naver.jp`. That spec applies to the mobile client (Android/iOS) and the older desktop client. The Chrome extension v3.7.2 uses a completely different protocol:

| Aspect | Old spec (mobile/legacy) | Chrome extension v3.7.2 (this spec) |
|---|---|---|
| Gateway | `ga2.line.naver.jp` | `line-chrome-gw.line-apps.com` |
| Protocol | Thrift binary/compact | JSON over HTTPS |
| Auth header | `x-line-access` (opaque) | `x-line-access` (JWT) |
| Login method | Email+RSA encrypt or QR (Thrift) | QR only (JSON) |
| Message streaming | `POST /P4` fetchOperations (Thrift) | `GET /api/operation/receive` (SSE) |
| Signing | `x-lcs`, `x-le` | `x-hmac` |
| E2EE key exchange | Full Curve25519 + AES-CBC | Same crypto (metaData field in qrCodeLoginV2) |

The E2EE cryptography (§5 of the old spec) still applies for decrypting E2EE messages received via the Chrome API.
