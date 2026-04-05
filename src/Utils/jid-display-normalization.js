'use strict'

Object.defineProperty(exports, '__esModule', { value: true })
exports.normalizeMessageForDisplayJids = void 0
exports.normalizeMentionedJidsForSend = void 0

const WABinary_1 = require('../WABinary')

const fallbackPnFromLidJid = jid => {
	const decoded = (0, WABinary_1.jidDecode)(jid)
	const rawUser = decoded?.user || (typeof jid === 'string' ? jid.split('@')[0] : '')
	const user = rawUser.split(':')[0]
	if (!user) {
		return jid
	}
	return `${user}@s.whatsapp.net`
}

const toDisplayPnJid = jid => {
	if (!jid || typeof jid !== 'string') {
		return jid
	}
	const decoded = (0, WABinary_1.jidDecode)(jid)
	if (!decoded?.user) {
		return jid
	}
	if (!(0, WABinary_1.isPnUser)(jid) && !(0, WABinary_1.isHostedPnUser)(jid)) {
		return jid
	}
	const user = decoded.user.split(':')[0]
	if (!user) {
		return jid
	}
	const server = decoded.server === 'hosted' ? 'hosted' : 's.whatsapp.net'
	return `${user}@${server}`
}

const buildLidPnHints = key => {
	const hints = new Map()
	if (!key) {
		return hints
	}
	const addHint = (lid, pn) => {
		if (!(0, WABinary_1.isLidUser)(lid) && !(0, WABinary_1.isHostedLidUser)(lid)) {
			return
		}
		if (!(0, WABinary_1.isPnUser)(pn) && !(0, WABinary_1.isHostedPnUser)(pn)) {
			return
		}
		hints.set(lid, pn)
		const lidDecoded = (0, WABinary_1.jidDecode)(lid)
		const pnDecoded = (0, WABinary_1.jidDecode)(pn)
		if (lidDecoded?.user && pnDecoded?.user) {
			hints.set(`${lidDecoded.user}@lid`, `${pnDecoded.user}@s.whatsapp.net`)
		}
	}
	addHint(key.participant, key.participantAlt)
	addHint(key.remoteJid, key.remoteJidAlt)
	addHint(key.participantAlt, key.participant)
	addHint(key.remoteJidAlt, key.remoteJid)
	return hints
}

const normalizeToPnJid = async (jid, hints, signalRepository) => {
	if (!jid || typeof jid !== 'string') {
		return jid
	}
	if (!(0, WABinary_1.isLidUser)(jid) && !(0, WABinary_1.isHostedLidUser)(jid)) {
		return jid
	}
	const hinted = hints.get(jid)
	if (hinted) {
		return toDisplayPnJid(hinted)
	}
	const decoded = (0, WABinary_1.jidDecode)(jid)
	if (decoded?.user) {
		const userHint = hints.get(`${decoded.user}@lid`)
		if (userHint) {
			return userHint
		}
	}
	const mapped = await signalRepository?.lidMapping?.getPNForLID?.(jid)
	if (mapped) {
		return toDisplayPnJid(mapped)
	}
	return fallbackPnFromLidJid(jid)
}

const normalizeMentionedJidsToPn = async (node, hints, signalRepository) => {
	if (!node || typeof node !== 'object') {
		return
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			await normalizeMentionedJidsToPn(item, hints, signalRepository)
		}
		return
	}
	if (Array.isArray(node.mentionedJid)) {
		node.mentionedJid = await Promise.all(node.mentionedJid.map(jid => normalizeToPnJid(jid, hints, signalRepository)))
	}
	for (const value of Object.values(node)) {
		if (value && typeof value === 'object') {
			await normalizeMentionedJidsToPn(value, hints, signalRepository)
		}
	}
}

const normalizeMentionedJidsForSend = async (mentions, groupData, signalRepository) => {
	if (!Array.isArray(mentions)) {
		return mentions
	}
	const hints = new Map()
	if (groupData?.participants?.length) {
		for (const participant of groupData.participants) {
			const lid = participant?.id
			const pn = participant?.phoneNumber
			if (
				((0, WABinary_1.isLidUser)(lid) || (0, WABinary_1.isHostedLidUser)(lid)) &&
				((0, WABinary_1.isPnUser)(pn) || (0, WABinary_1.isHostedPnUser)(pn))
			) {
				hints.set(lid, toDisplayPnJid(pn))
				const lidDecoded = (0, WABinary_1.jidDecode)(lid)
				if (lidDecoded?.user) {
					hints.set(`${lidDecoded.user}@lid`, toDisplayPnJid(pn))
				}
			}
		}
	}
	return Promise.all(mentions.map(jid => normalizeToPnJid(jid, hints, signalRepository)))
}

const normalizeMessageForDisplayJids = async (messageInfo, signalRepository) => {
	if (!messageInfo?.key) {
		return messageInfo
	}
	const hints = buildLidPnHints(messageInfo.key)
	messageInfo.key.participant = await normalizeToPnJid(messageInfo.key.participant, hints, signalRepository)
	messageInfo.key.participantAlt = await normalizeToPnJid(messageInfo.key.participantAlt, hints, signalRepository)
	messageInfo.key.remoteJid = await normalizeToPnJid(messageInfo.key.remoteJid, hints, signalRepository)
	messageInfo.key.remoteJidAlt = await normalizeToPnJid(messageInfo.key.remoteJidAlt, hints, signalRepository)
	await normalizeMentionedJidsToPn(messageInfo.message, hints, signalRepository)
	return messageInfo
}

exports.normalizeMessageForDisplayJids = normalizeMessageForDisplayJids
exports.normalizeMentionedJidsForSend = normalizeMentionedJidsForSend
