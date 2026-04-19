'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.assertMediaContent =
	exports.downloadMediaMessage =
	exports.aggregateMessageKeysNotFromMe =
	exports.updateMessageWithEventResponse =
	exports.updateMessageWithPollUpdate =
	exports.updateMessageWithReaction =
	exports.updateMessageWithReceipt =
	exports.getDevice =
	exports.extractMessageContent =
	exports.normalizeMessageContent =
	exports.getContentType =
	exports.generateWAMessage =
	exports.generateWAMessageFromContent =
	exports.generateWAMessageContent =
	exports.hasNonNullishProperty =
	exports.generateForwardMessageContent =
	exports.prepareDisappearingMessageSettingContent =
	exports.prepareWAMessageMedia =
	exports.generateLinkPreviewIfRequired =
	exports.extractUrlFromText =
		void 0
exports.getAggregateVotesInPollMessage = getAggregateVotesInPollMessage
exports.getAggregateResponsesInEventMessage = getAggregateResponsesInEventMessage
const boom_1 = require('@hapi/boom')
const crypto_1 = require('crypto')
const fs_1 = require('fs')
const index_js_1 = require('../../WAProto/index.js')
const WAProto_1 = require('../../WAProto/index.js')
const Defaults_1 = require('../Defaults')
const Types_1 = require('../Types')
const WABinary_1 = require('../WABinary')
const crypto_2 = require('./crypto')
const generics_1 = require('./generics')
const messages_media_1 = require('./messages-media')
const reporting_utils_1 = require('./reporting-utils')
const jid_display_normalization_1 = require('./jid-display-normalization')
const MIMETYPE_MAP = {
	image: 'image/jpeg',
	video: 'video/mp4',
	document: 'application/pdf',
	audio: 'audio/ogg; codecs=opus',
	sticker: 'image/webp',
	'product-catalog-image': 'image/jpeg'
}
const MessageTypeProto = {
	image: WAProto_1.proto.Message.ImageMessage,
	video: WAProto_1.proto.Message.VideoMessage,
	audio: WAProto_1.proto.Message.AudioMessage,
	sticker: WAProto_1.proto.Message.StickerMessage,
	document: WAProto_1.proto.Message.DocumentMessage
}

// Input payloads can carry protobuf media message keys (e.g. imageMessage).
const MEDIA_MESSAGE_TYPE_ALIASES = {
	imageMessage: 'image',
	videoMessage: 'video',
	audioMessage: 'audio',
	documentMessage: 'document',
	stickerMessage: 'sticker',
	// PTV = push-to-video (video note) payload.
	ptvMessage: 'video'
}
const MEDIA_MESSAGE_TYPE_ALIAS_KEYS = Object.keys(MEDIA_MESSAGE_TYPE_ALIASES)
const hasMediaPayload = message =>
	Defaults_1.MEDIA_KEYS.some(key => key in message) || MEDIA_MESSAGE_TYPE_ALIAS_KEYS.some(key => key in message)

const ButtonType = WAProto_1.proto.Message.ButtonsMessage.HeaderType

const RICH_RESPONSE_CODE_KEYWORDS = new Set([
	'break',
	'case',
	'catch',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'finally',
	'for',
	'function',
	'if',
	'in',
	'instanceof',
	'new',
	'return',
	'switch',
	'this',
	'throw',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'true',
	'false',
	'null',
	'undefined',
	'NaN',
	'Infinity',
	'class',
	'const',
	'let',
	'super',
	'extends',
	'export',
	'import',
	'yield',
	'static',
	'constructor',
	'of',
	'async',
	'await',
	'get',
	'set',
	'implements',
	'interface',
	'package',
	'private',
	'protected',
	'public',
	'enum',
	'throws',
	'transient'
])
const tokenizeCode = code => {
	const tokens = []
	let i = 0
	const len = code.length
	while (i < len) {
		if (/\s/.test(code[i])) {
			const start = i
			while (i < len && /\s/.test(code[i])) i++
			tokens.push({ content: code.slice(start, i), type: 'DEFAULT' })
			continue
		}
		if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
			const start = i
			const quote = code[i]
			i++
			while (i < len && code[i] !== quote) {
				if (code[i] === '\\') i++
				i++
			}
			i++
			tokens.push({ content: code.slice(start, i), type: 'STR' })
			continue
		}
		if (code[i] === '/' && i + 1 < len && code[i + 1] === '/') {
			const start = i
			while (i < len && code[i] !== '\n') i++
			tokens.push({ content: code.slice(start, i), type: 'COMMENT' })
			continue
		}
		if (code[i] === '/' && i + 1 < len && code[i + 1] === '*') {
			const start = i
			i += 2
			while (i + 1 < len && !(code[i] === '*' && code[i + 1] === '/')) i++
			i += 2
			tokens.push({ content: code.slice(start, i), type: 'COMMENT' })
			continue
		}
		if (/[0-9]/.test(code[i])) {
			const start = i
			while (i < len && /[0-9.]/.test(code[i])) i++
			tokens.push({ content: code.slice(start, i), type: 'NUMBER' })
			continue
		}
		if (/[a-zA-Z_$]/.test(code[i])) {
			const start = i
			while (i < len && /[a-zA-Z0-9_$]/.test(code[i])) i++
			const word = code.slice(start, i)
			if (RICH_RESPONSE_CODE_KEYWORDS.has(word)) {
				tokens.push({ content: word, type: 'KEYWORD' })
			} else {
				let j = i
				while (j < len && /\s/.test(code[j])) j++
				tokens.push({ content: word, type: j < len && code[j] === '(' ? 'METHOD' : 'DEFAULT' })
			}
			continue
		}
		tokens.push({ content: code[i], type: 'DEFAULT' })
		i++
	}
	const merged = []
	for (const t of tokens) {
		if (merged.length && merged[merged.length - 1].type === 'DEFAULT' && t.type === 'DEFAULT') {
			merged[merged.length - 1].content += t.content
		} else {
			merged.push(t)
		}
	}
	return merged
}

