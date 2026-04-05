'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
const Defaults_1 = require('../Defaults')
const communities_1 = require('./communities')
// export the last socket layer
const makeWASocket = config => {
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
	return (0, communities_1.makeCommunitiesSocket)(newConfig)
}
exports.default = makeWASocket
