'use strict'
// Jest mock for whatsapp-rust-bridge — uses Node.js native crypto
// so tests run without WASM/ESM initialization
const crypto = require('crypto')

const hkdf = (buffer, length, opts = {}) => {
	const { salt, info } = opts
	const saltBuf = salt ? Buffer.from(salt) : Buffer.alloc(0)
	const infoBuf = info ? Buffer.from(info) : Buffer.alloc(0)
	return crypto.hkdfSync('sha256', Buffer.from(buffer), saltBuf, infoBuf, length)
}

const aesDecryptGCM = (ciphertextWithTag, key, iv, aad) => {
	const GCM_TAG = 16
	const ct = ciphertextWithTag.slice(0, ciphertextWithTag.length - GCM_TAG)
	const tag = ciphertextWithTag.slice(-GCM_TAG)
	const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv))
	d.setAAD(Buffer.from(aad))
	d.setAuthTag(Buffer.from(tag))
	return Buffer.concat([d.update(Buffer.from(ct)), d.final()])
}

const aesEncryptGCM = (plaintext, key, iv, aad) => {
	const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv))
	c.setAAD(Buffer.from(aad))
	const enc = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()])
	return Buffer.concat([enc, c.getAuthTag()])
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest()
const hmacSign = (buf, key) => crypto.createHmac('sha256', Buffer.from(key)).update(buf).digest()
const md5 = buf => crypto.createHash('md5').update(buf).digest()

module.exports = {
	hkdf,
	aesDecryptGCM,
	aesEncryptGCM,
	sha256,
	hmacSign,
	md5,
}