/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
const extractUrlFromText = text => text.match(Defaults_1.URL_REGEX)?.[0]
exports.extractUrlFromText = extractUrlFromText
const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
	const url = (0, exports.extractUrlFromText)(text)
	if (!!getUrlInfo && url) {
		try {
			const urlInfo = await getUrlInfo(url)
			return urlInfo
		} catch (error) {
			// ignore if fails
			logger?.warn({ trace: error.stack }, 'url generation failed')
		}
	}
}
exports.generateLinkPreviewIfRequired = generateLinkPreviewIfRequired
const assertColor = async color => {
	let assertedColor
	if (typeof color === 'number') {
		assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1
	} else {
		let hex = color.trim().replace('#', '')
		if (hex.length <= 6) {
			hex = 'FF' + hex.padStart(6, '0')
		}
		assertedColor = parseInt(hex, 16)
		return assertedColor
	}
}
const prepareWAMessageMedia = async (message, options) => {
	const logger = options.logger
	let mediaType
	for (const key of Defaults_1.MEDIA_KEYS) {
		if (key in message) {
			mediaType = key
		}
	}
	if (!mediaType) {
		throw new boom_1.Boom('Invalid media type', { statusCode: 400 })
	}
	const uploadData = {
		...message,
		media: message[mediaType]
	}
	delete uploadData[mediaType]
	// check if cacheable + generate cache key
	const cacheableKey =
		typeof uploadData.media === 'object' &&
		'url' in uploadData.media &&
		!!uploadData.media.url &&
		!!options.mediaCache &&
		mediaType + ':' + uploadData.media.url.toString()
	if (mediaType === 'document' && !uploadData.fileName) {
		uploadData.fileName = 'file'
	}
	if (!uploadData.mimetype) {
		uploadData.mimetype = MIMETYPE_MAP[mediaType]
	}
	if (cacheableKey) {
		const mediaBuff = await options.mediaCache.get(cacheableKey)
		if (mediaBuff) {
			logger?.debug({ cacheableKey }, 'got media cache hit')
			const obj = index_js_1.proto.Message.decode(mediaBuff)
			const key = `${mediaType}Message`
			Object.assign(obj[key], { ...uploadData, media: undefined })
			return obj
		}
	}
	const isNewsletter = !!options.jid && (0, WABinary_1.isJidNewsletter)(options.jid)
	if (isNewsletter) {
		logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter')
		const { filePath, fileSha256, fileLength } = await (0, messages_media_1.getRawMediaUploadData)(
			uploadData.media,
			options.mediaTypeOverride || mediaType,
			logger
		)
		const fileSha256B64 = fileSha256.toString('base64')
		const { mediaUrl, directPath } = await options.upload(filePath, {
			fileEncSha256B64: fileSha256B64,
			mediaType: mediaType,
			timeoutMs: options.mediaUploadTimeoutMs
		})
		await fs_1.promises.unlink(filePath)
		const obj = WAProto_1.proto.Message.fromObject({
			// todo: add more support here
			[`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
				url: mediaUrl,
				directPath,
				fileSha256,
				fileLength,
				...uploadData,
				media: undefined
			})
		})
		if (uploadData.ptv) {
			obj.ptvMessage = obj.videoMessage
			delete obj.videoMessage
		}
		if (obj.stickerMessage) {
			obj.stickerMessage.stickerSentTs = Date.now()
		}
		if (cacheableKey) {
			logger?.debug({ cacheableKey }, 'set cache')
			await options.mediaCache.set(cacheableKey, WAProto_1.proto.Message.encode(obj).finish())
		}
		return obj
	}
	const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined'
	const requiresThumbnailComputation =
		(mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined'

	const requiresWaveformProcessing =
		mediaType === 'audio' && uploadData.ptt === true && typeof uploadData.waveform === 'undefined'
	const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true
	const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation
	const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await (0,
	messages_media_1.encryptedStream)(uploadData.media, options.mediaTypeOverride || mediaType, {
		logger,
		saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
		opts: options.options
	})
	const fileEncSha256B64 = fileEncSha256.toString('base64')
	const [{ mediaUrl, directPath }] = await Promise.all([
		(async () => {
			const result = await options.upload(encFilePath, {
				fileEncSha256B64,
				mediaType,
				timeoutMs: options.mediaUploadTimeoutMs
			})
			logger?.debug({ mediaType, cacheableKey }, 'uploaded media')
			return result
		})(),
		(async () => {
			try {
				if (requiresThumbnailComputation) {
					const { thumbnail, originalImageDimensions } = await (0, messages_media_1.generateThumbnail)(
						originalFilePath,
						mediaType,
						options
					)
					uploadData.jpegThumbnail = thumbnail
					if (!uploadData.width && originalImageDimensions) {
						uploadData.width = originalImageDimensions.width
						uploadData.height = originalImageDimensions.height
						logger?.debug('set dimensions')
					}
					logger?.debug('generated thumbnail')
				}
				if (requiresDurationComputation) {
					uploadData.seconds = await (0, messages_media_1.getAudioDuration)(originalFilePath)
					logger?.debug('computed audio duration')
				}
				if (requiresWaveformProcessing) {
					uploadData.waveform = await (0, messages_media_1.getAudioWaveform)(originalFilePath, logger)
					logger?.debug('processed waveform')
				}
				if (requiresAudioBackground) {
					uploadData.backgroundArgb = await assertColor(options.backgroundColor)
					logger?.debug('computed backgroundColor audio status')
				}
			} catch (error) {
				logger?.warn({ trace: error.stack }, 'failed to obtain extra info')
			}
		})()
	]).finally(async () => {
		try {
			await fs_1.promises.unlink(encFilePath)
			if (originalFilePath) {
				await fs_1.promises.unlink(originalFilePath)
			}
			logger?.debug('removed tmp files')
		} catch (error) {
			logger?.warn('failed to remove tmp file')
		}
	})
	const obj = WAProto_1.proto.Message.fromObject({
		[`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
			url: mediaUrl,
			directPath,
			mediaKey,
			fileEncSha256,
			fileSha256,
			fileLength,
			mediaKeyTimestamp: (0, generics_1.unixTimestampSeconds)(),
			...uploadData,
			media: undefined
		})
	})
	if (uploadData.ptv) {
		obj.ptvMessage = obj.videoMessage
		delete obj.videoMessage
	}
	if (cacheableKey) {
		logger?.debug({ cacheableKey }, 'set cache')
		await options.mediaCache.set(cacheableKey, WAProto_1.proto.Message.encode(obj).finish())
	}
	return obj
}
exports.prepareWAMessageMedia = prepareWAMessageMedia
const prepareDisappearingMessageSettingContent = ephemeralExpiration => {
	ephemeralExpiration = ephemeralExpiration || 0
	const content = {
		ephemeralMessage: {
			message: {
				protocolMessage: {
					type: WAProto_1.proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
					ephemeralExpiration
				}
			}
		}
	}
	return WAProto_1.proto.Message.fromObject(content)
}
exports.prepareDisappearingMessageSettingContent = prepareDisappearingMessageSettingContent
/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
const generateForwardMessageContent = (message, forceForward) => {
	let content = message.message
	if (!content) {
		throw new boom_1.Boom('no content in message', { statusCode: 400 })
	}
	// hacky copy
	content = (0, exports.normalizeMessageContent)(content)
	content = index_js_1.proto.Message.decode(index_js_1.proto.Message.encode(content).finish())
	let key = Object.keys(content)[0]
	let score = content?.[key]?.contextInfo?.forwardingScore || 0
	score += message.key.fromMe && !forceForward ? 0 : 1
	if (key === 'conversation') {
		content.extendedTextMessage = { text: content[key] }
		delete content.conversation
		key = 'extendedTextMessage'
	}
	const key_ = content?.[key]
	if (score > 0) {
		key_.contextInfo = { forwardingScore: score, isForwarded: true }
	} else {
		key_.contextInfo = {}
	}
	return content
}
exports.generateForwardMessageContent = generateForwardMessageContent
const hasNonNullishProperty = (message, key) => {
	return (
		typeof message === 'object' &&
		message !== null &&
		key in message &&
		message[key] !== null &&
		message[key] !== undefined
	)
}
exports.hasNonNullishProperty = hasNonNullishProperty
function hasOptionalProperty(obj, key) {
	return typeof obj === 'object' && obj !== null && key in obj && obj[key] !== null
}
const normalizeEarFields = ear => {
	const result = { ...ear }
	const applyAlias = (fromKey, toKey) => {
		if (result[fromKey] !== undefined && result[toKey] === undefined) result[toKey] = result[fromKey]
	}
	applyAlias('thumbnail_url', 'thumbnailUrl')
	applyAlias('thumbnailUrl', 'thumbnail')
	applyAlias('source_url', 'sourceUrl')
	applyAlias('media_type', 'mediaType')
	applyAlias('show_ad_attribution', 'showAdAttribution')
	applyAlias('render_larger_thumbnail', 'renderLargerThumbnail')
	if (result.thumbnail && !result.jpegThumbnail) result.jpegThumbnail = result.thumbnail
	if (result.largeThumbnail !== undefined && result.renderLargerThumbnail === undefined)
		result.renderLargerThumbnail = result.largeThumbnail
	if (result.url && !result.sourceUrl) result.sourceUrl = result.url
	delete result.thumbnail
	delete result.largeThumbnail
	delete result.url
	delete result.thumbnail_url
	delete result.source_url
	delete result.media_type
	delete result.show_ad_attribution
	delete result.render_larger_thumbnail
	return result
}
const normalizeQuickReplyButton = button => {
	var _a
	if (button.name && typeof button.name === 'string') {
		return {
			name: button.name,
			buttonParamsJson:
				typeof button.buttonParamsJson === 'string'
					? button.buttonParamsJson
					: JSON.stringify(button.buttonParamsJson || {})
		}
	}
	if (button.type === 4 && button.nativeFlowInfo) {
		const { name, paramsJson } = button.nativeFlowInfo
		return {
			name: name || 'quick_reply',
			buttonParamsJson: typeof paramsJson === 'string' ? paramsJson : JSON.stringify(paramsJson || {})
		}
	}
	const buttonTextObject = button.buttonText && typeof button.buttonText === 'object' ? button.buttonText : undefined
	const displayTextCandidates = [
		button.text,
		button.displayText,
		button.display_text,
		typeof button.buttonText === 'string' ? button.buttonText : undefined,
		buttonTextObject === null || buttonTextObject === void 0 ? void 0 : buttonTextObject.displayText,
		buttonTextObject === null || buttonTextObject === void 0 ? void 0 : buttonTextObject.display_text
	]
	const displayText = displayTextCandidates.find(value => typeof value === 'string' && value.length > 0) || ''
	const id =
		button.buttonId || button.id || ((_a = button.buttonParamsJson) === null || _a === void 0 ? void 0 : _a.id) || ''
	return {
		name: 'quick_reply',
		buttonParamsJson: JSON.stringify({
			display_text: displayText,
			id
		})
	}
}
const asciiDecode = arr => arr.map(e => String.fromCharCode(e)).join('')

