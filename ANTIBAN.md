# Antiban Protection

> **⚠ Test Phase** — This antiban integration is currently experimental. It is being tested to evaluate how well it works in real-world scenarios. Behavior may change.

The antiban system is based on [baileys-antiban](https://github.com/kobie3717) by [@kobie3717](https://github.com/kobie3717) and has been bundled directly into baron-baileys-v2.

Every socket created with `makeWASocket()` is **automatically protected** — no extra setup required.

## How It Works

Every `sendMessage()` call passes through multiple protection layers:

- **Rate Limiting** — max 8/min, 200/h, 1,500/day
- **Warmup** — new numbers start at 20 messages/day, scaling up ~1.8x daily
- **Circadian Rhythm** — automatically slows down during night hours (2–6 AM)
- **Timelock** — on 463 errors, new contacts are automatically blocked
- **Reply Ratio** — sent/received ratio is monitored (~2:1)
- **Human Delays** — random 1.5–5s pause between messages
- **Session Health** — automatically pauses on too many errors

## Basic Usage

```js
const sock = makeWASocket({ auth: state })

try {
    await sock.sendMessage(jid, { text: 'Hello' })
} catch (err) {
    if (err.message.includes('[baileys-antiban]')) {
        console.log('Blocked:', err.message)
        // wait, skip, or queue the message
    } else {
        throw err
    }
}
```

## Opt-out (disable protection)

```js
const sock = makeWASocket({ antiban: false, auth: state })
```

## Custom Configuration

```js
const sock = makeWASocket({
    antiban: {
        preset: 'conservative' // 'conservative' | 'moderate' | 'aggressive'
    },
    auth: state
})
```

## sock.antiban — Stats & Diagnostics

```js
// Full stats from all guards
const stats = sock.antiban.getStats()
console.log(stats)

// Example output:
// {
//   rateLimiter:  { sentLastMinute: 3, sentLastHour: 47, sentToday: 312 },
//   warmup:       { day: 5, dailyLimit: 185, sentToday: 47 },
//   health:       { riskLevel: 'low', paused: false, disconnects: 0 },
//   replyRatio:   { sent: 47, received: 28, ratio: 1.68 },
//   contactGraph: { uniqueContacts: 12 },
//   timelock:     { active: false },
//   reconnect:    { throttleActive: false }
// }
```

### Individual Guards

```js
// Health — is antiban paused due to ban risk?
const health = sock.antiban.health.getStatus()
console.log(health.paused)       // true / false
console.log(health.riskLevel)    // 'low' | 'medium' | 'high' | 'critical'

// Warmup status
const warmup = sock.antiban.warmup.getStatus()
console.log(warmup.day)          // current day (1–7+)
console.log(warmup.dailyLimit)   // today's message limit
console.log(warmup.sentToday)    // messages sent today

// Rate limiter
const rate = sock.antiban.rateLimiter.getStats()
console.log(rate.sentLastMinute) // messages in last minute
console.log(rate.sentLastHour)   // messages in last hour
console.log(rate.sentToday)      // messages today total

// Reply ratio (sent vs received)
const ratio = sock.antiban.replyRatio.getStats()
console.log(ratio.sent)          // sent messages
console.log(ratio.received)      // received messages

// Timelock (463 errors)
const timelock = sock.antiban.timelock.getState()
console.log(timelock.active)     // true if timelock is active
```

### Cleanup on Disconnect

```js
sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'close') {
        sock.antiban.destroy() // cleanly stop all internal timers
    }
})
```

## Error Messages

| Error | Meaning |
|---|---|
| `rate limit exceeded` | Too many messages (minute/hour/day limit) |
| `warm-up daily limit` | New number reached its daily cap |
| `timelock active` | 463 error active, new contacts blocked |
| `health paused` | Ban risk too high, all sends paused |

## Credits

Antiban logic by [@kobie3717](https://github.com/kobie3717) — [baileys-antiban](https://github.com/kobie3717/baileys-antiban)
