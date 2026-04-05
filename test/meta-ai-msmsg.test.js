'use strict'

const { proto } = require('../WAProto')
const {
  privateChatFixture,
  normalGroupFixture,
  metaAiGroupFixture,
} = require('./fixtures/meta-ai-msmsg-fixtures')
const {
  buildMsmsgDecryptionStrategies,
  decryptMsmsgBotMessage,
  decodeDecryptedMsmsgMessage,
} = require('../src/Utils/meta-ai-msmsg')

const msMsgFromHex = ({ encIvHex, encPayloadHex }) => ({
  version: 1,
  encIv: Buffer.from(encIvHex, 'hex'),
  encPayload: Buffer.from(encPayloadHex, 'hex'),
})

const knownVectors = {
  privatePrimary: {
    msMsg: msMsgFromHex({
      encIvHex: '000102030405060708090a0b',
      encPayloadHex: 'cdd172931e02d67a9332662ea9b37224e2f2c1b36592ba4123aebcac679ebbcf537d1feb',
    }),
    expectedText: 'private ok',
  },
  groupPrimary: {
    msMsg: msMsgFromHex({
      encIvHex: '101112131415161718191a1b',
      encPayloadHex: '75abc30849e328531b803048b81bff603235150341c4c335412df57e3f336542929a',
    }),
    expectedText: 'group ok',
  },
  groupFallbackMetaTarget: {
    msMsg: msMsgFromHex({
      encIvHex: '202122232425262728292a2b',
      encPayloadHex: '6db9b2a0d4008e9b56a1e4aae13b80966c8c3e6adc5617f6a52c91bc69c1a61f2f72f61aff72',
    }),
    expectedText: 'fallback ok',
  },
}

describe('meta-ai msmsg strategy selection', () => {
  test('keeps private chat strategy list small and deterministic', () => {
    const strategies = buildMsmsgDecryptionStrategies(privateChatFixture.messageKey, 1)

    expect(strategies[0]).toMatchObject({
      mode: '2step',
      idSource: 'botEditTargetId',
      infoSource: 'msgIdAscii+meId+botJid',
      aadSource: 'msgIdAscii+0+botJid',
      authTagLayout: 'trailing',
    })
    expect(strategies).toHaveLength(6)
  })

  test('prefers stanza id first for botType full group replies', () => {
    const strategies = buildMsmsgDecryptionStrategies(metaAiGroupFixture.messageKey, 1)

    expect(strategies[0]).toMatchObject({
      idSource: 'stanzaId',
      infoSource: 'msgIdAscii+meId+botJid',
      aadSource: 'msgIdAscii+0+botJid',
    })
    expect(strategies).toHaveLength(8)
  })

  test('includes bounded binary and alternate jid fallbacks without mislabeling target ids', () => {
    const strategies = buildMsmsgDecryptionStrategies(normalGroupFixture.messageKey, 1)

    expect(strategies).toHaveLength(12)
    expect(strategies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idSource: 'botEditTargetId',
          idSources: ['botEditTargetId', 'targetId', 'targetIdCandidates[0]'],
          infoSource: 'msgIdBinary+meId+botJid',
          aadSource: 'msgIdBinary+0+botJid',
        }),
        expect.objectContaining({
          idSource: 'metaTargetId',
          infoSource: 'msgIdAscii+conversationJid+botJid',
          aadSource: 'msgIdAscii+0+conversationJid',
        }),
      ]),
    )
  })
})