const applyContextInfoAndMentions = (interactiveMessage, message) => {
	if ('contextInfo' in message && !!message.contextInfo) {
		interactiveMessage.contextInfo = message.contextInfo
	}
	if ('mentions' in message && !!message.mentions) {
		interactiveMessage.contextInfo = {
			...(interactiveMessage.contextInfo || {}),
			mentionedJid: message.mentions
		}
	}
}
const buildPaymentNoteMessage = async (paymentPayload, options, fallbackText = '') => {
	let notes
	if (paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.sticker) {
		const stickerPrep = await (0, exports.prepareWAMessageMedia)({ sticker: paymentPayload.sticker }, options)
		notes = {
			stickerMessage: {
				...(stickerPrep === null || stickerPrep === void 0 ? void 0 : stickerPrep.stickerMessage),
				contextInfo: paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.contextInfo
			}
		}
	} else if (
		typeof (paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.note) === 'string'
	) {
		notes = {
			extendedTextMessage: {
				text: paymentPayload.note,
				contextInfo: paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.contextInfo
			}
		}
	} else if (
		(paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.noteMessage) &&
		typeof paymentPayload.noteMessage === 'object'
	) {
		const noteKeys = Object.keys(paymentPayload.noteMessage)
		const allowedNoteMessageKeys = ['extendedTextMessage', 'stickerMessage']
		const hasOnlyAllowedKeys = noteKeys.length > 0 && noteKeys.every(key => allowedNoteMessageKeys.includes(key))
		if (!noteKeys.length || !hasOnlyAllowedKeys) {
			throw new boom_1.Boom('Invalid payment noteMessage', { statusCode: 400 })
		}
		notes = paymentPayload.noteMessage
	} else {
		notes = { extendedTextMessage: { text: fallbackText } }
	}
	return notes
}

