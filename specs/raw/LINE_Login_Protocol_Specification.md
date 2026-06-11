# LINE Messenger — Login Protocol Specification

> **Important caveat:** This specification was compiled from publicly available reverse-engineering research — primarily the CHRLINE project (archived GitHub repo `DeachSword/CHRLINE`) and the older `carpedm20/LINE` Python client. Direct live traffic inspection of the Chrome extension was not possible due to Chrome's cross-extension security sandbox. Compatibility with the current live LINE backend is not guaranteed.

---

## 1. Transport & Encoding Layer

### 1.1 Base Transport

All API requests are HTTPS POST to one of several gateway domains:

| Domain | Purpose |
|---|---|
| `https://ga2.line.naver.jp` | Primary API host |
| `https://gf.line.naver.jp` | Encrypted endpoint host |
| `https://gd2.line.naver.jp` | Legacy / regional gateway |

HTTP/2 is supported and preferred for most service calls. Plain HTTP/1.1 is used for polling and legacy auth flows.

### 1.2 Serialization Protocols

LINE uses Apache Thrift for all RPC, but operates three codec variants simultaneously:

| Protocol | Endpoint Suffix | Description |
|---|---|---|
| **TBinary** | `/S3` | Standard Thrift binary framing |
| **TCompact** | `/S4` | Compact varint encoding |
| **TMoreCompact** | `/S5` | Custom LINE-proprietary extension of TCompact using Huffman-compressed field-type tables and 16-byte mid compression |

Most login flows use TCompact over the `/api/v3/TalkService.do`, `/api/v3p/rs`, and `/acct/lgn/sq/v1` paths.

### 1.3 Required HTTP Headers

Every request must carry:

```
x-line-application: <APP_NAME>       e.g. "CHROMEOS\t3.0.3\tChrome_OS\t1"
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...
content-type: application/x-thrift; protocol=TBINARY
x-lal: zh-Hant_TW                   (locale)
x-lhm: POST
x-lpv: 1
x-lap: 5
x-lcs: <encryptKey>                  (per-session encryption key ID)
x-le: <le_value>                     (opaque lease/entropy value)
```

After authentication, all requests also include:

```
x-line-access: <authToken>
```

### 1.4 App Name / Device Identifier Format

The `x-line-application` header encodes device identity as a tab-separated string:

```
<DEVICE_TYPE>\t<APP_VER>\t<OS_NAME>\t<OS_VER>
```

Examples for supported device types:

| Device Type | APP_VER example | OS_NAME | OS_VER |
|---|---|---|---|
| `CHROMEOS` | `3.0.3` | `Chrome_OS` | `1` |
| `DESKTOPWIN` | `7.16.1.3000` | `WINDOWS` | `10.0.0-NT-x64` |
| `DESKTOPMAC` | `7.16.1.3000` | `MAC` | *(version string)* |
| `ANDROID` | `13.4.1` | `Android OS` | *(build string)* |
| `IOS` | `13.3.0` | `iOS` | *(version string)* |

For secondary device registration append `;SECONDARY` to the app name.

---

## 2. Email / Password Login Flow

### 2.1 High-Level Flow

```
Client                                    LINE Server
  |                                            |
  |-- POST /api/v3/TalkService.do (getRSAKeyInfo) -->|
  |<-- {keynm, n, e, sessionKey} -------------|
  |                                            |
  | [build message: len+sessionKey+len+email+len+password]
  | [RSA encrypt message with public key (n,e)]
  | [generate E2EE Curve25519 keypair]        |
  |                                            |
  |-- POST /api/v3p/rs (loginV2) ------------->|
  |<-- {val_5=3: verifier + pinCode} ---------|
  |                                            |
  | [display PIN code to user]                |
  |                                            |
  |-- GET /LF1 (long-poll, x-lst:150000) ----->|
  |         (user approves login on mobile)   |
  |<-- {metadata: publicKey+encryptedKeyChain}|
  |                                            |
  | [decodeE2EEKeyV1(metadata, secret)]       |
  | [encryptDeviceSecret(...)]                |
  |                                            |
  |-- POST AuthService (confirmE2EELogin) ---->|
  |<-- {e2eeLogin verifier} -----------------|
  |                                            |
  |-- POST /api/v3p/rs (loginV2+verifier) ---->|
  |<-- {authToken, certificate, refreshToken}--|
```

### 2.2 Step 1 — Fetch RSA Key

**Endpoint:** `POST /api/v3/TalkService.do`  
**Thrift method:** `getRSAKeyInfo`  
**Params:** `[[8, 2, provider]]` where provider = 1 (LINE), 2 (NAVER_KR), 3 (LINE_PHONE)

