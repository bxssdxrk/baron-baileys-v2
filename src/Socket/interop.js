'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.makeInteropSocket = void 0

const { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } = require('../WABinary')

/**
 * Known integrator IDs (assigned by WhatsApp).
 * BirdyChat → identifier_type="email"
 * Haiket    → identifier_type="pn"
 */
const INTEGRATOR_BIRDYCHAT = 12
const INTEGRATOR_HAIKET = 13

/**
 * TOS trackable results sent by WA on first interop opt-in.
 * 105 = TOS shown, 160 = TOS accepted.
 */
const TOS_TRACKABLE_ID = '20240306'
const TOS_RESULT_SHOWN = '105'
const TOS_RESULT_ACCEPTED = '160'

/** Maximum users per batch lookup (enforced server-side too). */
const INTEROP_BATCH_MAX = 256

const makeInteropSocket = sock => {
	const { query, logger } = sock

	/**
	 * Fetch all available interop integrators from the server.
	 * Each integrator carries: id, name, status, icon, identifierType,
	 * optedIn, features.groupMessaging.
	 * status can be "active" | "onboarding" | "removed".
	 */
	const fetchIntegrators = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				type: 'get',
				xmlns: 'w:interop',
				to: S_WHATSAPP_NET
			},
			content: [{ tag: 'integrator', attrs: { fetch: 'all' } }]
		})
		const listNode = getBinaryNodeChild(result, 'integrator_list')
		if (!listNode) return []
		const globalOptedIn = listNode.attrs?.opted_in === 'true'
		return getBinaryNodeChildren(listNode, 'integrator').map(node => {
			const featuresNode = getBinaryNodeChild(node, 'features')
			return {
				id: parseInt(node.attrs.id),
				name: node.attrs.name,
				// "active" | "onboarding" | "removed"
				status: node.attrs.status,
				icon: node.attrs.icon,
				// "email" | "pn" | "username"
				identifierType: node.attrs.identifier_type,
				// Whether we are already opted-in to this integrator
				optedIn: node.attrs.opted_in === 'true' || globalOptedIn,
				features: {
					groupMessaging: featuresNode?.attrs?.group_messaging === 'true'
				}
			}
		})
	}

	/** Send a single TOS trackable item (shown or accepted). */
	const sendTOSTrackable = async (id, result) => {
		await query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'tos' },
			content: [{ tag: 'trackable', attrs: { id, result } }]
		})
	}

	/**
	 * Accept TOS for interop.
	 * Sends two trackable items: shown (105) then accepted (160).
	 * Must be called before opting in.
	 */
	const acceptInteropTOS = async () => {
		await sendTOSTrackable(TOS_TRACKABLE_ID, TOS_RESULT_SHOWN)
		await sendTOSTrackable(TOS_TRACKABLE_ID, TOS_RESULT_ACCEPTED)
	}

	/**
	 * Opt in to a list of integrators (by numeric ID).
	 * Defaults to both known integrators (BirdyChat + Haiket).
	 */
	const optInIntegrators = async (integratorIds = [INTEGRATOR_BIRDYCHAT, INTEGRATOR_HAIKET]) => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'opt_in_integrators',
					attrs: {},
					content: [
						{
							tag: 'integrator_list',
							attrs: {},
							content: integratorIds.map(id => ({
								tag: 'integrator',
								attrs: { id: id.toString() }
							}))
						}
					]
				}
			]
		})
	}

	/**
	 * Opt out of a list of integrators (by numeric ID).
	 * Mirror of optInIntegrators — uses <opt_out_integrators>.
	 */
	const optOutIntegrators = async (integratorIds = [INTEGRATOR_BIRDYCHAT, INTEGRATOR_HAIKET]) => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'opt_out_integrators',
					attrs: {},
					content: [
						{
							tag: 'integrator_list',
							attrs: {},
							content: integratorIds.map(id => ({
								tag: 'integrator',
								attrs: { id: id.toString() }
							}))
						}
					]
				}
			]
		})
	}

	/**
	 * Resolve one or more interop users by external ID in a single IQ.
	 * Each entry: { externalId, integratorId }
	 *   - BirdyChat (12): externalId = email address
	 *   - Haiket    (13): externalId = phone number string (e.g. "19146088152")
	 *
	 * Max 256 entries per call (server limit).
	 *
	 * Returns an array of results:
	 *   { jid, externalId, normalizedExternalId, integratorId }  on success
	 *   { externalId, integratorId, error: { code, text } }       on failure
	 */
	const resolveInteropUsers = async users => {
		if (!users || users.length === 0) return []
		if (users.length > INTEROP_BATCH_MAX) {
			throw new Error(`resolveInteropUsers: max ${INTEROP_BATCH_MAX} users per request`)
		}
		const result = await query({
			tag: 'iq',
			attrs: { type: 'get', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'users',
					attrs: {},
					content: users.map(({ externalId, integratorId }) => ({
						tag: 'user',
						attrs: {
							external_id: externalId,
							integrator_id: integratorId.toString()
						}
					}))
				}
			]
		})
		const usersNode = getBinaryNodeChild(result, 'users')
		if (!usersNode) return []
		return getBinaryNodeChildren(usersNode, 'user').map(userNode => {
			const errorNode = getBinaryNodeChild(userNode, 'error')
			if (errorNode) {
				return {
					externalId: userNode.attrs.external_id,
					integratorId: parseInt(userNode.attrs.integrator_id),
					error: {
						code: parseInt(errorNode.attrs.code),
						text: errorNode.attrs.text
					}
				}
			}
			return {
				jid: userNode.attrs.jid,
				externalId: userNode.attrs.external_id,
				normalizedExternalId: userNode.attrs.normalized_external_id,
				integratorId: parseInt(userNode.attrs.integrator_id)
			}
		})
	}

	/**
	 * Convenience wrapper: resolve a single interop user.
	 * Returns the result object or null.
	 */
	const resolveInteropUser = async (externalId, integratorId) => {
		const results = await resolveInteropUsers([{ externalId, integratorId }])
		return results[0] ?? null
	}

	/**
	 * Get reachability settings for interop contacts.
	 * Returns the raw <reachability_settings> node content.
	 * WA uses this as the interop presence/subscription mechanism.
	 */
	const getReachabilitySettings = async () => {
		const result = await query({
			tag: 'iq',
			attrs: { type: 'get', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [{ tag: 'reachability_settings', attrs: {} }]
		})
		const settingsNode = getBinaryNodeChild(result, 'reachability_settings')
		if (!settingsNode) return null
		return {
			enabled: settingsNode.attrs?.enabled,
			users: getBinaryNodeChildren(settingsNode, 'user').map(n => ({
				externalId: n.attrs.external_id,
				integratorId: parseInt(n.attrs.integrator_id),
				jid: n.attrs.jid
			}))
		}
	}

	/**
	 * Set reachability settings (subscribe to presence) for interop contacts.
	 * users: array of { externalId, integratorId }
	 * enabled: "true" | "false"
	 */
	const setReachabilitySettings = async (users, enabled = 'true') => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'reachability_settings',
					attrs: { enabled },
					content: users.map(({ externalId, integratorId }) => ({
						tag: 'user',
						attrs: {
							external_id: externalId,
							integrator_id: integratorId.toString()
						}
					}))
				}
			]
		})
	}

	/**
	 * Block or unblock an interop user via the w:interop blocklist.
	 * Different from regular WA block (xmlns=blocklist).
	 */
	const updateInteropBlockStatus = async (jid, action) => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'blocklist',
					attrs: {},
					content: [{ tag: 'item', attrs: { action, jid } }]
				}
			]
		})
	}

	const blockInteropUser = jid => updateInteropBlockStatus(jid, 'block')
	const unblockInteropUser = jid => updateInteropBlockStatus(jid, 'unblock')

	/**
	 * Report an interop contact as spam.
	 * spam_flow="account_info_block" = block + report (WA Web default).
	 */
	const reportInteropSpam = async (jid, spamFlow = 'account_info_block') => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
			content: [{ tag: 'spam_list', attrs: { jid, spam_flow: spamFlow } }]
		})
	}

	/**
	 * Mark an interop JID as trusted_contact in privacy tokens.
	 * WA calls this automatically after the first outgoing message.
	 */
	const trustInteropContact = async jid => {
		const t = Math.floor(Date.now() / 1000).toString()
		await query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, xmlns: 'privacy', type: 'set' },
			content: [
				{
					tag: 'tokens',
					attrs: {},
					content: [{ tag: 'token', attrs: { jid, type: 'trusted_contact', t } }]
				}
			]
		})
	}

	/**
	 * Full interop initialization sequence matching WA Web:
	 * 1. Fetch available integrators
	 * 2. Accept TOS (shown 105 + accepted 160)
	 * 3. Opt-in to all active/onboarding integrators
	 *
	 * Silently tolerates TOS/opt-in errors.
	 * Returns the full integrator list.
	 */
	const initInterop = async () => {
		let integrators
		try {
			integrators = await fetchIntegrators()
		} catch (err) {
			logger.warn({ err }, 'interop: failed to fetch integrators')
			return []
		}
		const toOptIn = integrators.filter(i => i.status === 'active' || i.status === 'onboarding')
		if (toOptIn.length === 0) return integrators
		try {
			await acceptInteropTOS()
		} catch (err) {
			logger.warn({ err }, 'interop: failed to accept TOS')
		}
		try {
			await optInIntegrators(toOptIn.map(i => i.id))
		} catch (err) {
			logger.warn({ err }, 'interop: failed to opt-in integrators')
		}
		logger.info({ integrators: toOptIn.map(i => i.name) }, 'interop: initialized')
		return integrators
	}

	return {
		...sock,
		fetchIntegrators,
		acceptInteropTOS,
		optInIntegrators,
		optOutIntegrators,
		resolveInteropUser,
		resolveInteropUsers,
		getReachabilitySettings,
		setReachabilitySettings,
		blockInteropUser,
		unblockInteropUser,
		reportInteropSpam,
		trustInteropContact,
		initInterop,
		INTEGRATOR_BIRDYCHAT,
		INTEGRATOR_HAIKET
	}
}

exports.makeInteropSocket = makeInteropSocket