describe('meta-ai msmsg decryption', () => {
  test('decryptMessageNode delegates msmsg integration to helper module', async () => {
    const decryptMsmsgBotMessage = jest.fn().mockResolvedValue(Buffer.from('decrypted-msmsg'))
    const decodeDecryptedMsmsgMessage = jest.fn().mockReturnValue({
      protocolMessage: {
        editedMessage: {
          extendedTextMessage: {
            text: 'delegated ok',
          },
        },
      },
    })

    jest.resetModules()
    jest.doMock('../src/Utils/generics', () => ({
      unpadRandomMax16: value => value,
    }))
    jest.doMock('../src/Utils/messages', () => ({
      getDevice: jest.fn().mockReturnValue(undefined),
    }))
    jest.doMock('../src/Utils/meta-ai-msmsg', () => ({
      decryptMsmsgBotMessage,
      decodeDecryptedMsmsgMessage,
    }))

    let decryptMessageNode
    let setBotMessageSecret
    jest.isolateModules(() => {
      ;({ decryptMessageNode, setBotMessageSecret } = require('../src/Utils/decode-wa-message'))
    })

    setBotMessageSecret(
      privateChatFixture.messageKey.botEditTargetId,
      privateChatFixture.messageSecret,
      privateChatFixture.messageKey.conversationJid,
    )

    const stanza = {
      attrs: {
        id: privateChatFixture.messageKey.stanzaId,
        from: privateChatFixture.messageKey.participant,
        t: '1712345678',
      },
      content: [
        {
          tag: 'meta',
          attrs: {
            target_id: privateChatFixture.messageKey.metaTargetId,
          },
        },
        {
          tag: 'bot',
          attrs: {
            edit: privateChatFixture.messageKey.botType,
            edit_target_id: privateChatFixture.messageKey.botEditTargetId,
          },
        },
        {
          tag: 'enc',
          attrs: {
            type: 'msmsg',
          },
          content: proto.MessageSecretMessage.encode(knownVectors.privatePrimary.msMsg).finish(),
        },
      ],
    }

    const repository = {
      lidMapping: {
        getLIDForPN: jest.fn().mockResolvedValue(null),
        storeLIDPNMappings: jest.fn().mockResolvedValue(undefined),
      },
      migrateSession: jest.fn().mockResolvedValue(undefined),
      processSenderKeyDistributionMessage: jest.fn().mockResolvedValue(undefined),
    }
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }

    const decoded = decryptMessageNode(
      stanza,
      '1234567890@s.whatsapp.net',
      privateChatFixture.messageKey.meLid,
      repository,
      logger,
    )

    await decoded.decrypt()

    expect(decryptMsmsgBotMessage).toHaveBeenCalledTimes(1)
    expect(decryptMsmsgBotMessage).toHaveBeenCalledWith(
      privateChatFixture.messageSecret,
      expect.objectContaining({
        participant: privateChatFixture.messageKey.participant,
        meId: privateChatFixture.messageKey.meId,
        meLid: privateChatFixture.messageKey.meLid,
        conversationJid: privateChatFixture.messageKey.conversationJid,
        botType: privateChatFixture.messageKey.botType,
        botEditTargetId: privateChatFixture.messageKey.botEditTargetId,
        metaTargetId: privateChatFixture.messageKey.metaTargetId,
        stanzaId: privateChatFixture.messageKey.stanzaId,
        targetId: privateChatFixture.messageKey.botEditTargetId,
        targetIdCandidates: [
          privateChatFixture.messageKey.botEditTargetId,
          privateChatFixture.messageKey.metaTargetId,
          privateChatFixture.messageKey.stanzaId,
        ],
      }),
      knownVectors.privatePrimary.msMsg,
    )
    expect(decodeDecryptedMsmsgMessage).toHaveBeenCalledWith(Buffer.from('decrypted-msmsg'))
    expect(decoded.fullMessage.message.protocolMessage.editedMessage.extendedTextMessage.text).toBe('delegated ok')

    jest.dontMock('../src/Utils/meta-ai-msmsg')
    jest.resetModules()
  })

  test('decrypts a known private chat payload', async () => {
    const decrypted = await decryptMsmsgBotMessage(
      privateChatFixture.messageSecret,
      privateChatFixture.messageKey,
      knownVectors.privatePrimary.msMsg,
    )

    const decoded = decodeDecryptedMsmsgMessage(decrypted)
    expect(decoded.protocolMessage.editedMessage.extendedTextMessage.text).toBe(
      knownVectors.privatePrimary.expectedText,
    )
  })

  test('decrypts a known normal group payload', async () => {
    const decrypted = await decryptMsmsgBotMessage(
      normalGroupFixture.messageSecret,
      normalGroupFixture.messageKey,
      knownVectors.groupPrimary.msMsg,
    )

    const decoded = decodeDecryptedMsmsgMessage(decrypted)
    expect(decoded.protocolMessage.editedMessage.extendedTextMessage.text).toBe(
      knownVectors.groupPrimary.expectedText,
    )
  })

  test('decrypts a known payload by falling back to a non-primary target id candidate', async () => {
    const decrypted = await decryptMsmsgBotMessage(
      normalGroupFixture.messageSecret,
      normalGroupFixture.messageKey,
      knownVectors.groupFallbackMetaTarget.msMsg,
    )

    const decoded = decodeDecryptedMsmsgMessage(decrypted)
    expect(decoded.richResponseMessage.submessages[0].messageText).toBe(
      knownVectors.groupFallbackMetaTarget.expectedText,
    )
  })

  test('fails early when required decryption inputs are missing', async () => {
    await expect(
      decryptMsmsgBotMessage(
        privateChatFixture.messageSecret,
        { ...privateChatFixture.messageKey, meId: '' },
        knownVectors.privatePrimary.msMsg,
      ),
    ).rejects.toThrow('Missing required meId for msmsg decryption')
  })

  test('fails early when there is no usable target message id source', async () => {
    await expect(
      decryptMsmsgBotMessage(
        privateChatFixture.messageSecret,
        {
          ...privateChatFixture.messageKey,
          targetId: '',
          botEditTargetId: '',
          metaTargetId: '',
          stanzaId: '',
          targetIdCandidates: [],
        },
        knownVectors.privatePrimary.msMsg,
      ),
    ).rejects.toThrow('Missing required target message id for msmsg decryption')
  })

  test('fails early on empty typed-array encryption inputs', async () => {
    await expect(
      decryptMsmsgBotMessage(
        new Uint8Array(0),
        privateChatFixture.messageKey,
        {
          version: 1,
          encIv: new Uint8Array(0),
          encPayload: new Uint8Array(0),
        },
      ),
    ).rejects.toThrow('Missing required messageSecret for msmsg decryption')
  })

  test('reports accurate deduplicated attempted strategy telemetry on bounded failure', async () => {
    try {
      await decryptMsmsgBotMessage(
        Buffer.alloc(32),
        normalGroupFixture.messageKey,
        knownVectors.groupPrimary.msMsg,
      )
      throw new Error('expected decryptMsmsgBotMessage to fail')
    } catch (error) {
      expect(error.message).toBe('Failed to decrypt msmsg with bounded deterministic strategies')
      expect(Array.isArray(error.attemptedStrategies)).toBe(true)
      expect(error.attemptedStrategies.length).toBeGreaterThan(0)
      expect(error.attemptedStrategies.length).toBeLessThanOrEqual(12)
      expect(error.cause).toBeTruthy()
      expect(typeof error.cause.message).toBe('string')
      expect(error.attemptedStrategies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            idSource: 'botEditTargetId',
            idSources: ['botEditTargetId', 'targetId', 'targetIdCandidates[0]'],
            infoSource: 'msgIdAscii+meId+botJid',
            aadSource: 'msgIdAscii+0+botJid',
            messageId: normalGroupFixture.messageKey.targetId,
          }),
          expect.objectContaining({
            idSource: 'metaTargetId',
            idSources: ['metaTargetId', 'targetIdCandidates[1]'],
            messageId: normalGroupFixture.messageKey.metaTargetId,
          }),
        ]),
      )
      expect(
        error.attemptedStrategies.filter(
          attempt =>
            attempt.messageId === normalGroupFixture.messageKey.targetId &&
            attempt.infoSource === 'msgIdAscii+meId+botJid' &&
            attempt.aadSource === 'msgIdAscii+0+botJid',
        ),
      ).toHaveLength(1)
    }
  })
})