Response fields:
- `val_1` → `keynm` (key name identifier)
- `val_2` → `n` (RSA modulus, hex string)
- `val_3` → `e` (RSA exponent, hex string)
- `val_4` → `sessionKey` (server-generated session binding string)

### 2.3 Step 2 — Encrypt Credentials

Construct plaintext:
```
chr(len(sessionKey)) + sessionKey + chr(len(email)) + email + chr(len(password)) + password
```
Encode as UTF-8, then RSA-encrypt using public key `(int(n,16), int(e,16))`. Hex-encode the ciphertext → `encData`.

Also generate a Curve25519 keypair for E2EE:
```
secret (private key, 32 random bytes)
secretPK (public key derived from secret)
```

Compute the E2EE secret parameter:
```
pincode = b"202202"   (static default)
_secret = AES_ECB_encrypt(SHA256(pincode), base64.decode(secretPK))
```

### 2.4 Step 3 — First loginV2 Call

**Endpoint:** `POST /api/v3p/rs`  
**Thrift method:** `loginV2`

Thrift struct (field 2) parameters:

| Field # | Thrift Type | Value |
|---|---|---|
| 1 | i32 | loginType: 0=normal, 1=verifier, 2=e2ee |
| 2 | i32 | provider: 1 (LINE) |
| 3 | string | keynm |
| 4 | string | encData (hex ciphertext) |
| 5 | bool | false (0) |
| 6 | string | "" (accessLocation) |
| 7 | string | deviceName e.g. "Chrome" |
| 8 | string | certificate (saved cert or empty string) |
| 9 | string | verifier (null on first call) |
| 10 | string | secret (E2EE AES-ECB encrypted secret) |
| 11 | i32 | 1 |
| 12 | string | "System Product Name" |

Response when `val_5 = 3`: device confirmation required.  
Extract `val_3` = verifier (temporary access session token).

### 2.5 Step 4 — Long-Poll for Mobile Approval

**Endpoint:** `GET /LF1` (E2EE flow) or `GET /Q` (legacy)

Additional headers:
```
x-lst: 150000
x-line-access: <verifier from step 3>
```

Blocks until user approves on mobile. Response JSON:
```json
{
  "result": {
    "metadata": {
      "publicKey": "<base64 Curve25519 public key>",
      "encryptedKeyChain": "<base64 AES-CBC encrypted key chain>",
      "e2eeVersion": "2"
    }
  }
}
```

### 2.6 Step 5 — E2EE Device Secret Exchange

Compute `encryptDeviceSecret`:
```
sharedSecret      = Curve25519.ECDH(clientPrivKey, serverPublicKey)
aesKey            = SHA256(sharedSecret || "Key")
encKC_xor         = XOR_halves(SHA256(encryptedKeyChain))
deviceSecret      = AES_ECB_encrypt(aesKey, encKC_xor)
```

Call `confirmE2EELogin(verifier, deviceSecret)` → returns `e2eeLogin` token.

### 2.7 Step 6 — Final loginV2 with Verifier

Repeat `loginV2` with `loginType=1`, `verifier=e2eeLogin`.

Successful response:
- `val_1` → authToken (legacy)
- `val_2` → certificate (save to disk)
- `val_9` → tokenV3Info:
  - `val_1` → accessToken
  - `val_2` → refreshToken

### 2.8 Certificate Re-Login

On subsequent logins pass the saved certificate in field 8 of `loginV2`. If still valid, server returns authToken directly (skips PIN/E2EE steps).

---

## 3. QR Code Login Flow

Used to register a new secondary device by scanning a QR with an authenticated mobile app.

### 3.1 High-Level Flow

```
Client (Chrome)                     LINE Server          Mobile App
  |                                       |                   |
  |-- createSession() ----------------->  |                   |
  |<-- {authSessionId} --------------- - |                   |
  |                                       |                   |
  |-- createQrCode(authSessionId) ----->  |                   |
  |<-- {callbackUrl} ----------------- - |                   |
  |                                       |                   |
  | [generate Curve25519 keypair]        |                   |
  | [QR URL = callbackUrl + ?secret=...] |                   |
  | [render and display QR code]         |                   |
  |                                       |                   |
  |                   [user scans QR] -->|<-- scan+approve --|
  |                                       |                   |
  |-- checkQrCodeVerified() (long-poll)->  |                   |
  |<-- (verified) ------------------- -- |                   |
  |                                       |                   |
  |-- verifyCertificate(sessionId, cert)->|                   |
  |<-- OK or exception ----------------  |                   |
  |                                       |                   |
  | [if no cert] createPinCode() ------>  |                   |
  |<-- {pinCode} --------------------- - |                   |
  | [show PIN on screen]                 |                   |
  |                                       |<-- user types PIN-|
  |-- checkPinCodeVerified() (long-poll)->|                   |
  |<-- (verified) ------------------- -- |                   |
  |                                       |                   |
  |-- qrCodeLoginV2(sessionId,...) ----->  |                   |
  |<-- {authToken, refreshToken,          |                   |
  |     cert, mid, E2EE metadata} ------ |                   |
  |                                       |                   |
  | [decodeE2EEKeyV1(metadata, secret)]  |                   |
  | [persist authToken + refreshToken]   |                   |
```

