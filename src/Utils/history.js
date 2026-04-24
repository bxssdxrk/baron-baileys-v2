'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.getHistoryMsg =
	exports.downloadAndProcessHistorySyncNotification =
	exports.processHistoryMessage =
	exports.downloadHistory =
		void 0
const util_1 = require('util')
const zlib_1 = require('zlib')
const index_js_1 = require('../../WAProto/index.js')
const Types_1 = require('../Types')
const WABinary_1 = require('../WABinary')
const generics_1 = require('./generics')
const messages_1 = require('./messages')
const messages_media_1 = require('./messages-media')
const inflatePromise = (0, util_1.promisify)(zlib_1.inflate)
const extractPnFromMessages = messages => {
	for (const msgItem of messages) {
		const message = msgItem.message
		// Only extract from outgoing messages (fromMe: true) in 1:1 chats
		// because userReceipt.userJid is the recipient's JID
		if (!message?.key?.fromMe || !message.userReceipt?.length) {
			continue
		}
		const userJid = message.userReceipt[0]?.userJid
		if (userJid && ((0, WABinary_1.isPnUser)(userJid) || (0, WABinary_1.isHostedPnUser)(userJid))) {
			return userJid
		}
	}
	return undefined
}
const downloadHistory = async (msg, options) => {
	const stream = await (0, messages_media_1.downloadContentFromMessage)(msg, 'md-msg-hist', { options })
	const bufferArray = []
	for await (const chunk of stream) {
		bufferArray.push(chunk)
	}
	let buffer = Buffer.concat(bufferArray)
	// decompress buffer
	buffer = await inflatePromise(buffer)
	const syncData = index_js_1.proto.HistorySync.decode(buffer)
	return syncData
}
exports.downloadHistory = downloadHistory
const processHistoryMessage = (item, logger) => {
	const messages = []
	const contacts = []
	const chats = []
	const lidPnMappings = []
	logger?.trace({ progress: item.progress }, 'processing history of type ' + item.syncType?.toString())
	// Extract LID-PN mappings for all sync types
	for (const m of item.phoneNumberToLidMappings || []) {
		if (m.lidJid && m.pnJid) {
			lidPnMappings.push({ lid: m.lidJid, pn: m.pnJid })
		}
	}
	switch (item.syncType) {
		case index_js_1.proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
		case index_js_1.proto.HistorySync.HistorySyncType.RECENT:
		case index_js_1.proto.HistorySync.HistorySyncType.FULL:
		case index_js_1.proto.HistorySync.HistorySyncType.ON_DEMAND:
			for (const chat of item.conversations) {
				contacts.push({
					id: chat.id,
					name: chat.displayName || chat.name || chat.username || undefined,
					username: chat.username || undefined,
					lid: chat.lidJid || chat.accountLid || undefined,
					phoneNumber: chat.pnJid || undefined
				})
				const chatId = chat.id
				const isLid = (0, WABinary_1.isLidUser)(chatId) || (0, WABinary_1.isHostedLidUser)(chatId)
				const isPn = (0, WABinary_1.isPnUser)(chatId) || (0, WABinary_1.isHostedPnUser)(chatId)
				if (isLid && chat.pnJid) {
					lidPnMappings.push({ lid: chatId, pn: chat.pnJid })
				} else if (isPn && chat.lidJid) {
					lidPnMappings.push({ lid: chat.lidJid, pn: chatId })
				} else if (isLid && !chat.pnJid) {
					// Fallback: extract PN from userReceipt in messages when pnJid is missing
					const pnFromReceipt = extractPnFromMessages(chat.messages || [])
					if (pnFromReceipt) {
						lidPnMappings.push({ lid: chatId, pn: pnFromReceipt })
					}
				}
				const msgs = chat.messages || []
				delete chat.messages
				for (const item of msgs) {
					const message = item.message
					messages.push(message)
					if (!chat.messages?.length) {
						// keep only the most recent message in the chat array
						chat.messages = [{ message }]
					}
					if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) {
						chat.lastMessageRecvTimestamp = (0, generics_1.toNumber)(message.messageTimestamp)
					}
					if (
						(message.messageStubType === Types_1.WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP ||
							message.messageStubType === Types_1.WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
						message.messageStubParameters?.[0]
					) {
						contacts.push({
							id: message.key.participant || message.key.remoteJid,
							verifiedName: message.messageStubParameters?.[0]
						})
					}
				}
				chats.push({ ...chat })
			}
			break
		case index_js_1.proto.HistorySync.HistorySyncType.PUSH_NAME:
			for (const c of item.pushnames) {
				contacts.push({ id: c.id, notify: c.pushname })
			}
			break
	}
	return {
		chats,
		contacts,
		messages,
		lidPnMappings,
		syncType: item.syncType,
		progress: item.progress
	}
}
exports.processHistoryMessage = processHistoryMessage
const downloadAndProcessHistorySyncNotification = async (msg, options, logger) => {
	let historyMsg
	if (msg.initialHistBootstrapInlinePayload) {
		historyMsg = index_js_1.proto.HistorySync.decode(await inflatePromise(msg.initialHistBootstrapInlinePayload))
	} else {
		historyMsg = await (0, exports.downloadHistory)(msg, options)
	}
	return (0, exports.processHistoryMessage)(historyMsg, logger)
}
exports.downloadAndProcessHistorySyncNotification = downloadAndProcessHistorySyncNotification
const getHistoryMsg = message => {
	const normalizedContent = !!message ? (0, messages_1.normalizeMessageContent)(message) : undefined
	const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification
	return anyHistoryMsg
}
exports.getHistoryMsg = getHistoryMsg
