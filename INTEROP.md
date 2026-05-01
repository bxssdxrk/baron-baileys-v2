# WhatsApp Interop Support

Baron-Baileys-v2 supports the WhatsApp Interoperability Protocol (DMA-Interop), which allows users of third-party messaging services to communicate with WhatsApp accounts.

## What is Interop?

Since 2024, large messaging platforms are required by the EU Digital Markets Act (DMA) to offer interoperability. WhatsApp implements this via the `w:interop` IQ namespace protocol.

Currently available integrators:

| ID | Name | Identifier Type | Status |
|----|------|-----------------|--------|
| 12 | BirdyChat | Email address | active |
| 13 | Haiket | Phone number | active |

Interop JIDs follow the format: `{integrator_id}-{user_id}@interop`  
Example: `12-105012705411308@interop`

---

## Automatic Initialization

The socket initializes interop automatically on connection open (in parallel with other init queries). No manual call required.

```js
const sock = makeWASocket({ auth, /* ... */ })

sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'open') {
        // Interop is already initialized:
        // 1. Integrators fetched
        // 2. TOS accepted (result 105 + 160)
        // 3. Opt-in sent
    }
})
```

---

## Fetch Integrators

```js
const integrators = await sock.fetchIntegrators()

// Example output:
// [
//   {
//     id: 12,
//     name: 'BirdyChat',
//     status: 'active',        // 'active' | 'onboarding' | 'removed'
//     icon: 'https://static.whatsapp.net/wa/static/interop?cat=integrator_icons&id=birdychat-icon',
//     identifierType: 'email', // 'email' | 'pn' | 'username'
//     optedIn: true,
//     features: { groupMessaging: false }
//   },
//   {
//     id: 13,
//     name: 'Haiket',
//     status: 'active',
//     identifierType: 'pn',
//     optedIn: true,
//     features: { groupMessaging: false }
//   }
// ]

console.log(sock.INTEGRATOR_BIRDYCHAT) // 12
console.log(sock.INTEGRATOR_HAIKET)    // 13
```

---

## Resolve a User / Look Up JID

### Single user

```js
// Look up a BirdyChat user by email
const result = await sock.resolveInteropUser(
    'user@example.com',
    sock.INTEGRATOR_BIRDYCHAT // 12
)

if (result.error) {
    console.log('Not found:', result.error.code, result.error.text)
    // { code: 404, text: 'item-not-found' }
} else {
    console.log('JID:', result.jid)
    // '12-105012705411308@interop'
    console.log('External ID:', result.externalId)
    console.log('Normalized ID:', result.normalizedExternalId)
}

// Look up a Haiket user by phone number
const result2 = await sock.resolveInteropUser(
    '19146088152',          // phone number without +
    sock.INTEGRATOR_HAIKET  // 13
)
```

### Batch lookup (up to 256 users at once)

```js
const results = await sock.resolveInteropUsers([
    { externalId: 'alice@example.com', integratorId: 12 },
    { externalId: 'bob@example.com',   integratorId: 12 },
    { externalId: '19146088152',       integratorId: 13 },
])

for (const r of results) {
    if (r.error) {
        console.log(`${r.externalId} → not found`)
    } else {
        console.log(`${r.externalId} → ${r.jid}`)
    }
}
```

---

## Sending Messages

Interop JIDs work exactly like regular WhatsApp JIDs in `sendMessage`:

```js
const interopJid = '12-105012705411308@interop'

// Send text
await sock.sendMessage(interopJid, { text: 'Hello from WhatsApp!' })

// Send image
await sock.sendMessage(interopJid, {
    image: { url: './photo.jpg' },
    caption: 'Check this out!'
})

// Send GIF
await sock.sendMessage(interopJid, {
    video: { url: './animation.gif' },
    gifPlayback: true
})

// After the first outgoing message: mark as trusted contact
// (WA does this automatically after the first send)
await sock.trustInteropContact(interopJid)
```

---

## Receiving Messages

Incoming interop messages arrive via the normal `messages.upsert` event:

```js
sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
        const jid = msg.key.remoteJid

        if (jid.endsWith('@interop')) {
            // Extract integrator ID and user ID
            const [integratorId, userId] = jid.replace('@interop', '').split('-')

            console.log(`Interop message from integrator ${integratorId}:`)
            console.log('User ID:', userId)
            console.log('Text:', msg.message?.conversation)
        }
    }
})
```