### 3.2 Step 1 — Create Session

**Endpoint:** `POST /acct/lgn/sq/v1`  
**Thrift method:** `createSession` (no params)  
**Response:** `val_1` = `authSessionId`

### 3.3 Step 2 — Create QR Code URL

**Endpoint:** `POST /acct/lgn/sq/v1`  
**Thrift method:** `createQrCode`  
**Params:** `[[12, 1, [[11, 1, authSessionId]]]]`  
**Response:** `val_1` = `callbackUrl` (a `line://` deep-link)

### 3.4 Step 3 — Build QR URL with E2EE Secret

```python
secret    = os.urandom(32)                        # Curve25519 private key
secretPK  = Curve25519.generatePublicKey(secret)  # public key
secretUrl = "?secret=" + base64url_encode(secretPK)
qrUrl     = callbackUrl + secretUrl
```

Render `qrUrl` as a QR code image.

### 3.5 Step 4 — Poll for QR Scan

**Endpoint:** `POST /acct/lp/lgn/sq/v1`  
**Thrift method:** `checkQrCodeVerified`  
**Headers:** `x-lst: 150000`, `x-line-access: <authSessionId>`

Blocks until mobile scans the code. Returns `True` on success, `False` on timeout.

### 3.6 Step 5 — Verify Saved Certificate

**Endpoint:** `POST /acct/lgn/sq/v1`  
**Thrift method:** `verifyCertificate`  
**Params:** `[[12, 1, [[11, 1, authSessionId], [11, 2, certificate]]]]`

Success → skip PIN. Exception → proceed to PIN creation.

### 3.7 Step 6 — PIN Code (first-time or expired cert)

**Create:** `POST /acct/lgn/sq/v1` → `createPinCode(authSessionId)`  
Response `val_1` = PIN digits. Display to user.

**Confirm:** `POST /acct/lp/lgn/sq/v1` → `checkPinCodeVerified(authSessionId)`  
Long-poll (`x-lst: 150000`) until user enters PIN on mobile.

### 3.8 Step 7 — Complete QR Login

**Endpoint:** `POST /acct/lgn/sq/v1`  
**Thrift method:** `qrCodeLoginV2`

Parameters:

| Param | Value |
|---|---|
| authSessionId | session token from step 1 |
| systemName | device display name (visible on mobile) |
| modelName | e.g. `"CHROMEOS"` |
| autoLoginIsRequired | true |

Response:

| Field | Content |
|---|---|
| `val_1` / `certificate` | device certificate (save to disk) |
| `val_3` / `tokenV3IssueResult` | `accessToken` (field 1), `refreshToken` (field 2) |
| `val_4` / `mid` | user MID (`u` + 40 hex chars) |
| `val_10` / `metaData` | E2EE key material |

### 3.9 Step 8 — E2EE Key Derivation

```python
decodeE2EEKeyV1(metadata, secret, mid)
```

Decrypts the server-supplied `encryptedKeyChain` via:
```
sharedSecret = Curve25519.ECDH(secret, serverPublicKey)
aes_key      = SHA256(sharedSecret || "Key")
aes_iv       = XOR_halves(SHA256(sharedSecret || "IV"))
keyChain     = AES_CBC_decrypt(aes_key, aes_iv, encryptedKeyChain)
```

Stores the derived local keypair for future E2EE message operations.

---

## 4. Token Management

### 4.1 Token Types

| Token | Description | Persistence |
|---|---|---|
| `authToken` / `accessToken` | Bearer token sent as `x-line-access` header | Memory + optional file cache |
| `refreshToken` | Renews accessToken without re-login | Persistent (`.refreshToken` cache) |
| `certificate` | Device trust cert; skips PIN on future logins | Persistent (`.line.crt` / `.sqr.crt`) |

### 4.2 Token Refresh

**Service:** `AccessTokenRefreshService`  
**Thrift method:** `refreshAccessToken(refreshToken)`  
→ Returns new `accessToken`.  
**Follow-up:** Call `reportRefreshedAccessToken` to acknowledge.

