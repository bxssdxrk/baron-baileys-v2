'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.decryptMessageNode =
	exports.extractAddressingContext =
	exports.NACK_REASONS =
	exports.DECRYPTION_RETRY_CONFIG =
	exports.MISSING_KEYS_ERROR_TEXT =
	exports.NO_MESSAGE_FOUND_ERROR_TEXT =
	exports.getDecryptionJid =
		void 0
exports.decodeMessageNode = decodeMessageNode
const boom_1 = require('@hapi/boom')
const index_js_1 = require('../../WAProto/index.js')
const WAProto_1 = require('../../WAProto/index.js')
const crypto_1 = require('crypto')
const WABinary_1 = require('../WABinary')
const generics_1 = require('./generics')
const messages_1 = require('./messages')
const baron_hkdf_1 = require("baron-util-js-hkdf")
const BOT_MESSAGE_CONSTANT = "Bot Message";
const KEY_LENGTH = 32;
const MAX_SECRETS_PER_CHAT = 20;
// Module-level map: outgoing @bot message ID → messageSecret
// Populated when we receive the outgoing pkmsg/msg to @bot (which contains messageContextInfo.messageSecret)
// Consumed when the msmsg response from @bot arrives and needs decryption
const botMessageSecrets = new Map();
const botRecentSecretsByChat = new Map();
const pushRecentChatSecret = (chatJid, id, secretBuf) => {
	if (!chatJid || !secretBuf) return
	const existing = botRecentSecretsByChat.get(chatJid) || []
	const filtered = existing.filter(item => item.id !== id && !item.secret.equals(secretBuf))
	filtered.unshift({ id, secret: secretBuf })
	if (filtered.length > MAX_SECRETS_PER_CHAT) {
		filtered.length = MAX_SECRETS_PER_CHAT
	}
	botRecentSecretsByChat.set(chatJid, filtered)
}
const setBotMessageSecret = (id, secret, chatJid) => {
	if (!id || !secret) return
	let buf
	if (Buffer.isBuffer(secret)) {
		buf = secret
	} else if (secret instanceof Uint8Array) {
		buf = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)
	} else if (typeof secret === 'string') {
		buf = Buffer.from(secret, 'base64')
	} else {
		return
	}
	botMessageSecrets.set(id, buf)
	if (chatJid) {
		pushRecentChatSecret(chatJid, id, buf)
	}
}
exports.setBotMessageSecret = setBotMessageSecret
const getDecryptionJid = async (sender, repository) => {
	if ((0, WABinary_1.isLidUser)(sender) || (0, WABinary_1.isHostedLidUser)(sender)) {
		return sender
	}
	const mapped = await repository.lidMapping.getLIDForPN(sender)
	return mapped || sender
}
exports.getDecryptionJid = getDecryptionJid
const storeMappingFromEnvelope = async (stanza, sender, repository, decryptionJid, logger) => {
	// TODO: Handle hosted IDs
	const { senderAlt } = (0, exports.extractAddressingContext)(stanza)
	if (
		senderAlt &&
		(0, WABinary_1.isLidUser)(senderAlt) &&
		(0, WABinary_1.isPnUser)(sender) &&
		decryptionJid === sender
	) {
		try {
			await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }])
			await repository.migrateSession(sender, senderAlt)
			logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope')
		} catch (error) {
			logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping')
		}
	}
}
exports.NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'
exports.MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'
// Retry configuration for failed decryption
exports.DECRYPTION_RETRY_CONFIG = {
	maxRetries: 3,
	baseDelayMs: 100,
	sessionRecordErrors: ['No session record', 'SessionError: No session record']
}
exports.NACK_REASONS = {
	ParsingError: 487,
	UnrecognizedStanza: 488,
	UnrecognizedStanzaClass: 489,
	UnrecognizedStanzaType: 490,
	InvalidProtobuf: 491,
	InvalidHostedCompanionStanza: 493,
	MissingMessageSecret: 495,
	SignalErrorOldCounter: 496,
	MessageDeletedOnPeer: 499,
	UnhandledError: 500,
	UnsupportedAdminRevoke: 550,
	UnsupportedLIDGroup: 551,
	DBOperationFailed: 552
}
const deriveMessageSecret = async (messageSecret) => {
    // Always convert to Buffer to ensure compatibility
    const secretBuffer = Buffer.isBuffer(messageSecret)
        ? messageSecret
        : Buffer.from(messageSecret.buffer, messageSecret.byteOffset, messageSecret.length);
    return await (0, baron_hkdf_1)(secretBuffer, KEY_LENGTH, { salt: undefined, info: BOT_MESSAGE_CONSTANT, hash: "SHA-256" });
};
const buildDecryptionKey = async (messageID, botJID, targetJID, messageSecret) => {
    const derivedSecret = await deriveMessageSecret(messageSecret);
    // Try hex-decoding the message ID — WA stores IDs as hex strings of raw bytes
    const msgIdBuf = /^[0-9A-Fa-f]{32}$/.test(messageID)
        ? Buffer.from(messageID, 'hex')
        : Buffer.from(messageID)
    const useCaseSecret = Buffer.concat([
        msgIdBuf,
        Buffer.from(targetJID),
        Buffer.from(botJID),
        Buffer.from("")
    ]);
    console.log('[buildDecryptionKey]', {
        messageID,
        msgIdBufHex: msgIdBuf.toString('hex'),
        targetJID,
        botJID,
        useCaseSecretHex: useCaseSecret.toString('hex')
    })
    return await (0, baron_hkdf_1)(derivedSecret, KEY_LENGTH, { salt: undefined, info: useCaseSecret, hash: "SHA-256" });
};
const decryptBotMessage = async (encPayload, encIv, messageID, botJID, decryptionKey) => {
    encPayload = Buffer.isBuffer(encPayload) ? encPayload : Buffer.from(encPayload);
    encIv = Buffer.isBuffer(encIv) ? encIv : Buffer.from(encIv);
    decryptionKey = Buffer.isBuffer(decryptionKey) ? decryptionKey : Buffer.from(decryptionKey);
    if (encIv.length !== 12) {
        throw new Error(`IV size incorrect: expected 12, got ${encIv.length}`);
    }
    const authTag = encPayload.slice(-16);
    const encryptedData = encPayload.slice(0, -16);
    if (encryptedData.length < 16) {
        throw new Error(`Encrypted data too short: ${encryptedData.length} bytes`);
    }
    const msgIdBuf = /^[0-9A-Fa-f]{32}$/.test(messageID)
        ? Buffer.from(messageID, 'hex')
        : Buffer.from(messageID)
    const aad = Buffer.concat([
        msgIdBuf,
        Buffer.from([0]),
        Buffer.from(botJID)
    ]);
    console.log('[decryptBotMessage aad]', aad.toString('hex'))
    try {
        const decipher = (0, crypto_1.createDecipheriv)("aes-256-gcm", decryptionKey, encIv);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([
            decipher.update(encryptedData),
            decipher.final()
        ]);
        return decrypted;
    }
    catch (error) {
        console.error("Decrypt - Failed with:", error.message);
        throw error;
    }
};
const decryptMsmsgBotMessage = async (messageSecret, messageKey, msMsg) => {
    try {
		const { targetId, targetIdCandidates, participant: botJID, meId: targetJID, senderJid, conversationJid, meLid } = messageKey;
        if (!botJID || !targetJID || !messageSecret || !msMsg.encPayload || !msMsg.encIv) {
            throw new Error("Missing required components for decryption");
        }
        const encPayload = Buffer.isBuffer(msMsg.encPayload) ? msMsg.encPayload : Buffer.from(msMsg.encPayload)
        const encIv     = Buffer.isBuffer(msMsg.encIv)      ? msMsg.encIv      : Buffer.from(msMsg.encIv)
        const version   = msMsg.version ?? 0
		const targetIdList = [targetId, ...(Array.isArray(targetIdCandidates) ? targetIdCandidates : [])].filter(Boolean)
		const uniqueTargetIds = []
		const seenTargetIds = new Set()
		for (const id of targetIdList) {
			const key = String(id)
			if (!seenTargetIds.has(key)) {
				seenTargetIds.add(key)
				uniqueTargetIds.push(key)
			}
		}
		const msgIdPairs = uniqueTargetIds.length
			? uniqueTargetIds.map(id => ({
				id,
				msgIdBuf: /^[0-9A-Fa-f]{32}$/.test(id) ? Buffer.from(id, 'hex') : Buffer.from(id),
				msgIdAscii: Buffer.from(id)
			}))
			: [{ id: '', msgIdBuf: Buffer.alloc(0), msgIdAscii: Buffer.alloc(0) }]
		const primaryMsgId = msgIdPairs[0]
		console.log('[msmsg proto]', { version, encIvLen: encIv.length, encPayloadLen: encPayload.length, botJID, targetJID, targetId, targetIdCandidates: uniqueTargetIds, senderJid, conversationJid, meLid })

        const msgIdBuf     = primaryMsgId.msgIdBuf
        const msgIdAscii   = primaryMsgId.msgIdAscii
		const botJIDBuf    = Buffer.from(botJID)
		const normalizeLidJid = jid => {
			if (!jid || !jid.endsWith('@lid') || !jid.includes(':')) {
				return jid
			}
			return `${jid.split(':')[0]}@lid`
		}
		const targetJidCandidates = [
			targetJID,
			conversationJid,
			senderJid,
			normalizeLidJid(meLid),
			normalizeLidJid(targetJID)
		].filter(Boolean)
		const seenTargetJids = new Set()
		const targetJidBuffers = []
		for (const jid of targetJidCandidates) {
			const key = String(jid)
			if (!seenTargetJids.has(key)) {
				seenTargetJids.add(key)
				targetJidBuffers.push(Buffer.from(key))
			}
		}
		const meJIDBuf = targetJidBuffers[0] || Buffer.from(targetJID)
		const senderJIDBuf = senderJid ? Buffer.from(senderJid) : Buffer.alloc(0)
        const emptyBuf     = Buffer.alloc(0)

        const secretBuf    = Buffer.isBuffer(messageSecret) ? messageSecret : Buffer.from(messageSecret)
        const derivedSecret = await deriveMessageSecret(secretBuf)

        // Derive 80-byte keys with different constants (WhatsApp dual-key pattern)
        const BOT_CIPHER_KEY_CONST = "WhatsApp Bot Cipher Keys"
        const BOT_SECRET_KEY_CONST = "WhatsApp Bot Message Secret Keys"
        const expand80_cipher = await (0, baron_hkdf_1)(secretBuf, 80, { salt: undefined, info: BOT_CIPHER_KEY_CONST, hash: 'SHA-256' })
        const expand80_secret = await (0, baron_hkdf_1)(secretBuf, 80, { salt: undefined, info: BOT_SECRET_KEY_CONST, hash: 'SHA-256' })
        const expand64_cipher = await (0, baron_hkdf_1)(secretBuf, 64, { salt: undefined, info: BOT_CIPHER_KEY_CONST, hash: 'SHA-256' })
        const expand32_cipher = await (0, baron_hkdf_1)(secretBuf, 32, { salt: undefined, info: BOT_CIPHER_KEY_CONST, hash: 'SHA-256' })
        const expand32_secret = await (0, baron_hkdf_1)(secretBuf, 32, { salt: undefined, info: BOT_SECRET_KEY_CONST, hash: 'SHA-256' })
        const expand32_botmsg = await (0, baron_hkdf_1)(secretBuf, 32, { salt: undefined, info: 'Bot Message', hash: 'SHA-256' })

        // Fixed-constant key sources (no HKDF info = just constant + length)
        const fixedKeySources = [
            ['cipher80-write',  expand80_cipher.slice(0, 32)],
            ['cipher80-read',   expand80_cipher.slice(32, 64)],
            ['cipher80-tail',   expand80_cipher.slice(48, 80)],
            ['secret80-write',  expand80_secret.slice(0, 32)],
            ['secret80-read',   expand80_secret.slice(32, 64)],
            ['cipher64-write',  expand64_cipher.slice(0, 32)],
            ['cipher64-read',   expand64_cipher.slice(32, 64)],
            ['cipher32',        expand32_cipher],
            ['secret32',        expand32_secret],
            ['botmsg32',        expand32_botmsg],
            ['derived32',       derivedSecret],
            ['raw32',           secretBuf],
        ]

        // HKDF infos for the variable-info key sources
        const hkdfInfos = [
            Buffer.concat([msgIdBuf,   meJIDBuf,  botJIDBuf, emptyBuf]),
            Buffer.concat([msgIdBuf,   botJIDBuf, meJIDBuf,  emptyBuf]),
            Buffer.concat([msgIdBuf,   botJIDBuf, emptyBuf]),
            Buffer.concat([msgIdAscii, meJIDBuf,  botJIDBuf, emptyBuf]),
            Buffer.concat([msgIdAscii, botJIDBuf, meJIDBuf,  emptyBuf]),
            Buffer.concat([msgIdAscii, botJIDBuf, emptyBuf]),
            Buffer.concat([meJIDBuf,   botJIDBuf, emptyBuf]),
            Buffer.concat([botJIDBuf,  meJIDBuf,  emptyBuf]),
            msgIdBuf,
            msgIdAscii,
            emptyBuf,
        ]

		for (const pair of msgIdPairs.slice(1)) {
			hkdfInfos.push(Buffer.concat([pair.msgIdBuf, meJIDBuf, botJIDBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([pair.msgIdBuf, botJIDBuf, meJIDBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([pair.msgIdBuf, botJIDBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([pair.msgIdAscii, meJIDBuf, botJIDBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([pair.msgIdAscii, botJIDBuf, meJIDBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([pair.msgIdAscii, botJIDBuf, emptyBuf]))
			hkdfInfos.push(pair.msgIdBuf)
			hkdfInfos.push(pair.msgIdAscii)
		}

		for (const targetBuf of targetJidBuffers) {
			hkdfInfos.push(Buffer.concat([msgIdBuf, targetBuf, botJIDBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([msgIdBuf, botJIDBuf, targetBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([msgIdAscii, targetBuf, botJIDBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([msgIdAscii, botJIDBuf, targetBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([targetBuf, botJIDBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([botJIDBuf, targetBuf, emptyBuf]))
			hkdfInfos.push(Buffer.concat([msgIdBuf, targetBuf]))
			hkdfInfos.push(Buffer.concat([msgIdAscii, targetBuf]))
			if (senderJid) {
				hkdfInfos.push(Buffer.concat([msgIdBuf, targetBuf, senderJIDBuf, botJIDBuf, emptyBuf]))
				hkdfInfos.push(Buffer.concat([msgIdAscii, targetBuf, senderJIDBuf, botJIDBuf, emptyBuf]))
			}
		}

        const aadOptions = [
            emptyBuf,
            Buffer.concat([msgIdBuf,   Buffer.from([0]), botJIDBuf]),
            Buffer.concat([msgIdAscii, Buffer.from([0]), botJIDBuf]),
            Buffer.concat([botJIDBuf,  Buffer.from([0]), msgIdBuf]),
            msgIdBuf,
            msgIdAscii,
            botJIDBuf,
            meJIDBuf,
            ...(senderJid ? [senderJIDBuf, Buffer.concat([msgIdBuf, senderJIDBuf]), Buffer.concat([senderJIDBuf, botJIDBuf])] : []),
        ]

		const separatorBytes = [Buffer.from([0]), Buffer.from([1]), Buffer.from([version & 0xff])]
		for (const pair of msgIdPairs) {
			for (const sep of separatorBytes) {
				aadOptions.push(Buffer.concat([pair.msgIdBuf, sep, botJIDBuf]))
				aadOptions.push(Buffer.concat([pair.msgIdAscii, sep, botJIDBuf]))
				aadOptions.push(Buffer.concat([botJIDBuf, sep, pair.msgIdBuf]))
				aadOptions.push(Buffer.concat([botJIDBuf, sep, pair.msgIdAscii]))
				if (senderJid) {
					aadOptions.push(Buffer.concat([pair.msgIdBuf, sep, senderJIDBuf]))
					aadOptions.push(Buffer.concat([pair.msgIdAscii, sep, senderJIDBuf]))
				}
			}
		}

		for (const targetBuf of targetJidBuffers) {
			aadOptions.push(targetBuf)
			aadOptions.push(Buffer.concat([msgIdBuf, Buffer.from([0]), targetBuf]))
			aadOptions.push(Buffer.concat([msgIdAscii, Buffer.from([0]), targetBuf]))
			aadOptions.push(Buffer.concat([msgIdBuf, Buffer.from([0]), botJIDBuf, targetBuf]))
			aadOptions.push(Buffer.concat([msgIdAscii, Buffer.from([0]), botJIDBuf, targetBuf]))
			aadOptions.push(Buffer.concat([targetBuf, Buffer.from([0]), botJIDBuf]))
			aadOptions.push(Buffer.concat([botJIDBuf, Buffer.from([0]), targetBuf]))
			if (senderJid) {
				aadOptions.push(Buffer.concat([msgIdBuf, Buffer.from([0]), senderJIDBuf, targetBuf]))
				aadOptions.push(Buffer.concat([targetBuf, Buffer.from([0]), senderJIDBuf, botJIDBuf]))
			}
		}

		const tryDecrypt = async (key, aad, tagFirst, label) => {
			const authTag    = tagFirst ? encPayload.slice(0, 16) : encPayload.slice(-16)
			const ciphertext = tagFirst ? encPayload.slice(16)    : encPayload.slice(0, -16)
			try {
				const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', key, encIv)
				decipher.setAAD(aad)
				decipher.setAuthTag(authTag)
				const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
				console.log(`[msmsg] SUCCEEDED: ${label}`)
				return decrypted
			} catch (e) {
				return null 
			}
		}

        let stratNum = 0

		// Phase 1: fixed-constant keys × AADs × tag positions
		for (const [kLabel, key] of fixedKeySources) {
			for (const [ai, aad] of aadOptions.entries()) {
				for (const tagFirst of [false, true]) {
					stratNum++
					const result = await tryDecrypt(key, aad, tagFirst, `fixed key=${kLabel} aad=${ai} tagFirst=${tagFirst}`)
					if (result) return result
				}
				// also try without auth tag
				stratNum++
				try {
					const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', key, encIv)
					decipher.setAAD(aad)
					const decrypted = Buffer.concat([decipher.update(encPayload), decipher.final()])
					console.log(`[msmsg] SUCCEEDED (no authTag): fixed key=${kLabel} aad=${ai}`)
					return decrypted
				} catch (e) {
					// Try with 16-byte auth tag trimmed (for corrupted/missing auth tag)
					stratNum++
					try {
						const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', key, encIv)
						decipher.setAAD(aad)
						const decrypted = Buffer.concat([decipher.update(encPayload.slice(0, -16)), decipher.final()])
						console.log(`[msmsg] SUCCEEDED (no authTag, trimmed): fixed key=${kLabel} aad=${ai}`)
						return decrypted
					} catch {}
				}
			}
		}

        // Phase 2: variable-info HKDF (1-step from secret, 2-step from derived) × AADs
        const varKeySources = [
            ['1step', (info) => (0, baron_hkdf_1)(secretBuf,    KEY_LENGTH, { salt: undefined, info, hash: 'SHA-256' })],
            ['2step', (info) => (0, baron_hkdf_1)(derivedSecret, KEY_LENGTH, { salt: undefined, info, hash: 'SHA-256' })],
        ]
        for (const [kLabel, derive] of varKeySources) {
            for (let ii = 0; ii < hkdfInfos.length; ii++) {
                const key = await derive(hkdfInfos[ii])
                for (const [ai, aad] of aadOptions.entries()) {
                    for (const tagFirst of [false, true]) {
                        stratNum++
                        const result = await tryDecrypt(key, aad, tagFirst, `var key=${kLabel} info=${ii} aad=${ai} tagFirst=${tagFirst}`)
                        if (result) return result
                    }
					stratNum++
					try {
						const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', key, encIv)
						decipher.setAAD(aad)
						const decrypted = Buffer.concat([decipher.update(encPayload), decipher.final()])
						console.log(`[msmsg] SUCCEEDED (no authTag): var key=${kLabel} info=${ii} aad=${ai}`)
						return decrypted
					} catch (e) {
						stratNum++
						try {
							const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', key, encIv)
							decipher.setAAD(aad)
							const decrypted = Buffer.concat([decipher.update(encPayload.slice(0, -16)), decipher.final()])
							console.log(`[msmsg] SUCCEEDED (no authTag, trimmed): var key=${kLabel} info=${ii} aad=${ai}`)
							return decrypted
						} catch {}
					}
                }
            }
        }

		// Phase 3: Emergency fallback - try with just secret/derived keys and minimal AAD
		console.warn('[msmsg] Attempting emergency fallback strategies...')
		const emergencyKeyResults = await Promise.all([
			(0, baron_hkdf_1)(secretBuf, 32, { salt: Buffer.alloc(0), info: msgIdBuf, hash: 'SHA-256' }),
			(0, baron_hkdf_1)(derivedSecret, 32, { salt: Buffer.alloc(0), info: msgIdBuf, hash: 'SHA-256' }),
			(0, baron_hkdf_1)(secretBuf, 32, { salt: msgIdBuf, info: Buffer.alloc(0), hash: 'SHA-256' }),
			(0, baron_hkdf_1)(secretBuf, 32, { salt: botJIDBuf, info: msgIdBuf, hash: 'SHA-256' }),
		])
		const emergencyKeys = [
			['raw_secret', secretBuf],
			['derived_secret', derivedSecret],
			['emergency_0', emergencyKeyResults[0]],
			['emergency_1', emergencyKeyResults[1]],
			['emergency_2', emergencyKeyResults[2]],
			['emergency_3', emergencyKeyResults[3]],
		]

		for (const [kLabel, key] of emergencyKeys) {
			for (const [ai, aad] of aadOptions.entries()) {
				for (const tagFirst of [false, true]) {
					stratNum++
					const result = await tryDecrypt(key, aad, tagFirst, `emergency key=${kLabel} aad=${ai} tagFirst=${tagFirst}`)
					if (result) return result
				}
			}
		}

		console.warn(`[msmsg] Emergency strategies also failed. Total: ${stratNum} attempts`)
		console.warn('[msmsg] Debuggable info:', {
			secretHex: secretBuf.toString('hex'),
			targetId,
			targetIdHexBuf: msgIdBuf.toString('hex'),
			botJIDHex: botJIDBuf.toString('hex'),
			meJIDHex: meJIDBuf.toString('hex'),
			encIvLength: encIv.length,
			encPayloadLength: encPayload.length,
			authTagHex: encPayload.slice(-16).toString('hex')
		})
		throw new Error(`All decryption strategies failed (${stratNum} attempts)`)
    }
    catch (error) {
        console.error("Failed to decrypt bot message:", error.message);
        throw error;
    }
};
const decryptBotMsg = async (content, { messageKey, messageSecret }) => {
    try {
        const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content)
        console.log('[msmsg raw content]', {
            len: contentBuf.length,
            first32hex: contentBuf.slice(0, 32).toString('hex'),
            secretHex: Buffer.from(messageSecret).toString('hex')
        })
        const msMsg = WAProto_1.proto.MessageSecretMessage.decode(content);
        console.log('[msmsg decoded]', {
            version: msMsg.version,
            encIvHex: msMsg.encIv ? Buffer.from(msMsg.encIv).toString('hex') : null,
            encPayloadFirst16: msMsg.encPayload ? Buffer.from(msMsg.encPayload).slice(0, 16).toString('hex') : null,
            encPayloadLast16:  msMsg.encPayload ? Buffer.from(msMsg.encPayload).slice(-16).toString('hex') : null,
        })
        return await decryptMsmsgBotMessage(messageSecret, messageKey, msMsg);
    }
    catch (error) {
        console.error("Error in decryptBotMsg:", error);
        throw error;
    }
};

const extractAddressingContext = stanza => {
	let senderAlt
	let recipientAlt
	const sender = stanza.attrs.participant || stanza.attrs.from
	const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn')
	if (addressingMode === 'lid') {
		// Message is LID-addressed: sender is LID, extract corresponding PN
		// without device data
		senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn
		recipientAlt = stanza.attrs.recipient_pn
		// with device data
		//if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
	} else {
		// Message is PN-addressed: sender is PN, extract corresponding LID
		// without device data
		senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid
		recipientAlt = stanza.attrs.recipient_lid
		//with device data
		//if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
	}
	return {
		addressingMode,
		senderAlt,
		recipientAlt
	}
}
exports.extractAddressingContext = extractAddressingContext
/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
function decodeMessageNode(stanza, meId, meLid) {
	let msgType
	let chatId
	let author
	let fromMe = false
	const msgId = stanza.attrs.id
	const from = stanza.attrs.from
	const participant = stanza.attrs.participant
	const recipient = stanza.attrs.recipient
	const addressingContext = (0, exports.extractAddressingContext)(stanza)
	const isMe = jid => (0, WABinary_1.areJidsSameUser)(jid, meId)
	const isMeLid = jid => (0, WABinary_1.areJidsSameUser)(jid, meLid)
	if (
		(0, WABinary_1.isPnUser)(from) ||
		(0, WABinary_1.isLidUser)(from) ||
		(0, WABinary_1.isHostedLidUser)(from) ||
		(0, WABinary_1.isHostedPnUser)(from)
	) {
		if (recipient) {
			if (!isMe(from) && !isMeLid(from)) {
				throw new boom_1.Boom('receipient present, but msg not from me', { data: stanza })
			}
			if (isMe(from) || isMeLid(from)) {
				fromMe = true
			}
			chatId = recipient
		} else {
			chatId = from
		}
		msgType = 'chat'
		author = from
	} else if ((0, WABinary_1.isJidGroup)(from)) {
		if (!participant) {
			throw new boom_1.Boom('No participant in group message')
		}
		if (isMe(participant) || isMeLid(participant)) {
			fromMe = true
		}
		msgType = 'group'
		author = participant
		chatId = from
	} else if ((0, WABinary_1.isJidBroadcast)(from)) {
		if (!participant) {
			throw new boom_1.Boom('No participant in group message')
		}
		const isParticipantMe = isMe(participant)
		if ((0, WABinary_1.isJidStatusBroadcast)(from)) {
			msgType = isParticipantMe ? 'direct_peer_status' : 'other_status'
		} else {
			msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast'
		}
		fromMe = isParticipantMe
		chatId = from
		author = participant
	} else if ((0, WABinary_1.isJidMetaAI)(from)) {
		msgType = 'chat'
		chatId = from
		author = from
		fromMe = false
	} else if ((0, WABinary_1.isJidNewsletter)(from)) {
		msgType = 'newsletter'
		chatId = from
		author = from
		// if (isMe(from) || isMeLid(from)) {
		// 	fromMe = true
		// }
		
    fromMe = (0, WABinary_1.isJidNewsletter)(from)
      ? !!stanza.attrs?.is_sender
      : (0, WABinary_1.isLidUser)(from)
        ? (0, WABinary_1.areJidsSameUser)(from, meLid)
        : (0, WABinary_1.areJidsSameUser)(from, meId);
	} else {
		throw new boom_1.Boom('Unknown message type', { data: stanza })
	}
	const pushname = stanza?.attrs?.notify
	const key = {
		remoteJid: chatId,
		remoteJidAlt: !(0, WABinary_1.isJidGroup)(chatId) ? addressingContext.senderAlt : undefined,
		fromMe,
		id: msgId,
		participant,
		participantAlt: (0, WABinary_1.isJidGroup)(chatId) ? addressingContext.senderAlt : undefined,
		addressingMode: addressingContext.addressingMode,
		...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
	}
	const fullMessage = {
		key,
		category: stanza.attrs.category,
		messageTimestamp: +stanza.attrs.t,
		pushName: pushname,
		broadcast: (0, WABinary_1.isJidBroadcast)(from),
		newsletter: (0, WABinary_1.isJidNewsletter)(from),
		StanzaAttrs: stanza.attrs,
		Owner: 'Baron' // Non-WhatsApp attribute
	}
	if (key.fromMe) {
		fullMessage.status = index_js_1.proto.WebMessageInfo.Status.SERVER_ACK
	}
	if (msgType === 'newsletter') {
		fullMessage.newsletter_server_id = +stanza.attrs?.server_id
	}
	if (!key.fromMe) {
		fullMessage.platform = messages_1.getDevice(key.id)
	}
	return {
		fullMessage,
		author,
		sender: msgType === 'chat' ? author : chatId
	}
}
const decryptMessageNode = (stanza, meId, meLid, repository, logger) => {
	const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
	let metaTargetId = null;
    let botEditTargetId = null;
    let botType = null;
    let metaTargetSenderJid = null;
	return {
		fullMessage,
		category: stanza.attrs.category,
		author,
		async decrypt() {
			let decryptables = 0
			if (Array.isArray(stanza.content)) {
				 let hasMsmsg = false;
                for (const { attrs } of stanza.content) {
                    if ((attrs === null || attrs === void 0 ? void 0 : attrs.type) === 'msmsg') {
                        hasMsmsg = true;
                        break;
                    }
                }
                if (hasMsmsg) {
                    for (const { tag, attrs } of stanza.content) {
                        if (tag === 'meta' && attrs?.target_id) {
                            metaTargetId = attrs.target_id;
                        }
                        if (tag === 'meta' && attrs?.target_sender_jid) {
                            metaTargetSenderJid = attrs.target_sender_jid;
                        }
                        if (tag === 'bot' && attrs && 'edit_target_id' in attrs) {
                            botEditTargetId = attrs.edit_target_id;  // Can be '' for 'first' type
                        }
                        if (tag === 'bot' && (attrs === null || attrs === void 0 ? void 0 : attrs.edit)) {
                            botType = attrs.edit;
                        }
                    }
                }

				for (const { tag, attrs, content } of stanza.content) {
					if (tag === 'verified_name' && content instanceof Uint8Array) {
						const cert = index_js_1.proto.VerifiedNameCertificate.decode(content)
						const details = index_js_1.proto.VerifiedNameCertificate.Details.decode(cert.details)
						fullMessage.verifiedBizName = details.verifiedName
					}
					if (tag === 'unavailable' && attrs.type === 'view_once') {
						fullMessage.key.isViewOnce = true // TODO: remove from here and add a STUB TYPE
					}
					if (attrs.count && tag === 'enc') {
						fullMessage.retryCount = Number(attrs.count)
					}
					if (tag !== 'enc' && tag !== 'plaintext') {
						continue
					}
					if (!(content instanceof Uint8Array)) {
						continue
					}
					decryptables += 1
					let msgBuffer
					const decryptionJid = await (0, exports.getDecryptionJid)(author, repository)
					if (tag !== 'plaintext') {
						// TODO: Handle hosted devices
						await storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger)
					}
					try {
							const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type
						switch (e2eType) {

							case 'skmsg':
								msgBuffer = await repository.decryptGroupMessage({
									group: sender,
									authorJid: author,
									msg: content
								})
								break

							case 'pkmsg':
							case 'msg':
								msgBuffer = await repository.decryptMessage({
									jid: decryptionJid,
									type: e2eType,
									ciphertext: content
								})
								break
 case 'msmsg': //Message Secret Message
                              if (!['full', 'last'].includes(botType)) return;
                                const secretIdCandidates = [
									botEditTargetId,
									metaTargetId,
									fullMessage.key?.id
								].filter(Boolean)
								const secretCandidates = []
								const seenSecrets = new Set()
								for (const idCandidate of secretIdCandidates) {
									const byId = botMessageSecrets.get(idCandidate)
									if (!byId) continue
									const fp = byId.toString('hex')
									if (!seenSecrets.has(fp)) {
										seenSecrets.add(fp)
										secretCandidates.push({ source: `id:${idCandidate}`, secret: byId })
									}
								}
								const chatRecent = botRecentSecretsByChat.get(sender) || []
								for (const item of chatRecent) {
									const fp = item.secret.toString('hex')
									if (!seenSecrets.has(fp)) {
										seenSecrets.add(fp)
										secretCandidates.push({ source: `chat:${item.id}`, secret: item.secret })
									}
									if (secretCandidates.length >= 6) break
								}
                                console.log('[msmsg case]', { metaTargetId, botType, botEditTargetId, metaTargetSenderJid, meLid, secretIdCandidates, secretCandidates: secretCandidates.map(s => s.source) })
                                if (!secretCandidates.length) {
                                    logger.warn({ metaTargetId, botType, secretIdCandidates }, 'msmsg: no candidate messageSecret found, skipping');
                                    return;
                                }
                                {
                                    const botJID = author;
                                    const resolvedMeId = metaTargetSenderJid
                                        ? metaTargetSenderJid
                                        : `${meLid.split(`:`)[0]}@lid`;
                                    const newkey = {
                                        participant: botJID,
                                        meId: resolvedMeId,
										targetId: botEditTargetId || metaTargetId,
						targetIdCandidates: secretIdCandidates,
						senderJid: metaTargetSenderJid,
						conversationJid: sender,
						meLid
                                    };
								let decryptErr
								for (const candidate of secretCandidates) {
									try {
										msgBuffer = await decryptBotMsg(content, {
											messageKey: newkey,
											messageSecret: candidate.secret
										});
										console.log('[msmsg] secret candidate success:', candidate.source)
										break
									} catch (e) {
										decryptErr = e
									}
								}
								if (!msgBuffer && decryptErr) {
									throw decryptErr
								}
                                }
                                break;
							case 'plaintext':
								msgBuffer = content
								break
							default:
								throw new Error(`Unknown e2e type: ${e2eType}`)
						}
						let msgToDecode
						if (e2eType === 'msmsg') {
							// Bot messages (AES-GCM): try unpad first, fall back to raw if unpad corrupts the proto
							try {
								const unpadded = (0, generics_1.unpadRandomMax16)(msgBuffer)
								const testDecode = index_js_1.proto.Message.decode(unpadded)
								const hasContent = Object.keys(testDecode).some(k => k !== 'messageContextInfo' && testDecode[k] != null)
								if (hasContent) {
									console.log('[msmsg] unpad+decode OK, contentKey:', Object.keys(testDecode).filter(k => k !== 'messageContextInfo'))
									msgToDecode = unpadded
								} else {
									console.log('[msmsg] unpad gave empty message, trying raw buffer')
									msgToDecode = msgBuffer
								}
							} catch (unpadErr) {
								console.log('[msmsg] unpad failed, using raw buffer:', unpadErr.message)
								msgToDecode = msgBuffer
							}
						} else {
							msgToDecode = e2eType !== 'plaintext' ? (0, generics_1.unpadRandomMax16)(msgBuffer) : msgBuffer
						}
						let msg = index_js_1.proto.Message.decode(msgToDecode)
						if (e2eType === 'msmsg') {
							console.log('[msmsg] final decoded keys:', Object.keys(msg))
						}
						if (false) {
						}
						const outerMessageContextInfo = msg.messageContextInfo
						msg = msg.deviceSentMessage?.message || msg
						// deviceSentMessage.message may not carry messageContextInfo (e.g. messageSecret for @bot)
						// even though the outer wrapper does — preserve it
						if (outerMessageContextInfo && !msg.messageContextInfo) {
							msg.messageContextInfo = outerMessageContextInfo
						}
						if (msg.senderKeyDistributionMessage) {
							//eslint-disable-next-line max-depth
							try {
								await repository.processSenderKeyDistributionMessage({
									authorJid: author,
									item: msg.senderKeyDistributionMessage
								})
							} catch (err) {
								logger.error({ key: fullMessage.key, err }, 'failed to process sender key distribution message')
							}
						}
						if (fullMessage.message) {
							Object.assign(fullMessage.message, msg)
						} else {
							fullMessage.message = msg
						}
						// Auto-decode richResponseMessage text so m.msg.text is populated
						{
							const rich = fullMessage.message?.richResponseMessage
							if (rich && !rich.text) {
								const decoded = decodeRichResponseMessage(rich)
								if (decoded) rich.text = decoded
							}
							const editedRich = fullMessage.message?.protocolMessage?.editedMessage?.richResponseMessage
							if (editedRich && !editedRich.text) {
								const decoded = decodeRichResponseMessage(editedRich)
								if (decoded) editedRich.text = decoded
							}
						}
						// Save messageSecret for any message (AI group server may set it on any message)
						{
							const secret = msg.messageContextInfo?.messageSecret
							if (secret) {
								const secretBuf = Buffer.isBuffer(secret) ? secret : Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)
								setBotMessageSecret(fullMessage.key.id, secretBuf, fullMessage.key.remoteJid)
							}
						}
					} catch (err) {
						const errorContext = {
							key: fullMessage.key,
							err,
							messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
							sender,
							author,
							isSessionRecordError: isSessionRecordError(err)
						}
						logger.error(errorContext, 'failed to decrypt message')
						fullMessage.messageStubType = index_js_1.proto.WebMessageInfo.StubType.CIPHERTEXT
						fullMessage.messageStubParameters = [err.message.toString()]
					}
				}
			}
			// if nothing was found to decrypt
			if (!decryptables && !fullMessage.key?.isViewOnce) {
				fullMessage.messageStubType = index_js_1.proto.WebMessageInfo.StubType.CIPHERTEXT
				fullMessage.messageStubParameters = [exports.NO_MESSAGE_FOUND_ERROR_TEXT]
			}
		}
	}
}
exports.decryptMessageNode = decryptMessageNode
/**
 * Decode text content from a richResponseMessage (Meta AI).
 * Tries submessages first, then parses base64 JSON from unifiedResponse.data.
 * Returns the extracted text string or '' on failure.
 */
function decodeRichResponseMessage(richMsg) {
	try {
		if (!richMsg) return ''
		if (Array.isArray(richMsg.submessages) && richMsg.submessages.length > 0) {
			const sub = richMsg.submessages.map(s => s.messageText).filter(Boolean).join('\n')
			if (sub) return sub
		}
		const data = richMsg.unifiedResponse?.data
		if (!data) return ''
		const json = JSON.parse(Buffer.from(data, 'base64').toString('utf8'))
		const texts = []
		for (const section of (json.sections || [])) {
			const prim = section?.view_model?.primitive
			if (prim?.text) texts.push(prim.text)
			if (prim?.header) texts.push(prim.header)
			for (const sub of (section?.view_model?.items || [])) {
				if (sub?.primitive?.text) texts.push(sub.primitive.text)
			}
		}
		return texts.join('\n')
	} catch (e) {
		return ''
	}
}
/**
 * Utility function to check if an error is related to missing session record
 */
function isSessionRecordError(error) {
	const errorMessage = error?.message || error?.toString() || ''
	return exports.DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(errorPattern => errorMessage.includes(errorPattern))
}