---

## Profile Picture

```js
const interopJid = '12-105012705411308@interop'

// Low-resolution preview
const previewUrl = await sock.profilePictureUrl(interopJid, 'preview')

// Full resolution
const fullUrl = await sock.profilePictureUrl(interopJid, 'image')
```

---

## Reachability / Presence

Instead of XMPP presence subscriptions, interop uses `reachability_settings`:

```js
// Query current reachability settings
const settings = await sock.getReachabilitySettings()
// {
//   enabled: 'true',
//   users: [
//     { externalId: 'user@email.com', integratorId: 12, jid: '12-...@interop' }
//   ]
// }

// Enable reachability for specific users (subscribe to presence)
await sock.setReachabilitySettings(
    [
        { externalId: 'user@example.com', integratorId: 12 },
        { externalId: '19146088152',      integratorId: 13 }
    ],
    'true'  // 'true' | 'false'
)
```

---

## Block / Unblock

Interop blocking uses its **own channel** (`xmlns="w:interop"`) — separate from the regular WA blocklist:

```js
const interopJid = '12-105012705411308@interop'

// Block
await sock.blockInteropUser(interopJid)

// Unblock
await sock.unblockInteropUser(interopJid)
```

---

## Report Spam

```js
// Report as spam + block (default WA flow)
await sock.reportInteropSpam(interopJid)

// Report with a custom flow
await sock.reportInteropSpam(interopJid, 'report_only')
```

---

## Opt-in / Opt-out

Manually opt in or out (normally handled automatically during init):

```js
// Opt in to all known integrators
await sock.optInIntegrators()

// Opt in to specific integrators
await sock.optInIntegrators([12]) // BirdyChat only

// Opt out
await sock.optOutIntegrators([13]) // disable Haiket
await sock.optOutIntegrators()     // disable all
```

---

## isInteropUser — Check a JID

```js
const { isInteropUser } = require('./src/WABinary')

isInteropUser('12-105012705411308@interop')  // true
isInteropUser('491234567890@s.whatsapp.net') // false
```

---

## Full Example

```js
const makeWASocket = require('./src').default
const { useMultiFileAuthState } = require('./src')
const { isInteropUser } = require('./src/WABinary')

async function main() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth')
    const sock = makeWASocket({ auth: state })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection }) => {
        if (connection !== 'open') return

        // Look up a BirdyChat user and send a message
        const user = await sock.resolveInteropUser(
            'friend@birdychat.app',
            sock.INTEGRATOR_BIRDYCHAT
        )

        if (user.error) {
            console.log('User not found on BirdyChat')
            return
        }

        console.log('Found:', user.jid)

        await sock.sendMessage(user.jid, {
            text: 'Hey! This is a message from WhatsApp via DMA Interop!'
        })

        // Mark as trusted after first send
        await sock.trustInteropContact(user.jid)
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (!msg.key.fromMe && isInteropUser(msg.key.remoteJid)) {
                console.log('Reply received:', msg.message?.conversation)
            }
        }
    })
}

main()
```

---

## Protocol Details

### Stanza flow during init

```
→ GET  w:interop  <integrator fetch="all"/>
← integrator_list with active integrators

→ SET  tos        <trackable id="20240306" result="105"/>   (TOS shown)
← result OK

→ SET  tos        <trackable id="20240306" result="160"/>   (TOS accepted)
← result OK

→ SET  w:interop  <opt_in_integrators><integrator_list>...
← integrator_list (empty = OK)
```

### Stanza flow when sending a message

```
→ <message to="12-105012705411308@interop" type="text">
    <enc v="2" type="pkmsg">...</enc>
  </message>
← <ack from="12-105012705411308@interop" class="message" .../>

→ SET  privacy  <tokens><token jid="..." type="trusted_contact"/></tokens>
← result OK
```

### JID format

```
{integrator_id}-{user_id}:{device}@interop

integrator_id  → numeric (12 = BirdyChat, 13 = Haiket, ...)
user_id        → platform-specific user ID
device         → device index (optional, usually 0)
server         → always "interop"
```

### Known limits (from APK sources)

| Operation | Limit |
|-----------|-------|
| Batch lookup | max 256 users per request |
| Integrator ID range | 1–999 |
| Reachability settings items | max 999 |