const generateWAMessageContent = async (message, options) => {
	var _a, _b
	let m = {}
	const hasCaptionWithoutMedia = 'caption' in message && !hasMediaPayload(message)
	const hasCaptionContainer = ('groupStatus' in message && !!message.groupStatus) ||
		('viewOnce' in message && !!message.viewOnce)
	if ((0, exports.hasNonNullishProperty)(message, 'text')) {
		const extContent = { text: message.text }
		let urlInfo = message.linkPreview
		if (typeof urlInfo === 'undefined') {
			urlInfo = await (0, exports.generateLinkPreviewIfRequired)(message.text, options.getUrlInfo, options.logger)
		}
		if (urlInfo) {
			extContent.matchedText = urlInfo['matched-text']
			extContent.jpegThumbnail = urlInfo.jpegThumbnail
			extContent.description = urlInfo.description
			extContent.title = urlInfo.title
			extContent.previewType = 0
			const img = urlInfo.highQualityThumbnail
			if (img) {
				extContent.thumbnailDirectPath = img.directPath
				extContent.mediaKey = img.mediaKey
				extContent.mediaKeyTimestamp = img.mediaKeyTimestamp
				extContent.thumbnailWidth = img.width
				extContent.thumbnailHeight = img.height
				extContent.thumbnailSha256 = img.fileSha256
				extContent.thumbnailEncSha256 = img.fileEncSha256
			}
		}
		if (options.backgroundColor) {
			extContent.backgroundArgb = await assertColor(options.backgroundColor)
		}
		if (options.font) {
			extContent.font = options.font
		}
		m.extendedTextMessage = extContent
	} else if ((0, exports.hasNonNullishProperty)(message, 'contacts')) {
		const contactLen = message.contacts.contacts.length
		if (!contactLen) {
			throw new boom_1.Boom('require atleast 1 contact', { statusCode: 400 })
		}
		if (contactLen === 1) {
			m.contactMessage = WAProto_1.proto.Message.ContactMessage.create(message.contacts.contacts[0])
		} else {
			m.contactsArrayMessage = WAProto_1.proto.Message.ContactsArrayMessage.create(message.contacts)
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'location')) {
		m.locationMessage = WAProto_1.proto.Message.LocationMessage.create(message.location)
	} else if ((0, exports.hasNonNullishProperty)(message, 'react')) {
		if (!message.react.senderTimestampMs) {
			message.react.senderTimestampMs = Date.now()
		}
		m.reactionMessage = WAProto_1.proto.Message.ReactionMessage.create(message.react)
	} else if ((0, exports.hasNonNullishProperty)(message, 'delete')) {
		m.protocolMessage = {
			key: message.delete,
			type: WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'forward')) {
		m = (0, exports.generateForwardMessageContent)(message.forward, message.force)
	} else if ((0, exports.hasNonNullishProperty)(message, 'disappearingMessagesInChat')) {
		const exp =
			typeof message.disappearingMessagesInChat === 'boolean'
				? message.disappearingMessagesInChat
					? Defaults_1.WA_DEFAULT_EPHEMERAL
					: 0
				: message.disappearingMessagesInChat
		m = (0, exports.prepareDisappearingMessageSettingContent)(exp)
	} else if ((0, exports.hasNonNullishProperty)(message, 'groupInvite')) {
		m.groupInviteMessage = {}
		m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode
		m.groupInviteMessage.inviteExpiration = message.groupInvite.inviteExpiration
		m.groupInviteMessage.caption = message.groupInvite.text
		m.groupInviteMessage.groupJid = message.groupInvite.jid
		m.groupInviteMessage.groupName = message.groupInvite.subject
		//TODO: use built-in interface and get disappearing mode info etc.
		//TODO: cache / use store!?
		if (options.getProfilePicUrl) {
			const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview')
			if (pfpUrl) {
				const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher })
				if (resp.ok) {
					const buf = Buffer.from(await resp.arrayBuffer())
					m.groupInviteMessage.jpegThumbnail = buf
				}
			}
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'pin')) {
		m.pinInChatMessage = {}
		m.messageContextInfo = {}
		m.pinInChatMessage.key = message.pin
		m.pinInChatMessage.type = message.type
		m.pinInChatMessage.senderTimestampMs = Date.now()
		m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0
	} else if ((0, exports.hasNonNullishProperty)(message, 'buttonReply')) {
		switch (message.type) {
			case 'template':
				m.templateButtonReplyMessage = {
					selectedDisplayText: message.buttonReply.displayText,
					selectedId: message.buttonReply.id,
					selectedIndex: message.buttonReply.index
				}
				break
			case 'plain':
				m.buttonsResponseMessage = {
					selectedButtonId: message.buttonReply.id,
					selectedDisplayText: message.buttonReply.displayText,
					type: index_js_1.proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
				}
				break
			case 'interactive':
				m.interactiveResponseMessage = {
					body: {
						text: message.buttonReply.displayText,
						format: WAProto_1.proto.Message.InteractiveResponseMessage.Body.Format.EXTENSIONS_1
					},
					nativeFlowResponseMessage: {
						name: message.buttonReply.nativeFlows.name,
						paramsJson: message.buttonReply.nativeFlows.paramsJson,
						version: message.buttonReply.nativeFlows.version
					}
				}
				break
			case 'list':
				m.listResponseMessage = {
					title: message.buttonReply.title,
					description: message.buttonReply.description,
					singleSelectReply: {
						selectedRowId: message.buttonReply.rowId
					},
					listType: WAProto_1.proto.Message.ListResponseMessage.ListType.SINGLE_SELECT
				}
				break
		}
	} else if (hasOptionalProperty(message, 'ptv') && message.ptv) {
		const { videoMessage } = await (0, exports.prepareWAMessageMedia)({ video: message.video }, options)
		m.ptvMessage = videoMessage
	} else if ((0, exports.hasNonNullishProperty)(message, 'product')) {
		const { imageMessage } = await (0, exports.prepareWAMessageMedia)({ image: message.product.productImage }, options)
		m.productMessage = WAProto_1.proto.Message.ProductMessage.create({
			...message,
			product: {
				...message.product,
				productImage: imageMessage
			}
		})
	} else if ((0, exports.hasNonNullishProperty)(message, 'listReply')) {
		m.listResponseMessage = { ...message.listReply }
	} else if ((0, exports.hasNonNullishProperty)(message, 'event')) {
		m.eventMessage = {}
		const startTime = Math.floor(message.event.startDate.getTime() / 1000)
		if (message.event.call && options.getCallLink) {
			const token = await options.getCallLink(message.event.call, { startTime })
			m.eventMessage.joinLink =
				(message.event.call === 'audio' ? Defaults_1.CALL_AUDIO_PREFIX : Defaults_1.CALL_VIDEO_PREFIX) + token
		}
		m.messageContextInfo = {
			// encKey
			messageSecret: message.event.messageSecret || (0, crypto_1.randomBytes)(32)
		}
		m.eventMessage.name = message.event.name
		m.eventMessage.description = message.event.description
		m.eventMessage.startTime = startTime
		m.eventMessage.endTime = message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined
		m.eventMessage.isCanceled = message.event.isCancelled ?? false
		m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed
		m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false
		m.eventMessage.location = message.event.location
	} else if ((0, exports.hasNonNullishProperty)(message, 'poll')) {
		;(_a = message.poll).selectableCount || (_a.selectableCount = 0)
		;(_b = message.poll).toAnnouncementGroup || (_b.toAnnouncementGroup = false)
		if (!Array.isArray(message.poll.values)) {
			throw new boom_1.Boom('Invalid poll values', { statusCode: 400 })
		}
		if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length) {
			throw new boom_1.Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, {
				statusCode: 400
			})
		}
		m.messageContextInfo = {
			// encKey
			messageSecret: message.poll.messageSecret || (0, crypto_1.randomBytes)(32)
		}
		const pollCreationMessage = {
			name: message.poll.name,
			selectableOptionsCount: message.poll.selectableCount,
			options: message.poll.values.map(optionName => ({ optionName }))
		}
		if (message.poll.toAnnouncementGroup) {
			// poll v2 is for community announcement groups (single select and multiple)
			m.pollCreationMessageV2 = pollCreationMessage
		} else {
			if (message.poll.selectableCount === 1) {
				//poll v3 is for single select polls
				m.pollCreationMessageV3 = pollCreationMessage
			} else {
				// poll for multiple choice polls
				m.pollCreationMessage = pollCreationMessage
			}
		}
	} else if ('inviteAdmin' in message) {
		m.newsletterAdminInviteMessage = {}
		m.newsletterAdminInviteMessage.inviteExpiration = message.inviteAdmin.inviteExpiration
		m.newsletterAdminInviteMessage.caption = message.inviteAdmin.text
		m.newsletterAdminInviteMessage.newsletterJid = message.inviteAdmin.jid
		m.newsletterAdminInviteMessage.newsletterName = message.inviteAdmin.subject
		m.newsletterAdminInviteMessage.jpegThumbnail = message.inviteAdmin.thumbnail
	} else if ('requestPayment' in message || 'requestPaymentMessage' in message) {
		if ('requestPayment' in message && 'requestPaymentMessage' in message) {
			throw new boom_1.Boom('Use either requestPayment or requestPaymentMessage, not both', { statusCode: 400 })
		}
		const requestPayment = message.requestPayment || message.requestPaymentMessage
		const notes = await buildPaymentNoteMessage(requestPayment, options)
		const amountValue = requestPayment.amount ?? requestPayment.amount1000
		const amount1000Raw =
			typeof (amountValue === null || amountValue === void 0 ? void 0 : amountValue.toNumber) === 'function'
				? amountValue.toNumber()
				: Number(amountValue)
		const amount1000 = Number.isFinite(amount1000Raw) ? Math.round(amount1000Raw) : amount1000Raw
		const currencyCodeIso4217 = requestPayment.currency ?? requestPayment.currencyCodeIso4217
		const requestFrom = requestPayment.from ?? requestPayment.requestFrom ?? options.recipientJid
		const missingFields = []
		if (amountValue === undefined) missingFields.push('amount/amount1000')
		if (currencyCodeIso4217 === undefined) missingFields.push('currency/currencyCodeIso4217')
		if (requestFrom === undefined) missingFields.push('from/requestFrom')
		if (missingFields.length) {
			throw new boom_1.Boom(`Invalid requestPayment fields: missing ${missingFields.join(', ')}`, { statusCode: 400 })
		}
		if (
			typeof amount1000 !== 'number' ||
			!Number.isFinite(amount1000) ||
			!Number.isInteger(amount1000) ||
			amount1000 <= 0
		) {
			throw new boom_1.Boom('Invalid requestPayment fields: amount/amount1000 must be a positive integer', {
				statusCode: 400
			})
		}
		const bg = requestPayment.background
		m.requestPaymentMessage = WAProto_1.proto.Message.RequestPaymentMessage.fromObject({
			expiryTimestamp: requestPayment.expiry ?? requestPayment.expiryTimestamp,
			amount1000,
			currencyCodeIso4217,
			requestFrom,
			noteMessage: notes,
			...(bg != null ? { background: bg } : {})
		})
	} else if ('sendPayment' in message || 'sendPaymentMessage' in message) {
		if ('sendPayment' in message && 'sendPaymentMessage' in message) {
			throw new boom_1.Boom('Use either sendPayment or sendPaymentMessage, not both', { statusCode: 400 })
		}
		const sendPayment = message.sendPayment || message.sendPaymentMessage
		const notes = await buildPaymentNoteMessage(sendPayment, options, message.text || '')
		const requestMessageKey = sendPayment.requestMessageKey ?? sendPayment.requestKey ?? sendPayment.request
		if (!requestMessageKey) {
			throw new boom_1.Boom('Invalid sendPayment fields: missing requestMessageKey/requestKey/request', {
				statusCode: 400
			})
		}
		m.sendPaymentMessage = WAProto_1.proto.Message.SendPaymentMessage.fromObject({
			noteMessage: notes,
			requestMessageKey,
			...(sendPayment.background != null ? { background: sendPayment.background } : {}),
			...(sendPayment.transactionData != null ? { transactionData: sendPayment.transactionData } : {})
		})
	} else if ('declinePaymentRequest' in message || 'declinePaymentRequestMessage' in message) {
		if ('declinePaymentRequest' in message && 'declinePaymentRequestMessage' in message) {
			throw new boom_1.Boom('Use either declinePaymentRequest or declinePaymentRequestMessage, not both', {
				statusCode: 400
			})
		}
		const declinePayment = message.declinePaymentRequest || message.declinePaymentRequestMessage
		const key = (declinePayment === null || declinePayment === void 0 ? void 0 : declinePayment.key) || declinePayment
		if (!key) {
			throw new boom_1.Boom('Invalid declinePaymentRequest fields: missing key', { statusCode: 400 })
		}
		m.declinePaymentRequestMessage = WAProto_1.proto.Message.DeclinePaymentRequestMessage.fromObject({ key })
	} else if ('cancelPaymentRequest' in message || 'cancelPaymentRequestMessage' in message) {
		if ('cancelPaymentRequest' in message && 'cancelPaymentRequestMessage' in message) {
			throw new boom_1.Boom('Use either cancelPaymentRequest or cancelPaymentRequestMessage, not both', {
				statusCode: 400
			})
		}
		const cancelPayment = message.cancelPaymentRequest || message.cancelPaymentRequestMessage
		const key = (cancelPayment === null || cancelPayment === void 0 ? void 0 : cancelPayment.key) || cancelPayment
		if (!key) {
			throw new boom_1.Boom('Invalid cancelPaymentRequest fields: missing key', { statusCode: 400 })
		}
		m.cancelPaymentRequestMessage = WAProto_1.proto.Message.CancelPaymentRequestMessage.fromObject({ key })
	} else if ('requestPaymentFrom' in message && !!message.requestPaymentFrom) {
		const noteText = message.text || ''
		m.requestPaymentMessage = WAProto_1.proto.Message.RequestPaymentMessage.fromObject({
			requestFrom: message.requestPaymentFrom,
			noteMessage: { extendedTextMessage: { text: noteText } }
		})
	} else if ('invoiceNote' in message) {
		const preparedInvoice = await (0, exports.prepareWAMessageMedia)(message, options)
		const mediaType = Object.keys(preparedInvoice)[0]
		const mediaMsg = preparedInvoice[mediaType] || {}
		m.invoiceMessage = WAProto_1.proto.Message.InvoiceMessage.fromObject({
			note: message.invoiceNote,
			token: message.invoiceToken || '',
			attachmentType: mediaType === 'imageMessage' ? 1 : 0,
			attachmentMimetype: mediaMsg.mimetype,
			attachmentMediaKey: mediaMsg.mediaKey,
			attachmentMediaKeyTimestamp: mediaMsg.mediaKeyTimestamp,
			attachmentFileSha256: mediaMsg.fileSha256,
			attachmentFileEncSha256: mediaMsg.fileEncSha256,
			attachmentDirectPath: mediaMsg.directPath,
			attachmentJpegThumbnail: mediaMsg.jpegThumbnail
		})
	} else if ('orderText' in message) {
		m.orderMessage = WAProto_1.proto.Message.OrderMessage.fromObject({
			message: message.orderText,
			thumbnail: message.thumbnail,
			status: message.orderStatus || 1,
			surface: message.orderSurface || 1
		})
	} else if ('paymentInviteServiceType' in message) {
		m.paymentInviteMessage = {
			serviceType: message.paymentInviteServiceType,
			expiryTimestamp: message.paymentInviteExpiry
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'sharePhoneNumber')) {
		m.protocolMessage = {
			type: index_js_1.proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'requestPhoneNumber')) {
		m.requestPhoneNumberMessage = {}
	} else if ((0, exports.hasNonNullishProperty)(message, 'limitSharing')) {
		m.protocolMessage = {
			type: index_js_1.proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
			limitSharing: {
				sharingLimited: message.limitSharing === true,
				trigger: 1,
				limitSharingSettingTimestamp: Date.now(),
				initiatedByMe: true
			}
		}
	} else if ('album' in message) {
		const imageMessages = message.album.filter(item => 'image' in item)
		const videoMessages = message.album.filter(item => 'video' in item)
		m.albumMessage = WAProto_1.proto.Message.AlbumMessage.fromObject({
			expectedImageCount: imageMessages.length,
			expectedVideoCount: videoMessages.length
		})
	} else if ('pollResult' in message) {
		if (!Array.isArray(message.pollResult.values)) {
			throw new boom_1.Boom('Invalid pollResult values', { statusCode: 400 })
		}
		m.pollResultSnapshotMessage = {
			name: message.pollResult.name,
			pollVotes: message.pollResult.values.map(([optionName, optionVoteCount]) => ({
				optionName,
				optionVoteCount
			}))
		}
	} else if ('stickerPack' in message || 'stickerPackMessage' in message) {
		if ('stickerPack' in message && 'stickerPackMessage' in message) {
			throw new boom_1.Boom('Cannot specify both stickerPack and stickerPackMessage; use only one property.', {
				statusCode: 400
			})
		}
		const stickerPackMessage = 'stickerPack' in message ? message.stickerPack : message.stickerPackMessage
		m.stickerPackMessage = WAProto_1.proto.Message.StickerPackMessage.fromObject(stickerPackMessage)
	} else if ('listMessage' in message) {
		const lm = { ...message.listMessage }
		if (lm.text !== undefined && lm.description === undefined) {
			lm.description = lm.text
			delete lm.text
		}
		m = { listMessage: lm }
	} else if ('buttonsMessage' in message) {
		m = {
			buttonsMessage: WAProto_1.proto.Message.ButtonsMessage.fromObject(message.buttonsMessage)
		}
	} else if ('interactiveMessage' in message) {
		m = { interactiveMessage: message.interactiveMessage }
	} else if ('richResponse' in message) {
		// handled in richResponse block below
	} else if ('groupStatusMessage' in message) {
		m = { groupStatusMessage: WAProto_1.proto.Message.GroupStatusMessage.fromObject(message.groupStatusMessage) }
	} else if (hasCaptionWithoutMedia && !hasCaptionContainer) {
		m.extendedTextMessage = { text: message.caption }
	} else if (hasCaptionWithoutMedia && hasCaptionContainer) {
		m = {}
	} else if (!hasCaptionWithoutMedia && hasMediaPayload(message)) {
		m = await (0, exports.prepareWAMessageMedia)(message, options)
	}
	if ('buttons' in message && !!message.buttons) {
		const interactiveMessage = {
			nativeFlowMessage: WAProto_1.proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
				buttons: message.buttons.map(normalizeQuickReplyButton)
			})
		}
		if ('text' in message) {
			interactiveMessage.body = { text: message.text }
		} else if ('caption' in message) {
			interactiveMessage.body = { text: message.caption }
			interactiveMessage.header = {
				title: message.title || '',
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		if ('title' in message && !!message.title && !interactiveMessage.header) {
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
		} else if ('title' in message && !!message.title && interactiveMessage.header) {
			interactiveMessage.header.title = message.title
			if (message.subtitle !== undefined) {
				interactiveMessage.header.subtitle = message.subtitle
			}
		}
		if ('footer' in message && !!message.footer) {
			interactiveMessage.footer = { text: message.footer }
		}
		applyContextInfoAndMentions(interactiveMessage, message)
		m = { interactiveMessage }
	} else if ('templateButtons' in message && !!message.templateButtons) {
		const msg = {
			hydratedButtons: message.hasOwnProperty('templateButtons') ? message.templateButtons : message.templateButtons
		}
		if ('text' in message) {
			msg.hydratedContentText = message.text
		} else {
			if ('caption' in message) {
				msg.hydratedContentText = message.caption
			}
			Object.assign(msg, m)
		}
		if ('footer' in message && !!message.footer) {
			msg.hydratedFooterText = message.footer
		}
		m = {
			templateMessage: {
				fourRowTemplate: msg,
				hydratedTemplate: msg
			}
		}
	}
	if ('sections' in message && !!message.sections) {
		const listMessage = {
			sections: message.sections,
			buttonText: message.buttonText,
			title: message.title,
			footerText: message.footer,
			description: message.text,
			listType: WAProto_1.proto.Message.ListMessage.ListType.SINGLE_SELECT
		}
		m = { listMessage }
	} else if ('productList' in message && !!message.productList) {
		if (
			!Array.isArray(message.productList) ||
			message.productList.length === 0 ||
			!Array.isArray(message.productList[0].products) ||
			message.productList[0].products.length === 0
		) {
			throw new boom_1.Boom('Invalid productList: must contain at least one section with one product', {
				statusCode: 400
			})
		}
		m.listMessage = {
			title: message.title,
			buttonText: message.buttonText,
			footerText: message.footer,
			description: message.text,
			productListInfo: {
				productSections: message.productList,
				headerImage: {
					productId: message.productList[0].products[0].productId
				},
				businessOwnerJid: message.businessOwnerJid
			},
			listType: WAProto_1.proto.Message.ListMessage.ListType.PRODUCT_LIST
		}
	}
	if ('interactiveButtons' in message && !!message.interactiveButtons) {
		const interactiveMessage = {
			nativeFlowMessage: WAProto_1.proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
				buttons: message.interactiveButtons
			})
		}
		if ('text' in message) {
			interactiveMessage.body = {
				text: message.text
			}
		} else if ('caption' in message) {
			interactiveMessage.body = {
				text: message.caption
			}
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		if ('footer' in message && !!message.footer) {
			interactiveMessage.footer = {
				text: message.footer
			}
		}
		if ('title' in message && !!message.title) {
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		applyContextInfoAndMentions(interactiveMessage, message)
		m = { interactiveMessage }
	}
	if ('shop' in message && !!message.shop) {
		const interactiveMessage = {
			shopStorefrontMessage: WAProto_1.proto.Message.InteractiveMessage.ShopMessage.fromObject({
				surface: (_l = message.shop) === null || _l === void 0 ? void 0 : _l.surface,
				id: (_m = message.shop) === null || _m === void 0 ? void 0 : _m.id
			})
		}
		if ('text' in message) {
			interactiveMessage.body = {
				text: message.text
			}
		} else if ('caption' in message) {
			interactiveMessage.body = {
				text: message.caption
			}
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		if ('footer' in message && !!message.footer) {
			interactiveMessage.footer = {
				text: message.footer
			}
		}
		if ('title' in message && !!message.title) {
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		applyContextInfoAndMentions(interactiveMessage, message)
		m = { interactiveMessage }
		if ('interactiveAsTemplate' in message && message.interactiveAsTemplate !== false) {
			m = { templateMessage: { interactiveMessageTemplate: interactiveMessage } }
		}
	}
	if ('richResponse' in message) {
		const { text, code, language = 'javascript', botJid = '259786046210223@bot' } = message.richResponse
		const sections = [
			{
				view_model: {
					primitive: {
						text: text,
						__typename: 'GenAIMarkdownTextUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			}
		]
		if (code) {
			sections.push({
				view_model: {
					primitive: {
						language,
						code_blocks: tokenizeCode(String(code)),
						__typename: 'GenAICodeUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		const unifiedData = {
			response_id: (0, crypto_1.randomUUID)(),
			sections
		}
		return WAProto_1.proto.Message.fromObject({
			messageContextInfo: {
				deviceListMetadata: {},
				deviceListMetadataVersion: 2,
				messageSecret: (0, crypto_1.randomBytes)(32)
			},
			botForwardedMessage: {
				message: {
					richResponseMessage: {
						submessages: [],
						messageType: 1,
						unifiedResponse: { data: Buffer.from(JSON.stringify(unifiedData)) },
						contextInfo: {
							forwardingScore: 2,
							isForwarded: true,
							forwardedAiBotMessageInfo: { botJid },
							botMessageSharingInfo: {
								botEntryPointOrigin: 1,
								forwardScore: 2
							}
						}
					}
				}
			}
		})
	}
	if ('statusNotification' in message || 'statusNotificationMessage' in message) {
		const notifData = 'statusNotification' in message ? message.statusNotification : message.statusNotificationMessage
		m = { statusNotificationMessage: WAProto_1.proto.Message.StatusNotificationMessage.fromObject(notifData) }
	} else if ('statusQuestionAnswer' in message || 'statusQuestionAnswerMessage' in message) {
		const qaData =
			'statusQuestionAnswer' in message ? message.statusQuestionAnswer : message.statusQuestionAnswerMessage
		m = { statusQuestionAnswerMessage: WAProto_1.proto.Message.StatusQuestionAnswerMessage.fromObject(qaData) }
	} else if ('questionResponse' in message || 'questionResponseMessage' in message) {
		const qrData = 'questionResponse' in message ? message.questionResponse : message.questionResponseMessage
		m = { questionResponseMessage: WAProto_1.proto.Message.QuestionResponseMessage.fromObject(qrData) }
	} else if ('statusQuoted' in message || 'statusQuotedMessage' in message) {
		const sqData = 'statusQuoted' in message ? message.statusQuoted : message.statusQuotedMessage
		m = { statusQuotedMessage: WAProto_1.proto.Message.StatusQuotedMessage.fromObject(sqData) }
	} else if ('statusStickerInteraction' in message || 'statusStickerInteractionMessage' in message) {
		const ssiData =
			'statusStickerInteraction' in message ? message.statusStickerInteraction : message.statusStickerInteractionMessage
		m = { statusStickerInteractionMessage: WAProto_1.proto.Message.StatusStickerInteractionMessage.fromObject(ssiData) }
	} else if ('newsletterFollowerInvite' in message || 'newsletterFollowerInviteMessageV2' in message) {
		const nfiData =
			'newsletterFollowerInvite' in message
				? message.newsletterFollowerInvite
				: message.newsletterFollowerInviteMessageV2
		m = {
			newsletterFollowerInviteMessageV2: WAProto_1.proto.Message.NewsletterFollowerInviteMessage.fromObject(nfiData)
		}
	} else if ('messageHistoryNotice' in message) {
		m = { messageHistoryNotice: WAProto_1.proto.Message.MessageHistoryNotice.fromObject(message.messageHistoryNotice) }
	}
	if ('raw' in message && !!message.raw) {
		const { raw: _, externalAdReply: _ear, ...rawMsg } = message
		if ('externalAdReply' in message && !!message.externalAdReply) {
			const ear = normalizeEarFields(message.externalAdReply)
			const [rawType] = Object.keys(rawMsg)
			if (rawType && rawMsg[rawType]) {
				rawMsg[rawType].contextInfo = {
					...(rawMsg[rawType].contextInfo || {}),
					externalAdReply: ear
				}
			}
		}
		return WAProto_1.proto.Message.fromObject(rawMsg)
	} else if (Object.keys(m).length === 0) {
		m = await (0, exports.prepareWAMessageMedia)(message, options)
	}

	if (hasOptionalProperty(message, 'viewOnce') && !!message.viewOnce) {
		m = { viewOnceMessage: { message: m } }
	}
	if ('groupStatus' in message && !!message.groupStatus) {
		m = { groupStatusMessage: { message: m } }
	}
	if (
		(hasOptionalProperty(message, 'mentions') && message.mentions?.length) ||
		(hasOptionalProperty(message, 'mentionAll') && message.mentionAll)
	) {
		const normalizedMentions = await (0, jid_display_normalization_1.normalizeMentionedJidsForSend)(
			message.mentions,
			options.groupData,
			options.signalRepository,
			options.logger
		)
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		if (key && 'contextInfo' in key) {
			key.contextInfo = key.contextInfo || {}
			if (normalizedMentions?.length) {
				key.contextInfo.mentionedJid = normalizedMentions
			}
			if (message.mentionAll) {
				key.contextInfo.nonJidMentions = 1
			} else if (!key) {
				key.contextInfo = {
					mentionedJid: normalizedMentions,
					nonJidMentions: message.mentionAll ? 1 : 0
				}
			}
		}
	}
	if (hasOptionalProperty(message, 'edit')) {
		m = {
			protocolMessage: {
				key: message.edit,
				editedMessage: m,
				timestampMs: Date.now(),
				type: WAProto_1.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
			}
		}
	}
	if (hasOptionalProperty(message, 'contextInfo') && !!message.contextInfo) {
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		if ('contextInfo' in key && !!key.contextInfo) {
			key.contextInfo = { ...key.contextInfo, ...message.contextInfo }
		} else if (key) {
			key.contextInfo = message.contextInfo
		}
	}
	if ((0, reporting_utils_1.shouldIncludeReportingToken)(m)) {
		m.messageContextInfo = m.messageContextInfo || {}
		if (!m.messageContextInfo.messageSecret) {
			m.messageContextInfo.messageSecret = (0, crypto_1.randomBytes)(32)
		}
	}

	if ('externalAdReply' in message && !!message.externalAdReply) {
		const wrappers = [
			'viewOnceMessage',
			'viewOnceMessageV2',
			'viewOnceMessageV2Extension',
			'ephemeralMessage',
			'groupStatusMessage',
			'templateMessage'
		]
		const [outerType] = Object.keys(m)
		const inner = wrappers.includes(outerType) ? m[outerType].message : m
		const [innerType] = Object.keys(inner)
		const innerPayload = innerType ? inner[innerType] : undefined
		if (innerType && innerType !== 'carouselMessage' && innerPayload && typeof innerPayload === 'object') {
			const ear = normalizeEarFields(message.externalAdReply)
			innerPayload.contextInfo = {
				...(innerPayload.contextInfo || {}),
				externalAdReply: ear
			}
		}
	}
	if ('secureMetaServiceLabel' in message && !!message.secureMetaServiceLabel) {
		const [messageType] = Object.keys(m)
		m[messageType] = m[messageType] || {}
		m[messageType].contextInfo = {
			...(m[messageType].contextInfo || {}),
			secureMetaServiceLabel: 1
		}
	}

	return WAProto_1.proto.Message.create(m)
}
exports.generateWAMessageContent = generateWAMessageContent
const generateWAMessageFromContent = (jid, message, options) => {
	// set timestamp to now
	// if not specified
	if (!options.timestamp) {
		options.timestamp = new Date()
	}
	const innerMessage = (0, exports.normalizeMessageContent)(message)
	const key = (0, exports.getContentType)(innerMessage)
	const timestamp = (0, generics_1.unixTimestampSeconds)(options.timestamp)
	const { quoted, userJid } = options
	if (quoted && !(0, WABinary_1.isJidNewsletter)(jid)) {
		const participant = quoted.key.fromMe
			? userJid // TODO: Add support for LIDs
			: quoted.participant || quoted.key.participant || quoted.key.remoteJid
		let quotedMsg = (0, exports.normalizeMessageContent)(quoted.message)
		const msgType = (0, exports.getContentType)(quotedMsg)
		// strip any redundant properties
		quotedMsg = index_js_1.proto.Message.create({ [msgType]: quotedMsg[msgType] })
		const quotedContent = quotedMsg[msgType]
		if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
			delete quotedContent.contextInfo
		}
		const contextInfo = ('contextInfo' in innerMessage[key] && innerMessage[key]?.contextInfo) || {}
		contextInfo.participant = (0, WABinary_1.jidNormalizedUser)(participant)
		contextInfo.stanzaId = quoted.key.id
		contextInfo.quotedMessage = quotedMsg
		// if a participant is quoted, then it must be a group
		// hence, remoteJid of group must also be entered
		if (jid !== quoted.key.remoteJid) {
			contextInfo.remoteJid = quoted.key.remoteJid
		}
		if (contextInfo && innerMessage[key]) {
			/* @ts-ignore */
			innerMessage[key].contextInfo = contextInfo
		}
	}
	if (
		// if we want to send a disappearing message
		!!options.ephemeralExpiration &&
		// and it's not a protocol message -- delete, toggle disappear message
		key !== 'protocolMessage' &&
		// already not converted to disappearing message
		key !== 'ephemeralMessage' &&
		// newsletters don't support ephemeral messages
		!(0, WABinary_1.isJidNewsletter)(jid)
	) {
		/* @ts-ignore */
		innerMessage[key].contextInfo = {
			...(innerMessage[key].contextInfo || {}),
			expiration: options.ephemeralExpiration || Defaults_1.WA_DEFAULT_EPHEMERAL
			//ephemeralSettingTimestamp: options.ephemeralOptions.eph_setting_ts?.toString()
		}
	}
	message = WAProto_1.proto.Message.create(message)
	const messageJSON = {
		key: {
			remoteJid: jid,
			fromMe: true,
			id: options?.messageId || (0, generics_1.generateMessageIDV2)()
		},
		message: message,
		messageTimestamp: timestamp,
		messageStubParameters: [],
		participant: (0, WABinary_1.isJidGroup)(jid) || (0, WABinary_1.isJidStatusBroadcast)(jid) ? userJid : undefined, // TODO: Add support for LIDs
		status: Types_1.WAMessageStatus.PENDING
	}
	return WAProto_1.proto.WebMessageInfo.fromObject(messageJSON)
}
exports.generateWAMessageFromContent = generateWAMessageFromContent
const generateWAMessage = async (jid, content, options) => {
	// ensure msg ID is with every log
	options.logger = options?.logger?.child({ msgId: options.messageId })
	// Pass jid in the options to generateWAMessageContent
	return (0, exports.generateWAMessageFromContent)(
		jid,
		await (0, exports.generateWAMessageContent)(content, { ...options, jid }),
		options
	)
}
exports.generateWAMessage = generateWAMessage
/** Get the key to access the true type of content */
const getContentType = content => {
	if (content) {
		const keys = Object.keys(content)
		const key = keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage')
		return key
	}
}
exports.getContentType = getContentType
/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
const normalizeMessageContent = content => {
	if (!content) {
		return undefined
	}
	// set max iterations to prevent an infinite loop
	for (let i = 0; i < 5; i++) {
		const inner = getFutureProofMessage(content)
		if (!inner) {
			break
		}
		content = inner.message
	}
	return content
	function getFutureProofMessage(message) {
		return (
			message.ephemeralMessage ||
			message.viewOnceMessage ||
			message.documentWithCaptionMessage ||
			message.viewOnceMessageV2 ||
			message.viewOnceMessageV2Extension ||
			message.editedMessage ||
			message.groupMentionedMessage ||
			message.botInvokeMessage ||
			message.lottieStickerMessage ||
			message.eventCoverImage ||
			message.statusMentionMessage ||
			message.pollCreationOptionImageMessage ||
			message.associatedChildMessage ||
			message.groupStatusMentionMessage ||
			message.pollCreationMessageV4 ||
			message.pollCreationMessageV5 ||
			message.statusAddYours ||
			message.groupStatusMessage ||
			message.limitSharingMessage ||
			message.botTaskMessage ||
			message.questionMessage ||
			message.groupStatusMessageV2 ||
			message.botForwardedMessage ||
			message.questionReplyMessage
		)
	}
}
exports.normalizeMessageContent = normalizeMessageContent
/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
const extractMessageContent = content => {
	const extractFromTemplateMessage = msg => {
		if (msg.imageMessage) {
			return { imageMessage: msg.imageMessage }
		} else if (msg.documentMessage) {
			return { documentMessage: msg.documentMessage }
		} else if (msg.videoMessage) {
			return { videoMessage: msg.videoMessage }
		} else if (msg.locationMessage) {
			return { locationMessage: msg.locationMessage }
		} else {
			return {
				conversation:
					'contentText' in msg ? msg.contentText : 'hydratedContentText' in msg ? msg.hydratedContentText : ''
			}
		}
	}
	content = (0, exports.normalizeMessageContent)(content)
	if (content?.buttonsMessage) {
		return extractFromTemplateMessage(content.buttonsMessage)
	}
	if (content?.templateMessage?.hydratedFourRowTemplate) {
		return extractFromTemplateMessage(content?.templateMessage?.hydratedFourRowTemplate)
	}
	if (content?.templateMessage?.hydratedTemplate) {
		return extractFromTemplateMessage(content?.templateMessage?.hydratedTemplate)
	}
	if (content?.templateMessage?.fourRowTemplate) {
		return extractFromTemplateMessage(content?.templateMessage?.fourRowTemplate)
	}
	return content
}
exports.extractMessageContent = extractMessageContent
/**
 * Returns the device predicted by message ID
 */
const getDevice = id =>
	/^3A.{18}$/.test(id)
		? 'ios'
		: /^3E.{20}$/.test(id)
			? 'web'
			: /^(.{21}|.{32})$/.test(id)
				? 'android'
				: /^(3F|.{18}$)/.test(id)
					? 'desktop'
					: 'api/baileys'
exports.getDevice = getDevice
/** Upserts a receipt in the message */
const updateMessageWithReceipt = (msg, receipt) => {
	msg.userReceipt = msg.userReceipt || []
	const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid)
	if (recp) {
		Object.assign(recp, receipt)
	} else {
		msg.userReceipt.push(receipt)
	}
}
exports.updateMessageWithReceipt = updateMessageWithReceipt
/** Update the message with a new reaction */
const updateMessageWithReaction = (msg, reaction) => {
	const authorID = (0, generics_1.getKeyAuthor)(reaction.key)
	const reactions = (msg.reactions || []).filter(r => (0, generics_1.getKeyAuthor)(r.key) !== authorID)
	reaction.text = reaction.text || ''
	reactions.push(reaction)
	msg.reactions = reactions
}
exports.updateMessageWithReaction = updateMessageWithReaction
/** Update the message with a new poll update */
const updateMessageWithPollUpdate = (msg, update) => {
	const authorID = (0, generics_1.getKeyAuthor)(update.pollUpdateMessageKey)
	const reactions = (msg.pollUpdates || []).filter(
		r => (0, generics_1.getKeyAuthor)(r.pollUpdateMessageKey) !== authorID
	)
	if (update.vote?.selectedOptions?.length) {
		reactions.push(update)
	}
	msg.pollUpdates = reactions
}
exports.updateMessageWithPollUpdate = updateMessageWithPollUpdate
/** Update the message with a new event response */
const updateMessageWithEventResponse = (msg, update) => {
	const authorID = (0, generics_1.getKeyAuthor)(update.eventResponseMessageKey)
	const responses = (msg.eventResponses || []).filter(
		r => (0, generics_1.getKeyAuthor)(r.eventResponseMessageKey) !== authorID
	)
	responses.push(update)
	msg.eventResponses = responses
}
exports.updateMessageWithEventResponse = updateMessageWithEventResponse
/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
	const opts =
		message?.pollCreationMessage?.options ||
		message?.pollCreationMessageV2?.options ||
		message?.pollCreationMessageV3?.options ||
		[]
	const voteHashMap = opts.reduce((acc, opt) => {
		const hash = (0, crypto_2.sha256)(Buffer.from(opt.optionName || '')).toString()
		acc[hash] = {
			name: opt.optionName || '',
			voters: []
		}
		return acc
	}, {})
	for (const update of pollUpdates || []) {
		const { vote } = update
		if (!vote) {
			continue
		}
		for (const option of vote.selectedOptions || []) {
			const hash = option.toString()
			let data = voteHashMap[hash]
			if (!data) {
				voteHashMap[hash] = {
					name: 'Unknown',
					voters: []
				}
				data = voteHashMap[hash]
			}
			voteHashMap[hash].voters.push((0, generics_1.getKeyAuthor)(update.pollUpdateMessageKey, meId))
		}
	}
	return Object.values(voteHashMap)
}
/**
 * Aggregates all event responses in an event message.
 * @param msg the event creation message
 * @param meId your jid
 * @returns A list of response types & their responders
 */
function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
	const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE']
	const responseMap = {}
	for (const type of responseTypes) {
		responseMap[type] = {
			response: type,
			responders: []
		}
	}
	for (const update of eventResponses || []) {
		const responseType = update.eventResponse || 'UNKNOWN'
		if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
			responseMap[responseType].responders.push((0, generics_1.getKeyAuthor)(update.eventResponseMessageKey, meId))
		}
	}
	return Object.values(responseMap)
}
/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
const aggregateMessageKeysNotFromMe = keys => {
	const keyMap = {}
	for (const { remoteJid, id, participant, fromMe } of keys) {
		if (!fromMe) {
			const uqKey = `${remoteJid}:${participant || ''}`
			if (!keyMap[uqKey]) {
				keyMap[uqKey] = {
					jid: remoteJid,
					participant: participant,
					messageIds: []
				}
			}
			keyMap[uqKey].messageIds.push(id)
		}
	}
	return Object.values(keyMap)
}
exports.aggregateMessageKeysNotFromMe = aggregateMessageKeysNotFromMe

/**
 * Aggregates all event responses in an event message.
 * @param msg the event creation message
 * @param meLid your lid
 * @returns A list of response types & their responders
 */
function getAggregateResponsesInEventMessage({ eventResponses }, meLid) {
	const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE']
	const responseMap = {}

	for (const type of responseTypes) {
		responseMap[type] = {
			response: type,
			responders: []
		}
	}
	for (const update of eventResponses) {
		const { response } = update.response || {}
		const responseType = index_js_1.proto.Message.EventResponseMessage.EventResponseType[response]
		if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
			responseMap[responseType].responders.push(generics_1.getKeyAuthor(update.eventResponseMessageKey, meLid))
		}
	}

	return Object.values(responseMap)
}

exports.getAggregateResponsesInEventMessage = getAggregateResponsesInEventMessage

const REUPLOAD_REQUIRED_STATUS = [410, 404]
/**
 * Downloads the given message. Throws an error if it's not a media message
 */
const downloadMediaMessage = async (message, type, options, ctx) => {
	const result = await downloadMsg().catch(async error => {
		if (
			ctx &&
			typeof error?.status === 'number' && // treat errors with status as HTTP failures requiring reupload
			REUPLOAD_REQUIRED_STATUS.includes(error.status)
		) {
			ctx.logger.info({ key: message.key }, 'sending reupload media request...')
			// request reupload
			message = await ctx.reuploadRequest(message)
			const result = await downloadMsg()
			return result
		}
		throw error
	})
	return result
	async function downloadMsg() {
		const mContent = (0, exports.extractMessageContent)(message.message)
		if (!mContent) {
			throw new boom_1.Boom('No message present', { statusCode: 400, data: message })
		}
		const contentType = (0, exports.getContentType)(mContent)
		let mediaType = contentType?.replace('Message', '')
		const media = mContent[contentType]
		if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
			throw new boom_1.Boom(`"${contentType}" message is not a media message`)
		}
		let download
		if ('thumbnailDirectPath' in media && !('url' in media)) {
			download = {
				directPath: media.thumbnailDirectPath,
				mediaKey: media.mediaKey
			}
			mediaType = 'thumbnail-link'
		} else {
			download = media
		}
		const stream = await (0, messages_media_1.downloadContentFromMessage)(download, mediaType, options)
		if (type === 'buffer') {
			const bufferArray = []
			for await (const chunk of stream) {
				bufferArray.push(chunk)
			}
			return Buffer.concat(bufferArray)
		}
		return stream
	}
}
exports.downloadMediaMessage = downloadMediaMessage
/** Checks whether the given message is a media message; if it is returns the inner content */
const assertMediaContent = content => {
	content = (0, exports.extractMessageContent)(content)
	const mediaContent =
		content?.documentMessage ||
		content?.imageMessage ||
		content?.videoMessage ||
		content?.audioMessage ||
		content?.stickerMessage
	if (!mediaContent) {
		throw new boom_1.Boom('given message is not a media message', { statusCode: 400, data: content })
	}
	return mediaContent
}
exports.assertMediaContent = assertMediaContent
/**
 * Normalizes a bare user id to @s.whatsapp.net. Does not convert LID↔PN; use lidMapping / PN in key.remoteJidAlt when needed.
 */
const toJid = id => {
	if (!id) return ''
	if (id.includes('@')) return id
	return `${id}@s.whatsapp.net`
}
exports.toJid = toJid
/**
 * Returns the peer LID JID when the key is LID-primary (decode sets remoteJid/participant to @lid when WA sends LID).
 */
const getSenderLid = message => {
	const k = message.key
	if (!k) {
		return { jid: '', lid: '' }
	}
	const jid = k.participant || k.remoteJid || ''
	if (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')) {
		return { jid, lid: jid }
	}
	if (k.lid && typeof k.lid === 'string') {
		const lid = k.lid.includes('@') ? k.lid : (0, WABinary_1.jidEncode)(k.lid, 'lid')
		return { jid, lid }
	}
	if (k.participantLid && (0, WABinary_1.isLidUser)(k.participantLid)) {
		return { jid, lid: k.participantLid }
	}
	return { jid, lid: '' }
}
exports.getSenderLid = getSenderLid
