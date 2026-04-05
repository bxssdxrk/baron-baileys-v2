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
	image: Types_1.WAProto.Message.ImageMessage,
	video: Types_1.WAProto.Message.VideoMessage,
	audio: Types_1.WAProto.Message.AudioMessage,
	sticker: Types_1.WAProto.Message.StickerMessage,
	document: Types_1.WAProto.Message.DocumentMessage
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
		const obj = Types_1.WAProto.Message.fromObject({
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
			await options.mediaCache.set(cacheableKey, Types_1.WAProto.Message.encode(obj).finish())
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
	const obj = Types_1.WAProto.Message.fromObject({
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
		await options.mediaCache.set(cacheableKey, Types_1.WAProto.Message.encode(obj).finish())
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
					type: Types_1.WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
					ephemeralExpiration
				}
			}
		}
	}
	return Types_1.WAProto.Message.fromObject(content)
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
const generateWAMessageContent = async (message, options) => {
	var _a, _b
	let m = {}
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
			m.contactMessage = Types_1.WAProto.Message.ContactMessage.create(message.contacts.contacts[0])
		} else {
			m.contactsArrayMessage = Types_1.WAProto.Message.ContactsArrayMessage.create(message.contacts)
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'location')) {
		m.locationMessage = Types_1.WAProto.Message.LocationMessage.create(message.location)
	} else if ((0, exports.hasNonNullishProperty)(message, 'react')) {
		if (!message.react.senderTimestampMs) {
			message.react.senderTimestampMs = Date.now()
		}
		m.reactionMessage = Types_1.WAProto.Message.ReactionMessage.create(message.react)
	} else if ((0, exports.hasNonNullishProperty)(message, 'delete')) {
		m.protocolMessage = {
			key: message.delete,
			type: Types_1.WAProto.Message.ProtocolMessage.Type.REVOKE
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
		}
	} else if (hasOptionalProperty(message, 'ptv') && message.ptv) {
		const { videoMessage } = await (0, exports.prepareWAMessageMedia)({ video: message.video }, options)
		m.ptvMessage = videoMessage
	} else if ((0, exports.hasNonNullishProperty)(message, 'product')) {
		const { imageMessage } = await (0, exports.prepareWAMessageMedia)({ image: message.product.productImage }, options)
		m.productMessage = Types_1.WAProto.Message.ProductMessage.create({
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
	} else {
		m = await (0, exports.prepareWAMessageMedia)(message, options)
	}
	if (hasOptionalProperty(message, 'viewOnce') && !!message.viewOnce) {
		m = { viewOnceMessage: { message: m } }
	}
	if (
		(hasOptionalProperty(message, 'mentions') && message.mentions?.length) ||
		(hasOptionalProperty(message, 'mentionAll') && message.mentionAll)
	) {
		const normalizedMentions = await (0, jid_display_normalization_1.normalizeMentionedJidsForSend)(
			message.mentions,
			options.groupData,
			options.signalRepository
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
				type: Types_1.WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
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
	return Types_1.WAProto.Message.create(m)
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
	message = Types_1.WAProto.Message.create(message)
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
	return Types_1.WAProto.WebMessageInfo.fromObject(messageJSON)
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
			message?.ephemeralMessage ||
			message?.viewOnceMessage ||
			message?.documentWithCaptionMessage ||
			message?.viewOnceMessageV2 ||
			message?.viewOnceMessageV2Extension ||
			message?.editedMessage ||
			message?.associatedChildMessage ||
			message?.groupStatusMessage ||
			message?.groupStatusMessageV2
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
