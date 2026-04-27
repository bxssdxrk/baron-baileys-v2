'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
const Defaults_1 = require('../Defaults')
const communities_1 = require('./communities')
// Antiban protection — bundled directly into baron-baileys-v2
const { wrapSocket: _wrapSocket } = require('../antiban')

// export the last socket layer
const makeWASocket = (config) => {
	const userExplicitSyncFlag = typeof config?.syncFullHistory === 'boolean'
	const initialFullSyncDone = !!config?.auth?.creds?.initialFullSyncDone
	const effectiveSyncFullHistory = userExplicitSyncFlag ? config.syncFullHistory : !initialFullSyncDone
	const newConfig = {
		...Defaults_1.DEFAULT_CONNECTION_CONFIG,
		...config,
		syncFullHistory: effectiveSyncFullHistory
	}
	newConfig.logger?.debug?.(
		{ initialFullSyncDone, effectiveSyncFullHistory, userExplicitSyncFlag },
		'computed syncFullHistory policy'
	)
	const sock = (0, communities_1.makeCommunitiesSocket)(newConfig)
	// Auto-wrap with antiban if available (config.antiban = false to opt-out)
	if (_wrapSocket && config?.antiban !== false) {
		return _wrapSocket(sock, config?.antiban || undefined)
	}
	return sock
}
exports.default = makeWASocket
