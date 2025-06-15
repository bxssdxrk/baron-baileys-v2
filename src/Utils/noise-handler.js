"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const boom_1 = require("@hapi/boom")
const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const WABinary_1 = require("../WABinary")
const crypto_1 = require("./crypto")

const generateIV = (counter) => {
    const iv = new ArrayBuffer(12)
    new DataView(iv).setUint32(8, counter)
    return new Uint8Array(iv)
}

const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }) => {
    logger = logger.child({ class: 'ns' })
    const authenticate = (data) => {
        if (!isFinished) {
            hash = crypto_1.sha256(Buffer.concat([hash, data]))
        }
    }
    const encrypt = (plaintext) => {
        const result = crypto_1.aesEncryptGCM(plaintext, encKey, generateIV(writeCounter), hash)
        writeCounter += 1
        authenticate(result)
        return result
    }
    const decrypt = (ciphertext) => {
        // before the handshake is finished, we use the same counter
        // after handshake, the counters are different
        const iv = generateIV(isFinished ? readCounter : writeCounter)
        const result = crypto_1.aesDecryptGCM(ciphertext, decKey, iv, hash)
        if (isFinished) {
            readCounter += 1
        }
        else {
            writeCounter += 1
        }
        authenticate(ciphertext)
        return result
    }
    const localHKDF = async (data) => {
        const key = await crypto_1.hkdf(Buffer.from(data), 64, { salt, info: '' })
        return [key.slice(0, 32), key.slice(32)]
    }
    const mixIntoKey = async (data) => {
        const [write, read] = await localHKDF(data)
        salt = write
        encKey = read
        decKey = read
        readCounter = 0
        writeCounter = 0
    }
    const finishInit = async () => {
        const [write, read] = await localHKDF(new Uint8Array(0))
        encKey = write
        decKey = read
        hash = Buffer.from([])
        readCounter = 0
        writeCounter = 0
        isFinished = true
    }
    const data = Buffer.from(Defaults_1.NOISE_MODE)
    let hash = data.byteLength === 32 ? data : crypto_1.sha256(data)
    let salt = hash
    let encKey = hash
    let decKey = hash
    let readCounter = 0
    let writeCounter = 0
    let isFinished = false
    let sentIntro = false
    let inBytes = Buffer.alloc(0)
    authenticate(NOISE_HEADER)
    authenticate(publicKey)
    return {
        encrypt,
        decrypt,
        authenticate,
        mixIntoKey,
        finishInit,
        processHandshake: async ({ serverHello }, noiseKey) => {
            authenticate(serverHello.ephemeral)
            await mixIntoKey(crypto_1.Curve.sharedKey(privateKey, serverHello.ephemeral))
            const decStaticContent = decrypt(serverHello.static)
            await mixIntoKey(crypto_1.Curve.sharedKey(privateKey, decStaticContent))
            const certDecoded = decrypt(serverHello.payload)
            const { intermediate: certIntermediate } = WAProto_1.proto.CertChain.decode(certDecoded)
            const { issuerSerial } = WAProto_1.proto.CertChain.NoiseCertificate.Details.decode(certIntermediate.details)
            if (issuerSerial !== Defaults_1.WA_CERT_DETAILS.SERIAL) {
                throw new boom_1.Boom('certification match failed', { statusCode: 400 })
            }
            const keyEnc = encrypt(noiseKey.public)
            await mixIntoKey(crypto_1.Curve.sharedKey(noiseKey.private, serverHello.ephemeral))
            return keyEnc
        },
       encodeFrame: (data) => {
            const MAX_FRAME_SIZE = 0xFFFFFF;
            const frames = [];
            if (isFinished) {
                data = encrypt(data);
            }
            let header;
            if (routingInfo) {
                header = Buffer.alloc(7);
                header.write('ED', 0, 'utf8');
                header.writeUInt8(0, 2);
                header.writeUInt8(1, 3);
                header.writeUInt8(routingInfo.byteLength >> 16, 4);
                header.writeUInt16BE(routingInfo.byteLength & 0xFFFF, 5);
                header = Buffer.concat([header, routingInfo, NOISE_HEADER]);
            } else {
                header = Buffer.from(NOISE_HEADER);
            }
            const introSize = sentIntro ? 0 : header.length;
            let offset = 0;
            while (offset < data.length) {
                const chunkSize = Math.min(MAX_FRAME_SIZE, data.length - offset);
                const chunk = data.slice(offset, offset + chunkSize);
                const frame = Buffer.alloc(introSize + 3 + chunk.length);
                if (!sentIntro) {
                    frame.set(header);
                    sentIntro = true;
                }
                frame.writeUInt8((chunk.length >> 16) & 0xFF, introSize);
                frame.writeUInt16BE(chunk.length & 0xFFFF, introSize + 1);
                frame.set(chunk, introSize + 3);
        
                frames.push(frame);
                offset += chunkSize;
            }
            return frames.length === 1 ? frames[0] : frames;
        },

        decodeFrame: async (newData, onFrame) => {
            // the binary protocol uses its own framing mechanism
            // on top of the WS frames
            // so we get this data and separate out the frames
            const getBytesSize = () => {
                if (inBytes.length >= 3) {
                    return (inBytes.readUInt8() << 16) | inBytes.readUInt16BE(1)
                }
            }
            inBytes = Buffer.concat([inBytes, newData])
            logger.trace(`recv ${newData.length} bytes, total recv ${inBytes.length} bytes`)
            let size = getBytesSize()
            while (size && inBytes.length >= size + 3) {
                let frame = inBytes.slice(3, size + 3)
                inBytes = inBytes.slice(size + 3)
                if (isFinished) {
                    const result = decrypt(frame)
                    frame = await WABinary_1.decodeBinaryNode(result)
                }
                logger.trace({ msg: frame?.attrs?.id }, 'recv frame')
                onFrame(frame)
                size = getBytesSize()
            }
        }
    }
}

module.exports = {
  makeNoiseHandler
}