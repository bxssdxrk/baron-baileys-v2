const { isInteropUser } = require('./src/WABinary');
const { generateWAMessageFromContent } = require('./src/Utils/messages');

const jid = '13-107310445768773@interop';
const text = 'H';

// Mock options
const options = {
    jid,
    logger: { debug: () => {}, trace: () => {}, warn: () => {}, error: () => {} }
};

// This is roughly what relayMessage does
const m = { conversation: text };
// ... (some logic here)

console.log('Interop message content:', JSON.stringify(m, null, 2));

if (isInteropUser(jid)) {
    console.log('Is interop: true');
}