---

## 5. E2EE Cryptography Summary

| Primitive | Algorithm |
|---|---|
| Key agreement | Curve25519 ECDH (`axolotl_curve25519`) |
| Message encryption v1 | AES-256-CBC; key=SHA256(shared\|salt\|"Key"); IV=XOR-halves(SHA256(shared\|salt\|"IV")) |
| Message encryption v2 | AES-256-GCM; key=SHA256(shared\|salt\|"Key"); nonce=16 random bytes; AAD=to+from+senderKeyId+receiverKeyId+version+contentType |
| Key chain decryption | AES-256-CBC with ECDH-derived key+IV |
| Device secret encryption | AES-128-ECB(SHA256(XOR-halves(encKeyChain))) |
| Hashing | SHA-256 |

### 5.1 E2EE Message Chunk Format

```
chunks[0] = salt               (16 random bytes)
chunks[1] = encryptedPayload
chunks[2] = sign / GCM nonce  (16 random bytes)
chunks[3] = senderKeyId        (4-byte big-endian int)
chunks[4] = receiverKeyId      (4-byte big-endian int)
```

---

## 6. Post-Login: Reading Messages

### 6.1 Long-Polling for Operations

**Endpoint:** `POST /P4`  
**Thrift method:** `fetchOperations(revision, count=50)`

Each `Operation` contains:
- `type` — OperationType (25 = RECEIVE_MESSAGE)
- `revision` — monotonic counter; always save and send the latest value
- `message` — Message object (present when type = 25)

### 6.2 Message Object Key Fields

| Thrift Field | Name | Notes |
|---|---|---|
| 1 | `_from` | Sender MID |
| 2 | `to` | Recipient MID |
| 3 | `toType` | 0=user, 1=room, 2=group |
| 10 | `text` | Plain text (null for E2EE) |
| 15 | `contentType` | 0=text, 15=location, etc. |
| 18 | `contentMetadata` | Dict; contains `e2eeVersion` |
| 20 | `chunks` | E2EE payload (5-element list) |

For E2EE messages call `decryptE2EETextMessage(messageObj)` to recover plaintext.

---

## 7. Key Endpoints Reference

| Path | Transport | Purpose |
|---|---|---|
| `/api/v3/TalkService.do` | Thrift TCompact | `getRSAKeyInfo`, legacy TalkService |
| `/api/v3p/rs` | Thrift TCompact | `loginV2`, `loginZ`, `confirmE2EELogin` |
| `/acct/lgn/sq/v1` | Thrift TCompact | QR session: `createSession`, `createQrCode`, `verifyCertificate`, `createPinCode`, `qrCodeLogin(V2)` |
| `/acct/lp/lgn/sq/v1` | Thrift TCompact (long-poll) | `checkQrCodeVerified`, `checkPinCodeVerified` |
| `/LF1` | GET long-poll | `checkLoginV2PinCode` (E2EE metadata) |
| `/Q` | GET long-poll | `checkLoginZPinCode` (legacy) |
| `/S3` | Thrift TBinary | TalkService post-auth |
| `/S4` | Thrift TCompact | TalkService post-auth |
| `/S5` | Thrift TMoreCompact | TalkService post-auth (Android-style) |
| `/P4` | Thrift | `fetchOperations` long-poll |
| `/enc` | Encrypted custom | `gf.line.naver.jp` encrypted wrapper |

---

## 8. Implementation Notes & Known Risks

**Protocol stability:** LINE Corp has sent DMCA takedowns to reverse-engineering projects and has made breaking auth changes. The `carpedm20/LINE` library had login code removed at LINE's request; CHRLINE was archived November 2023. Validate all calls against live traffic before relying on this spec.

**Certificate pinning:** The Chrome extension may use SSL certificate pinning. Intercepting traffic requires browser-level hooks (e.g., injecting into the extension's service worker context) rather than system-level MITM proxies.

**TMoreCompact:** The `/S5` endpoint uses a proprietary Huffman-coded variant not in Apache Thrift. Refer to the `TMoreCompactProtocol` class in CHRLINE for a full decoder implementation.

**Rate limiting:** LINE detects abnormal login patterns. Use realistic User-Agent strings, honour retry-after headers, and apply exponential backoff on 4xx/5xx responses.

**Error codes:**

| Code | Meaning | Fix |
|---|---|---|
| 20 | Token/version mismatch | Upgrade APP_VER string |
| 89 | E2EE not supported for this flow | Fall back to non-E2EE `loginZ` |
| 5 (E2EE svc) | Group key not registered | Call `registerE2EEGroupKey` first |
