'use strict'
var __importDefault =
	(this && this.__importDefault) ||
	function (mod) {
		return mod && mod.__esModule ? mod : { default: mod }
	}
Object.defineProperty(exports, '__esModule', { value: true })
exports.makeMessagesSocket = void 0
const node_cache_1 = __importDefault(require('@cacheable/node-cache'))
const boom_1 = require('@hapi/boom')
const index_js_1 = require('../../WAProto/index.js')
const Defaults_1 = require('../Defaults')
const Utils_1 = require('../Utils')
const link_preview_1 = require('../Utils/link-preview')
const make_mutex_1 = require('../Utils/make-mutex')
const reporting_utils_1 = require('../Utils/reporting-utils')
const jid_display_normalization_1 = require('../Utils/jid-display-normalization')
const WABinary_1 = require('../WABinary')
const WAUSync_1 = require('../WAUSync')
const message_composer_1 = require('../Utils/message-composer.js')
const interactive_handler_1 = require('./interactive-handler.js')
const newsletter_1 = require('./newsletter')
const makeMessagesSocket = config => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: httpRequestOptions,
		patchMessageBeforeSending,
		cachedGroupMetadata,
		enableRecentMessageCache,
		maxMsgRetryCount
	} = config
	const sock = (0, newsletter_1.makeNewsletterSocket)(config)
	const {
		ev,
		authState,
		messageMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		sendNode,
		groupMetadata,
		groupToggleEphemeral
	} = sock
	const userDevicesCache =
		config.userDevicesCache ||
		new node_cache_1.default({
			stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
			useClones: false
		})
	const peerSessionsCache = new node_cache_1.default({
		stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES,
		useClones: false
	})
	// Initialize message retry manager if enabled
	const messageRetryManager = enableRecentMessageCache
		? new Utils_1.MessageRetryManager(logger, maxMsgRetryCount)
		: null
	// Prevent race conditions in Signal session encryption by user
	const encryptionMutex = (0, make_mutex_1.makeKeyedMutex)()
	let mediaConn
	const refreshMediaConn = async (forceGet = false) => {
		const media = await mediaConn
		if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
			mediaConn = (async () => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: WABinary_1.S_WHATSAPP_NET
					},
					content: [{ tag: 'media_conn', attrs: {} }]
				})
				const mediaConnNode = (0, WABinary_1.getBinaryNodeChild)(result, 'media_conn')
				// TODO: explore full length of data that whatsapp provides
				const node = {
					hosts: (0, WABinary_1.getBinaryNodeChildren)(mediaConnNode, 'host').map(({ attrs }) => ({
						hostname: attrs.hostname,
						maxContentLengthBytes: +attrs.maxContentLengthBytes
					})),
					auth: mediaConnNode.attrs.auth,
					ttl: +mediaConnNode.attrs.ttl,
					fetchDate: new Date()
				}
				logger.debug('fetched media conn')
				return node
			})()
		}
		return mediaConn
	}
	/**
	 * generic send receipt function
	 * used for receipts of phone call, read, delivery etc.
	 * */
	const sendReceipt = async (jid, participant, messageIds, type) => {
		if (!messageIds || messageIds.length === 0) {
			throw new boom_1.Boom('missing ids in receipt')
		}
		const node = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0]
			}
		}
		const isReadReceipt = type === 'read' || type === 'read-self'
		if (isReadReceipt) {
			node.attrs.t = (0, Utils_1.unixTimestampSeconds)().toString()
		}
		if (type === 'sender' && ((0, WABinary_1.isPnUser)(jid) || (0, WABinary_1.isLidUser)(jid))) {
			node.attrs.recipient = jid
			node.attrs.to = participant
		} else {
			node.attrs.to = jid
			if (participant) {
				node.attrs.participant = participant
			}
		}
		if (type) {
			node.attrs.type = type
		}
		const remainingMessageIds = messageIds.slice(1)
		if (remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: {},
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id }
					}))
				}
			]
		}
		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}
	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async (keys, type) => {
		const recps = (0, Utils_1.aggregateMessageKeysNotFromMe)(keys)
		for (const { jid, participant, messageIds } of recps) {
			await sendReceipt(jid, participant, messageIds, type)
		}
	}
	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async keys => {
		const privacySettings = await fetchPrivacySettings()
		// based on privacy settings, we have to change the read type
		const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
		await sendReceipts(keys, readType)
	}
	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
		const deviceResults = []
		if (!useCache) {
			logger.debug('not using cache for devices')
		}
		const toFetch = []
		const jidsWithUser = jids
			.map(jid => {
				const decoded = (0, WABinary_1.jidDecode)(jid)
				const user = decoded?.user
				const device = decoded?.device
				const isExplicitDevice = typeof device === 'number' && device >= 0
				if (isExplicitDevice && user) {
					deviceResults.push({
						user,
						device,
						jid
					})
					return null
				}
				jid = (0, WABinary_1.jidNormalizedUser)(jid)
				return { jid, user }
			})
			.filter(jid => jid !== null)
		let mgetDevices
		if (useCache && userDevicesCache.mget) {
			const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean)
			mgetDevices = await userDevicesCache.mget(usersToFetch)
		}
		for (const { jid, user } of jidsWithUser) {
			if (useCache) {
				const devices = mgetDevices?.[user] || (userDevicesCache.mget ? undefined : await userDevicesCache.get(user))
				if (devices) {
					const devicesWithJid = devices.map(d => ({
						...d,
						jid: (0, WABinary_1.jidEncode)(d.user, d.server, d.device)
					}))
					deviceResults.push(...devicesWithJid)
					logger.trace({ user }, 'using cache for devices')
				} else {
					toFetch.push(jid)
				}
			} else {
				toFetch.push(jid)
			}
		}
		if (!toFetch.length) {
			return deviceResults
		}
		const requestedLidUsers = new Set()
		for (const jid of toFetch) {
			if ((0, WABinary_1.isLidUser)(jid) || (0, WABinary_1.isHostedLidUser)(jid)) {
				const user = (0, WABinary_1.jidDecode)(jid)?.user
				if (user) requestedLidUsers.add(user)
			}
		}
		const query = new WAUSync_1.USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol()
		for (const jid of toFetch) {
			query.withUser(new WAUSync_1.USyncUser().withId(jid)) // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
		}
		const result = await sock.executeUSyncQuery(query)
		if (result) {
			// TODO: LID MAP this stuff (lid protocol will now return lid with devices)
			const lidResults = result.list.filter(a => !!a.lid)
			if (lidResults.length > 0) {
				logger.trace('Storing LID maps from device call')
				await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid, pn: a.id })))
				// Force-refresh sessions for newly mapped LIDs to align identity addressing
				try {
					const lids = lidResults.map(a => a.lid)
					if (lids.length) {
						await assertSessions(lids, true)
					}
				} catch (e) {
					logger.warn({ e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs')
				}
			}
			const extracted = (0, Utils_1.extractDeviceJids)(
				result?.list,
				authState.creds.me.id,
				authState.creds.me.lid,
				ignoreZeroDevices
			)
			const deviceMap = {}
			for (const item of extracted) {
				deviceMap[item.user] = deviceMap[item.user] || []
				deviceMap[item.user]?.push(item)
			}
			// Process each user's devices as a group for bulk LID migration
			for (const [user, userDevices] of Object.entries(deviceMap)) {
				const isLidUser = requestedLidUsers.has(user)
				// Process all devices for this user
				for (const item of userDevices) {
					const finalJid = isLidUser
						? (0, WABinary_1.jidEncode)(user, item.server, item.device)
						: (0, WABinary_1.jidEncode)(item.user, item.server, item.device)
					deviceResults.push({
						...item,
						jid: finalJid
					})
					logger.debug(
						{
							user: item.user,
							device: item.device,
							finalJid,
							usedLid: isLidUser
						},
						'Processed device with LID priority'
					)
				}
			}
			if (userDevicesCache.mset) {
				// if the cache supports mset, we can set all devices in one go
				await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
			} else {
				for (const key in deviceMap) {
					if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
				}
			}
			const userDeviceUpdates = {}
			for (const [userId, devices] of Object.entries(deviceMap)) {
				if (devices && devices.length > 0) {
					userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')
				}
			}
			if (Object.keys(userDeviceUpdates).length > 0) {
				try {
					await authState.keys.set({ 'device-list': userDeviceUpdates })
					logger.debug(
						{ userCount: Object.keys(userDeviceUpdates).length },
						'stored user device lists for bulk migration'
					)
				} catch (error) {
					logger.warn({ error }, 'failed to store user device lists')
				}
			}
		}
		return deviceResults
	}
	/**
	 * Update Member Label
	 */
	const updateMemberLabel = (jid, memberLabel) => {
		return relayMessage(
			jid,
			{
				protocolMessage: {
					type: index_js_1.proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
					memberLabel: {
						label: memberLabel?.slice(0, 30),
						labelTimestamp: (0, Utils_1.unixTimestampSeconds)()
					}
				}
			},
			{
				additionalNodes: [
					{
						tag: 'meta',
						attrs: {
							tag_reason: 'user_update',
							appdata: 'member_tag'
						},
						content: undefined
					}
				]
			}
		)
	}
	const assertSessions = async (jids, force) => {
		let didFetchNewSession = false
		const uniqueJids = [...new Set(jids)] // Deduplicate JIDs
		const jidsRequiringFetch = []
		logger.debug({ jids }, 'assertSessions call with jids')
		// Check peerSessionsCache and validate sessions using libsignal loadSession
		for (const jid of uniqueJids) {
			const signalId = signalRepository.jidToSignalProtocolAddress(jid)
			const cachedSession = peerSessionsCache.get(signalId)
			if (cachedSession !== undefined) {
				if (cachedSession && !force) {
					continue // Session exists in cache
				}
			} else {
				const sessionValidation = await signalRepository.validateSession(jid)
				const hasSession = sessionValidation.exists
				peerSessionsCache.set(signalId, hasSession)
				if (hasSession && !force) {
					continue
				}
			}
			jidsRequiringFetch.push(jid)
		}
		if (jidsRequiringFetch.length) {
			// LID if mapped, otherwise original
			const wireJids = [
				...jidsRequiringFetch.filter(jid => !!(0, WABinary_1.isLidUser)(jid) || !!(0, WABinary_1.isHostedLidUser)(jid)),
				...(
					(await signalRepository.lidMapping.getLIDsForPNs(
						jidsRequiringFetch.filter(jid => !!(0, WABinary_1.isPnUser)(jid) || !!(0, WABinary_1.isHostedPnUser)(jid))
					)) || []
				).map(a => a.lid)
			]
			logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions')
			const result = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'encrypt',
					type: 'get',
					to: WABinary_1.S_WHATSAPP_NET
				},
				content: [
					{
						tag: 'key',
						attrs: {},
						content: wireJids.map(jid => {
							const attrs = { jid }
							if (force) attrs.reason = 'identity'
							return { tag: 'user', attrs }
						})
					}
				]
			})
			await (0, Utils_1.parseAndInjectE2ESessions)(result, signalRepository)
			didFetchNewSession = true
			// Cache fetched sessions using wire JIDs
			for (const wireJid of wireJids) {
				const signalId = signalRepository.jidToSignalProtocolAddress(wireJid)
				peerSessionsCache.set(signalId, true)
			}
		}
		return didFetchNewSession
	}
	const sendPeerDataOperationMessage = async pdoMessage => {
		//TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
		if (!authState.creds.me?.id) {
			throw new boom_1.Boom('Not authenticated')
		}
		const protocolMessage = {
			protocolMessage: {
				peerDataOperationRequestMessage: pdoMessage,
				type: index_js_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
			}
		}
		const meJid = (0, WABinary_1.jidNormalizedUser)(authState.creds.me.id)
		const msgId = await relayMessage(meJid, protocolMessage, {
			additionalAttributes: {
				category: 'peer',
				push_priority: 'high_force'
			},
			additionalNodes: [
				{
					tag: 'meta',
					attrs: { appdata: 'default' }
				}
			]
		})
		return msgId
	}
	const createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {
		if (!recipientJids.length) {
			return { nodes: [], shouldIncludeDeviceIdentity: false }
		}
		const patched = await patchMessageBeforeSending(message, recipientJids)
		const patchedMessages = Array.isArray(patched)
			? patched
			: recipientJids.map(jid => ({ recipientJid: jid, message: patched }))
		let shouldIncludeDeviceIdentity = false
		const meId = authState.creds.me.id
		const meLid = authState.creds.me?.lid
		const meLidUser = meLid ? (0, WABinary_1.jidDecode)(meLid)?.user : null
		const encryptionPromises = patchedMessages.map(async ({ recipientJid: jid, message: patchedMessage }) => {
			try {
				if (!jid) return null
				let msgToEncrypt = patchedMessage
				if (dsmMessage) {
					const { user: targetUser } = (0, WABinary_1.jidDecode)(jid)
					const { user: ownPnUser } = (0, WABinary_1.jidDecode)(meId)
					const ownLidUser = meLidUser
					const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser)
					const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
					if (isOwnUser && !isExactSenderDevice) {
						msgToEncrypt = dsmMessage
						logger.debug({ jid, targetUser }, 'Using DSM for own device')
					}
				}
				const bytes = (0, Utils_1.encodeWAMessage)(msgToEncrypt)
				const mutexKey = jid
				const node = await encryptionMutex.mutex(mutexKey, async () => {
					const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes })
					if (type === 'pkmsg') {
						shouldIncludeDeviceIdentity = true
					}
					return {
						tag: 'to',
						attrs: { jid },
						content: [
							{
								tag: 'enc',
								attrs: { v: '2', type, ...(extraAttrs || {}) },
								content: ciphertext
							}
						]
					}
				})
				return node
			} catch (err) {
				logger.error({ jid, err }, 'Failed to encrypt for recipient')
				return null
			}
		})
		const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null)
		if (recipientJids.length > 0 && nodes.length === 0) {
			throw new boom_1.Boom('All encryptions failed', { statusCode: 500 })
		}
		return { nodes, shouldIncludeDeviceIdentity }
	}
	const relayMessage = async (
		jid,
		message,
		{
			messageId: msgId,
			participant,
			additionalAttributes,
			additionalNodes,
			useUserDevicesCache,
			useCachedGroupMetadata,
			statusJidList,
			AI = false
		}
	) => {
		const meId = authState.creds.me.id
		const meLid = authState.creds.me?.lid
		const isRetryResend = Boolean(participant?.jid)
		let shouldIncludeDeviceIdentity = isRetryResend
		const statusJid = 'status@broadcast'
		const { user, server } = (0, WABinary_1.jidDecode)(jid)
		const isGroup = server === 'g.us'
		const isStatus = jid === statusJid
		const isLid = server === 'lid'
		const isNewsletter = server === 'newsletter'
		const isGroupOrStatus = isGroup || isStatus
		const finalJid = jid
		msgId = msgId || (0, Utils_1.generateMessageIDV2)(meId)
		useUserDevicesCache = useUserDevicesCache !== false
		useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus
		const participants = []
		const destinationJid = !isStatus ? finalJid : statusJid
		const binaryNodeContent = []
		const devices = []
		let reportingMessage
		const meMsg = {
			deviceSentMessage: {
				destinationJid,
				message
			},
			messageContextInfo: message.messageContextInfo
		}
		const extraAttrs = {}

		const regexGroupOld = /^(\d{1,15})-(\d+)@g\.us$/

		const messages = Utils_1.normalizeMessageContent(message)

		const buttonType = getButtonType(messages)
		const pollMessage = messages.pollCreationMessage || messages.pollCreationMessageV2 || messages.pollCreationMessageV3

		if (participant) {
			if (!isGroup && !isStatus) {
				additionalAttributes = { ...additionalAttributes, device_fanout: 'false' }
			}
			const { user, device } = (0, WABinary_1.jidDecode)(participant.jid)
			devices.push({
				user,
				device,
				jid: participant.jid
			})
		}
		await authState.keys.transaction(async () => {
			const mediaType = getMediaType(message)
			if (mediaType) {
				extraAttrs['mediatype'] = mediaType
			}
			if (isNewsletter) {
				const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message
				const bytes = (0, Utils_1.encodeNewsletterMessage)(patched)
				binaryNodeContent.push({
					tag: 'plaintext',
					attrs: {},
					content: bytes
				})
				const stanza = {
					tag: 'message',
					attrs: {
						to: jid,
						id: msgId,
						type: getTypeMessage(message),
						...(additionalAttributes || {})
					},
					content: binaryNodeContent
				}
				logger.debug({ msgId }, `sending newsletter message to ${jid}`)
				await sendNode(stanza)
				return
			}
			if (
				(0, Utils_1.normalizeMessageContent)(message)?.pinInChatMessage ||
				(0, Utils_1.normalizeMessageContent)(message)?.reactionMessage
			) {
				extraAttrs['decrypt-fail'] = 'hide' // todo: expand for reactions and other types
			}
			if (isGroupOrStatus && !isRetryResend) {
				const [groupData, senderKeyMap] = await Promise.all([
					(async () => {
						let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined // todo: should we rely on the cache specially if the cache is outdated and the metadata has new fields?
						if (groupData && Array.isArray(groupData?.participants)) {
							logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
						} else if (!isStatus) {
							groupData = await groupMetadata(jid) // TODO: start storing group participant list + addr mode in Signal & stop relying on this
						}
						return groupData
					})(),
					(async () => {
						if (!participant && !isStatus) {
							// what if sender memory is less accurate than the cached metadata
							// on participant change in group, we should do sender memory manipulation
							const result = await authState.keys.get('sender-key-memory', [jid]) // TODO: check out what if the sender key memory doesn't include the LID stuff now?
							return result[jid] || {}
						}
						return {}
					})()
				])
				const participantsList = groupData ? groupData.participants.map(p => p.id) : []
				if (groupData?.ephemeralDuration && groupData.ephemeralDuration > 0) {
					additionalAttributes = {
						...additionalAttributes,
						expiration: groupData.ephemeralDuration.toString()
					}
				}
				if (isStatus && statusJidList) {
					participantsList.push(...statusJidList)
				}
				const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
				devices.push(...additionalDevices)
				if (isGroup) {
					additionalAttributes = {
						...additionalAttributes,
						addressing_mode: groupData?.addressingMode || 'lid'
					}
				}
				if (message?.groupStatusMessageV2 && !message?.messageContextInfo?.messageSecret) {
					const { randomBytes } = require('crypto')
					message = {
						...message,
						messageContextInfo: {
							...(message.messageContextInfo || {}),
							messageSecret: randomBytes(32)
						},
						groupStatusMessageV2: {
							...message.groupStatusMessageV2,
							message: {
								...(message.groupStatusMessageV2.message || {}),
								messageContextInfo: {
									...(message.groupStatusMessageV2.message?.messageContextInfo || {}),
									messageSecret: message.messageContextInfo?.messageSecret || randomBytes(32)
								}
							}
						}
					}
				}
				if (message.listMessage) {
					const list = message.listMessage
					const interactiveMessage = {
						nativeFlowMessage: {
							buttons: [
								{
									name: 'single_select',
									buttonParamsJson: JSON.stringify({
										title: list.buttonText || 'Select',
										sections: (list.sections || []).map(section => ({
											title: section.title || '',
											highlight_label: '',
											rows: (section.rows || []).map(row => ({
												header: '',
												title: row.title || '',
												description: row.description || '',
												id: row.rowId || row.id || ''
											}))
										}))
									})
								}
							],
							messageParamsJson: '',
							messageVersion: 1
						},
						body: { text: list.description || '' },
						footer: list.footerText ? { text: list.footerText } : undefined,
						header: list.title ? { title: list.title, hasMediaAttachment: false, subtitle: '' } : undefined,
						contextInfo: list.contextInfo
					}
					message = { interactiveMessage }
				} else if (message.buttonsMessage) {
					const bMsg = message.buttonsMessage
					const buttons = (bMsg.buttons || []).map(btn => ({
						name: 'quick_reply',
						buttonParamsJson: JSON.stringify({
							display_text: btn.buttonText?.displayText || btn.buttonText || '',
							id: btn.buttonId || btn.buttonText?.displayText || ''
						})
					}))
					const interactiveMessage = {
						nativeFlowMessage: {
							buttons,
							messageParamsJson: '',
							messageVersion: 1
						},
						body: { text: bMsg.contentText || bMsg.text || '' },
						footer: bMsg.footerText ? { text: bMsg.footerText } : undefined,
						header: bMsg.text
							? { title: bMsg.text, hasMediaAttachment: false, subtitle: '' }
							: bMsg.imageMessage || bMsg.videoMessage || bMsg.documentMessage
								? {
										hasMediaAttachment: true,
										...(bMsg.imageMessage ? { imageMessage: bMsg.imageMessage } : {}),
										...(bMsg.videoMessage ? { videoMessage: bMsg.videoMessage } : {})
									}
								: undefined,
						contextInfo: bMsg.contextInfo
					}
					message = { interactiveMessage }
				} else if (message.templateMessage) {
					const tmpl = message.templateMessage.hydratedTemplate || message.templateMessage.fourRowTemplate
					if (tmpl) {
						const hydratedButtons = tmpl.hydratedButtons || []
						const buttons = hydratedButtons
							.map(hBtn => {
								if (hBtn.quickReplyButton) {
									return {
										name: 'quick_reply',
										buttonParamsJson: JSON.stringify({
											display_text: hBtn.quickReplyButton.displayText || '',
											id: hBtn.quickReplyButton.id || hBtn.quickReplyButton.displayText || ''
										})
									}
								} else if (hBtn.urlButton) {
									return {
										name: 'cta_url',
										buttonParamsJson: JSON.stringify({
											display_text: hBtn.urlButton.displayText || '',
											url: hBtn.urlButton.url || '',
											merchant_url: hBtn.urlButton.url || ''
										})
									}
								} else if (hBtn.callButton) {
									return {
										name: 'cta_call',
										buttonParamsJson: JSON.stringify({
											display_text: hBtn.callButton.displayText || '',
											phone_number: hBtn.callButton.phoneNumber || ''
										})
									}
								}
								return null
							})
							.filter(Boolean)
						const interactiveMessage = {
							nativeFlowMessage: {
								buttons,
								messageParamsJson: '',
								messageVersion: 1
							},
							body: { text: tmpl.hydratedContentText || tmpl.contentText || '' },
							footer: tmpl.hydratedFooterText ? { text: tmpl.hydratedFooterText } : undefined,
							header: tmpl.hydratedTitleText
								? { title: tmpl.hydratedTitleText, hasMediaAttachment: false, subtitle: '' }
								: tmpl.imageMessage || tmpl.videoMessage || tmpl.documentMessage
									? {
											hasMediaAttachment: true,
											...(tmpl.imageMessage ? { imageMessage: tmpl.imageMessage } : {}),
											...(tmpl.videoMessage ? { videoMessage: tmpl.videoMessage } : {})
										}
									: undefined,
							contextInfo: tmpl.contextInfo
						}
						message = { interactiveMessage }
					}
				}
				const patched = await patchMessageBeforeSending(message)
				if (Array.isArray(patched)) {
					throw new boom_1.Boom('Per-jid patching is not supported in groups')
				}
				const bytes = (0, Utils_1.encodeWAMessage)(patched)
				reportingMessage = patched
				const groupAddressingMode = additionalAttributes?.['addressing_mode'] || groupData?.addressingMode || 'lid'
				const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId
				const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
					group: destinationJid,
					data: bytes,
					meId: groupSenderIdentity
				})
				const senderKeyRecipients = []
				for (const device of devices) {
					const deviceJid = device.jid
					const hasKey = !!senderKeyMap[deviceJid]
					if (
						(!hasKey || !!participant) &&
						!(0, WABinary_1.isHostedLidUser)(deviceJid) &&
						!(0, WABinary_1.isHostedPnUser)(deviceJid) &&
						device.device !== 99
					) {
						//todo: revamp all this logic
						// the goal is to follow with what I said above for each group, and instead of a true false map of ids, we can set an array full of those the app has already sent pkmsgs
						senderKeyRecipients.push(deviceJid)
						senderKeyMap[deviceJid] = true
					}
				}
				if (senderKeyRecipients.length) {
					logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending new sender key')
					const senderKeyMsg = {
						senderKeyDistributionMessage: {
							axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
							groupId: destinationJid
						}
					}
					const senderKeySessionTargets = senderKeyRecipients
					await assertSessions(senderKeySessionTargets)
					const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs)
					shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity
					participants.push(...result.nodes)
				}
				binaryNodeContent.push({
					tag: 'enc',
					attrs: { v: '2', type: 'skmsg', ...extraAttrs },
					content: ciphertext
				})
				await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
			} else {
				// ADDRESSING CONSISTENCY: Match own identity to conversation context
				// TODO: investigate if this is true
				let ownId = meId
				if (isLid && meLid) {
					ownId = meLid
					logger.debug({ to: jid, ownId }, 'Using LID identity for @lid conversation')
				} else {
					logger.debug({ to: jid, ownId }, 'Using PN identity for @s.whatsapp.net conversation')
				}
				const { user: ownUser } = (0, WABinary_1.jidDecode)(ownId)
				if (!participant) {
					const patchedForReporting = await patchMessageBeforeSending(message, [jid])
					reportingMessage = Array.isArray(patchedForReporting)
						? patchedForReporting.find(item => item.recipientJid === jid) || patchedForReporting[0]
						: patchedForReporting
				}
				if (!isRetryResend) {
					const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
					devices.push({
						user,
						device: 0,
						jid: (0, WABinary_1.jidEncode)(user, targetUserServer, 0) // rajeh, todo: this entire logic is convoluted and weird.
					})
					if (user !== ownUser) {
						const ownUserServer = isLid ? 'lid' : 's.whatsapp.net'
						const ownUserForAddressing =
							isLid && meLid ? (0, WABinary_1.jidDecode)(meLid).user : (0, WABinary_1.jidDecode)(meId).user
						devices.push({
							user: ownUserForAddressing,
							device: 0,
							jid: (0, WABinary_1.jidEncode)(ownUserForAddressing, ownUserServer, 0)
						})
					}
					if (additionalAttributes?.['category'] !== 'peer') {
						// Clear placeholders and enumerate actual devices
						devices.length = 0
						// Use conversation-appropriate sender identity
						const senderIdentity =
							isLid && meLid
								? (0, WABinary_1.jidEncode)((0, WABinary_1.jidDecode)(meLid)?.user, 'lid', undefined)
								: (0, WABinary_1.jidEncode)((0, WABinary_1.jidDecode)(meId)?.user, 's.whatsapp.net', undefined)
						// Enumerate devices for sender and target with consistent addressing
						const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false)
						devices.push(...sessionDevices)
						logger.debug(
							{
								deviceCount: devices.length,
								devices: devices.map(d => `${d.user}:${d.device}@${(0, WABinary_1.jidDecode)(d.jid)?.server}`)
							},
							'Device enumeration complete with unified addressing'
						)
					}
				}
				const allRecipients = []
				const meRecipients = []
				const otherRecipients = []
				const { user: mePnUser } = (0, WABinary_1.jidDecode)(meId)
				const { user: meLidUser } = meLid ? (0, WABinary_1.jidDecode)(meLid) : { user: null }
				for (const { user, jid } of devices) {
					const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
					if (isExactSenderDevice) {
						logger.debug({ jid, meId, meLid }, 'Skipping exact sender device (whatsmeow pattern)')
						continue
					}
					// Check if this is our device (could match either PN or LID user)
					const isMe = user === mePnUser || user === meLidUser
					if (isMe) {
						meRecipients.push(jid)
					} else {
						otherRecipients.push(jid)
					}
					allRecipients.push(jid)
				}
				await assertSessions(allRecipients)
				const [
					{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
					{ nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }
				] = await Promise.all([
					// For own devices: use DSM if available (1:1 chats only)
					createParticipantNodes(meRecipients, meMsg || message, extraAttrs),
					createParticipantNodes(otherRecipients, message, extraAttrs, meMsg)
				])
				participants.push(...meNodes)
				participants.push(...otherNodes)
				if (meRecipients.length > 0 || otherRecipients.length > 0) {
					extraAttrs['phash'] = (0, Utils_1.generateParticipantHashV2)([...meRecipients, ...otherRecipients])
				}
				shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
			}
			if (isRetryResend) {
				const isParticipantLid = (0, WABinary_1.isLidUser)(participant.jid)
				const isMe = (0, WABinary_1.areJidsSameUser)(participant.jid, isParticipantLid ? meLid : meId)
				const encodedMessageToSend = isMe
					? (0, Utils_1.encodeWAMessage)({
							deviceSentMessage: {
								destinationJid,
								message
							}
						})
					: (0, Utils_1.encodeWAMessage)(message)
				const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({
					data: encodedMessageToSend,
					jid: participant.jid
				})
				binaryNodeContent.push({
					tag: 'enc',
					attrs: {
						v: '2',
						type,
						count: participant.count.toString()
					},
					content: encryptedContent
				})
			}
			if (participants.length) {
				if (additionalAttributes?.['category'] === 'peer') {
					const peerNode = participants[0]?.content?.[0]
					if (peerNode) {
						binaryNodeContent.push(peerNode) // push only enc
					}
				} else {
					binaryNodeContent.push({
						tag: 'participants',
						attrs: {},
						content: participants
					})
				}
			}
			const stanza = {
				tag: 'message',
				attrs: {
					id: msgId,
					to: destinationJid,
					type: getTypeMessage(message),
					...(additionalAttributes || {})
				},
				content: binaryNodeContent
			}
			// if the participant to send to is explicitly specified (generally retry recp)
			// ensure the message is only sent to that person
			// if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
			if (participant) {
				if ((0, WABinary_1.isJidGroup)(destinationJid)) {
					stanza.attrs.to = destinationJid
					stanza.attrs.participant = participant.jid
				} else if ((0, WABinary_1.areJidsSameUser)(participant.jid, meId)) {
					stanza.attrs.to = participant.jid
					stanza.attrs.recipient = destinationJid
				} else {
					stanza.attrs.to = participant.jid
				}
			} else {
				stanza.attrs.to = destinationJid
			}
			if (shouldIncludeDeviceIdentity) {
				stanza.content.push({
					tag: 'device-identity',
					attrs: {},
					content: (0, Utils_1.encodeSignedDeviceIdentity)(authState.creds.account, true)
				})
				logger.debug({ jid }, 'adding device identity')
			}

			if (isGroup && regexGroupOld.test(jid) && !message.reactionMessage) {
				stanza.content.push({
					tag: 'multicast',
					attrs: {}
				})
			}

			if (pollMessage || messages.eventMessage) {
				stanza.content.push({
					tag: 'meta',
					attrs: messages.eventMessage
						? {
								event_type: 'creation'
							}
						: isNewsletter
							? {
									polltype: 'creation',
									contenttype: pollMessage?.pollContentType === 2 ? 'image' : 'text'
								}
							: {
									polltype: 'creation'
								}
				})
			}
			if (
				!isNewsletter &&
				!isRetryResend &&
				reportingMessage?.messageContextInfo?.messageSecret &&
				(0, reporting_utils_1.shouldIncludeReportingToken)(reportingMessage)
			) {
				try {
					const encoded = (0, Utils_1.encodeWAMessage)(reportingMessage)
					const reportingKey = {
						id: msgId,
						fromMe: true,
						remoteJid: destinationJid,
						participant: participant?.jid
					}
					const reportingNode = await (0, reporting_utils_1.getMessageReportingToken)(
						encoded,
						reportingMessage,
						reportingKey
					)
					if (reportingNode) {
						stanza.content.push(reportingNode)
						logger.trace({ jid }, 'added reporting token to message')
					}
				} catch (error) {
					logger.warn({ jid, trace: error?.stack }, 'failed to attach reporting token')
				}
			}

			if (!isNewsletter && buttonType) {
				const buttonsNode = getButtonArgs(messages)
				const filteredButtons = WABinary_1.getBinaryFilteredButtons(additionalNodes ? additionalNodes : [])

				if (filteredButtons) {
					stanza.content.push(...additionalNodes)
					didPushAdditional = true
				} else {
					stanza.content.push(buttonsNode)
				}
			}
			if (!AI && (0, WABinary_1.isPnUser)(destinationJid)) {
				const alreadyHasBizBot =
					WABinary_1.getBinaryFilteredBizBot(additionalNodes || []) ||
					WABinary_1.getBinaryFilteredBizBot(stanza.content)
				if (!alreadyHasBizBot) {
					stanza.content.push({ tag: 'bot', attrs: { biz_bot: '1' } })
				}
			} else if (AI && !isGroup && !isStatus && !isNewsletter) {
				const existingBizBot = WABinary_1.getBinaryFilteredBizBot(additionalNodes || [])
				if (!existingBizBot) {
					stanza.content.push({ tag: 'bot', attrs: { biz_bot: '1' } })
				}
			}
			const contactTcTokenData =
				!isGroup && !isRetryResend && !isStatus ? await authState.keys.get('tctoken', [destinationJid]) : {}
			const tcTokenBuffer = contactTcTokenData[destinationJid]?.token
			if (tcTokenBuffer) {
				stanza.content.push({
					tag: 'tctoken',
					attrs: {},
					content: tcTokenBuffer
				})
			}
			if (additionalNodes && additionalNodes.length > 0) {
				stanza.content.push(...additionalNodes)
			}
			logger.debug({ msgId }, `sending message to ${participants.length} devices`)
			await sendNode(stanza)
			// Add message to retry cache if enabled
			if (messageRetryManager && !participant) {
				messageRetryManager.addRecentMessage(destinationJid, msgId, message)
			}
		}, meId)
		return msgId
	}
	const getTypeMessage = msg => {
		const message = Utils_1.normalizeMessageContent(msg)
		if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
			return 'poll'
		} else if (message.reactionMessage) {
			return 'reaction'
		} else if (message.eventMessage) {
			return 'event'
		} else if (getMediaType(message)) {
			return 'media'
		} else {
			return 'text'
		}
	}

	const getMediaType = message => {
		if (message.imageMessage) {
			return 'image'
		} else if (message.stickerMessage) {
			return message.stickerMessage.isLottie
				? '1p_sticker'
				: message.stickerMessage.isAvatar
					? 'avatar_sticker'
					: 'sticker'
		} else if (message.videoMessage) {
			return message.videoMessage.gifPlayback ? 'gif' : 'video'
		} else if (message.audioMessage) {
			return message.audioMessage.ptt ? 'ptt' : 'audio'
		} else if (message.ptvMessage) {
			return 'ptv'
		} else if (message.albumMessage) {
			return 'collection'
		} else if (message.contactMessage) {
			return 'vcard'
		} else if (message.documentMessage) {
			return 'document'
		} else if (message.stickerPackMessage) {
			return 'sticker_pack'
		} else if (message.contactsArrayMessage) {
			return 'contact_array'
		} else if (message.locationMessage) {
			return 'location'
		} else if (message.liveLocationMessage) {
			return 'livelocation'
		} else if (message.listMessage) {
			return 'list'
		} else if (message.listResponseMessage) {
			return 'list_response'
		} else if (message.buttonsResponseMessage) {
			return 'buttons_response'
		} else if (message.orderMessage) {
			return 'order'
		} else if (message.productMessage) {
			return 'product'
		} else if (message.interactiveResponseMessage) {
			return 'native_flow_response'
		} else if (/https:\/\/wa\.me\/c\/\d+/.test(message.extendedTextMessage?.text)) {
			return 'cataloglink'
		} else if (/https:\/\/wa\.me\/p\/\d+\/\d+/.test(message.extendedTextMessage?.text)) {
			return 'productlink'
		} else if (message.extendedTextMessage?.matchedText || message.groupInviteMessage) {
			return 'url'
		}
	}
	const baron2 = new interactive_handler_1.Baron(waUploadToServer, relayMessage, config, sock)
	const getButtonType = message => {
		if (message.listMessage) {
			return 'list'
		} else if (message.buttonsMessage) {
			return 'buttons'
		} else if (message.interactiveMessage?.nativeFlowMessage) {
			const firstButtonName = message.interactiveMessage.nativeFlowMessage.buttons?.[0]?.name
			if (firstButtonName === 'review_and_pay') {
				return 'review_and_pay'
			} else if (firstButtonName === 'review_order') {
				return 'review_order'
			} else if (firstButtonName === 'payment_info') {
				return 'payment_info'
			} else if (firstButtonName === 'payment_status') {
				return 'payment_status'
			} else if (firstButtonName === 'payment_method') {
				return 'payment_method'
			} else if (firstButtonName === 'pix') {
				return 'pix'
			} else if (firstButtonName === 'pay') {
				return 'pay'
			}
			return 'native_flow'
		}
	}

	const getButtonArgs = message => {
		const nativeFlow = message.interactiveMessage?.nativeFlowMessage
		const firstButtonName = nativeFlow?.buttons?.[0]?.name
		const nativeFlowSpecials = [
			'mpm',
			'cta_catalog',
			'send_location',
			'call_permission_request',
			'wa_payment_transaction_details',
			'automated_greeting_message_view_catalog'
		]

		if (nativeFlow && (firstButtonName === 'review_and_pay' || firstButtonName === 'payment_info')) {
			return {
				tag: 'biz',
				attrs: {
					native_flow_name: firstButtonName === 'review_and_pay' ? 'order_details' : firstButtonName
				}
			}
		} else if (nativeFlow && nativeFlowSpecials.includes(firstButtonName)) {
			// Only works for WhatsApp Original, not WhatsApp Business
			return {
				tag: 'biz',
				attrs: {
					actual_actors: '2',
					host_storage: '2',
					privacy_mode_ts: Utils_1.unixTimestampSeconds().toString()
				},
				content: [
					{
						tag: 'interactive',
						attrs: {
							type: 'native_flow',
							v: '1'
						},
						content: [
							{
								tag: 'native_flow',
								attrs: {
									v: '2',
									name: firstButtonName
								}
							}
						]
					},
					{
						tag: 'quality_control',
						attrs: {
							source_type: 'third_party'
						}
					}
				]
			}
		} else if (nativeFlow || message.buttonsMessage) {
			// It works for whatsapp original and whatsapp business
			return {
				tag: 'biz',
				attrs: {
					actual_actors: '2',
					host_storage: '2',
					privacy_mode_ts: Utils_1.unixTimestampSeconds().toString()
				},
				content: [
					{
						tag: 'interactive',
						attrs: {
							type: 'native_flow',
							v: '1'
						},
						content: [
							{
								tag: 'native_flow',
								attrs: {
									v: '9',
									name: 'mixed'
								}
							}
						]
					},
					{
						tag: 'quality_control',
						attrs: {
							source_type: 'third_party'
						}
					}
				]
			}
		} else if (message.listMessage) {
			return {
				tag: 'biz',
				attrs: {
					actual_actors: '2',
					host_storage: '2',
					privacy_mode_ts: Utils_1.unixTimestampSeconds().toString()
				},
				content: [
					{
						tag: 'list',
						attrs: {
							v: '2',
							type: 'product_list'
						}
					},
					{
						tag: 'quality_control',
						attrs: {
							source_type: 'third_party'
						}
					}
				]
			}
		} else {
			return {
				tag: 'biz',
				attrs: {
					actual_actors: '2',
					host_storage: '2',
					privacy_mode_ts: Utils_1.unixTimestampSeconds().toString()
				}
			}
		}
	}
	const getPrivacyTokens = async jids => {
		const t = (0, Utils_1.unixTimestampSeconds)().toString()
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'privacy'
			},
			content: [
				{
					tag: 'tokens',
					attrs: {},
					content: jids.map(jid => ({
						tag: 'token',
						attrs: {
							jid: (0, WABinary_1.jidNormalizedUser)(jid),
							t,
							type: 'trusted_contact'
						}
					}))
				}
			]
		})
		return result
	}
	const waUploadToServer = (0, Utils_1.getWAUploadToServer)(config, refreshMediaConn)
	const waitForMsgMediaUpdate = (0, Utils_1.bindWaitForEvent)(ev, 'messages.media-update')
	return {
		...sock,
		getPrivacyTokens,
		assertSessions,
		relayMessage,
		sendReceipt,
		sendReceipts,
		readMessages,
		refreshMediaConn,
		waUploadToServer,
		fetchPrivacySettings,
		sendPeerDataOperationMessage,
		createParticipantNodes,
		getUSyncDevices,
		messageRetryManager,
		updateMemberLabel,
		updateMediaMessage: async message => {
			const content = (0, Utils_1.assertMediaContent)(message.message)
			const mediaKey = content.mediaKey
			const meId = authState.creds.me.id
			const node = (0, Utils_1.encryptMediaRetryRequest)(message.key, mediaKey, meId)
			let error = undefined
			await Promise.all([
				sendNode(node),
				waitForMsgMediaUpdate(async update => {
					const result = update.find(c => c.key.id === message.key.id)
					if (result) {
						if (result.error) {
							error = result.error
						} else {
							try {
								const media = (0, Utils_1.decryptMediaRetryData)(result.media, mediaKey, result.key.id)
								if (media.result !== index_js_1.proto.MediaRetryNotification.ResultType.SUCCESS) {
									const resultStr = index_js_1.proto.MediaRetryNotification.ResultType[media.result]
									throw new boom_1.Boom(`Media re-upload failed by device (${resultStr})`, {
										data: media,
										statusCode: (0, Utils_1.getStatusCodeForMediaRetry)(media.result) || 404
									})
								}
								content.directPath = media.directPath
								content.url = (0, Utils_1.getUrlFromDirectPath)(content.directPath)
								logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
							} catch (err) {
								error = err
							}
						}
						return true
					}
				})
			])
			if (error) {
				throw error
			}
			ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }])
			return message
		},

		sendGroupStatus: async (content, jid) => {
			const userJid = WABinary_1.jidNormalizedUser(authState.creds.me.id)
			let allUsers = new Set()
			allUsers.add(userJid)

			const uniqueUsers = Array.from(allUsers)
			const getRandomHexColor = () =>
				'#' +
				Math.floor(Math.random() * 16777215)
					.toString(16)
					.padStart(6, '0')

			const isMedia = content.image || content.video || content.audio
			const isAudio = !!content.audio

			const messageContent = { ...content }

			if (isMedia && !isAudio) {
				if (messageContent.text) {
					messageContent.caption = messageContent.text

					delete messageContent.text
				}

				delete messageContent.ptt
				delete messageContent.font
				delete messageContent.backgroundColor
				delete messageContent.textColor
			}

			if (isAudio) {
				delete messageContent.text
				delete messageContent.caption
				delete messageContent.font
				delete messageContent.textColor
			}

			const font = !isMedia ? content.font || Math.floor(Math.random() * 9) : undefined
			const textColor = !isMedia ? content.textColor || getRandomHexColor() : undefined
			const backgroundColor = !isMedia || isAudio ? content.backgroundColor || getRandomHexColor() : undefined
			const ptt = isAudio ? (typeof content.ptt === 'boolean' ? content.ptt : true) : undefined

			let msg
			let mediaHandle
			try {
				msg = await Utils_1.generateWAMessage(jid, messageContent, {
					logger,
					userJid,
					getUrlInfo: text =>
						link_preview_1.getUrlInfo(text, {
							thumbnailWidth: linkPreviewImageThumbnailWidth,
							fetchOpts: { timeout: 3000, ...(axiosOptions || {}) },
							logger,
							uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
						}),
					upload: async (encFilePath, opts) => {
						const up = await waUploadToServer(encFilePath, { ...opts })
						mediaHandle = up.handle
						return up
					},
					mediaCache: config.mediaCache,
					options: config.options,
					font,
					textColor,
					backgroundColor,
					ptt
				})
			} catch (error) {
				logger.error(`Error generating message: ${error}`)
				throw error
			}

			try {
				const normalizedId = WABinary_1.jidNormalizedUser(jid)

				// Funktion, um den richtigen Message-Typ zurückzugeben
				const getMessageContent = content => {
					if (content.image) {
						return { imageMessage: { ...content } }
					} else if (content.video) {
						return { videoMessage: { ...content } }
					} else if (content.audio) {
						return { audioMessage: { ...content } }
					} else if (content.text) {
						return { extendedTextMessage: { text: content.text } }
					} else {
						return { extendedTextMessage: { text: '' } } // Fallback
					}
				}

				const Message = {
					groupStatusMessageV2: {
						message: getMessageContent(messageContent)
					},
					messageContextInfo: {
						messageSecret: crypto_1.randomBytes(32)
					}
				}

				const statusMsg = await Utils_1.generateWAMessageFromContent(normalizedId, Message, {})

				await relayMessage(normalizedId, statusMsg.message, {
					additionalNodes: [
						{
							tag: 'meta',
							attrs: { is_group_status: 'true' }
						}
					]
				})

				await Utils_1.delay(2000)
			} catch (error) {
				logger.log(`Error sending to ${id}: ${error}`)
			}

			return msg
		},

		sendStatusMention: async (content, jids = []) => {
			return await baron2.sendStatusWhatsApp(content, jids)
		},
		sendTable: async (jid, title, headers, rows, quoted, options = {}) => {
			const { message, messageId } = message_composer_1.generateTableContent(title, headers, rows, quoted, options)
			await relayMessage(jid, message, { messageId })
			return { message, messageId }
		},
		sendList: async (jid, title, items, quoted, options = {}) => {
			const { message, messageId } = message_composer_1.generateListContent(title, items, quoted, options)
			await relayMessage(jid, message, { messageId })
			return { message, messageId }
		},
		sendCodeBlock: async (jid, code, quoted, options = {}) => {
			const { message, messageId } = message_composer_1.generateCodeBlockContent(code, quoted, options)
			await relayMessage(jid, message, { messageId })
			return { message, messageId }
		},
		sendLatex: async (jid, quoted, options) => {
			const { message, messageId } = message_composer_1.generateLatexContent(quoted, options)
			await relayMessage(jid, message, { messageId })
			return { message, messageId }
		},
		sendLatexImage: async (jid, quoted, options, renderLatexToPng, uploadFn) => {
			const { message, messageId } = await message_composer_1.generateLatexImageContent(
				quoted,
				options,
				uploadFn,
				renderLatexToPng
			)
			await relayMessage(jid, message, { messageId })
			return { message, messageId }
		},
		sendLatexInlineImage: async (jid, quoted, options, renderLatexToPng, uploadFn) => {
			const { message, messageId } = await message_composer_1.generateLatexInlineImageContent(
				quoted,
				options,
				uploadFn,
				renderLatexToPng
			)
			await relayMessage(jid, message, { messageId })
			return { message, messageId }
		},
		captureUnifiedResponse: message_composer_1.captureUnifiedResponse,
		sendUnifiedResponse: async (jid, quoted, captured) => {
			const { message, messageId } = message_composer_1.generateUnifiedResponseContent(quoted, captured)
			await relayMessage(jid, message, { messageId })
			return { message, messageId }
		},
		sendRichMessage: async (jid, submessages, quoted, options = {}) => {
			const { message, messageId } = message_composer_1.generateRichMessageContent(submessages, quoted)
			await relayMessage(jid, message, { messageId })
			return { message, messageId }
		},
		sendMessage: async (jid, content, options = {}) => {
			const userJid = authState.creds.me.id
			// ── Normalize: buttons[].nativeFlowInfo -> interactiveButtons ──────
			if (
				typeof content === 'object' &&
				Array.isArray(content.buttons) &&
				content.buttons.length > 0 &&
				content.buttons.some(b => b.nativeFlowInfo)
			) {
				const interactiveButtons = content.buttons.map(b => {
					if (b.nativeFlowInfo) {
						return {
							name: b.nativeFlowInfo.name,
							buttonParamsJson: b.nativeFlowInfo.paramsJson || '{}'
						}
					}
					return {
						name: 'quick_reply',
						buttonParamsJson: JSON.stringify({
							display_text: b.buttonText?.displayText || b.buttonId || 'Button',
							id: b.buttonId || b.buttonText?.displayText || 'btn'
						})
					}
				})
				const { buttons, headerType, viewOnce, ...rest } = content
				content = { ...rest, interactiveButtons }
			}
			if (
				typeof content === 'object' &&
				Array.isArray(content.interactiveButtons) &&
				content.interactiveButtons.length > 0
			) {
				const {
					text = '',
					caption = '',
					title = '',
					footer = '',
					interactiveButtons,
					hasMediaAttachment = false,
					image = null,
					video = null,
					document = null,
					mimetype = null,
					jpegThumbnail = null,
					location = null,
					product = null,
					businessOwnerJid = null,
					externalAdReply = null
				} = content
				// Normalize buttons
				const processedButtons = []
				for (let i = 0; i < interactiveButtons.length; i++) {
					const btn = interactiveButtons[i]
					if (!btn || typeof btn !== 'object') throw new Error(`interactiveButtons[${i}] must be an object`)
					if (btn.name && btn.buttonParamsJson) {
						processedButtons.push(btn)
						continue
					}
					if (btn.id || btn.text || btn.displayText) {
						processedButtons.push({
							name: 'quick_reply',
							buttonParamsJson: JSON.stringify({
								display_text: btn.text || btn.displayText || `Button ${i + 1}`,
								id: btn.id || `quick_${i + 1}`
							})
						})
						continue
					}
					if (btn.buttonId && btn.buttonText?.displayText) {
						processedButtons.push({
							name: 'quick_reply',
							buttonParamsJson: JSON.stringify({ display_text: btn.buttonText.displayText, id: btn.buttonId })
						})
						continue
					}
					throw new Error(`interactiveButtons[${i}] has invalid shape`)
				}
				let messageContent = {}
				if (image) {
					const mi = Buffer.isBuffer(image)
						? { image }
						: { image: { url: typeof image === 'object' ? image.url : image } }
					const pm = await (0, Utils_1.prepareWAMessageMedia)(mi, { upload: waUploadToServer })
					messageContent.header = { title: title || '', hasMediaAttachment: true, imageMessage: pm.imageMessage }
				} else if (video) {
					const mi = Buffer.isBuffer(video)
						? { video }
						: { video: { url: typeof video === 'object' ? video.url : video } }
					const pm = await (0, Utils_1.prepareWAMessageMedia)(mi, { upload: waUploadToServer })
					messageContent.header = { title: title || '', hasMediaAttachment: true, videoMessage: pm.videoMessage }
				} else if (document) {
					const mi = Buffer.isBuffer(document)
						? { document }
						: { document: { url: typeof document === 'object' ? document.url : document } }
					if (mimetype && typeof mi.document === 'object') mi.document.mimetype = mimetype
					if (jpegThumbnail) {
						const thumb = Buffer.isBuffer(jpegThumbnail)
							? jpegThumbnail
							: await (async () => {
									try {
										const r = await fetch(jpegThumbnail)
										return Buffer.from(await r.arrayBuffer())
									} catch {
										return undefined
									}
								})()
						if (thumb) mi.document.jpegThumbnail = thumb
					}
					const pm = await (0, Utils_1.prepareWAMessageMedia)(mi, { upload: waUploadToServer })
					messageContent.header = { title: title || '', hasMediaAttachment: true, documentMessage: pm.documentMessage }
				} else if (location && typeof location === 'object') {
					messageContent.header = {
						title: title || location.name || 'Location',
						hasMediaAttachment: false,
						locationMessage: {
							degreesLatitude: location.degreesLatitude || location.degressLatitude || 0,
							degreesLongitude: location.degreesLongitude || location.degressLongitude || 0,
							name: location.name || '',
							address: location.address || ''
						}
					}
				} else if (product && typeof product === 'object') {
					let productImageMessage = null
					if (product.productImage) {
						const mi = Buffer.isBuffer(product.productImage)
							? { image: product.productImage }
							: {
									image: {
										url: typeof product.productImage === 'object' ? product.productImage.url : product.productImage
									}
								}
						const pm = await (0, Utils_1.prepareWAMessageMedia)(mi, { upload: waUploadToServer })
						productImageMessage = pm.imageMessage
					}
					messageContent.header = {
						title: title || product.title || 'Product',
						hasMediaAttachment: false,
						productMessage: {
							product: {
								productImage: productImageMessage,
								productId: product.productId || '',
								title: product.title || '',
								description: product.description || '',
								currencyCode: product.currencyCode || 'USD',
								priceAmount1000: parseInt(product.priceAmount1000) || 0,
								retailerId: product.retailerId || '',
								url: product.url || '',
								productImageCount: product.productImageCount || 1
							},
							businessOwnerJid: businessOwnerJid || product.businessOwnerJid || userJid
						}
					}
				} else if (title) {
					messageContent.header = { title, hasMediaAttachment: false }
				}
				const hasMedia = !!(image || video || document || location || product)
				const bodyText = hasMedia ? caption : text || caption
				if (bodyText) messageContent.body = { text: bodyText }
				if (footer) messageContent.footer = { text: footer }
				messageContent.nativeFlowMessage = { buttons: processedButtons }
				if (externalAdReply && typeof externalAdReply === 'object') {
					messageContent.contextInfo = {
						externalAdReply: {
							title: externalAdReply.title || '',
							body: externalAdReply.body || '',
							mediaType: externalAdReply.mediaType || 1,
							sourceUrl: externalAdReply.sourceUrl || externalAdReply.url || '',
							thumbnailUrl: externalAdReply.thumbnailUrl || externalAdReply.thumbnail || '',
							renderLargerThumbnail: externalAdReply.renderLargerThumbnail || false,
							showAdAttribution: externalAdReply.showAdAttribution !== false,
							containsAutoReply: externalAdReply.containsAutoReply || false,
							...(externalAdReply.mediaUrl && { mediaUrl: externalAdReply.mediaUrl }),
							...(Buffer.isBuffer(externalAdReply.thumbnail) && { thumbnail: externalAdReply.thumbnail }),
							...(externalAdReply.jpegThumbnail && { jpegThumbnail: externalAdReply.jpegThumbnail })
						},
						...(options.mentionedJid && { mentionedJid: options.mentionedJid })
					}
				} else if (options.mentionedJid) {
					messageContent.contextInfo = { mentionedJid: options.mentionedJid }
				}
				const payload = index_js_1.proto.Message.InteractiveMessage.create(messageContent)
				const msg = (0, Utils_1.generateWAMessageFromContent)(
					jid,
					{ viewOnceMessage: { message: { interactiveMessage: payload } } },
					{ userJid, quoted: options?.quoted || null }
				)
				const additionalNodes = [
					{
						tag: 'biz',
						attrs: {},
						content: [
							{
								tag: 'interactive',
								attrs: { type: 'native_flow', v: '1' },
								content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
							}
						]
					}
				]
				await relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes })
				return msg
			}
			if (
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(jid)
			) {
				const { disappearingMessagesInChat } = content
				const value =
					typeof disappearingMessagesInChat === 'boolean'
						? disappearingMessagesInChat
							? WA_DEFAULT_EPHEMERAL
							: 0
						: disappearingMessagesInChat
				await groupToggleEphemeral(jid, value)
			} else if (baron2.detectType(content)) {
				const { quoted } = options
				const messageType = baron2.detectType(content)
				switch (messageType) {
					case 'PAYMENT': {
						const paymentContent = await baron2.handlePayment(content, quoted)
						return await relayMessage(jid, paymentContent, {
							messageId: (0, Utils_1.generateMessageIDV2)(userJid)
						})
					}
					case 'PRODUCT': {
						const productContent = await baron2.handleProduct(content, jid, quoted)
						const productMsg = await (0, Utils_1.generateWAMessageFromContent)(jid, productContent, { quoted, userJid })
						return await relayMessage(jid, productMsg.message, {
							messageId: productMsg.key.id
						})
					}
					case 'INTERACTIVE': {
						const interactiveContent = await baron2.handleInteractive(content, jid, quoted)
						const interactiveMsg = await (0, Utils_1.generateWAMessageFromContent)(jid, interactiveContent, {
							quoted,
							userJid
						})
						return await relayMessage(jid, interactiveMsg.message, {
							messageId: interactiveMsg.key.id
						})
					}
					case 'INTERACTIVE_BUTTONS': {
						const ibContent = await baron2.handleInteractiveButtons(content, jid, quoted)
						const ibMsg = await (0, Utils_1.generateWAMessageFromContent)(jid, ibContent, { quoted, userJid })
						return await relayMessage(jid, ibMsg.message, {
							messageId: ibMsg.key.id
						})
					}
					case 'ALBUM':
						return await baron2.handleAlbum(content, jid, quoted)
					case 'EVENT':
						return await baron2.handleEvent(content, jid, quoted)
					case 'POLL_RESULT':
						return await baron2.handlePollResult(content, jid, quoted)
					case 'GROUP_STORY':
						return await baron2.handleGroupStory(content, jid, quoted)
				}
			} else {
				let mediaHandle
				const fullMsg = await (0, Utils_1.generateWAMessage)(jid, content, {
					logger,
					userJid,
					getUrlInfo: text =>
						(0, link_preview_1.getUrlInfo)(text, {
							thumbnailWidth: linkPreviewImageThumbnailWidth,
							fetchOpts: {
								timeout: 3000,
								...(httpRequestOptions || {})
							},
							logger,
							uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
						}),
					//TODO: CACHE
					getProfilePicUrl: sock.profilePictureUrl,
					getCallLink: sock.createCallLink,
					newsletter: (0, WABinary_1.isJidNewsletter)(jid),
					upload: async (encFilePath, opts) => {
						const up = await waUploadToServer(encFilePath, {
							...opts,
							newsletter: (0, WABinary_1.isJidNewsletter)(jid)
						})
						mediaHandle = up.handle
						return up
					},
					mediaCache: config.mediaCache,
					options: config.options,
					messageId: (0, Utils_1.generateMessageIDV2)(sock.user?.id),
					...options
				})
				if (!mediaHandle) {
					const msgContent = fullMsg.message
					const msgTypes = ['audioMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage']
					for (const t of msgTypes) {
						if (msgContent?.[t]?._uploadHandle) {
							mediaHandle = msgContent[t]._uploadHandle

							delete msgContent[t]._uploadHandle
							break
						}
					}
				}
				const isEventMsg = 'event' in content && !!content.event
				const isDeleteMsg = 'delete' in content && !!content.delete
				const isEditMsg = 'edit' in content && !!content.edit
				const isPinMsg = 'pin' in content && !!content.pin
				const isPollMessage = 'poll' in content && !!content.poll
				const additionalAttributes = {}
				const additionalNodes = []
				if (isDeleteMsg) {
					if (isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe) {
						additionalAttributes.edit = '8'
					} else {
						additionalAttributes.edit = '7'
					}
				} else if (isEditMsg) {
					additionalAttributes.edit = '1'
				} else if (isPinMsg) {
					additionalAttributes.edit = '2'
				} else if (isPollMessage) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							polltype: 'creation'
						}
					})
				} else if (isEventMsg) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							event_type: 'creation'
						}
					})
				}
				const buttonType = getButtonType(fullMsg.message)
				if (content?.audio && options?.contextInfo) {
					const msgContent = fullMsg.message
					if (msgContent?.audioMessage) {
						msgContent.audioMessage.contextInfo = options.contextInfo
					}
				}
				if (buttonType) {
					const btnNode = getButtonArgs(fullMsg.message)
					if (btnNode) additionalNodes.push(btnNode)
				}
				if (mediaHandle) {
					additionalAttributes['media_id'] = mediaHandle
				}
				await relayMessage(jid, fullMsg.message, {
					messageId: fullMsg.key.id,
					useCachedGroupMetadata: options.useCachedGroupMetadata,
					additionalAttributes,
					statusJidList: options.statusJidList,
					additionalNodes,
					AI: options.ai || false
				})
				if (config.emitOwnEvents) {
					process.nextTick(async () => {
						await messageMutex.mutex(() => upsertMessage(fullMsg, 'append'))
					})
				}
				return fullMsg
			}
		}
	}
}
exports.makeMessagesSocket = makeMessagesSocket
